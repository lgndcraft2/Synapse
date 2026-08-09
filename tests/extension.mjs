import { chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXTENSION_DIR } from './paths.mjs';

/**
 * Launches a throwaway Chrome profile with the unpacked extension loaded and
 * waits for its MV3 service worker.
 *
 * Uses Playwright's bundled Chromium on purpose: Chrome 137+ ignores
 * --load-extension in official builds, so `channel: 'chrome'` silently starts
 * a browser with no extension at all.
 */
export async function launchExtension() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-ext-'));

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent('serviceworker', { timeout: 30_000 }));

  return {
    context,
    worker,
    extensionId: new URL(worker.url()).host,
    userDataDir,
  };
}

/** Reads chrome.storage.local from inside the service worker. */
export function readStorage(worker, keys = null) {
  return worker.evaluate(
    (k) => new Promise((resolve) => chrome.storage.local.get(k, resolve)),
    keys
  );
}

/** Writes chrome.storage.local from inside the service worker. */
export function writeStorage(worker, values) {
  return worker.evaluate(
    (v) => new Promise((resolve) => chrome.storage.local.set(v, () => resolve(true))),
    values
  );
}

/** Polls chrome.storage.local until `predicate` holds or the timeout expires. */
export async function waitForStorage(worker, keys, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await readStorage(worker, keys);
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(
    `Timed out waiting for storage condition. Last value: ${JSON.stringify(last)}`
  );
}

/** Sends an internal runtime message from an extension page (not the worker). */
export function sendMessage(page, message) {
  return page.evaluate(
    (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve)),
    message
  );
}

/** Sends an external message the way the dashboard does, from a web page. */
export function sendExternalMessage(page, extensionId, message) {
  return page.evaluate(
    ([id, msg]) =>
      new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage(id, msg, (response) => {
            resolve(response ?? { __lastError: chrome.runtime.lastError?.message ?? null });
          });
        } catch (err) {
          resolve({ __threw: String(err) });
        }
      }),
    [extensionId, message]
  );
}
