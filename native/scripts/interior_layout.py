#!/usr/bin/env python3
"""Deterministic, source-footprint floor planning with measured furniture.

This is an offline data compiler. It does not claim native playability or that
an inferred door/room/tenant was surveyed. Runtime consumes one floor at a time.
Requires Shapely 2.1.2; never silently repairs or substitutes invalid footprints.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import math
import os
from pathlib import Path

from shapely import constrained_delaunay_triangles, maximum_inscribed_circle
from shapely.affinity import rotate, translate
from shapely.geometry import Point, Polygon, box, mapping
from shapely.ops import unary_union

PROJECT = Path(__file__).resolve().parents[1]
WORKSPACE = Path(os.environ.get("TOKYO_WORKSPACE", str(PROJECT / "External"))).expanduser().resolve()
DATA = PROJECT / "Content/SourceData"
KIT = WORKSPACE / "outputs/tokyo-unreal-source-assets/InteriorKit/manifest.json"
OUT = DATA / "Interiors"
WALL = 0.18
RADIUS = 0.38  # 34 cm native capsule plus 4 cm layout margin.
GAP = 0.06


def item(asset, x=0, y=0, z=0, yaw=0):
    return {"asset": asset, "position": [x, y, z], "yaw": yaw}


# Furniture groups have realistic relationships and a clear approach. Their
# exact envelopes are computed from the release kit; no furniture is rescaled.
GROUPS = {
    "cafe_seating": [item("round_cafe_table"), item("dining_chair", -.98, 0, yaw=-90), item("dining_chair", .98, 0, yaw=90)],
    "dining": [item("dining_table"), item("dining_chair", -.47, .92, yaw=180), item("dining_chair", .47, .92, yaw=180)],
    "service_counter": [item("cafe_counter"), item("espresso_machine", -.55, 0, 1.045), item("cafe_service_set", .68, 0, 1.045)],
    "retail_rack": [item("retail_clothing_rack")],
    "retail_display": [item("apparel_display_table")],
    "retail_checkout": [item("checkout_counter")],
    "retail_shelf": [item("retail_wall_shelf")],
    "grocery": [item("grocery_shelf")],
    "books": [item("bookcase")],
    "lounge": [item("sofa_two_seat", 0, -.5), item("coffee_table", 0, 1.05)],
    "sleep": [item("low_double_bed", 0, -.28), item("bedside_table_lamp", 1.47, -.92)],
    "kitchen": [item("kitchen_counter_sink"), item("kitchen_cooktop", -.8, 0, .935), item("refrigerator", 2.34, 0)],
    "bathroom": [item("toilet", -.85, -.4), item("bathroom_vanity", .4, -.4), item("shower_set", 1.48, -.4)],
    "desk": [item("office_desk_computer"), item("office_chair", 0, .88, yaw=180)],
    "salon": [item("salon_station"), item("office_chair", 0, 1.0, yaw=180)],
    "clinic": [item("examination_bed"), item("office_chair", 1, 0, yaw=90)],
    "fitness": [item("gym_bench")],
    "laundry": [item("laundry_machine", -.5), item("laundry_machine", .5)],
    "vending": [item("vending_machine")],
    "plant": [item("indoor_plant")],
}

# Exactly the user's 24 types. Category-specific merchandise/equipment remains
# an explicit open requirement where the current kit does not supply it.
PROFILES = {
    "studio_apartment": (["sleep", "kitchen", "bathroom", "dining"], ["lounge", "desk"], []),
    "family_apartment": (["sleep", "sleep", "kitchen", "bathroom", "dining", "lounge"], ["desk", "books"], []),
    "detached_house": (["sleep", "kitchen", "bathroom", "dining", "lounge"], ["desk", "books"], []),
    "apartment_lobby": (["lounge"], ["plant", "vending"], ["mailboxes", "entry_access_panel"]),
    "office": (["desk"], ["desk", "books", "lounge"], []),
    "coworking": (["desk", "cafe_seating"], ["desk", "lounge", "books"], []),
    "convenience_store": (["grocery", "retail_checkout"], ["grocery", "vending"], ["refrigerated_retail_cases"]),
    "supermarket": (["grocery", "retail_checkout"], ["grocery"], ["fresh_produce", "refrigerated_retail_cases"]),
    "cafe": (["service_counter", "cafe_seating"], ["cafe_seating", "lounge", "plant"], []),
    "restaurant": (["kitchen", "dining"], ["dining"], ["commercial_cooking_equipment"]),
    "ramen_shop": (["kitchen", "dining"], ["dining"], ["ramen_counter", "noodle_cooking_equipment"]),
    "bakery": (["service_counter", "retail_shelf"], ["cafe_seating"], ["bakery_oven", "bread_display"]),
    "clothing_store": (["retail_rack", "retail_display", "retail_checkout"], ["retail_rack", "retail_shelf", "plant"], ["fitting_room"]),
    "shoe_store": (["retail_shelf", "retail_checkout", "lounge"], ["retail_shelf"], ["shoe_merchandise"]),
    "electronics_store": (["retail_display", "retail_checkout"], ["retail_shelf"], ["electronics_merchandise"]),
    "bookstore": (["books", "retail_checkout"], ["books", "cafe_seating"], []),
    "pharmacy": (["retail_shelf", "retail_checkout"], ["retail_shelf"], ["pharmacy_merchandise", "dispensing_counter"]),
    "salon": (["salon"], ["salon", "lounge"], ["wash_basin"]),
    "clinic": (["clinic", "desk"], ["lounge"], ["medical_storage"]),
    "gym": (["fitness"], ["fitness"], ["exercise_equipment"]),
    "hotel": (["sleep", "bathroom", "desk"], ["lounge"], ["guest_storage"]),
    "classroom": (["dining"], ["dining", "books"], ["teaching_board"]),
    "laundromat": (["laundry"], ["laundry", "lounge"], []),
    "workshop": (["books"], ["books"], ["workbench", "tools", "trade_equipment"]),
}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")
    temporary.replace(path)


def polygons(geometry):
    if geometry.is_empty:
        return []
    if geometry.geom_type == "Polygon":
        return [geometry]
    return [p for p in geometry.geoms if p.geom_type == "Polygon" and p.area > 1e-8]


def transform(poly, x, y, angle):
    return translate(rotate(poly, angle, origin=(0, 0)), x, y)


def point_transform(xy, x, y, angle):
    a = math.radians(angle)
    return [x + xy[0] * math.cos(a) - xy[1] * math.sin(a), y + xy[0] * math.sin(a) + xy[1] * math.cos(a)]


def assign_profile(building, floor):
    """Source type is retained separately; specificity is explicitly generated."""
    use = (building.get("usage") or {}).get("code")
    details = {d["code"] for d in building.get("detailedUsage", [])}
    area = building["footprintAreaSquareMeters"]
    h = int(digest([building["id"], floor])[:12], 16)
    retail = ["cafe", "clothing_store", "bookstore", "convenience_store", "restaurant", "salon", "bakery", "shoe_store", "electronics_store", "pharmacy", "ramen_shop", "laundromat"]
    if use in ("411", "412") or (use in ("413", "415") and floor > 0):
        return "detached_house" if use == "411" else ("studio_apartment" if area < 95 else "family_apartment")
    if use in ("401", "421"):
        return "office" if h % 5 else "coworking"
    if use == "403":
        return "hotel"
    if "1131" in details or "1132" in details:
        return "clinic"
    if "1121" in details:
        return "classroom"
    if "1251" in details:
        return "gym"
    if use in ("431", "452", "415"):
        return "workshop"
    if use in ("402", "413"):
        return retail[h % len(retail)]
    # Religion, cultural buildings, unknown uses and infrastructure must not be
    # mislabeled as factual shops merely to report total coverage.
    return None


def footprint(building):
    origin = [building["centroidCm"][0], building["centroidCm"][1], building["groundHeightMeters"] * 100]
    source = []
    for face in building["footprints"]:
        convert = lambda ring: [((p[0] - origin[0]) / 100, (p[1] - origin[1]) / 100) for p in ring]
        p = Polygon(convert(face["exterior"]), [convert(h) for h in face["holes"]])
        if not p.is_valid:
            raise ValueError("invalid-source-footprint")
        source.append(p)
    return origin, unary_union(source)


def group_geometry(name, assets):
    instances = GROUPS[name]
    solids = []
    max_z = 0
    for entry in instances:
        b = assets[entry["asset"]]["bounds"]
        lo, hi = b["min"], b["max"]
        p = box(lo[0], lo[2], hi[0], hi[2])
        solids.append(transform(p, *entry["position"][:2], entry["yaw"]))
        max_z = max(max_z, entry["position"][2] + hi[1])
    envelope = unary_union(solids)
    lo_x, lo_y, hi_x, hi_y = envelope.bounds
    # Reserve an approach to the whole group on its front, with width adequate
    # for the native capsule; a real concave floor stays concave in this check.
    reserve = box(lo_x - .06, lo_y - .06, hi_x + .06, hi_y + .9)
    access = [(lo_x + hi_x) / 2, hi_y + .48]
    return envelope, reserve, access, max_z


def wall_candidates(floor, reserve):
    lo_x, lo_y, hi_x, hi_y = reserve.bounds
    width = hi_x - lo_x
    candidates = []
    for component in polygons(floor):
        # Test both normals instead of assuming source ring orientation.
        for ring in [component.exterior, *component.interiors]:
            points = list(ring.coords)
            for a, b in zip(points, points[1:]):
                dx, dy = b[0] - a[0], b[1] - a[1]
                length = math.hypot(dx, dy)
                if length < width + .08:
                    continue
                angle = math.degrees(math.atan2(dy, dx))
                available = length - width - .08
                steps = max(1, int(available / 1.4) + 1)
                fractions = [(.5 if steps == 1 else i / (steps - 1)) for i in range(steps)]
                fractions.sort(key=lambda f: abs(f - .5))
                for side in [1, -1]:
                    yaw = angle if side == 1 else angle + 180
                    for fraction in fractions:
                        distance = width / 2 + .04 + available * fraction
                        point = [a[0] + dx * distance / length, a[1] + dy * distance / length]
                        offset = point_transform([-(lo_x + hi_x) / 2, -lo_y + .035], 0, 0, yaw)
                        candidates.append((point[0] + offset[0], point[1] + offset[1], yaw))
    return candidates


def island_candidates(floor, reserve, seed):
    # Source-aligned axis without a calipers division at repeated/collinear
    # vertices. This changes furniture orientation only, never the source ring.
    edges = []
    for component in polygons(floor):
        points = list(component.exterior.coords)
        edges += [(math.dist(a, b), a, b) for a, b in zip(points, points[1:]) if math.dist(a, b) > 1e-6]
    _, a, b = max(edges)
    angle = math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))
    aligned = rotate(floor, -angle, origin=(0, 0))
    lo_x, lo_y, hi_x, hi_y = aligned.bounds
    step_x = max(1.25, reserve.bounds[2] - reserve.bounds[0] + .85)
    step_y = max(1.25, reserve.bounds[3] - reserve.bounds[1] + .85)
    candidates = []
    for row in range(int((hi_y - lo_y) / step_y) + 1):
        for col in range(int((hi_x - lo_x) / step_x) + 1):
            x, y = point_transform([lo_x + (col + .5) * step_x, lo_y + (row + .5) * step_y], 0, 0, angle)
            candidates.append((x, y, angle))
    candidates.sort(key=lambda p: digest([seed, round(p[0], 4), round(p[1], 4)]))
    return candidates


def triangles(poly):
    result = []
    for t in constrained_delaunay_triangles(poly).geoms:
        points = [list(p) for p in list(t.exterior.coords)[:3]]
        a, b, c = points
        if (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) < 0:
            points.reverse()
        result.append(points)
    return result


def make_layout(building, assets, floor_number=0, profile_override=None, fill=True):
    profile = profile_override or assign_profile(building, floor_number)
    source_hash = digest(building)
    base = {"schemaVersion": 1, "buildingId": building["id"], "sourceBuildingId": building["buildingId"],
            "floor": floor_number, "sourceHash": source_hash, "sourceUsage": building.get("usage"),
            "sourceDetailedUsage": building.get("detailedUsage", []), "profile": profile,
            "provenance": {"layout": "procedural", "furnishings": "authored", "isSurveyedInterior": False,
                           "tenant": None, "typeAssignment": "inferred from source category" if not profile_override else "explicit archetype demonstration"},
            "runtimeVerified": False, "unresolved": [], "placements": [], "groups": []}
    if profile is None:
        base["unresolved"].append("source-use-needs-specialized-or-verified-interior")
        return base
    if profile not in PROFILES:
        raise ValueError(f"Unknown profile: {profile}")
    origin, source = footprint(building)
    usable = source.buffer(-WALL, join_style="mitre")
    if usable.is_empty or usable.area < 4:
        base["unresolved"].append("source-footprint-too-small-for-furnished-capsule-access")
        return base
    geometry_height = building["geometryHeightMeters"]
    count = building.get("storeysAboveGround") or max(1, math.floor(geometry_height / 3.0))
    if floor_number < 0 or floor_number >= count:
        raise ValueError("floor-outside-source-storey-count")
    pitch = geometry_height / count
    ceiling = min(3.6, pitch - .22)
    if ceiling < 2.25:
        base["unresolved"].append("source-storeys-and-geometry-leave-insufficient-clear-height")
        return base
    origin[2] += floor_number * pitch * 100
    walk = usable.buffer(-RADIUS, join_style="mitre")
    if walk.is_empty:
        base["unresolved"].append("source-footprint-has-no-capsule-clearance")
        return base
    if len(polygons(walk)) != 1:
        base["unresolved"].append("source-footprint-has-disconnected-capsule-clearance")
    main_walk = max(polygons(walk), key=lambda p: p.area)
    spawn = Point(maximum_inscribed_circle(main_walk, tolerance=.02).coords[0])
    # A future actual entrance may use a different seed. The central seed is
    # explicitly not presented as an entrance or a route through the exterior.
    seed_keepout = spawn.buffer(.85, quad_segs=12)
    occupied = Polygon()
    reservations = seed_keepout
    access_points = [spawn]
    seed = [building["id"], floor_number, profile]
    planned = []
    missing = []
    required, repeated, fixture_gaps = PROFILES[profile]
    base["unresolved"] += ["missing-specific-fixture:" + key for key in fixture_gaps]

    def place(name, required_group):
        nonlocal occupied, reservations, main_walk
        envelope, reserve, access, height = group_geometry(name, assets)
        if height + .04 > ceiling:
            return False
        perimeter = wall_candidates(usable, reserve)
        islands = island_candidates(usable, reserve, seed + [name, len(planned)])
        standalone = {"cafe_seating", "dining", "retail_rack", "retail_display", "desk", "fitness"}
        same_kind = sum(g["id"] == name for g in planned)
        candidates = islands + perimeter if name in standalone and same_kind % 3 != 2 else perimeter + islands
        for x, y, yaw in candidates:
            reserved = transform(reserve, x, y, yaw)
            if not usable.covers(reserved) or reserved.intersects(reservations):
                continue
            shape = transform(envelope, x, y, yaw)
            if occupied.intersects(shape.buffer(GAP, join_style="mitre")):
                continue
            probe = Point(point_transform(access, x, y, yaw))
            next_occupied = unary_union([occupied, shape])
            next_walk = walk.difference(next_occupied.buffer(RADIUS, join_style="round"))
            parts = [p for p in polygons(next_walk) if p.covers(spawn)]
            if not parts:
                continue
            component = parts[0]
            if not all(component.covers(p) for p in access_points + [probe]):
                continue
            # Prevent enclosing new pockets large enough to strand a player.
            lost = sum(p.area for p in polygons(next_walk) if not p.equals(component))
            initial_lost = walk.area - max(polygons(walk), key=lambda p: p.area).area
            if lost > initial_lost + .25:
                continue
            instances = []
            for entry in GROUPS[name]:
                px, py = point_transform(entry["position"][:2], x, y, yaw)
                instances.append({"asset": entry["asset"], "positionMeters": [round(px, 6), round(py, 6), entry["position"][2]],
                                  "yawDegrees": round((entry["yaw"] + yaw) % 360, 6), "scale": [1, 1, 1], "group": len(planned)})
            planned.append({"id": name, "required": required_group, "accessMeters": [probe.x, probe.y],
                            "reserve": mapping(reserved), "footprint": mapping(shape), "heightMeters": height})
            base["placements"] += instances
            occupied, reservations, main_walk = next_occupied, unary_union([reservations, reserved]), component
            access_points.append(probe)
            return True
        return False

    for name in required:
        if not place(name, True):
            missing.append(name)
    # This fills an actual floor, never a smaller invented rectangular room.
    # A density budget avoids overflowing a tiny floor or unbounded asset work.
    if fill:
        capacity = max(0, min(100, int(usable.area / 16)) - len(planned))
        # Keep the main fixture most common, but actually place the secondary
        # furniture that defines the room. Always trying index zero starved it.
        wheel = [repeated[0]] * 3 + repeated[1:] if repeated else []
        for repeat_index in range(capacity):
            success = False
            preferred = wheel[repeat_index % len(wheel)]
            options = [preferred] + [name for name in repeated if name != preferred]
            for name in options:
                if place(name, False):
                    success = True
                    break
            if not success:
                break
    if missing:
        base["unresolved"] += ["required-group-does-not-fit:" + name for name in missing]
    if profile in {"studio_apartment", "family_apartment", "detached_house", "hotel", "clinic", "salon"}:
        base["unresolved"].append("privacy-partitions-and-room-doors-pending")
    if count > 1:
        base["unresolved"].append("vertical-circulation-pending")
    if floor_number > 0:
        base["unresolved"].append("upper-floor-source-envelope-and-roof-clearance-unverified")
    if usable.area > 1600:
        base["unresolved"].append("large-floor-needs-furnishing-and-streaming-cells")
    base["unresolved"].append("street-entrance-and-native-collision-unverified")
    base.update({"originCm": origin, "localAxes": ["east", "south", "up"], "sourceFootprint": mapping(source),
                 "usableFootprint": mapping(usable), "floorTrianglesMeters": triangles(usable),
                 "floorAreaMeters2": usable.area, "wallThicknessMeters": WALL,
                 "ceilingHeightMeters": ceiling, "floorPitchMeters": pitch, "storeysAboveGround": count,
                 "storeyCountProvenance": "source" if building.get("storeysAboveGround") else "estimated from geometry height",
                 "spawnEyeMeters": [spawn.x, spawn.y, 1.7], "spawnProvenance": "geometric interior seed, not a surveyed door",
                 "groups": planned, "walkableCapsuleCentres": mapping(main_walk),
                 "horizontalFitChecked": True, "layoutComplete": not base["unresolved"],
                 "geometryHeightMeters": geometry_height, "sourceMeasuredHeightMeters": building.get("measuredHeightMeters")})
    base["layoutHash"] = digest(base)
    return base


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--building")
    parser.add_argument("--floor", type=int, default=0)
    parser.add_argument("--profile", choices=sorted(PROFILES))
    parser.add_argument("--limit", type=int)
    parser.add_argument("--out", type=Path, default=OUT)
    parser.add_argument("--demonstrate", action="store_true", help="Save one fitted example per archetype, retaining all unmet requirements")
    args = parser.parse_args()
    source = json.loads((DATA / "shibuya-buildings.json").read_text())
    kit = json.loads(KIT.read_text())
    assets = {a["id"]: a for a in kit["assets"]}
    buildings = sorted([b for b in source["buildings"] if b["intersectsSdkRegion"]], key=lambda b: b["id"])
    if args.building:
        buildings = [b for b in buildings if args.building in (b["id"], b["buildingId"])]
        if not buildings:
            raise ValueError("Unknown building")
    if args.limit:
        buildings = buildings[:args.limit]
    records, failures = [], Counter()
    jobs = [(b, args.profile) for b in buildings]
    if args.demonstrate:
        # Each type uses a source footprint with sufficient space. It is an
        # explicit layout demonstration, not a factual tenant assignment.
        suitable = [b for b in buildings if 150 < b["footprintAreaSquareMeters"] < 600 and
                    b["geometryHeightMeters"] / (b.get("storeysAboveGround") or 1) >= 2.95]
        if len(suitable) < len(PROFILES):
            raise ValueError("Insufficient source buildings for 24 demonstrations")
        jobs = list(zip(suitable[:len(PROFILES)], PROFILES))
    for n, (building, profile) in enumerate(jobs):
        layout = make_layout(building, assets, args.floor, profile)
        layout["kitHash"] = digest(kit)
        filename = f"{building['id']}/floor-{args.floor:03d}.json"
        if args.demonstrate:
            filename = f"demonstrations/{profile}.json"
        write_json(args.out / filename, layout)
        failures.update(layout["unresolved"])
        records.append({"buildingId": building["id"], "sourceBuildingId": building["buildingId"],
                        "profile": layout["profile"], "file": filename, "instances": len(layout["placements"]),
                        "fitChecked": layout.get("horizontalFitChecked", False), "unresolved": layout["unresolved"]})
        if n % 100 == 0:
            print(f"Floor plans {n + 1}/{len(jobs)}", flush=True)
    report = {"schemaVersion": 1, "mode": "archetype-demonstrations" if args.demonstrate else "source-use-ground-floor-plans",
              "sourceCatalogueHash": digest(source), "kitHash": digest(kit), "archetypes": list(PROFILES),
              "buildings": records, "unresolvedCounts": dict(failures), "runtimeVerified": False}
    write_json(args.out / ("demonstrations.json" if args.demonstrate else "index.json"), report)
    print(json.dumps({"floors": len(records), "fitChecked": sum(r["fitChecked"] for r in records), "unresolved": dict(failures)}, indent=2))


if __name__ == "__main__":
    main()
