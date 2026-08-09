kk# Extension auth + sync e2e

End-to-end check of the dashboard → extension session handoff and the
extension → backend sync paths, driven by Playwright against a real Chromium
with the unpacked extension loaded.

```bash
npx playwright test --config=playwright.config.mjs
```

Nothing needs to be running first — `global-setup.mjs` does the whole dance:

1. Boots Chromium once to learn the unpacked extension's ID (Chrome derives it
   from the install path, so it can only be read at runtime).
2. Writes that ID into `webpage/.env` as `VITE_EXTENSION_ID`, because Vite reads
   it at serve time and the dashboard can't hand off a session without it.
   The original file is backed up and restored in teardown.
3. Starts `uvicorn` on :8000 and Vite on :5173, then waits for both.

Both ports must be free — setup fails loudly rather than testing against a
server it doesn't control.

## Notes

- Uses Playwright's **bundled Chromium**, not `channel: 'chrome'`. Chrome 137+
  ignores `--load-extension` in official builds and would silently launch with
  no extension at all.
- Every run signs up a **new Supabase account** (`synapse.e2e.<timestamp>@example.com`)
  and leaves the user, profile, billing and feedback rows behind. Prune them
  periodically. This requires "Confirm email" to be **off** for the Supabase
  project — otherwise signup returns no session, there is nothing to hand off,
  and the run fails with an explicit message.
- The suite is serial and stateful: each test builds on the session the previous
  one established.
