import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { ENV_BACKUP, STATE_FILE, WEBPAGE_ENV, readState } from './paths.mjs';

const log = (msg) => console.log(`[teardown] ${msg}`);

function killTree(pid, label) {
  if (!pid) return;
  try {
    // /T kills the child processes uvicorn and vite spawn for their reloaders.
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    log(`Stopped ${label} (pid ${pid})`);
  } catch {
    log(`${label} (pid ${pid}) was already gone`);
  }
}

export default async function globalTeardown() {
  let state = {};
  try {
    state = readState();
  } catch {
    log('No state file — nothing to clean up.');
  }

  killTree(state.backendPid, 'backend');
  killTree(state.vitePid, 'vite');

  if (fs.existsSync(ENV_BACKUP)) {
    fs.copyFileSync(ENV_BACKUP, WEBPAGE_ENV);
    fs.rmSync(ENV_BACKUP);
    log('Restored webpage/.env');
  }

  if (fs.existsSync(STATE_FILE)) fs.rmSync(STATE_FILE);
}
