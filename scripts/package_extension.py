"""
Build the Chrome Web Store upload: dist/synapse-extension-<version>.zip

    python scripts/package_extension.py

The zip holds extension/ as-is except for the manifest, which loses the
localhost origins in "externally_connectable". Those let a local dashboard
hand a session to an unpacked copy; a store install has no use for them, and
they would let any page served from localhost on a user's machine message it.

Nothing else differs between the two builds. Which API the extension talks to
is decided at runtime (extension/lib/config.js), so the code is not rewritten.
Uses only the standard library.
"""

from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXTENSION = ROOT / "extension"
DIST = ROOT / "dist"

# Never shipped: OS litter and source maps.
SKIP_NAMES = {".DS_Store", "Thumbs.db", "desktop.ini"}
SKIP_SUFFIXES = {".map"}

DEV_PREFIXES = ("http://localhost", "http://127.0.0.1")


def store_manifest() -> dict:
    manifest = json.loads((EXTENSION / "manifest.json").read_text(encoding="utf-8"))

    connectable = manifest.get("externally_connectable", {})
    matches = [m for m in connectable.get("matches", []) if not m.startswith(DEV_PREFIXES)]
    if not matches:
        sys.exit("externally_connectable has no production origins; the handoff would never work.")
    connectable["matches"] = matches

    # The store assigns the ID. A "key" here would either be rejected or pin
    # the store item to a developer's local key.
    manifest.pop("key", None)

    # Anything still pointing at localhost is a dev leftover worth stopping for.
    leftovers = [h for h in manifest.get("host_permissions", []) if h.startswith(DEV_PREFIXES)]
    if leftovers:
        sys.exit(f"host_permissions still lists dev hosts: {leftovers}")

    return manifest


def shipped_files() -> list[Path]:
    files = []
    for path in sorted(EXTENSION.rglob("*")):
        if not path.is_file() or path.name in SKIP_NAMES or path.suffix in SKIP_SUFFIXES:
            continue
        if path.name == "manifest.json" and path.parent == EXTENSION:
            continue  # written separately
        files.append(path)
    return files


def main() -> None:
    if not (EXTENSION / "lib" / "config.js").is_file():
        sys.exit("extension/lib/config.js is missing; the store build would not know its API.")

    manifest = store_manifest()
    files = shipped_files()

    DIST.mkdir(exist_ok=True)
    out = DIST / f"synapse-extension-{manifest['version']}.zip"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(manifest, indent=2) + "\n")
        for path in files:
            zf.write(path, path.relative_to(EXTENSION).as_posix())

    size_kb = out.stat().st_size / 1024
    print(f"Wrote {out.relative_to(ROOT)} ({len(files) + 1} files, {size_kb:,.0f} KB)")
    print(f"  version:               {manifest['version']}")
    print(f"  permissions:           {', '.join(manifest.get('permissions', []))}")
    print(f"  host_permissions:      {', '.join(manifest.get('host_permissions', []))}")
    print(f"  externally_connectable: {', '.join(manifest['externally_connectable']['matches'])}")


if __name__ == "__main__":
    main()
