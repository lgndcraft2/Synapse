import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(TESTS_DIR, '..');
export const WEBPAGE_DIR = path.join(ROOT, 'webpage');
export const BACKEND_DIR = path.join(ROOT, 'backend');

// The unpacked extension lives at the repo root (manifest.json is there).
export const EXTENSION_DIR = ROOT;

export const WEBPAGE_ENV = path.join(WEBPAGE_DIR, '.env');
export const ENV_BACKUP = path.join(TESTS_DIR, '.env.backup');
export const STATE_FILE = path.join(TESTS_DIR, '.state.json');

// A throwaway SQLite database, recreated on every run. The suite used to
// sign up a real Supabase account per run and leak it; nothing now touches a
// shared or persistent database.
export const E2E_DB = path.join(TESTS_DIR, '.e2e.db');

export const BACKEND_URL = 'http://localhost:8000';
// 3000 rather than Vite's default 5173, so a developer's own dev server can
// keep running while the suite does. Both origins are already listed in the
// extension manifest's externally_connectable, so the handoff works either way.
export const FRONTEND_PORT = '3000';
export const FRONTEND_URL = `http://localhost:${FRONTEND_PORT}`;

export function readState() {
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

export function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
