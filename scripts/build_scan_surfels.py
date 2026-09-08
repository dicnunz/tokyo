"""Estimate oriented surface elements from the unchanged measured scan points.

Reference: Guennebaud and Paulin, Efficient Screen Space Approach for Hardware
Accelerated Surfel Rendering (2003), https://www.labri.fr/perso/guenneba/EwaSplattingOnGpu_vmv03.php
Normals are weighted local PCA of measured neighbours. Original position/RGB
tile files are read only. Sidecars contain int8 normal XYZ + uint8 radius in mm.
"""
import argparse
import concurrent.futures
import functools
import hashlib
import json
import os
import pathlib
import sys
import time

os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("OMP_NUM_THREADS", "1")
parser = argparse.ArgumentParser()
parser.add_argument("--dataset", type=pathlib.Path, required=True)
parser.add_argument("--vendor", type=pathlib.Path)
parser.add_argument("--workers", type=int, default=2)
args = parser.parse_args()
if args.vendor:
    sys.path.insert(0, str(args.vendor))
import numpy as np
from scipy.spatial import cKDTree

manifest_path = args.dataset / "manifest.json"
manifest = json.loads(manifest_path.read_text())
tiles = {tile["id"]: tile for tile in manifest["tiles"]}
records = np.dtype([("position", "<u2", 3), ("color", "u1", 3)])
sidecars = args.dataset / "surfels"
sidecars.mkdir(exist_ok=True)


@functools.lru_cache(maxsize=24)
def points(tile_id):
    tile = tiles[tile_id]
    data = np.fromfile(args.dataset / tile["url"], dtype=records)
    assert len(data) == tile["count"]
    return data["position"].astype(np.float64) * tile["scale"] + tile["offset"]


def build(tile_id):
    tile = tiles[tile_id]
    destination = sidecars / (tile_id + ".bin")
    if destination.exists() and destination.stat().st_size == tile["count"] * 4:
        return tile_id, tile["count"], "cached"
    original = points(tile_id)
    if len(original) < 3:
        encoded = np.zeros((len(original), 4), dtype=np.uint8)
        encoded[:, 2] = 127
        encoded[:, 3] = 12
    else:
        # The halo makes plane fitting continuous across storage tile borders.
        low, high = np.asarray(tile["offset"]) - .3, np.asarray(tile["offset"]) + tile["scale"] * 65535 + .3
        neighbours = [original]
        grid = np.rint(np.asarray(tile["offset"]) / (tile["scale"] * 65535)).astype(int)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for dz in (-1, 0, 1):
                    if dx == dy == dz == 0:
                        continue
                    other = "_".join(map(str, (grid + [dx, dy, dz]).tolist()))
                    if other not in tiles:
                        continue
                    data = points(other)
                    keep = np.all((data >= low) & (data <= high), axis=1)
                    if keep.any():
                        neighbours.append(data[keep])
        cloud = np.concatenate(neighbours)
        tree = cKDTree(cloud, leafsize=24)
        encoded = np.empty((len(original), 4), dtype=np.uint8)
        for start in range(0, len(original), 12000):
            batch = original[start:start + 12000]
            distances, indices = tree.query(batch, k=min(16, len(cloud)), workers=1)
            local = cloud[indices] - batch[:, None, :]
            support = np.maximum(distances[:, min(8, distances.shape[1] - 1)], .008)
            weights = np.exp(-np.minimum((distances / support[:, None]) ** 2, 30))
            weights[distances > .3] = 0
            weights /= np.maximum(weights.sum(axis=1, keepdims=True), 1e-8)
            mean = np.einsum("nk,nki->ni", weights, local)
            local -= mean[:, None, :]
            covariance = np.einsum("nk,nki,nkj->nij", weights, local, local)
            eigenvalues, eigenvectors = np.linalg.eigh(covariance)
            normals = eigenvectors[:, :, 0]
            # Render both sides; eigenvector sign has no effect on a surfel plane.
            curvature = eigenvalues[:, 0] / np.maximum(eigenvalues.sum(axis=1), 1e-10)
            radius = np.clip(support * .82, .015, .125)
            radius *= np.where(curvature > .12, .55, 1.)
            output = encoded[start:start + len(batch)]
            output[:, :3] = np.rint(normals * 127).astype(np.int8).view(np.uint8)
            output[:, 3] = np.rint(radius * 1000).clip(10, 125).astype(np.uint8)
    temporary = destination.with_suffix(".tmp")
    temporary.write_bytes(encoded.tobytes())
    temporary.replace(destination)
    return tile_id, tile["count"], "new"


def main():
    stamp = time.monotonic()
    starts = np.asarray([location["position"] for location in manifest["locations"]])
    def priority(tile_id):
        low, high = np.asarray(tiles[tile_id]["bounds"])
        distances = np.linalg.norm(np.maximum(np.maximum(low - starts, starts - high), 0), axis=1)
        return float(distances.min())
    ordered = sorted(tiles, key=priority)
    completed = total = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        for tile_id, count, state in pool.map(build, ordered):
            completed += 1
            total += count
            if completed % 20 == 0 or completed == len(tiles):
                print(json.dumps({"tiles": completed, "totalTiles": len(tiles), "points": total, "seconds": round(time.monotonic() - stamp, 1)}), flush=True)
    assert total == manifest["pointCount"]
    for tile in manifest["tiles"]:
        tile["surfelUrl"] = "surfels/" + tile["id"] + ".bin"
        assert (args.dataset / tile["surfelUrl"]).stat().st_size == tile["count"] * 4
    manifest["surfaceElements"] = {"encoding": "int8 normal XYZ + uint8 radius millimetres", "stride": 4, "method": "Weighted PCA of 16 measured neighbours, 0.3 m tile halo", "radiusMetres": [.01, .125], "sourcePositionsAndRGBChanged": False, "reference": "https://www.labri.fr/perso/guenneba/EwaSplattingOnGpu_vmv03.php"}
    temporary = manifest_path.with_suffix(".tmp")
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    temporary.replace(manifest_path)
    print(json.dumps({"done": True, "points": total, "bytes": total * 4, "seconds": round(time.monotonic() - stamp, 1)}), flush=True)


if __name__ == "__main__":
    main()
