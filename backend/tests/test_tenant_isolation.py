"""
One user must never see another user's rows.

Supabase's row-level security used to make this a property of the database:
a query missing its `WHERE user_id = ...` returned nothing rather than
everything. We now connect as a single Postgres role with full table access,
so the same query returns every row in the table. Ownership is enforced only
by the filters written into the route handlers, and a filter nobody tests is a
filter somebody eventually drops.

These tests are the replacement for that guarantee. They sign in two accounts,
give one of them a distinctive marker on every user-owned table, and assert the
other can never reach it — through any endpoint, in any field.

`test_no_api_route_takes_a_path_parameter` is the important one to understand
before changing it. Every authenticated route derives identity from the bearer
token and takes no client-supplied ID, which is why there is no way to *ask*
for another user's row at all. Adding a route like `/support/tickets/{ref}`
breaks that property and that test will fail: the fix is an ownership check in
the handler, then adding the path to the allowlist below.
"""

import uuid
from datetime import datetime

import pytest
from sqlalchemy import select

pytestmark = pytest.mark.asyncio


# Seeded into every row Bob owns. If this string appears in a response to
# Alice, something leaked — regardless of which field carried it.
BOB_MARKER = "bob-private-marker-7k2x"

# Every authenticated read. A new user-scoped GET belongs in this list.
READ_ENDPOINTS = [
    "/api/v1/auth/me",
    "/api/v1/profile",
    "/api/v1/profile/history",
    "/api/v1/dashboard/sessions",
    "/api/v1/dashboard/stats",
    "/api/v1/support/tickets",
    "/api/v1/billing/status",
]


async def _sign_in(client, session_factory, label: str) -> dict:
    """Register, verify and log in a fresh account. Returns id + auth header."""
    from app.models.models import User

    email = f"{label}-{uuid.uuid4().hex[:8]}@example.com"
    password = "correct horse battery staple"

    resp = await client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": password, "name": label.title()},
    )
    assert resp.status_code == 202, resp.text

    async with session_factory() as session:
        user = await session.scalar(select(User).where(User.email == email))
        user.email_verified = True
        await session.commit()

    resp = await client.post(
        "/api/v1/auth/login", json={"email": email, "password": password}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()

    return {
        "id": uuid.UUID(body["user"]["id"]),
        "email": email,
        "password": password,
        "headers": {"Authorization": f"Bearer {body['access_token']}"},
    }


@pytest.fixture
def alice_and_bob(client, session_factory):
    """Two signed-in accounts, with every table Bob owns carrying the marker."""

    async def _build():
        from app.models.models import (
            Billing,
            CognitiveProfile,
            FeedbackLog,
            ProfileHistory,
            ReadingSession,
            SupportTicket,
        )

        alice = await _sign_in(client, session_factory, "alice")
        bob = await _sign_in(client, session_factory, "bob")

        async with session_factory() as session:
            # Registration already provisioned Bob's profile; mark it.
            profile = await session.scalar(
                select(CognitiveProfile).where(CognitiveProfile.user_id == bob["id"])
            )
            profile.notes = BOB_MARKER

            session.add(
                ProfileHistory(
                    user_id=bob["id"],
                    change_summary=f"Personal notes updated {BOB_MARKER}",
                    previous_state={"notes": ""},
                    new_state={"notes": BOB_MARKER},
                )
            )
            reading_session = ReadingSession(
                id=uuid.uuid4(),
                user_id=bob["id"],
                page_url=f"https://example.com/{BOB_MARKER}",
                page_title=f"Bob's page {BOB_MARKER}",
                cards_generated=7,
            )
            session.add(reading_session)
            session.add(
                FeedbackLog(
                    user_id=bob["id"],
                    session_id=reading_session.id,
                    reaction="clearer",
                    note=BOB_MARKER,
                    section_title=BOB_MARKER,
                )
            )
            session.add(
                SupportTicket(
                    id=uuid.uuid4(),
                    reference="SY-BOB123",
                    user_id=bob["id"],
                    email=bob["email"],
                    topic="billing",
                    subject=f"Bob's ticket {BOB_MARKER}",
                    message=BOB_MARKER,
                    status="open",
                )
            )

            # Bob pays; Alice does not. BillingOut carries no user id, so a
            # paid record is what makes the two responses distinguishable.
            bob_billing = await session.scalar(
                select(Billing).where(Billing.user_id == bob["id"])
            )
            bob_billing.plan = "premium"
            bob_billing.status = "active"
            bob_billing.stripe_customer_id = f"cus_{BOB_MARKER}"
            bob_billing.renews_at = datetime(2099, 1, 1)

            await session.commit()

        return alice, bob

    return _build


@pytest.mark.parametrize("endpoint", READ_ENDPOINTS)
async def test_read_endpoints_never_leak_another_users_data(
    client, alice_and_bob, endpoint
):
    """
    The blunt sweep: Bob's marker must not appear anywhere in Alice's response.

    Deliberately checks the raw body rather than named fields, so a leak
    through a field added later is still caught.
    """
    alice, _bob = await alice_and_bob()

    resp = await client.get(endpoint, headers=alice["headers"])
    assert resp.status_code == 200, resp.text
    assert BOB_MARKER not in resp.text, f"{endpoint} leaked another user's data"


async def test_reads_are_scoped_to_the_caller(client, alice_and_bob):
    """Alice sees her own empty collections, not Bob's populated ones.

    The sweep above proves the marker is absent; this proves the rows are too.
    A handler that returned an empty list unconditionally would pass the sweep.
    """
    alice, _bob = await alice_and_bob()
    h = alice["headers"]

    me = await client.get("/api/v1/auth/me", headers=h)
    assert me.json()["id"] == str(alice["id"])

    profile = await client.get("/api/v1/profile", headers=h)
    assert profile.json()["user_id"] == str(alice["id"])
    assert profile.json()["notes"] == ""

    history = await client.get("/api/v1/profile/history", headers=h)
    assert history.json()["total"] == 0
    assert history.json()["data"] == []

    sessions = await client.get("/api/v1/dashboard/sessions", headers=h)
    assert sessions.json()["total"] == 0
    assert sessions.json()["data"] == []

    tickets = await client.get("/api/v1/support/tickets", headers=h)
    assert tickets.json()["total"] == 0
    assert tickets.json()["data"] == []


async def test_dashboard_aggregates_exclude_other_users(client, alice_and_bob):
    """
    Aggregates are the easy place to drop a filter and not notice.

    Bob has one session worth 7 cards and one feedback row. Alice has none, so
    every counter must be zero — a missing `WHERE user_id` shows up here as
    Bob's numbers rather than as a visible record.
    """
    alice, _bob = await alice_and_bob()

    stats = (await client.get("/api/v1/dashboard/stats", headers=alice["headers"])).json()

    assert stats["cards_this_week"] == 0
    assert stats["cards_this_month"] == 0
    assert stats["pages_visited"] == 0
    assert stats["words_processed"] == 0
    assert stats["time_saved_minutes"] == 0
    assert stats["recent_sessions"] == []
    assert stats["feedback_breakdown"] == {}


async def test_writes_do_not_touch_another_users_rows(client, alice_and_bob, session_factory):
    """A PATCH scoped by a dropped filter would update every row in the table."""
    from app.models.models import CognitiveProfile, ProfileHistory

    alice, bob = await alice_and_bob()

    resp = await client.patch(
        "/api/v1/profile",
        headers=alice["headers"],
        json={"notes": "alice's notes", "chunk_size": "long"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["user_id"] == str(alice["id"])

    async with session_factory() as session:
        bob_profile = await session.scalar(
            select(CognitiveProfile).where(CognitiveProfile.user_id == bob["id"])
        )
        assert bob_profile.notes == BOB_MARKER, "Alice's update reached Bob's profile"
        assert bob_profile.chunk_size == "short"

        # The audit row must be attributed to the account that made the change.
        rows = (
            await session.scalars(
                select(ProfileHistory).where(ProfileHistory.user_id == alice["id"])
            )
        ).all()
        assert len(rows) == 1


async def test_submitted_feedback_is_attributed_to_the_caller(
    client, alice_and_bob, session_factory
):
    """Writes take their owner from the token, never from the request body."""
    from app.models.models import FeedbackLog

    alice, bob = await alice_and_bob()

    resp = await client.post(
        "/api/v1/feedback",
        headers=alice["headers"],
        json={"entries": [{"reaction": "clearer", "note": "alice's note"}]},
    )
    assert resp.status_code == 200, resp.text

    async with session_factory() as session:
        alice_rows = (
            await session.scalars(
                select(FeedbackLog).where(FeedbackLog.user_id == alice["id"])
            )
        ).all()
        bob_rows = (
            await session.scalars(
                select(FeedbackLog).where(FeedbackLog.user_id == bob["id"])
            )
        ).all()

    assert len(alice_rows) == 1
    assert alice_rows[0].note == "alice's note"
    assert len(bob_rows) == 1, "Bob's seeded feedback should be untouched"


async def test_billing_status_is_the_callers_own_record(client, alice_and_bob):
    """
    Billing reads resolve through the token, so two accounts see two records.

    Worth its own test because a dropped filter here does more than leak: the
    `scalar_one_or_none()` would hand Alice whichever billing row came back
    first, which could grant her Bob's paid entitlement.
    """
    alice, bob = await alice_and_bob()

    a = await client.get("/api/v1/billing/status", headers=alice["headers"])
    b = await client.get("/api/v1/billing/status", headers=bob["headers"])

    assert a.status_code == b.status_code == 200

    assert a.json()["plan"] == "free"
    assert a.json()["stripe_customer_id"] is None

    assert b.json()["plan"] == "premium"
    assert b.json()["stripe_customer_id"] == f"cus_{BOB_MARKER}"


@pytest.mark.parametrize("endpoint", READ_ENDPOINTS)
async def test_read_endpoints_reject_anonymous_callers(client, endpoint):
    """Without a token there is no identity to scope by, so there is no answer."""
    resp = await client.get(endpoint)
    assert resp.status_code in (401, 403), f"{endpoint} served an anonymous caller"


async def test_read_endpoints_reject_a_token_for_a_deleted_user(
    client, alice_and_bob, session_factory
):
    """
    A well-formed token whose subject no longer exists must not authenticate.

    The token stays cryptographically valid until it expires, so the check that
    matters is the user lookup in get_current_user — not the signature.
    """
    alice, bob = await alice_and_bob()

    # Deleted through the real endpoint rather than the ORM, so the test
    # exercises the cascade the application actually relies on.
    resp = await client.delete("/api/v1/auth/account", headers=alice["headers"])
    assert resp.status_code == 204, resp.text

    resp = await client.get("/api/v1/auth/me", headers=alice["headers"])
    assert resp.status_code == 401

    # And Bob, who shares every one of those tables, is still signed in.
    resp = await client.get("/api/v1/auth/me", headers=bob["headers"])
    assert resp.status_code == 200
    assert resp.json()["id"] == str(bob["id"])


async def test_no_api_route_takes_a_path_parameter():
    """
    Identity comes from the token, never from the URL.

    This is the structural reason the tests above hold: with no client-supplied
    ID on any API route, there is no way to reference another user's row. If
    you are adding a route that genuinely needs one — `/support/tickets/{ref}`,
    say — the handler must filter on `current_user.id` as well as the ID, and
    a test proving the cross-account request 404s belongs above. Then list the
    path here.
    """
    from app.main import app

    allowed: set[str] = set()

    offenders = [
        route.path
        for route in app.routes
        if getattr(route, "path", "").startswith("/api/")
        and "{" in getattr(route, "path", "")
        and route.path not in allowed
    ]

    assert not offenders, (
        "These API routes take an ID from the client and so must enforce "
        f"ownership explicitly: {offenders}. See this test's docstring."
    )
