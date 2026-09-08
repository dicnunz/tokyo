"""Prepare and import the measured Tokyo kit in the UE 5.8 editor.

Ordinary Python: import_interior_kit.py --prepare-only
Unreal Python:   import import_interior_kit; import_interior_kit.run()

Preparation never fabricates Unreal object paths. Native import publishes a registry
only after all expected meshes/materials/textures exist and their packages save.
The registry records cook/render verification separately from editor import.
See native/README.md for external asset requirements.
"""

import argparse
import copy
import hashlib
import itertools
import json
import math
import os
from pathlib import Path
import re
import struct
import tempfile
import traceback
from urllib.parse import unquote, urlparse


PROJECT = Path(__file__).resolve().parents[2]
WORKSPACE = Path(os.environ.get("TOKYO_WORKSPACE", str(PROJECT / "External"))).expanduser().resolve()
DEFAULT_MANIFEST = WORKSPACE / "outputs/tokyo-unreal-source-assets/InteriorKit/manifest.json"
DEFAULT_WORK = WORKSPACE / "work/unreal-migration/interior-kit-import"
DEFAULT_REGISTRY = PROJECT / "Content/Tokyo/Data/interior-kit-registry.json"
RECIPE_VERSION = 1
COMPONENTS = {5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2),
              5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4)}
WIDTHS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}
IDENTITY = [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = (json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n").encode()
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def local_uri(parent, uri, root):
    parsed = urlparse(uri)
    require(not parsed.scheme and not parsed.netloc and not parsed.query and not parsed.fragment,
            "Only local source files are supported: " + uri)
    path = (parent / unquote(parsed.path)).resolve()
    require(path.is_relative_to(root.resolve()), "Source URI escapes the kit: " + uri)
    require(path.is_file(), "Missing source file: " + str(path))
    return path


def read_accessor(document, buffers, index, normalized=True):
    accessor = document["accessors"][index]
    require("sparse" not in accessor, "Sparse accessors need an explicit preservation implementation")
    require(accessor["type"] in WIDTHS, "Unsupported accessor shape")
    require(accessor["componentType"] in COMPONENTS, "Unsupported component type")
    view = document["bufferViews"][accessor["bufferView"]]
    code, size = COMPONENTS[accessor["componentType"]]
    width = WIDTHS[accessor["type"]]
    stride = view.get("byteStride", size * width)
    start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    count = accessor["count"]
    data = buffers[view["buffer"]]
    end = start + (count - 1) * stride + size * width if count else start
    require(count > 0 and stride >= size * width and start >= 0,
            "Invalid accessor layout")
    require(end <= len(data) and end <= view.get("byteOffset", 0) + view["byteLength"],
            "Accessor exceeds source buffer view")
    unpack = struct.Struct("<" + code * width).unpack_from
    result = [unpack(data, start + item * stride) for item in range(count)]
    require(all(math.isfinite(value) for row in result for value in row), "Nonfinite vertex data")
    if normalized and accessor.get("normalized"):
        divisors = {5120: 127, 5121: 255, 5122: 32767, 5123: 65535}
        require(accessor["componentType"] in divisors, "Invalid normalized component type")
        divisor = divisors[accessor["componentType"]]
        result = [tuple(max(-1., value / divisor) for value in row) for row in result]
    return result


def multiply(a, b):
    """Row-major matrices acting on column vectors, independent of UE matrix storage."""
    return [sum(a[row * 4 + k] * b[k * 4 + column] for k in range(4))
            for row in range(4) for column in range(4)]


def transform_point(matrix, point):
    return [sum(matrix[row * 4 + k] * point[k] for k in range(3)) + matrix[row * 4 + 3]
            for row in range(3)]


def node_matrix(node):
    if "matrix" in node:
        require(not any(key in node for key in ("translation", "rotation", "scale")),
                "A glTF node cannot contain both matrix and TRS")
        require(len(node["matrix"]) == 16, "Invalid node matrix")
        result = [node["matrix"][column * 4 + row] for row in range(4) for column in range(4)]
    else:
        x, y, z, w = node.get("rotation", [0, 0, 0, 1])
        require(abs(x*x + y*y + z*z + w*w - 1) < 1e-5, "Non-unit node quaternion")
        sx, sy, sz = node.get("scale", [1, 1, 1])
        tx, ty, tz = node.get("translation", [0, 0, 0])
        result = [(1-2*y*y-2*z*z)*sx, (2*x*y-2*z*w)*sy, (2*x*z+2*y*w)*sz, tx,
                  (2*x*y+2*z*w)*sx, (1-2*x*x-2*z*z)*sy, (2*y*z-2*x*w)*sz, ty,
                  (2*x*z-2*y*w)*sx, (2*y*z+2*x*w)*sy, (1-2*x*x-2*y*y)*sz, tz,
                  0., 0., 0., 1.]
    require(all(math.isfinite(value) for value in result), "Nonfinite node transform")
    require(all(abs(result[12+i] - IDENTITY[12+i]) < 1e-8 for i in range(4)),
            "A node transform must be affine")
    return result


def scene_components(document):
    nodes = document.get("nodes", [])
    require(len(document.get("scenes", [])) == 1, "The kit must have one explicit scene per assembly")
    roots = document["scenes"][document.get("scene", 0)].get("nodes", [])
    result, visited = [], set()

    def visit(index, parent_matrix, ancestors):
        require(0 <= index < len(nodes) and index not in ancestors, "Invalid/cyclic source hierarchy")
        require(index not in visited, "A glTF node cannot have multiple parents")
        visited.add(index)
        node = nodes[index]
        world = multiply(parent_matrix, node_matrix(node))
        if "mesh" in node:
            result.append({"sourceNodeIndex": index, "sourceNodeName": node.get("name", ""),
                           "sourceMeshIndex": node["mesh"], "sourceWorldMatrix": world})
        for child in node.get("children", []):
            visit(child, world, ancestors | {index})

    for root in roots:
        visit(root, IDENTITY, set())
    require(len(visited) == len(nodes), "Unused source nodes would be silently omitted")
    return result, roots


def bounds(points):
    points = list(points)
    require(bool(points), "Empty geometry")
    return {"min": [min(point[axis] for point in points) for axis in range(3)],
            "max": [max(point[axis] for point in points) for axis in range(3)]}


def transform_bounds(source, matrix):
    return bounds(transform_point(matrix, point) for point in itertools.product(
        *[(source["min"][axis], source["max"][axis]) for axis in range(3)]))


def image_dimensions(data):
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return list(struct.unpack_from(">II", data, 16))
    require(data.startswith(b"\xff\xd8"), "The kit importer supports original PNG/JPEG images")
    cursor = 2
    while cursor < len(data):
        require(data[cursor] == 255, "Malformed JPEG marker")
        while cursor < len(data) and data[cursor] == 255:
            cursor += 1
        marker = data[cursor]
        cursor += 1
        if marker in {0xD8, 0xD9} or 0xD0 <= marker <= 0xD7:
            continue
        size = struct.unpack_from(">H", data, cursor)[0]
        require(size >= 2, "Malformed JPEG segment")
        if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}:
            height, width = struct.unpack_from(">HH", data, cursor + 3)
            return [width, height]
        cursor += size
    raise ValueError("JPEG dimensions not found")


def remap_material(value, texture_map, key=""):
    if isinstance(value, list):
        return [remap_material(item, texture_map, key) for item in value]
    if not isinstance(value, dict):
        return value
    result = {name: remap_material(item, texture_map, name) for name, item in value.items()}
    if key.endswith("Texture") and "index" in result:
        result["index"] = texture_map[result["index"]]
    return result


def prepare(manifest_path=DEFAULT_MANIFEST, work_dir=DEFAULT_WORK):
    """Pure stdlib source validation and lossless binary/image staging."""
    manifest_path, work_dir = Path(manifest_path).resolve(), Path(work_dir).resolve()
    root = manifest_path.parent
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    require(manifest.get("units") == "metres" and manifest.get("upAxis") == "Y", "Unexpected source units/axes")
    ids = [asset["id"] for asset in manifest["assets"]]
    require(len(ids) == len(set(ids)) and all(re.fullmatch(r"[a-z][a-z0-9_]*", item) for item in ids),
            "Kit IDs must be unique stable identifiers")
    prepared = work_dir / "prepared"
    prepared.mkdir(parents=True, exist_ok=True)
    gltf = {"asset": {"version": "2.0", "generator": "Tokyo kit import preparation v1"},
            "scene": 0, "scenes": [{"nodes": []}],
            **{key: [] for key in ("nodes", "meshes", "materials", "textures", "samplers", "images",
                                  "buffers", "bufferViews", "accessors")}}
    plan = {"schemaVersion": 1, "recipeVersion": RECIPE_VERSION, "state": "prepared",
            "nativeImportVerified": False, "nativeRenderingVerified": False, "cookVerified": False,
            "manifestSHA256": digest(manifest_bytes), "recipeSHA256": digest(Path(__file__).read_bytes()),
            "sourceManifest": str(manifest_path),
            "sourceMetadata": {key: value for key, value in manifest.items() if key != "assets"},
            "sourceFiles": {}, "assets": {}, "meshes": {}, "images": [], "materials": [],
            "matrixConvention": "row-major matrices acting on column vectors"}
    lookup = {key: {} for key in ("images", "textures", "samplers", "materials")}
    extra = bytearray()
    # Reserve one auxiliary buffer; all original buffer views keep their original bytes.
    gltf["buffers"].append({"uri": "Buffers/auxiliary.bin", "byteLength": 0})

    def stage(path, folder):
        data = path.read_bytes()
        sha = digest(data)
        relative = str(path.relative_to(root))
        prefix = "T_" if folder == "Textures" else "B_"
        uri = folder + "/" + prefix + sha + path.suffix.lower()
        target = prepared / uri
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists() or digest(target.read_bytes()) != sha:
            target.write_bytes(data)
        plan["sourceFiles"][relative] = {"sha256": sha, "bytes": len(data), "preparedURI": uri}
        return data, uri, sha

    def intern(table, value):
        key = canonical(value)
        if key not in lookup[table]:
            lookup[table][key] = len(gltf[table])
            gltf[table].append(value)
        return lookup[table][key]

    def append_float_accessor(values, shape):
        while len(extra) % 4:
            extra.append(0)
        offset = len(extra)
        width = WIDTHS[shape]
        for row in values:
            extra.extend(struct.pack("<" + "f" * width, *row))
        view_index = len(gltf["bufferViews"])
        gltf["bufferViews"].append({"buffer": 0, "byteOffset": offset, "byteLength": len(extra)-offset,
                                    "target": 34962})
        accessor_index = len(gltf["accessors"])
        accessor = {"bufferView": view_index, "componentType": 5126, "count": len(values), "type": shape}
        if shape == "VEC3":
            accessor.update(bounds(values))
        gltf["accessors"].append(accessor)
        return accessor_index

    extensions_used, extensions_required = set(), set()
    for source_asset in manifest["assets"]:
        asset_id = source_asset["id"]
        require(source_asset.get("units") == "metres" and source_asset.get("upAxis") == "Y",
                "Unexpected assembly coordinates: " + asset_id)
        source_path = local_uri(root, source_asset["file"], root)
        source_bytes = source_path.read_bytes()
        document = json.loads(source_bytes)
        plan["sourceFiles"][source_asset["file"]] = {"sha256": digest(source_bytes), "bytes": len(source_bytes)}
        require(document.get("asset", {}).get("version") == "2.0", "glTF 2.0 required")
        require(not any(document.get(key) for key in ("skins", "animations", "cameras", "extensions")),
                "Animated, skinned, camera or root-extension sources need a separate importer")
        extensions_used.update(document.get("extensionsUsed", []))
        extensions_required.update(document.get("extensionsRequired", []))
        components, roots = scene_components(document)
        require(len(document["meshes"]) == source_asset["meshCount"], "Manifest mesh count mismatch: " + asset_id)
        require({item["sourceMeshIndex"] for item in components} == set(range(len(document["meshes"]))),
                "Unused source mesh would be omitted: " + asset_id)
        raw_buffers, buffer_map = [], []
        for buffer in document["buffers"]:
            data, uri, _ = stage(local_uri(source_path.parent, buffer["uri"], root), "Buffers")
            require(len(data) == buffer["byteLength"], "Source buffer size mismatch")
            raw_buffers.append(data)
            buffer_map.append(len(gltf["buffers"]))
            gltf["buffers"].append({**buffer, "uri": uri})
        view_offset = len(gltf["bufferViews"])
        for view in document["bufferViews"]:
            require(not view.get("extensions"), "Compressed buffer view is not a plain source byte range")
            gltf["bufferViews"].append({**view, "buffer": buffer_map[view["buffer"]]})
        accessor_offset = len(gltf["accessors"])
        for index, accessor in enumerate(document["accessors"]):
            read_accessor(document, raw_buffers, index)  # Validate even otherwise-unused accessors.
            gltf["accessors"].append({**accessor, "bufferView": accessor["bufferView"] + view_offset})
        image_map = []
        for source_image in document.get("images", []):
            require("uri" in source_image, "Expected original external PNG/JPEG source")
            data, uri, sha = stage(local_uri(source_path.parent, source_image["uri"], root), "Textures")
            value = {**source_image, "name": "T_" + sha, "uri": uri}
            value.pop("extras", None)  # Source metadata is retained separately; it does not change pixels.
            index = intern("images", value)
            image_map.append(index)
            if len(plan["images"]) <= index:
                plan["images"].append({"name": value["name"], "sha256": sha,
                                        "dimensions": image_dimensions(data), "preparedURI": uri})
        sampler_map = [intern("samplers", sampler) for sampler in document.get("samplers", [])]
        texture_map = []
        for texture in document.get("textures", []):
            require(not texture.get("extensions"), "Texture source extensions need an explicit remapper")
            value = {**texture, "source": image_map[texture["source"]]}
            value.pop("name", None)
            if "sampler" in texture:
                value["sampler"] = sampler_map[texture["sampler"]]
            texture_map.append(intern("textures", value))
        material_map = []
        for material in document.get("materials", []):
            value = remap_material(material, texture_map)
            value.pop("name", None)
            name = "M_" + digest(canonical(value).encode())[:24]
            value["name"] = name
            index = intern("materials", value)
            material_map.append(index)
            if len(plan["materials"]) <= index:
                plan["materials"].append({"name": name, "gltf": copy.deepcopy(value)})
        mesh_offset, node_offset = len(gltf["meshes"]), len(gltf["nodes"])
        source_positions, source_triangles = {}, 0
        for mesh_index, source_mesh in enumerate(document["meshes"]):
            name = "KIT_" + asset_id + "_m%03d" % mesh_index
            mesh = copy.deepcopy(source_mesh)
            mesh["name"] = name
            require(not mesh.get("weights"), "Morph targets are not static kit geometry")
            info = {"name": name, "sourceMeshIndex": mesh_index, "assetId": asset_id,
                    "triangles": 0, "sections": len(mesh["primitives"]), "uvChannels": 0,
                    "primitives": [], "materialNames": []}
            positions = []
            for primitive_index, primitive in enumerate(mesh["primitives"]):
                require(primitive.get("mode", 4) == 4 and not primitive.get("targets") and not primitive.get("extensions"),
                        "Only uncompressed static triangle primitives are supported")
                attributes = primitive["attributes"]
                require(all(key in attributes for key in ("POSITION", "NORMAL", "TANGENT", "TEXCOORD_0", "COLOR_0")),
                        "Source is missing authored position, normal, tangent, UV or color: " + name)
                arrays = {key: read_accessor(document, raw_buffers, index) for key, index in attributes.items()}
                count = len(arrays["POSITION"])
                require(all(len(array) == count for array in arrays.values()), "Mismatched vertex attribute count")
                indices = (read_accessor(document, raw_buffers, primitive["indices"], False)
                           if "indices" in primitive else [(index,) for index in range(count)])
                require(len(indices) % 3 == 0 and all(0 <= item[0] < count for item in indices), "Invalid triangle indices")
                triangles = len(indices) // 3
                info["triangles"] += triangles
                positions.extend(arrays["POSITION"])
                source_attributes = copy.deepcopy(attributes)
                primitive["attributes"] = {key: value + accessor_offset for key, value in attributes.items()}
                if "indices" in primitive:
                    primitive["indices"] += accessor_offset
                require("material" in primitive, "Explicit PBR material required: " + name)
                primitive["material"] = material_map[primitive["material"]]
                info["materialNames"].append(gltf["materials"][primitive["material"]]["name"])
                channels = sorted(int(key.split("_")[1]) for key in attributes if key.startswith("TEXCOORD_"))
                require(channels == list(range(len(channels))), "Source UV channels must be contiguous")
                next_uv = len(channels)
                color_storage = {}
                for key in sorted(key for key in attributes if key.startswith("COLOR_")):
                    require(next_uv + 2 <= 8, "Preserving all colors would exceed Unreal's eight UV channels")
                    colors = [tuple(row) + (1.,) if len(row) == 3 else row for row in arrays[key]]
                    require(all(len(row) == 4 for row in colors), "Invalid vertex color shape")
                    for part in range(2):
                        accessor = append_float_accessor([row[part*2:part*2+2] for row in colors], "VEC2")
                        primitive["attributes"]["TEXCOORD_%d" % (next_uv + part)] = accessor
                    original = document["accessors"][attributes[key]]
                    color_storage[key] = {"rgUVChannel": next_uv, "baUVChannel": next_uv+1,
                                          "componentType": original["componentType"], "type": original["type"],
                                          "normalized": original.get("normalized", False)}
                    next_uv += 2
                info["uvChannels"] = max(info["uvChannels"], next_uv)
                info["primitives"].append({"sourcePrimitiveIndex": primitive_index, "sourceAttributes": source_attributes,
                                            "sourceIndices": document["meshes"][mesh_index]["primitives"][primitive_index].get("indices"),
                                            "vertices": count, "triangles": triangles, "colorStorage": color_storage})
            info["sourceBounds"] = bounds(positions)
            source_positions[mesh_index] = positions
            source_triangles += info["triangles"]
            plan["meshes"][name] = info
            gltf["meshes"].append(mesh)
        require(source_triangles == source_asset["triangleCount"], "Manifest triangle count mismatch: " + asset_id)
        actual_bounds = bounds(transform_point(component["sourceWorldMatrix"], point)
                               for component in components for point in source_positions[component["sourceMeshIndex"]])
        require(all(abs(actual_bounds[side][axis]-source_asset["bounds"][side][axis]) <= 2e-5
                    for side in ("min", "max") for axis in range(3)), "Manifest bounds mismatch: " + asset_id)
        for node_index, source_node in enumerate(document["nodes"]):
            node = copy.deepcopy(source_node)
            node["name"] = "NODE_" + asset_id + "_%03d" % node_index
            if "mesh" in node:
                node["name"] = "KIT_" + asset_id + "_m%03d" % node["mesh"]
                node["mesh"] += mesh_offset
            if "children" in node:
                node["children"] = [child + node_offset for child in node["children"]]
            gltf["nodes"].append(node)
        gltf["scenes"][0]["nodes"].extend(index + node_offset for index in roots)
        for component in components:
            component["meshName"] = "KIT_" + asset_id + "_m%03d" % component["sourceMeshIndex"]
        for box in source_asset.get("collisionBoxes", []):
            require(all(math.isfinite(value) for side in ("min", "max") for value in box[side]) and
                    all(box["max"][axis] >= box["min"][axis] for axis in range(3)), "Invalid collision envelope")
        plan["assets"][asset_id] = {"source": source_asset, "sourceNodes": document["nodes"],
                                    "sourceSceneRoots": roots, "components": components}

    # Off-origin mesh vertices, identity scene transforms: their imported bounds
    # measure the translator's real basis and metre-to-centimetre conversion.
    for axis, label in enumerate(("X", "Y", "Z")):
        center = [0., 0., 0.]
        center[axis] = 1.
        vertices = []
        for signs in itertools.product((-1., 1.), repeat=3):
            face = [[center[j] + (signs[j]*.01 if j == k else 0.) for j in range(3)] for k in range(3)]
            if signs[0]*signs[1]*signs[2] < 0:
                face.reverse()
            vertices.extend(face)
        name = "TOKYO_AXIS_" + label
        attrs = {"POSITION": append_float_accessor(vertices, "VEC3"),
                 "NORMAL": append_float_accessor([[0., 1., 0.]]*len(vertices), "VEC3"),
                 "TANGENT": append_float_accessor([[1., 0., 0., 1.]]*len(vertices), "VEC4"),
                 "TEXCOORD_0": append_float_accessor([[.2, .3]]*len(vertices), "VEC2"),
                 "COLOR_0": append_float_accessor([[1., 1., 1., 1.]]*len(vertices), "VEC4")}
        gltf["nodes"].append({"name": name, "mesh": len(gltf["meshes"])})
        gltf["scenes"][0]["nodes"].append(len(gltf["nodes"])-1)
        gltf["meshes"].append({"name": name, "primitives": [{"attributes": attrs, "material": 0}]})
    auxiliary_path = prepared / "Buffers/auxiliary.bin"
    auxiliary_path.parent.mkdir(parents=True, exist_ok=True)
    auxiliary_path.write_bytes(extra)
    gltf["buffers"][0]["byteLength"] = len(extra)
    if extensions_used:
        gltf["extensionsUsed"] = sorted(extensions_used)
    if extensions_required:
        gltf["extensionsRequired"] = sorted(extensions_required)
    fingerprint = digest(canonical({"recipe": plan["recipeSHA256"], "manifest": plan["manifestSHA256"],
                                    "sources": plan["sourceFiles"]}).encode())
    plan.update({"sourceFingerprint": fingerprint, "preparedGLTF": str(prepared / "TokyoInteriorKit.gltf"),
                 "summary": {"assemblies": len(plan["assets"]), "meshes": len(plan["meshes"]),
                             "triangles": sum(item["triangles"] for item in plan["meshes"].values()),
                             "sharedMaterials": len(plan["materials"]), "sharedImages": len(plan["images"]),
                             "auxiliaryColorBytes": len(extra), "calibrationMeshes": 3}})
    require(manifest_path.read_bytes() == manifest_bytes, "Manifest changed during preparation; rerun")
    atomic_json(plan["preparedGLTF"], gltf)
    plan["preparedGLTFSHA256"] = digest(Path(plan["preparedGLTF"]).read_bytes())
    atomic_json(work_dir / "import-plan.json", plan)
    return plan


def measured_basis(probe_centers):
    require(len(probe_centers) == 3, "Three imported axis probes are required")
    matrix = IDENTITY.copy()
    for column, center in enumerate(probe_centers):
        require(len(center) == 3 and all(math.isfinite(value) for value in center), "Invalid axis probe")
        snapped = [round(value / 100.) for value in center]
        require(sum(abs(value) for value in snapped) == 1 and
                all(abs(center[row]-100.*snapped[row]) <= .02 for row in range(3)),
                "Unreal did not preserve the expected centimetre-scale probe: " + str(center))
        for row in range(3):
            matrix[row*4+column] = 100.*snapped[row]
    require(all(sum(abs(matrix[row*4+column]) for column in range(3)) == 100. for row in range(3)),
            "Axis probes did not form an orthogonal basis")
    require([matrix[1], matrix[5], matrix[9]] == [0., 0., 100.],
            "glTF +Y must import as Unreal +Z; refusing sideways or inverted furniture")
    return matrix


def measured_uv_conversion(probe_uv):
    """Record a translator's V conversion before decoding auxiliary UV color data."""
    require(len(probe_uv) == 2 and abs(probe_uv[0] - .2) < 1e-5, "Unexpected probe U conversion")
    if abs(probe_uv[1] - .3) < 1e-5:
        return {"uScale": 1., "vScale": 1., "vOffset": 0., "measured": True}
    require(abs(probe_uv[1] - .7) < 1e-5, "Unexpected probe V conversion")
    return {"uScale": 1., "vScale": -1., "vOffset": 1., "measured": True}


def convert_transform(source_matrix, basis):
    inverse = IDENTITY.copy()
    for row in range(3):
        for column in range(3):
            inverse[row*4+column] = basis[column*4+row]/10000.
    matrix = multiply(multiply(basis, source_matrix), inverse)
    scale = [math.sqrt(sum(matrix[row*4+column]**2 for row in range(3))) for column in range(3)]
    require(all(value > 1e-9 for value in scale), "Singular assembly transform")
    rotation = [[matrix[row*4+column]/scale[column] for column in range(3)] for row in range(3)]
    require(all(abs(sum(rotation[row][a]*rotation[row][b] for row in range(3))) < 1e-5
                for a, b in ((0, 1), (0, 2), (1, 2))), "Sheared hierarchy needs mesh baking; refusing to lose transforms")
    det = (rotation[0][0]*(rotation[1][1]*rotation[2][2]-rotation[1][2]*rotation[2][1])
           - rotation[0][1]*(rotation[1][0]*rotation[2][2]-rotation[1][2]*rotation[2][0])
           + rotation[0][2]*(rotation[1][0]*rotation[2][1]-rotation[1][1]*rotation[2][0]))
    if det < 0:
        scale[0] *= -1
        for row in range(3):
            rotation[row][0] *= -1
    # Stable quaternion extraction, including rotations close to 180 degrees.
    candidates = [1+rotation[0][0]-rotation[1][1]-rotation[2][2],
                  1-rotation[0][0]+rotation[1][1]-rotation[2][2],
                  1-rotation[0][0]-rotation[1][1]+rotation[2][2],
                  1+rotation[0][0]+rotation[1][1]+rotation[2][2]]
    index = max(range(4), key=lambda item: candidates[item])
    quaternion = [0.]*4
    quaternion[index] = math.sqrt(max(0., candidates[index])) / 2
    denominator = 4*quaternion[index]
    if index == 3:
        quaternion[:3] = [(rotation[2][1]-rotation[1][2])/denominator,
                          (rotation[0][2]-rotation[2][0])/denominator,
                          (rotation[1][0]-rotation[0][1])/denominator]
    else:
        a, b = (index+1) % 3, (index+2) % 3
        quaternion[a] = (rotation[a][index]+rotation[index][a])/denominator
        quaternion[b] = (rotation[b][index]+rotation[index][b])/denominator
        quaternion[3] = (rotation[b][a]-rotation[a][b])/denominator
    return {"translationCm": [matrix[3], matrix[7], matrix[11]],
            "rotationQuaternionXYZW": quaternion, "scale3D": scale, "matrix": matrix}


def registry_from_import(plan, basis, imported_meshes, destination, engine_version):
    """Build runtime metadata from validated real objects; source-only callers have no paths."""
    registry = {"schemaVersion": 1, "state": "imported", "nativeImportVerified": True,
                "nativeRenderingVerified": False, "cookVerified": False, "engineVersion": engine_version,
                "sourceFingerprint": plan["sourceFingerprint"], "sourceManifestSHA256": plan["manifestSHA256"],
                "units": "centimetres", "upAxis": "+Z", "matrixConvention": plan["matrixConvention"],
                "sourceToUnrealMatrix": basis, "basisMeasured": True,
                "cookDirectories": [destination], "assets": {}}
    for asset_id, assembly in plan["assets"].items():
        source = assembly["source"]
        components = []
        for source_component in assembly["components"]:
            name = source_component["meshName"]
            require(name in imported_meshes, "Missing imported mesh: " + name)
            imported = imported_meshes[name]
            require(imported.get("objectPath", "").startswith(destination + "/"), "Unvalidated mesh object path")
            components.append({**source_component, "meshObjectPath": imported["objectPath"],
                               "materialObjectPaths": imported["materialObjectPaths"],
                               "localTransform": convert_transform(source_component["sourceWorldMatrix"], basis),
                               "colorStorageByPrimitive": [item["colorStorage"] for item in plan["meshes"][name]["primitives"]]})
        boxes = []
        for source_box in source.get("collisionBoxes", []):
            box = transform_bounds(source_box, basis)
            boxes.append({"name": source_box.get("name", ""), "source": source_box,
                          "centerCm": [(box["min"][i]+box["max"][i])/2 for i in range(3)],
                          "halfExtentsCm": [(box["max"][i]-box["min"][i])/2 for i in range(3)],
                          "rotationQuaternionXYZW": [0., 0., 0., 1.]})
        registry["assets"][asset_id] = {"source": source, "sourceNodes": assembly["sourceNodes"],
                                       "sourceSceneRoots": assembly["sourceSceneRoots"], "components": components,
                                       "boundsCm": transform_bounds(source["bounds"], basis), "collisionBoxes": boxes}
    return registry


def import_native(plan, registry_path=DEFAULT_REGISTRY, destination_root="/Game/Tokyo/InteriorKit"):
    import unreal  # Editor-only dependency; never imported by source preparation.
    version = unreal.SystemLibrary.get_engine_version()
    require(re.match(r"^5\.8(?:\.|-)", version), "This import recipe requires UE 5.8; detected " + version)
    require(re.fullmatch(r"/Game/[A-Za-z0-9_/]+", destination_root) is not None, "Invalid destination package root")
    destination = destination_root.rstrip("/") + "/v_" + plan["sourceFingerprint"][:16]
    settings = {}

    def configure(obj, prefix, values):
        require(obj is not None, "Unavailable Interchange pipeline: " + prefix)
        for name, value in values.items():
            obj.set_editor_property(name, value)
            actual = obj.get_editor_property(name)
            require(actual == value, "Interchange did not retain required setting " + prefix + "." + name)
            settings[prefix + "." + name] = str(actual) if not isinstance(actual, (str, int, float, bool)) else actual

    generic = unreal.InterchangeGenericAssetsPipeline()
    configure(generic, "assets", {"use_source_name_for_asset": False, "asset_name": "",
                                   "import_offset_uniform_scale": 1.0,
                                   "import_offset_translation": unreal.Vector(0, 0, 0),
                                   "import_offset_rotation": unreal.Rotator(0, 0, 0)})
    common = generic.get_editor_property("common_meshes_properties")
    configure(common, "common", {"bake_meshes": False, "bake_pivot_meshes": False,
                                 "recompute_normals": False, "recompute_tangents": False,
                                 "remove_degenerates": False, "keep_sections_separate": True,
                                 "use_full_precision_u_vs": True, "use_high_precision_tangent_basis": True,
                                 "vertex_color_import_option": unreal.InterchangeVertexColorImportOption.IVCIO_REPLACE})
    configure(generic.get_editor_property("mesh_pipeline"), "mesh",
              {"import_static_meshes": True, "import_skeletal_meshes": False,
               "combine_static_meshes": False, "generate_lightmap_u_vs": False,
               "collision": False, "build_nanite": False, "build_scale3d": unreal.Vector(1, 1, 1)})
    material = generic.get_editor_property("material_pipeline")
    configure(material, "material", {"import_materials": True,
                                      "material_import": unreal.InterchangeMaterialImportOption.IMPORT_AS_MATERIAL_INSTANCES})
    configure(material.get_editor_property("texture_pipeline"), "texture",
              {"import_textures": True, "allow_non_power_of_two": True, "import_udi_ms": False})
    # Specialized glTF pipeline selects Epic's glTF PBR parents and extension parameters.
    # No custom generic parent or normal-channel override replaces that translation.
    specialized = unreal.InterchangeGLTFPipeline()
    stack = unreal.InterchangePipelineStackOverride()
    stack.add_pipeline(generic)
    stack.add_pipeline(specialized)
    task = unreal.AssetImportTask()
    configure(task, "task", {"filename": plan["preparedGLTF"], "destination_path": destination,
                             "automated": True, "async_": False, "replace_existing": True,
                             "replace_existing_settings": True, "save": False, "options": stack})
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])
    objects = list(task.get_objects())  # Documented blocking completion, including Interchange work.
    require(bool(objects), "Unreal returned no import results; existing assets do not prove a successful import")
    # Some translators return only primary objects; enumerate this versioned destination
    # to include imported material and texture dependencies in validation/save.
    objects_by_path = {obj.get_path_name(): obj for obj in objects if obj}
    for path in unreal.EditorAssetLibrary.list_assets(destination, recursive=True, include_folder=False):
        obj = unreal.load_asset(path)
        if obj:
            objects_by_path[obj.get_path_name()] = obj
    objects = list(objects_by_path.values())
    static_meshes = [obj for obj in objects if isinstance(obj, unreal.StaticMesh)]

    def named(name, candidates):
        matches = [obj for obj in candidates if obj.get_name() in {name, "SM_"+name, "MI_"+name, "M_"+name}]
        require(len(matches) == 1, "Missing/ambiguous imported asset " + name + ": " +
                str([obj.get_path_name() for obj in matches]))
        return matches[0]

    require(len(static_meshes) == len(plan["meshes"])+3, "Import changed the number of separate source meshes")
    probe_centers = []
    for label in ("X", "Y", "Z"):
        origin = named("TOKYO_AXIS_"+label, static_meshes).get_bounds().origin
        probe_centers.append([origin.x, origin.y, origin.z])
    basis = measured_basis(probe_centers)
    probe_description = named("TOKYO_AXIS_X", static_meshes).get_static_mesh_description(0)
    require(probe_description is not None, "The imported calibration mesh has no editor mesh description")
    probe_instance = probe_description.get_triangle_vertex_instance(unreal.TriangleID(0), 0)
    probe_uv = probe_description.get_vertex_instance_uv(probe_instance, 0)
    uv_conversion = measured_uv_conversion([probe_uv.x, probe_uv.y])
    imported, all_materials = {}, {}
    for name, source in plan["meshes"].items():
        mesh = named(name, static_meshes)
        require(mesh.get_num_triangles(0) == source["triangles"], "Triangle loss during import: " + name)
        require(mesh.get_num_sections(0) == source["sections"], "Material section change during import: " + name)
        require(mesh.get_num_tex_coords(0) >= source["uvChannels"], "Vertex UV/color storage was dropped: " + name)
        native_box = mesh.get_bounding_box()
        actual_bounds = {"min": [native_box.min.x, native_box.min.y, native_box.min.z],
                         "max": [native_box.max.x, native_box.max.y, native_box.max.z]}
        expected_bounds = transform_bounds(source["sourceBounds"], basis)
        require(all(abs(actual_bounds[side][axis]-expected_bounds[side][axis]) <= .03
                    for side in ("min", "max") for axis in range(3)), "Mesh pivot/scale changed: " + name)
        slots = list(mesh.get_editor_property("static_materials"))
        require(len(slots) == source["sections"], "Material slots changed: " + name)
        paths = []
        for slot, expected_name in zip(slots, source["materialNames"]):
            interface = slot.get_editor_property("material_interface")
            require(interface is not None and interface.get_path_name().startswith(destination + "/"),
                    "Missing source PBR material: " + name)
            # Matching is by the imported object's name, never guessed package paths.
            require(interface.get_name() in {expected_name, "MI_"+expected_name, "M_"+expected_name},
                    "Wrong source material assigned to " + name + ": " + interface.get_name())
            paths.append(interface.get_path_name())
            all_materials[interface.get_path_name()] = interface
        imported[name] = {"objectPath": mesh.get_path_name(), "materialObjectPaths": paths,
                          "boundsCm": actual_bounds, "triangles": mesh.get_num_triangles(0),
                          "uvChannels": mesh.get_num_tex_coords(0)}
    textures = [obj for obj in objects if isinstance(obj, unreal.Texture2D)]
    texture_proof = []
    for source_image in plan["images"]:
        candidates = [obj for obj in textures if source_image["name"] in obj.get_name()]
        require(bool(candidates), "Original PBR image was not imported: " + source_image["name"])
        for texture in candidates:
            dimensions = [int(texture.blueprint_get_size_x()), int(texture.blueprint_get_size_y())]
            require(dimensions == source_image["dimensions"], "Original PBR resolution changed: " + texture.get_path_name())
            texture_proof.append({"sourceSHA256": source_image["sha256"], "objectPath": texture.get_path_name(),
                                  "dimensions": dimensions})
    registry = registry_from_import(plan, basis, imported, destination, version)
    registry["textureObjects"] = texture_proof
    registry["uvSourceToUnreal"] = uv_conversion
    registry["meshImportChecks"] = imported
    registry["pipelineSettings"] = settings
    registry["verification"] = {"sourceBytesPreserved": True, "originalTextureDimensions": True,
                                 "triangleCounts": True, "meshBoundsAndPivots": True, "uvChannelCounts": True,
                                 "materialAssignments": True, "nativeAttributeValuesCompared": False,
                                 "nativeRenderingVerified": False, "cookVerified": False}
    registry["sourceFiles"] = plan["sourceFiles"]
    require(unreal.EditorAssetLibrary.save_loaded_assets(objects, only_if_is_dirty=False),
            "Unreal failed to save imported asset packages; registry was not published")
    atomic_json(registry_path, registry)
    unreal.log("Tokyo interior kit imported and saved: " + canonical(plan["summary"]))
    return registry


def run(manifest_path=DEFAULT_MANIFEST, work_dir=DEFAULT_WORK, registry_path=DEFAULT_REGISTRY,
        prepare_only=False, destination_root="/Game/Tokyo/InteriorKit"):
    work_dir = Path(work_dir)
    try:
        plan = prepare(manifest_path, work_dir)
        if prepare_only:
            result = {"state": "prepared", "nativeImportVerified": False, "nativeRenderingVerified": False,
                      "cookVerified": False, "summary": plan["summary"],
                      "sourceFingerprint": plan["sourceFingerprint"], "plan": str(work_dir / "import-plan.json")}
        else:
            registry = import_native(plan, registry_path, destination_root)
            result = {"state": "imported", "nativeImportVerified": True, "nativeRenderingVerified": False,
                      "cookVerified": False, "summary": plan["summary"], "registry": str(registry_path),
                      "sourceFingerprint": plan["sourceFingerprint"], "engineVersion": registry["engineVersion"]}
        atomic_json(work_dir / "last-run.json", result)
        print(canonical(result))
        return result
    except Exception as error:
        atomic_json(work_dir / "last-run.json", {"state": "failed", "nativeImportVerified": False,
                                                "nativeRenderingVerified": False, "cookVerified": False,
                                                "error": str(error), "traceback": traceback.format_exc()})
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--work-dir", type=Path, default=DEFAULT_WORK)
    parser.add_argument("--registry", type=Path, default=DEFAULT_REGISTRY)
    parser.add_argument("--destination-root", default="/Game/Tokyo/InteriorKit")
    parser.add_argument("--prepare-only", action="store_true")
    arguments = parser.parse_args()
    run(arguments.manifest, arguments.work_dir, arguments.registry,
        arguments.prepare_only, arguments.destination_root)
