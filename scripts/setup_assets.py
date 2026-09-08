"""Install the versioned public asset pack without overwriting an existing folder."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import stat
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def validate_members(archive: zipfile.ZipFile, expected: dict):
    files = []
    seen = set()
    for member in archive.infolist():
        path = PurePosixPath(member.filename)
        mode = member.external_attr >> 16
        if (path.is_absolute() or ".." in path.parts or "\\" in member.filename
                or not path.parts or path.parts[0] != "public"
                or stat.S_ISLNK(mode) or member.filename in seen):
            raise ValueError(f"Unsafe or duplicate asset path: {member.filename}")
        seen.add(member.filename)
        if not member.is_dir():
            files.append(member)
    if len(files) != expected["files"]:
        raise ValueError("Asset count differs from the release manifest")
    if sum(member.file_size for member in files) != expected["uncompressedBytes"]:
        raise ValueError("Asset size differs from the release manifest")
    return files


def install(archive_path: Path, expected: dict, root: Path = ROOT):
    if archive_path.stat().st_size != expected["bytes"] or digest(archive_path) != expected["sha256"]:
        raise ValueError("Asset archive checksum or size mismatch")
    public = root / "public"
    cache = root / ".cache"
    cache.mkdir(exist_ok=True)
    marker = cache / "assets-installed.json"
    if public.exists() or public.is_symlink():
        if marker.is_file() and not public.is_symlink():
            installed = json.loads(marker.read_text())
            if (installed.get("sha256") == expected["sha256"]
                    and len(installed.get("paths", [])) == expected["files"]
                    and all((root / path).is_file() for path in installed["paths"])):
                print("The release asset pack is already installed.")
                return
        raise ValueError("public/ already exists without a complete matching asset install. Move it aside before installing.")
    with zipfile.ZipFile(archive_path) as archive:
        members = validate_members(archive, expected)
        with tempfile.TemporaryDirectory(prefix="assets-", dir=cache) as temporary:
            stage = Path(temporary)
            for member in members:
                destination = stage / member.filename
                destination.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(member) as source, destination.open("wb") as target:
                    shutil.copyfileobj(source, target)
            (stage / "public").rename(public)
    marker.write_text(json.dumps({"sha256": expected["sha256"], "paths": [m.filename for m in members]}, indent=2))
    print(f"Installed {len(members):,} assets in public/.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, help="Use an already downloaded release ZIP")
    args = parser.parse_args()
    expected = json.loads((ROOT / "assets.json").read_text())
    archive = args.archive
    if archive is None:
        cache = ROOT / ".cache"
        cache.mkdir(exist_ok=True)
        archive = cache / f"tokyo-assets-{expected['version']}.zip"
        if not archive.is_file() or digest(archive) != expected["sha256"]:
            partial = archive.with_suffix(".partial")
            print(f"Downloading {expected['bytes'] / 1_000_000:.0f} MB of versioned assets…", flush=True)
            try:
                with urllib.request.urlopen(expected["url"], timeout=60) as response, partial.open("wb") as target:
                    total = 0
                    for chunk in iter(lambda: response.read(1024 * 1024), b""):
                        total += len(chunk)
                        if total > expected["bytes"]:
                            raise ValueError("Download exceeds the expected archive size")
                        target.write(chunk)
                if partial.stat().st_size != expected["bytes"] or digest(partial) != expected["sha256"]:
                    raise ValueError("Downloaded archive does not match the release checksum")
                partial.replace(archive)
            finally:
                partial.unlink(missing_ok=True)
    install(archive, expected)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        raise SystemExit(f"Asset setup failed: {error}") from error
