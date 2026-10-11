// Where the extension's API and dashboard live. The one place it decides.
//
// The Chrome Web Store adds `update_url` to the manifest of every store
// install; an unpacked (Load unpacked) copy has none. So a store install talks
// to production and a developer's unpacked copy talks to localhost, with no
// build step. Shared by the service worker (importScripts) and the popup.
(function (root) {
  const IS_DEV = !("update_url" in chrome.runtime.getManifest());

  const URLS = {
    dev: {
      backend: "http://localhost:8000",
      dashboard: "http://localhost:5173"
    },
    prod: {
      backend: "https://api.usesynapse.cv",
      dashboard: "https://usesynapse.cv"
    }
  };

  const env = IS_DEV ? URLS.dev : URLS.prod;

  root.SynapseConfig = Object.freeze({
    IS_DEV,
    BACKEND_URL: env.backend,
    DASHBOARD_URL: env.dashboard
  });
})(typeof self !== "undefined" ? self : window);
