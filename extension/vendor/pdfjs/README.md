# pdf.js (vendored)

Mozilla pdf.js, `pdfjs-dist` **5.7.284** (Apache-2.0, see `LICENSE` and `wasm/LICENSE_*`).
Used by the Synapse PDF viewer (`extension/viewer/`).

## What is here

| Path | From `pdfjs-dist` | Why |
|---|---|---|
| `pdf.min.mjs` | `build/pdf.min.mjs` | Main ES module (`getDocument`, `TextLayer`, `OutputScale`) |
| `pdf.worker.min.mjs` | `build/pdf.worker.min.mjs` | Parser/render worker |
| `cmaps/` | `cmaps/` | CJK and other non-embedded CMaps |
| `standard_fonts/` | `standard_fonts/` | Data for the 14 standard fonts when a PDF doesn't embed them |
| `wasm/*.wasm` | `wasm/` | JPX (OpenJPEG), JBIG2 and ICC colour (QCMS) decoders |
| `iccs/` | `iccs/` | CMYK ICC profile used by QCMS |

Not vendored: `web/pdf_viewer.*` (the viewer has its own lightweight page
renderer), source maps, `legacy/`, the scripting sandbox (`pdf.sandbox*`,
`quickjs-eval.*`, PDF JavaScript is disabled) and the `*_nowasm_fallback.js`
decoders. The text-layer CSS the viewer needs is copied into
`extension/viewer/viewer.css`.

## CSP

pdf.js 5.x uses no `eval`/`new Function`. Its optional decoders are
WebAssembly, so `extension_pages` CSP in `manifest.json` allows
`'wasm-unsafe-eval'` (the MV3 default; it permits compiling WebAssembly only,
not JS eval). Without it, JPX/JBIG2 images would not render.

## Updating

```sh
cd "$(mktemp -d)"
npm pack pdfjs-dist@<version> && tar -xzf pdfjs-dist-<version>.tgz
DST=<repo>/extension/vendor/pdfjs
cp package/build/pdf.min.mjs package/build/pdf.worker.min.mjs package/LICENSE "$DST"/
rm -rf "$DST/cmaps" "$DST/standard_fonts" && cp -r package/cmaps package/standard_fonts "$DST"/
cp package/wasm/jbig2.wasm package/wasm/openjpeg.wasm package/wasm/qcms_bg.wasm package/wasm/LICENSE_* "$DST/wasm/"
cp package/iccs/* "$DST/iccs/"
```

Then update the version above, diff `package/web/pdf_viewer.css`'s `.textLayer`
rules against `extension/viewer/viewer.css`, check `getDocument` options in
`extension/viewer/viewer.js`, and run the viewer tests
(`npx playwright test --config=tests/explain.config.mjs -g viewer`).
