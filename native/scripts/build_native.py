#!/usr/bin/env python3
"""Build, import, partition, cook and launch Tokyo using a locally installed Unreal engine."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

PROJECT = Path(__file__).resolve().parents[1]
WORKSPACE = Path(os.environ.get("TOKYO_WORKSPACE", str(PROJECT / "External"))).expanduser().resolve()
SAVED = PROJECT / "Saved/Tokyo"
PROJECT_FILE = PROJECT / "Tokyo.uproject"


def find_engine(override=None):
    candidates = [Path(override)] if override else []
    candidates += [
        Path("/Users/Shared/Epic Games/UE_5.8"),
        Path.home() / "Applications/UnrealEngine/UE_5.8",
        Path("/Applications/Epic Games/UE_5.8"),
    ]
    for root in candidates:
        version_file = root / "Engine/Build/Build.version"
        if version_file.exists():
            version = json.loads(version_file.read_text())
            if (version["MajorVersion"], version["MinorVersion"]) != (5, 8):
                raise RuntimeError(f"PLATEAU port is pinned to UE5.8; found {version_file}")
            return root
    raise RuntimeError("Unreal Engine 5.8 is not installed. Complete its installation in Epic Games Launcher.")


def preflight(engine_override=None):
    result = {"engine": None, "xcode": None, "missing": [], "checkedAt": time.time()}
    try:
        result["engine"] = str(find_engine(engine_override))
    except RuntimeError as error:
        result["missing"].append(str(error))
    xcode = Path("/Applications/Xcode.app/Contents/Developer")
    if xcode.exists():
        env = dict(os.environ, DEVELOPER_DIR=str(xcode))
        version = subprocess.run(["/usr/bin/xcodebuild", "-version"], env=env, capture_output=True, text=True)
        # Xcode ships a metal launcher even when the separate toolchain is
        # missing. Execute it so a path-only check cannot report a false pass.
        metal = subprocess.run(["/usr/bin/xcrun", "metal", "--version"], env=env, capture_output=True, text=True)
        result["xcode"] = version.stdout.strip()
        result["metal"] = metal.stdout.strip()
        if version.returncode or not version.stdout.startswith("Xcode 26.1.1\n") or metal.returncode:
            result["missing"].append("The pinned build needs Xcode26.1.1 with a working Metal compiler.")
    else:
        result["missing"].append("Xcode26.1.1 with Metal tools is not installed at /Applications/Xcode.app.")
    region = WORKSPACE / "work/unreal-migration/data/import-region.json"
    if not region.exists():
        result["missing"].append("Native Shibuya ingest manifest is missing.")
    else:
        manifest = json.loads(region.read_text())["preferred"]
        if not (Path(manifest["sourceRoot"]) / "udx").is_dir():
            result["missing"].append("Native Shibuya CityGML source directory is missing.")
    for required in [
        WORKSPACE / "outputs/tokyo-unreal-source-assets/InteriorKit/manifest.json",
        PROJECT / "Content/SourceData/shibuya-buildings.json",
    ]:
        if not required.is_file():
            result["missing"].append(f"External source prerequisite is missing: {required}")
    plugin = PROJECT / "Plugins/PLATEAU-SDK-for-Unreal"
    for arch in ("arm64", "x86_64"):
        archive = plugin / f"Source/ThirdParty/lib/macos/{arch}/libplateau_combined.a"
        if not archive.exists() or archive.stat().st_size < 1000000:
            result["missing"].append(f"PLATEAU native {arch} archive is still downloading.")
    result["freeGiB"] = round(shutil.disk_usage(PROJECT).free / 1024**3, 1)
    if result["freeGiB"] < 25:
        result["missing"].append("Less than25GiB free for native build, derived data and cooked content.")
    SAVED.mkdir(parents=True, exist_ok=True)
    (SAVED / "preflight.json").write_text(json.dumps(result, indent=2))
    return result


def run_step(name, command, env):
    print(f"{name}: running", flush=True)
    log_path = SAVED / f"{name}.log"
    started = time.monotonic()
    with log_path.open("w") as log:
        process = subprocess.Popen(command, cwd=PROJECT, env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            code = process.wait()
        except KeyboardInterrupt:
            process.terminate()
            process.wait()
            raise
    if code:
        raise RuntimeError(f"{name} exited{code}. Log: {log_path}")
    print(f"{name}: finished in{time.monotonic()-started:.0f}s", flush=True)


def source_service_ready():
    # Check one original orthophoto near the crossing. It is then cached by the existing source service.
    import math
    z = 19
    x = int((139.7005 + 180) / 360 * 2**z)
    y = int((1 - math.asinh(math.tan(math.radians(35.6595))) / math.pi) / 2 * 2**z)
    url = f"http://127.0.0.1:5173/api/tokyo-ortho/{z}/{x}/{y}.png"
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=60) as response:
                if response.read(8) != b"\x89PNG\r\n\x1a\n":
                    raise RuntimeError("Tokyo photography endpoint did not return a PNG")
            return
        except urllib.error.HTTPError as error:
            if error.code not in (429, 503) or attempt == 3:
                raise
            time.sleep(1 + attempt)
    raise RuntimeError("Original ground photography is unavailable")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", help="Unreal5.8 installation root")
    parser.add_argument("--preflight", action="store_true")
    parser.add_argument("--launch", action="store_true")
    parser.add_argument("--reimport", action="store_true")
    args = parser.parse_args()
    state = preflight(args.engine)
    if args.preflight:
        print(json.dumps(state, indent=2))
        return 1 if state["missing"] else 0
    if state["missing"]:
        raise RuntimeError("\n".join(state["missing"]))
    root = Path(state["engine"])
    engine = root / "Engine"
    env = dict(os.environ, DEVELOPER_DIR="/Applications/Xcode.app/Contents/Developer")
    if args.reimport:
        env["TOKYO_REIMPORT"] = "1"
    # Bounded compilation protects the16GB host from an unrestricted parallel build.
    run_step("compile", ["/bin/bash", str(engine / "Build/BatchFiles/Mac/Build.sh"),
             "TokyoEditor", "Mac", "Development", str(PROJECT_FILE), "-architecture=arm64",
             "-MaxParallelActions=3", "-NoHotReload"], env)
    editor = engine / "Binaries/Mac/UnrealEditor.app/Contents/MacOS/UnrealEditor"
    common = [str(editor), str(PROJECT_FILE), "-unattended", "-nosplash", "-SCCProvider=None"]
    # Import shared furniture in a separate editor process so it does not add to
    # the CityGML import's peak memory. These are editor imports of authored
    # assets; no runtime Interchange work occurs while the player moves.
    kit_report = WORKSPACE / "work/unreal-migration/interior-kit-import/last-run.json"
    if kit_report.exists():
        kit_report.rename(kit_report.with_suffix(".previous.json"))
    run_step("import-interior-kit", common + [f"-ExecutePythonScript={PROJECT / 'Content/Python/build_interior_kit.py'}"], env)
    if not kit_report.exists():
        raise RuntimeError("Editor exited without an interior kit import report")
    kit_state = json.loads(kit_report.read_text())
    if kit_state.get("state") != "imported" or not kit_state.get("nativeImportVerified"):
        raise RuntimeError(f"Interior kit import did not pass: {kit_report}")
    imported = SAVED / "import-report.json"
    valid_import = imported.exists() and json.loads(imported.read_text()).get("state") == "imported"
    if args.reimport or not valid_import:
        source_service_ready()
        run_step("import", common + [f"-ExecutePythonScript={PROJECT / 'Content/Python/build_shibuya.py'}"], env)
        if not imported.exists() or json.loads(imported.read_text()).get("state") != "imported":
            raise RuntimeError(f"Editor exited without a successful native import report: {imported}")
    converted = PROJECT / "Content/Tokyo/Maps/Shibuya_WP.umap"
    if args.reimport or not converted.exists():
        run_step("partition", common + ["-run=WorldPartitionConvertCommandlet",
            "/Game/Tokyo/Maps/Shibuya", "-ConversionSuffix", "-AllowCommandletRendering"], env)
        if not converted.exists():
            raise RuntimeError("World Partition conversion did not create Shibuya_WP.umap")
    run_step("configure-partition", common + [f"-ExecutePythonScript={PROJECT / 'Content/Python/configure_partition.py'}"], env)
    grid_report = SAVED / "partition-report.json"
    if not grid_report.exists() or json.loads(grid_report.read_text()).get("state") != "configured":
        raise RuntimeError("The converted map has not passed its streaming grid assertion")
    run_step("hlod", common + ["/Game/Tokyo/Maps/Shibuya_WP", "-run=WorldPartitionBuilderCommandlet",
        "-Builder=WorldPartitionHLODsBuilder", "-SetupHLODs", "-BuildHLODs", "-AllowCommandletRendering"], env)
    run_step("package", ["/bin/bash", str(engine / "Build/BatchFiles/RunUAT.sh"), "BuildCookRun",
        f"-project={PROJECT_FILE}", "-noP4", "-platform=Mac", "-target=Tokyo", "-clientconfig=Development",
        "-build", "-cook", "-stage", "-pak", "-iostore", "-archive",
        f"-archivedirectory={PROJECT / 'Builds'}", "-architecture=arm64", "-unattended"], env)
    apps = list((PROJECT / "Builds").rglob("Tokyo.app"))
    if not apps:
        raise RuntimeError("Packaging returned without creating Tokyo.app")
    (SAVED / "package-report.json").write_text(json.dumps({"app": str(apps[0]),
        "packagedAt": time.time(), "interiorKitSourceFingerprint": kit_state["sourceFingerprint"],
        "runtimeTested": False, "interiorEntryTested": False}, indent=2))
    if args.launch:
        subprocess.run(["/usr/bin/open", str(apps[0])], check=True)
    print(f"Packaged app: {apps[0]}\nNative walking, flight and performance validation remains required.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
