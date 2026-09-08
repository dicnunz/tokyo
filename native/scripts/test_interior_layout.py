"""Adversarial geometry checks for the offline interior compiler."""
import copy
import json
from pathlib import Path
import unittest

from interior_layout import KIT, PROFILES, assign_profile, make_layout
from verify_interior_layout import inspect


def source(exterior, holes=(), height=3.5, floors=1, use="401"):
    return {"id": "test-stable-source", "buildingId": "test-fixture", "centroidCm": [23000, -41000, 2700],
            "groundHeightMeters": 27, "geometryHeightMeters": height, "measuredHeightMeters": height,
            "storeysAboveGround": floors, "usage": {"code": use, "label": "test source"}, "detailedUsage": [],
            "footprintAreaSquareMeters": 200,
            "footprints": [{"exterior": [[x * 100 + 23000, y * 100 - 41000, 2700] for x, y in exterior],
                            "holes": [[[x * 100 + 23000, y * 100 - 41000, 2700] for x, y in ring] for ring in holes]}]}


class LayoutTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.assets = {a["id"]: a for a in json.loads(KIT.read_text())["assets"]}

    def test_courtyard_hole_and_concave_source_survive(self):
        b = source([(0, 0), (24, 0), (24, 20), (14, 20), (14, 16), (0, 16), (0, 0)],
                   [[(8, 6), (8, 12), (14, 12), (14, 6), (8, 6)]])
        result = make_layout(b, self.assets, profile_override="office")
        self.assertTrue(result["horizontalFitChecked"])
        self.assertEqual(inspect(result, b, self.assets)["errors"], [])
        self.assertEqual(len(result["sourceFootprint"]["coordinates"]), 2)

    def test_thin_source_is_reported_without_rescaling(self):
        b = source([(0, 0), (10, 0), (10, .6), (0, .6), (0, 0)])
        result = make_layout(b, self.assets, profile_override="office")
        self.assertFalse(result.get("horizontalFitChecked", False))
        self.assertTrue(result["unresolved"])
        self.assertEqual(result["placements"], [])

    def test_conflicting_storeys_do_not_stretch_source_height(self):
        b = source([(0, 0), (15, 0), (15, 12), (0, 12), (0, 0)], height=10, floors=6)
        result = make_layout(b, self.assets, profile_override="office")
        self.assertIn("source-storeys-and-geometry-leave-insufficient-clear-height", result["unresolved"])
        self.assertEqual(b["geometryHeightMeters"], 10)

    def test_same_building_floor_reproduces_identical_layout(self):
        b = source([(0, 0), (18, 0), (18, 14), (0, 14), (0, 0)])
        first = make_layout(b, self.assets, profile_override="cafe")
        second = make_layout(b, self.assets, profile_override="cafe")
        self.assertEqual(first, second)
        self.assertGreater(len({g["id"] for g in first["groups"]}), 2)

    def test_mixed_residential_source_remains_residential_upstairs(self):
        b = source([(0, 0), (12, 0), (12, 12), (0, 12), (0, 0)], use="413")
        self.assertEqual(assign_profile(b, 1), "family_apartment")
        self.assertIn(assign_profile(b, 0), PROFILES)

    def test_unknown_use_is_not_claimed_as_a_business(self):
        b = source([(0, 0), (12, 0), (12, 12), (0, 12), (0, 0)], use="461")
        result = make_layout(b, self.assets)
        self.assertIsNone(result["profile"])
        self.assertIsNone(result["provenance"]["tenant"])

    def test_independent_validator_detects_corrupted_placement(self):
        b = source([(0, 0), (16, 0), (16, 14), (0, 14), (0, 0)])
        result = make_layout(b, self.assets, profile_override="office")
        self.assertEqual(inspect(result, b, self.assets)["errors"], [])
        bad = copy.deepcopy(result)
        bad["placements"][0]["positionMeters"][0] += 100
        self.assertTrue(any(e.startswith("furniture-outside-floor") for e in inspect(bad, b, self.assets)["errors"]))

    def test_independent_validator_detects_overlapping_floor_triangles(self):
        b = source([(0, 0), (16, 0), (16, 14), (0, 14), (0, 0)])
        result = make_layout(b, self.assets, profile_override="office")
        result["floorTrianglesMeters"].append(result["floorTrianglesMeters"][0])
        self.assertIn("floor-triangle-gap-overlap-or-filled-courtyard", inspect(result, b, self.assets)["errors"])


if __name__ == "__main__":
    unittest.main()
