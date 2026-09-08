#!/usr/bin/env python3
"""Independent geometric acceptance checks on serialized floor data and kit bounds.

These prove only offline placement and data invariants. Doors, native collision,
real appearance and runtime performance require the packaged Unreal app.
"""
import argparse
from collections import Counter
import json
import math
import os
from pathlib import Path
import sys

from shapely.geometry import Point, Polygon, shape
from shapely.ops import unary_union

PROJECT = Path(__file__).resolve().parents[1]
WORKSPACE = Path(os.environ.get("TOKYO_WORKSPACE", str(PROJECT / "External"))).expanduser().resolve()


def transformed_bounds(entry, asset):
    lo, hi = asset["bounds"]["min"], asset["bounds"]["max"]
    a = entry["yawDegrees"] / 180 * math.pi
    c, s = math.cos(a), math.sin(a)
    x, y, z = entry["positionMeters"]
    return Polygon([(x + c * u - s * v, y + s * u + c * v)
                    for u, v in [(lo[0], lo[2]), (hi[0], lo[2]), (hi[0], hi[2]), (lo[0], hi[2])]]), z + lo[1], z + hi[1]


def inspect(layout, building, assets):
    errors = []
    if not layout.get("horizontalFitChecked"):
        return {"checked": False, "errors": [], "unresolved": layout["unresolved"]}
    origin = layout["originCm"]
    expected = unary_union([Polygon([((p[0] - origin[0]) / 100, (p[1] - origin[1]) / 100) for p in f["exterior"]],
                                       [[((p[0] - origin[0]) / 100, (p[1] - origin[1]) / 100) for p in h] for h in f["holes"]])
                            for f in building["footprints"]])
    source, floor = shape(layout["sourceFootprint"]), shape(layout["usableFootprint"])
    if source.symmetric_difference(expected).area > 1e-6:
        errors.append("source-footprint-changed")
    if floor.difference(expected).area > 1e-6:
        errors.append("floor-outside-source")
    if abs(origin[2] / 100 - building["groundHeightMeters"] - layout["floor"] * layout["floorPitchMeters"]) > 1e-7:
        errors.append("floor-height-shifted")
    triangle_polys = [Polygon(points) for points in layout["floorTrianglesMeters"]]
    covered = unary_union(triangle_polys)
    if covered.symmetric_difference(floor).area > 1e-6 or abs(sum(p.area for p in triangle_polys) - floor.area) > 1e-6:
        errors.append("floor-triangle-gap-overlap-or-filled-courtyard")
    solid_bounds = []
    group_solids = {}
    for n, entry in enumerate(layout["placements"]):
        if entry["asset"] not in assets:
            errors.append(f"missing-kit-asset:{n}")
            continue
        if entry["scale"] != [1, 1, 1]:
            errors.append(f"scaled-furniture:{n}")
        p, lo_z, hi_z = transformed_bounds(entry, assets[entry["asset"]])
        if p.difference(floor).area > 2e-5:
            errors.append(f"furniture-outside-floor:{n}")
        if lo_z < -1e-4 or hi_z > layout["ceilingHeightMeters"] + 1e-4:
            errors.append(f"furniture-height-clipping:{n}")
        group_solids.setdefault(entry["group"], []).append(p)
        solid_bounds.append((p, lo_z, hi_z, entry["group"]))
    # Group placement may intentionally put an appliance on its counter; that
    # should not conceal collisions between independently placed groups.
    for i, (p, low, high, group) in enumerate(solid_bounds):
        for j, (q, qlow, qhigh, other) in enumerate(solid_bounds[:i]):
            if group != other and min(high, qhigh) - max(low, qlow) > .001 and p.intersection(q).area > 1e-5:
                errors.append(f"group-collision:{i}:{j}")
    blocked = unary_union([p for p, _, _, _ in solid_bounds])
    walkable = floor.buffer(-.38, join_style="mitre").difference(blocked.buffer(.38))
    pieces = [walkable] if walkable.geom_type == "Polygon" else [p for p in walkable.geoms if p.geom_type == "Polygon"]
    spawn = Point(layout["spawnEyeMeters"][:2])
    reachable = next((p for p in pieces if p.covers(spawn)), None)
    if reachable is None:
        errors.append("spawn-blocked")
    for n, group in enumerate(layout["groups"]):
        if reachable is None or not reachable.buffer(1e-5).covers(Point(group["accessMeters"])):
            errors.append(f"unreachable-group:{n}")
        actual = unary_union(group_solids.get(n, []))
        if actual.symmetric_difference(shape(group["footprint"])).area > 2e-4:
            errors.append(f"serialized-envelope-disagrees-with-kit:{n}")
    if layout["provenance"]["isSurveyedInterior"] or layout["runtimeVerified"]:
        errors.append("unsupported-runtime-or-survey-claim")
    if layout["unresolved"] and layout["layoutComplete"]:
        errors.append("incomplete-layout-marked-complete")
    return {"checked": True, "errors": sorted(set(errors)), "instances": len(solid_bounds), "groups": len(group_solids),
            "unresolved": layout["unresolved"]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=PROJECT / "Content/SourceData/Interiors")
    parser.add_argument("--out", type=Path, default=WORKSPACE / "work/unreal-migration/interior-layout/verification.json")
    args = parser.parse_args()
    source = json.loads((PROJECT / "Content/SourceData/shibuya-buildings.json").read_text())
    buildings = {b["id"]: b for b in source["buildings"]}
    kit = json.loads((WORKSPACE / "outputs/tokyo-unreal-source-assets/InteriorKit/manifest.json").read_text())
    assets = {a["id"]: a for a in kit["assets"]}
    reports, failures, unresolved = [], Counter(), Counter()
    for p in sorted(args.root.rglob("*.json")):
        data = json.loads(p.read_text())
        if "placements" not in data:
            continue
        result = inspect(data, buildings[data["buildingId"]], assets)
        reports.append({"file": str(p.relative_to(args.root)), **result})
        failures.update(result["errors"])
        unresolved.update(result["unresolved"])
    result = {"schemaVersion": 1, "plans": len(reports), "checked": sum(r["checked"] for r in reports),
              "geometryFailures": dict(failures), "unresolved": dict(unresolved), "results": reports,
              "nativeVerified": False, "allInteriorsComplete": False}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({k: v for k, v in result.items() if k != "results"}, indent=2))
    return int(bool(failures))


if __name__ == "__main__":
    sys.exit(main())
