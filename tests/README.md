# Extension Auth + Sync E2E

End-to-end check of the dashboard-to-extension session handoff and the extension-to-backend sync paths, driven by Playwright against bundled Chromium with the unpacked extension loaded.

```bash
npx playwright test --config=playwright.config.mjs
```

Nothing needs to be running first. `global-setup.mjs` handles the test environment:

1. Boots Chromium once to discover the unpacked extension ID. Chrome derives it from the install path, so it can only be read at runtime.
2. Writes that ID into `webpage/.env` as `VITE_EXTENSION_ID`, because Vite reads it at serve time and the dashboard cannot hand off a session without it. The original file is backed up and restored in teardown.
3. Creates `tests/.e2e.db`, a throwaway SQLite database, and seeds one already-verified account.
4. Starts `uvicorn` on port 8000 and Vite on port **3000**, then waits for both.

Ports 8000 and 3000 must be free. Setup fails loudly instead of testing against a server it does not control.

## What this suite is for

The browser-and-extension contract: session handoff, token refresh, profile sync, and sign-out. Anything provable without a browser belongs in `backend/tests/` instead, which is far faster and covers registration, email verification, password reset, refresh rotation, reuse detection and the OAuth state parameter.

```bash
cd backend && python -m pytest
```

## Notes

- **Nothing touches a shared or persistent database.** The suite used to register a real Supabase account on every run — `synapse.e2e.<timestamp>@example.com` — and leave user, profile, billing and feedback rows behind forever. It now seeds its own SQLite file and deletes it on the next run.
- **No mailbox required.** The seeded account is created already verified. Signup and the verification link are covered by `backend/tests/test_auth_flows.py`.
- **Vite runs on 3000, not 5173**, so your own dev server can keep running during a test run. Both origins are already in the extension manifest's `externally_connectable`, so the handoff works either way.
- The suite uses Playwright's bundled Chromium, not `channel: 'chrome'`. Chrome 137+ ignores `--load-extension` in official builds and would silently launch without the extension.
- The suite is serial and stateful. Each test builds on the session established by the previous one — so **one failure skips everything after it**. That is worth knowing: for a long time test 2 clicked `#backend-url` and `#save-provider-btn`, neither of which exists in `popup.html`, which meant tests 3-11 had not run at all.

## Known gap

The backend under test runs on SQLite, which ignores `SELECT ... FOR UPDATE`. Refresh rotation and reuse detection are therefore exercised for their *logic*, not for the row locking that makes them correct under genuine concurrency. Proving that needs a real Postgres — point `DATABASE_URL` at one in `global-setup.mjs` and run the migration instead of seeding, once a Postgres instance is available.
