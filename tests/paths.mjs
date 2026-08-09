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

export const BACKEND_URL = 'http://localhost:8000';
export const FRONTEND_URL = 'http://localhost:5173';

export function readState() {
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

export function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
