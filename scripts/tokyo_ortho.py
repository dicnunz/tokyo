"""On-demand native 20 cm Tokyo ortho sheets -> lossless RGBA XYZ tiles.

Usage: python tokyo_ortho.py Z X Y OUTPUT [--cache-dir PATH] [--vendor PATH]
Install rasterio and mapbox-vector-tile into --vendor, or the active environment.
The server should queue tile requests; a shared flock semaphore additionally
limits all processes to two simultaneous upstream downloads. No region preload.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager, ExitStack
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import sys
import time
import urllib.error
import urllib.request
import uuid
import zipfile

ROOT = Path(__file__).resolve().parent.parent
SOURCES = json.loads(Path(__file__).with_name("tokyo-ortho-sources.json").read_text())
WORLD = 20037508.342789244
SIZE = SOURCES["output"]["tileSize"]
ARCHIVE = re.compile(r"https://gic-tokyo\.s3\.ap-northeast-1\.amazonaws\.com/2023/dig/ortho/([0-9]{2}[A-Z]{2}[0-9]{4})\.zip\Z")


def load_dependencies(vendor: Path | None = None):
    """Keep environment-specific binary packages outside the source tree."""
    candidates = [vendor, os.environ.get("TOKYO_ORTHO_VENDOR"), ROOT / "work/ortho-vendor"]
    for candidate in candidates:
        if candidate and Path(candidate).is_dir():
            sys.path.insert(0, str(candidate))
            break
    global np, rasterio, mvt, Image, box, shape, affine_transform
    import numpy as np
    import rasterio
    import mapbox_vector_tile as mvt
    from PIL import Image
    from shapely.geometry import box, shape
    from shapely.affinity import affine_transform


def tile_bounds(z: int, x: int, y: int):
    span = WORLD * 2 / (1 << z)
    return (-WORLD + x * span, WORLD - (y + 1) * span,
            -WORLD + (x + 1) * span, WORLD - y * span)


def geographic_bounds(bounds):
    left, bottom, right, top = bounds
    return (left / WORLD * 180, math.degrees(math.atan(math.sinh(bottom / WORLD * math.pi))),
            right / WORLD * 180, math.degrees(math.atan(math.sinh(top / WORLD * math.pi))))


def intersects(a, b):
    return a[0] < b[2] and a[2] > b[0] and a[1] < b[3] and a[3] > b[1]


@contextmanager
def file_lock(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


@contextmanager
def download_slot(cache: Path):
    """Cross-process cap, including unrelated source sheets and index requests."""
    folder = cache / "locks"
    folder.mkdir(parents=True, exist_ok=True)
    handles = [(folder / f"download-{i}.lock").open("a+b") for i in range(2)]
    acquired = None
    deadline = time.monotonic() + 120
    try:
        while acquired is None:
            for handle in handles:
                try:
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    acquired = handle
                    break
                except BlockingIOError:
                    pass
            if acquired is None:
                if time.monotonic() > deadline:
                    raise TimeoutError("Native ortho download queue timed out")
                time.sleep(0.04)
        yield
    finally:
        if acquired is not None:
            fcntl.flock(acquired, fcntl.LOCK_UN)
        for handle in handles:
            handle.close()


def atomic_write(path: Path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + "." + uuid.uuid4().hex + ".partial")
    try:
        temp.write_bytes(data)
        temp.replace(path)
    finally:
        temp.unlink(missing_ok=True)


def fetch_index(url: str, cache: Path):
    key = hashlib.sha256(url.encode()).hexdigest()[:24]
    path = cache / "index" / (key + ".pbf")
    missing = path.with_suffix(".missing")
    with file_lock(cache / "locks" / (key + ".lock")):
        if path.exists():
            return path.read_bytes()
        if missing.exists() and time.time() - missing.stat().st_mtime < 86400:
            return None
        try:
            with download_slot(cache), urllib.request.urlopen(url, timeout=30) as response:
                data = response.read(2_000_001)
            if len(data) > 2_000_000:
                raise ValueError("Ortho index exceeded its size limit")
        except urllib.error.HTTPError as error:
            if error.code == 404:
                atomic_write(missing, b"")
                return None
            raise
        atomic_write(path, data)
        return data


def select_index_sheets(data: bytes, iz: int, ix: int, iy: int, wanted):
    """MVT is y-down; use the real footprint, never the sheet name as geometry."""
    ib = tile_bounds(iz, ix, iy)
    selected = {}
    for layer in mvt.decode(data, default_options={"y_coord_down": True}).values():
        scale = (ib[2] - ib[0]) / layer["extent"]
        for feature in layer["features"]:
            url = feature.get("properties", {}).get("URL", "")
            match = ARCHIVE.fullmatch(url)
            if not match or not feature.get("geometry"):
                continue
            footprint = affine_transform(shape(feature["geometry"]), [scale, 0, 0, -scale, ib[0], ib[3]])
            if footprint.intersects(box(*wanted)):
                selected[match[1]] = url
    return selected


def find_sheets(z: int, x: int, y: int, cache: Path):
    bounds = tile_bounds(z, x, y)
    geo = geographic_bounds(bounds)
    # Two native pixels at a sheet/index edge keep bilinear interpolation seamless.
    pad = SOURCES["sourcePixelMeters"] * 2 / math.cos(math.radians((geo[1] + geo[3]) / 2))
    wanted = (bounds[0] - pad, bounds[1] - pad, bounds[2] + pad, bounds[3] + pad)
    sheets = {}
    for region in SOURCES["regions"]:
        if not intersects(geo, region["bounds"]):
            continue
        iz = region["indexZoom"]
        span = WORLD * 2 / (1 << iz)
        xmin, xmax = [int(math.floor((v + WORLD) / span)) for v in [wanted[0], wanted[2]]]
        ymin, ymax = [int(math.floor((WORLD - v) / span)) for v in [wanted[3], wanted[1]]]
        for ix in range(xmin, xmax + 1):
            for iy in range(ymin, ymax + 1):
                url = region["indexUrl"].format(z=iz, x=ix, y=iy)
                data = fetch_index(url, cache)
                if data:
                    sheets.update(select_index_sheets(data, iz, ix, iy, wanted))
    return sheets


def ensure_sheet(item, cache: Path):
    key, url = item
    if not ARCHIVE.fullmatch(url) or ARCHIVE.fullmatch(url)[1] != key:
        raise ValueError("Unexpected native ortho source URL")
    archive, target = cache / "sheets" / (key + ".zip"), cache / "sheets" / (key + ".tif")
    with file_lock(cache / "locks" / (key + ".lock")):
        if target.exists():
            return target
        archive.parent.mkdir(parents=True, exist_ok=True)
        if not archive.exists():
            temp = archive.with_suffix("." + uuid.uuid4().hex + ".partial")
            try:
                with download_slot(cache), urllib.request.urlopen(url, timeout=45) as response, temp.open("wb") as output:
                    size = 0
                    while chunk := response.read(1024 * 1024):
                        size += len(chunk)
                        if size > 128 * 1024 * 1024:
                            raise ValueError("Native ortho archive exceeded its size limit")
                        output.write(chunk)
                temp.replace(archive)
            finally:
                temp.unlink(missing_ok=True)
        temp = target.with_suffix("." + uuid.uuid4().hex + ".partial")
        try:
            with zipfile.ZipFile(archive) as zipped:
                members = [f for f in zipped.infolist() if Path(f.filename).name.lower() == key.lower() + ".tif"]
                if len(members) != 1 or members[0].file_size > 128 * 1024 * 1024:
                    raise ValueError("Unexpected native ortho TIFF member")
                with zipped.open(members[0]) as source, temp.open("wb") as output:
                    shutil.copyfileobj(source, output, 1024 * 1024)
            temp.replace(target)
        finally:
            temp.unlink(missing_ok=True)
    return target


def mosaic_tile(paths, bounds, size=SIZE):
    """Mosaic source pixels before reprojection, so sheet edges share the filter."""
    from rasterio.merge import merge
    from rasterio.transform import from_bounds
    from rasterio.warp import reproject, transform_bounds, Resampling

    destination = np.zeros((4, size, size), dtype=np.uint8)
    if not paths:
        return destination

    def copy_valid(merged, fresh, merged_mask, fresh_mask, **_):
        valid = ~np.any(np.broadcast_to(fresh_mask, fresh.shape), axis=0)
        use = valid & (merged[3] == 0)
        merged[:3, use] = np.asarray(fresh)[:, use]
        merged[3, use] = 255

    with ExitStack() as stack, rasterio.Env(GDAL_CACHEMAX=32_000_000, GDAL_NUM_THREADS="1"):
        sources = [stack.enter_context(rasterio.open(path)) for path in paths]
        for source in sources:
            if source.crs != rasterio.crs.CRS.from_epsg(6677) or source.count < 3:
                raise ValueError("Native ortho CRS or RGB bands do not match its declared source")
            if max(abs(abs(source.transform.a) - 0.2), abs(abs(source.transform.e) - 0.2)) > 1e-6:
                raise ValueError("Native ortho source is not a 20 cm raster")
        left, bottom, right, top = transform_bounds("EPSG:3857", sources[0].crs, *bounds, densify_pts=8)
        crop = (left - 0.8, bottom - 0.8, right + 0.8, top + 0.8)
        mosaic, transform = merge(sources, bounds=crop, res=(0.2, 0.2), indexes=[1, 2, 3],
                                  output_count=4, dtype="uint8", method=copy_valid,
                                  target_aligned_pixels=True, mem_limit=16)
        reproject(mosaic, destination, src_transform=transform, src_crs=sources[0].crs,
                  src_alpha=4, dst_alpha=4, dst_transform=from_bounds(*bounds, size, size),
                  dst_crs="EPSG:3857", resampling=Resampling.bilinear,
                  num_threads=1, warp_mem_limit=16)
    return destination


def generate(z: int, x: int, y: int, output: Path, cache: Path):
    if not (SOURCES["output"]["minzoom"] <= z <= SOURCES["output"]["maxzoom"] and 0 <= x < 1 << z and 0 <= y < 1 << z):
        raise ValueError("Expected a valid XYZ tile at zoom 18 through 22")
    started = time.monotonic()
    sheets = find_sheets(z, x, y, cache)
    if len(sheets) > 8:
        raise ValueError("Unexpectedly many source sheets for this tile")
    with ThreadPoolExecutor(max_workers=2) as pool:
        paths = list(pool.map(lambda item: ensure_sheet(item, cache), sorted(sheets.items())))
    pixels = mosaic_tile(paths, tile_bounds(z, x, y))
    output.parent.mkdir(parents=True, exist_ok=True)
    temp = output.with_name(output.name + "." + uuid.uuid4().hex + ".partial")
    try:
        Image.fromarray(pixels.transpose(1, 2, 0)).save(temp, format="PNG", compress_level=3)
        temp.replace(output)
    finally:
        temp.unlink(missing_ok=True)
    geo = geographic_bounds(tile_bounds(z, x, y))
    report = {"z": z, "x": x, "y": y, "size": SIZE, "coverage": float(np.count_nonzero(pixels[3]) / (SIZE * SIZE)),
              "sources": sorted(sheets), "sourcePixelMeters": 0.2,
              "outputPixelMeters": WORLD * 2 / (1 << z) / SIZE * math.cos(math.radians((geo[1] + geo[3]) / 2)),
              "bounds": list(geo), "attribution": SOURCES["attribution"],
              "publicationYear": 2023, "elapsedMs": round((time.monotonic() - started) * 1000, 1)}
    atomic_write(output.with_suffix(output.suffix + ".json"), json.dumps(report, ensure_ascii=False, indent=2).encode())
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("z", type=int, nargs="?")
    parser.add_argument("x", type=int, nargs="?")
    parser.add_argument("y", type=int, nargs="?")
    parser.add_argument("output", type=Path, nargs="?")
    parser.add_argument("--worker", action="store_true", help="Read newline-delimited tile requests from stdin")
    parser.add_argument("--cache-dir", type=Path, default=ROOT / ".cache/tokyo-ortho")
    parser.add_argument("--vendor", type=Path)
    args = parser.parse_args()
    load_dependencies(args.vendor)
    if args.worker:
        for line in sys.stdin:
            if not line.strip():
                continue
            request = {}
            try:
                request = json.loads(line)
                result = generate(request["z"], request["x"], request["y"],
                                  Path(request.get("output", request.get("outputPath"))), args.cache_dir)
                result["ok"] = True
            except Exception as error:
                result = {"ok": False, "error": str(error)}
                print(f"Tokyo ortho: {error}", file=sys.stderr, flush=True)
            if isinstance(request, dict) and "id" in request:
                result["id"] = request["id"]
            print(json.dumps(result, ensure_ascii=False), flush=True)
    else:
        if any(v is None for v in [args.z, args.x, args.y, args.output]):
            parser.error("Z X Y OUTPUT are required unless --worker is used")
        print(json.dumps(generate(args.z, args.x, args.y, args.output, args.cache_dir), ensure_ascii=False))


if __name__ == "__main__":
    main()
