"""
Timezone-safe datetime comparison.

The models are a mix: columns are TIMESTAMP WITH TIME ZONE, but most Python
defaults are `datetime.utcnow`, which is naive. Postgres hands naive values
back as aware, so the mismatch stays hidden there — but comparing a naive
value to an aware one raises TypeError, and the auth paths compare stored
timestamps against "now" constantly (token expiry, family ceilings, password
change cut-offs).

Rather than depend on the driver's behaviour, every comparison goes through
`as_aware`. Naive values are read as UTC, which is what `utcnow` meant.
"""

from datetime import datetime, timezone


def now() -> datetime:
    """Aware UTC now."""
    return datetime.now(timezone.utc)


def as_aware(value: datetime | None) -> datetime | None:
    """
    Coerce a possibly-naive datetime to aware UTC.

    Naive input is interpreted as UTC rather than local time — every naive
    value in this codebase came from `datetime.utcnow`.
    """
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def is_past(value: datetime | None) -> bool:
    """True when `value` is non-null and already elapsed."""
    aware = as_aware(value)
    return aware is not None and aware <= now()
