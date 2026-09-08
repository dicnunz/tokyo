"""Offline geometry, transparency, seam and download-boundary regression checks."""
from pathlib import Path
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import tokyo_ortho as ortho

ortho.load_dependencies()
import numpy as np
import rasterio
from rasterio.transform import from_origin
from rasterio.warp import transform_bounds
import mapbox_vector_tile as mvt


class NativeOrthoTests(unittest.TestCase):
    def test_index_filters_footprints_and_decodes_y_down(self):
        def feature(name, coords):
            return {"geometry": {"type": "Polygon", "coordinates": [coords]},
                    "properties": {"URL": "https://gic-tokyo.s3.ap-northeast-1.amazonaws.com/2023/dig/ortho/" + name + ".zip"}}
        data = mvt.encode({"name": "sheets", "features": [
            feature("09LC2867", [[0, 0], [0, 2048], [2048, 2048], [2048, 0], [0, 0]]),
            feature("09LC2868", [[2048, 2048], [2048, 4096], [4096, 4096], [4096, 2048], [2048, 2048]])]},
            default_options={"y_coord_down": True})
        # NW quarter in projected space must choose the first MVT polygon.
        b = ortho.tile_bounds(16, 58133, 25811)
        wanted = (b[0] + 1, (b[1] + b[3]) / 2 + 1, (b[0] + b[2]) / 2 - 1, b[3] - 1)
        self.assertEqual(list(ortho.select_index_sheets(data, 16, 58133, 25811, wanted)), ["09LC2867"])

    def test_ogasawara_and_shibuya_have_no_network_requests_and_transparent_output(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(ortho, "fetch_index", side_effect=AssertionError("Outside coverage")):
            for x, y in [(469225, 221126), (465597, 206492)]:
                target = Path(folder) / f"{x}-{y}.png"
                report = ortho.generate(19, x, y, target, Path(folder) / "cache")
                self.assertEqual(report["coverage"], 0)
                self.assertEqual(report["sources"], [])
                self.assertEqual(np.asarray(ortho.Image.open(target))[..., 3].max(), 0)

    def test_sheet_boundary_matches_unsplit_source_and_preserves_black(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            # Source includes real black pixels and a sharp color change at the
            # sheet seam, which exposes per-sheet interpolation discontinuities.
            source = np.zeros((3, 96, 160), dtype=np.uint8)
            source[0] = np.arange(160, dtype=np.uint8)[None, :]
            source[1, :, 80:] = 240
            source[:, :8, :8] = 0
            transform = from_origin(-45200, -37500, 0.2, 0.2)
            def save(name, pixels, matrix):
                p = folder / name
                with rasterio.open(p, "w", driver="GTiff", width=pixels.shape[2], height=pixels.shape[1],
                                   count=3, dtype="uint8", crs="EPSG:6677", transform=matrix) as output:
                    output.write(pixels)
                return p
            full = save("full.tif", source, transform)
            west = save("west.tif", source[:, :, :80], transform)
            east = save("east.tif", source[:, :, 80:], from_origin(-45184, -37500, 0.2, 0.2))
            bounds = transform_bounds("EPSG:6677", "EPSG:3857", -45200, -37519.2, -45168, -37500)
            expected = ortho.mosaic_tile([full], bounds)
            actual = ortho.mosaic_tile([west, east], bounds)
            np.testing.assert_array_equal(actual, expected)
            self.assertGreater(np.count_nonzero((actual[:3] == 0).all(axis=0) & (actual[3] == 255)), 0)
            bigger = (bounds[0] - 30, bounds[1] - 30, bounds[2] + 30, bounds[3] + 30)
            alpha = ortho.mosaic_tile([full], bigger)[3]
            self.assertGreater(np.count_nonzero(alpha == 0), 1000)
            self.assertGreater(np.count_nonzero(alpha == 255), 1000)

    def test_shared_download_slots_limit_four_requesters_to_two(self):
        state = {"active": 0, "peak": 0}
        lock = threading.Lock()
        with tempfile.TemporaryDirectory() as folder:
            def request(_):
                with ortho.download_slot(Path(folder)):
                    with lock:
                        state["active"] += 1
                        state["peak"] = max(state["peak"], state["active"])
                    time.sleep(0.08)
                    with lock:
                        state["active"] -= 1
            with ThreadPoolExecutor(max_workers=4) as pool:
                list(pool.map(request, range(4)))
        self.assertEqual(state["peak"], 2)


if __name__ == "__main__":
    unittest.main()
