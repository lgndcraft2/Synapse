import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { launchExtension } from './extension.mjs';
import {
  BACKEND_DIR,
  BACKEND_URL,
  ENV_BACKUP,
  FRONTEND_URL,
  WEBPAGE_DIR,
  WEBPAGE_ENV,
  writeState,
} from './paths.mjs';

const log = (msg) => console.log(`[setup] ${msg}`);

async function isUp(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function waitUntilUp(url, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isUp(url)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label} never became reachable at ${url}`);
}

/**
 * Chrome derives an unpacked extension's ID from its install path, so we have to
 * boot the browser once to learn the ID before Vite starts: the dashboard reads
 * VITE_EXTENSION_ID at build/serve time and can't pick it up later.
 */
async function discoverExtensionId() {
  const { context, extensionId } = await launchExtension();
  await context.close();
  return extensionId;
}

function patchWebpageEnv(extensionId) {
  const original = fs.readFileSync(WEBPAGE_ENV, 'utf8');
  fs.writeFileSync(ENV_BACKUP, original);

  const match = original.match(/^VITE_EXTENSION_ID=(.*)$/m);
  if (!match) {
    throw new Error('Could not find a VITE_EXTENSION_ID line in webpage/.env');
  }

  fs.writeFileSync(
    WEBPAGE_ENV,
    original.replace(/^VITE_EXTENSION_ID=.*$/m, `VITE_EXTENSION_ID=${extensionId}`)
  );

  return match[1].trim();
}

function spawnServer(label, command, args, cwd, logFile) {
  const out = fs.openSync(logFile, 'w');
  const child = spawn(command, args, {
    cwd,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.unref();
  log(`${label} started (pid ${child.pid}), logging to ${path.basename(logFile)}`);
  return child.pid;
}

export default async function globalSetup() {
  if (await isUp(`${BACKEND_URL}/health`)) {
    throw new Error('Port 8000 is already in use — stop the running backend first.');
  }
  if (await isUp(FRONTEND_URL)) {
    throw new Error('Port 5173 is already in use — stop the running Vite server first.');
  }

  log('Booting Chrome once to discover the unpacked extension ID...');
  const extensionId = await discoverExtensionId();
  log(`Extension ID: ${extensionId}`);

  const previousExtensionId = patchWebpageEnv(extensionId);
  if (previousExtensionId === extensionId) {
    log('webpage/.env already carries the correct VITE_EXTENSION_ID — no patch needed.');
  } else {
    // Worth shouting about: the committed value is what real users' dashboards
    // ship with, and a wrong one makes the handoff a silent no-op.
    log(`WARNING: webpage/.env had VITE_EXTENSION_ID="${previousExtensionId}", expected "${extensionId}".`);
    log('WARNING: patched for this run only — the committed value would break the handoff.');
  }

  const backendPid = spawnServer(
    'backend',
    'python',
    ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000'],
    BACKEND_DIR,
    path.join(path.dirname(ENV_BACKUP), 'backend.log')
  );

  const vitePid = spawnServer(
    'vite',
    process.execPath,
    [path.join(WEBPAGE_DIR, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', '5173', '--strictPort'],
    WEBPAGE_DIR,
    path.join(path.dirname(ENV_BACKUP), 'vite.log')
  );

  writeState({ extensionId, previousExtensionId, backendPid, vitePid });

  await waitUntilUp(`${BACKEND_URL}/health`, 'Backend');
  log('Backend is up.');
  await waitUntilUp(FRONTEND_URL, 'Vite');
  log('Vite is up.');
}
