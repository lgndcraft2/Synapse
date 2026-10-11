"""
Build the production extension.

    python scripts/package_extension.py

Writes two copies of the same build:
  dist/synapse-extension-<version>.zip  the Chrome Web Store upload
  dist/synapse-extension/               the same files unzipped, for
                                        "Load unpacked" to test production

They hold extension/ as-is with two changes:
  - manifest.json loses the localhost origins in "externally_connectable".
    Those let a local dashboard hand a session to an unpacked copy; a
    production build has no use for them, and they would let any page served
    from localhost on a user's machine message it.
  - lib/config.js gets BUILD = "prod", so the build talks to the production
    API and dashboard even when loaded unpacked. Without it an unpacked copy
    counts as dev and sends you to localhost.

Uses only the standard library.
"""

from __future__ import annotations

import json
import shutil
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

CONFIG = "lib/config.js"
BUILD_LINE = "const BUILD = null;"


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


def prod_config() -> bytes:
    source = (EXTENSION / CONFIG).read_text(encoding="utf-8")
    if source.count(BUILD_LINE) != 1:
        sys.exit(f"extension/{CONFIG} must contain `{BUILD_LINE}` exactly once.")
    return source.replace(BUILD_LINE, 'const BUILD = "prod";').encode("utf-8")


def main() -> None:
    if not (EXTENSION / CONFIG).is_file():
        sys.exit(f"extension/{CONFIG} is missing; the build would not know its API.")

    manifest = store_manifest()
    contents: dict[str, bytes] = {
        "manifest.json": (json.dumps(manifest, indent=2) + "\n").encode("utf-8"),
    }
    for path in shipped_files():
        contents[path.relative_to(EXTENSION).as_posix()] = path.read_bytes()
    contents[CONFIG] = prod_config()

    DIST.mkdir(exist_ok=True)
    out = DIST / f"synapse-extension-{manifest['version']}.zip"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in contents.items():
            zf.writestr(name, data)

    # Same path every time, so Chrome keeps giving the unpacked copy one ID.
    unpacked = DIST / "synapse-extension"
    shutil.rmtree(unpacked, ignore_errors=True)
    for name, data in contents.items():
        target = unpacked / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    size_kb = out.stat().st_size / 1024
    print(f"Wrote {out.relative_to(ROOT)} ({len(contents)} files, {size_kb:,.0f} KB)")
    print(f"  and {unpacked.relative_to(ROOT)}{'/'} for Load unpacked")
    print(f"  version:               {manifest['version']}")
    print(f"  permissions:           {', '.join(manifest.get('permissions', []))}")
    print(f"  host_permissions:      {', '.join(manifest.get('host_permissions', []))}")
    print(f"  externally_connectable: {', '.join(manifest['externally_connectable']['matches'])}")


if __name__ == "__main__":
    main()
