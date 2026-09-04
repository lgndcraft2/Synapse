# Extension Auth + Sync E2E

End-to-end check of the dashboard-to-extension session handoff and the extension-to-backend sync paths, driven by Playwright against bundled Chromium with the unpacked extension loaded.

```bash
npx playwright test --config=playwright.config.mjs
```

Nothing needs to be running first. `global-setup.mjs` handles the test environment:

1. Boots Chromium once to discover the unpacked extension ID. Chrome derives it from the install path, so it can only be read at runtime.
2. Writes that ID into `webpage/.env` as `VITE_EXTENSION_ID`, because Vite reads it at serve time and the dashboard cannot hand off a session without it. The original file is backed up and restored in teardown.
3. Starts `uvicorn` on port 8000 and Vite on port 5173, then waits for both.

Both ports must be free. Setup fails loudly instead of testing against a server it does not control.

## Notes

- The suite uses Playwright's bundled Chromium, not `channel: 'chrome'`. Chrome 137+ ignores `--load-extension` in official builds and would silently launch without the extension.
- Every run signs up a new Supabase account such as `synapse.e2e.<timestamp>@example.com` and leaves user, profile, billing, and feedback rows behind. Prune them periodically.
- Supabase email confirmation must be off for the test project. If signup returns no session, there is nothing to hand off and the run fails with an explicit message.
- The suite is serial and stateful. Each test builds on the session established by the previous one.
