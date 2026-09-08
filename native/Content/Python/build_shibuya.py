"""Run in the full Unreal editor. Asynchronous SDK import stays alive until verified save."""
import json
import os
import time
import traceback
from pathlib import Path

import unreal

PROJECT = Path(unreal.Paths.project_dir()).resolve()
WORKSPACE = Path(os.environ.get("TOKYO_WORKSPACE", str(PROJECT / "External"))).expanduser().resolve()
REGION_FILE = WORKSPACE / "work/unreal-migration/data/import-region.json"
REPORT = PROJECT / "Saved/Tokyo/import-report.json"
MAP = "/Game/Tokyo/Maps/Shibuya"
REPORT.parent.mkdir(parents=True, exist_ok=True)
LEVELS = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
ACTORS = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
ASSETS = unreal.get_editor_subsystem(unreal.EditorAssetSubsystem)
STARTED = time.monotonic()
TICK_HANDLE = None
LOADER = None
NEXT_POLL = 0.0


def report(state, **values):
    payload = {"state": state, "elapsedSeconds": round(time.monotonic() - STARTED, 2), **values}
    temp = REPORT.with_suffix(".tmp")
    temp.write_text(json.dumps(payload, indent=2))
    temp.replace(REPORT)


def finish(error=None, **values):
    global TICK_HANDLE
    if TICK_HANDLE is not None:
        unreal.unregister_slate_post_tick_callback(TICK_HANDLE)
        TICK_HANDLE = None
    report("failed" if error else "imported", error=error, **values)
    if error:
        unreal.log_error(error)
    unreal.EditorPythonScripting.set_keep_python_script_alive(False)


def spawn(actor_class, label, position=None, rotation=None):
    actor = ACTORS.spawn_actor_from_class(actor_class, position or unreal.Vector(), rotation or unreal.Rotator())
    if not actor:
        raise RuntimeError(f"Could not create {label}")
    actor.set_actor_label(label)
    actor.set_editor_property("is_spatially_loaded", False)
    return actor


def add_environment():
    sun = spawn(unreal.DirectionalLight, "Tokyo afternoon sun", rotation=unreal.Rotator(-42, -125, 0))
    light = sun.get_component_by_class(unreal.DirectionalLightComponent)
    light.set_editor_property("mobility", unreal.ComponentMobility.MOVABLE)
    light.set_editor_property("intensity", 90000.0)
    light.set_editor_property("atmosphere_sun_light", True)
    light.set_editor_property("light_source_angle", 0.8)
    light.set_editor_property("dynamic_shadow_distance_movable_light", 18000.0)
    light.set_editor_property("dynamic_shadow_cascades", 3)
    spawn(unreal.SkyAtmosphere, "Tokyo sky")
    sky = spawn(unreal.SkyLight, "Tokyo sky illumination")
    skylight = sky.get_component_by_class(unreal.SkyLightComponent)
    skylight.set_editor_property("mobility", unreal.ComponentMobility.MOVABLE)
    skylight.set_editor_property("real_time_capture", False)
    skylight.set_editor_property("intensity", 1.0)
    skylight.recapture_sky()
    volume = spawn(unreal.PostProcessVolume, "Tokyo exposure")
    volume.set_editor_property("unbound", True)
    settings = volume.get_editor_property("settings")
    settings.set_editor_property("override_auto_exposure_method", True)
    settings.set_editor_property("auto_exposure_method", unreal.AutoExposureMethod.AEM_MANUAL)
    settings.set_editor_property("override_auto_exposure_bias", True)
    settings.set_editor_property("auto_exposure_bias", 0.0)
    settings.set_editor_property("override_auto_exposure_apply_physical_camera_exposure", True)
    settings.set_editor_property("auto_exposure_apply_physical_camera_exposure", True)
    settings.set_editor_property("override_camera_shutter_speed", True)
    settings.set_editor_property("camera_shutter_speed", 250.0)
    settings.set_editor_property("override_camera_iso", True)
    settings.set_editor_property("camera_iso", 100.0)
    settings.set_editor_property("override_depth_of_field_fstop", True)
    settings.set_editor_property("depth_of_field_fstop", 11.0)
    settings.set_editor_property("override_motion_blur_amount", True)
    settings.set_editor_property("motion_blur_amount", 0.0)
    volume.set_editor_property("settings", settings)
    # Above the crossing; native Character traces onto the actual imported ground before enabling motion.
    origin = unreal.TokyoImportLibrary.project_location(35.6595, 139.7005, 260.0)
    spawn(unreal.PlayerStart, "Shibuya Crossing start", origin, unreal.Rotator(0, -20, 0))


def tick(_delta):
    global NEXT_POLL
    now = time.monotonic()
    if now < NEXT_POLL:
        return
    NEXT_POLL = now + 0.5
    try:
        state = json.loads(unreal.TokyoImportLibrary.import_status_json(LOADER))
        report("importing", **state)
        if not state.get("valid"):
            raise RuntimeError("PLATEAU import loader was lost")
        if state.get("finished"):
            if state.get("failed") or state.get("loaded", 0) <= 0:
                raise RuntimeError(f"PLATEAU did not import every requested source: {state}")
            count = unreal.TokyoImportLibrary.bake_visible_features("/Game/Tokyo/Source")
            if count <= 0:
                raise RuntimeError("No saved visible source geometry was produced")
            ACTORS.destroy_actor(LOADER)
            add_environment()
            if not LEVELS.save_current_level():
                raise RuntimeError("Imported Shibuya level could not be saved")
            if not ASSETS.save_directory("/Game/Tokyo", only_if_is_dirty=True, recursive=True):
                raise RuntimeError("Source assets could not all be saved")
            finish(map=MAP, featureActors=count, nativeImport=state,
                   coordinateSystem="JGD2011 zone 9, ESU centimetres; origin 35.6595,139.7005,0",
                   runtimeTested=False)
        elif now - STARTED > 3600:
            LOADER.cancel()
            raise RuntimeError("Native source import exceeded one hour; inspect the failed-source report")
    except Exception:
        finish(traceback.format_exc())


try:
    unreal.EditorPythonScripting.set_keep_python_script_alive(True)
    if ASSETS.does_asset_exist(MAP) and os.environ.get("TOKYO_REIMPORT") != "1":
        raise RuntimeError("Shibuya already exists. Set TOKYO_REIMPORT=1 for an intentional source rebuild.")
    region = json.loads(REGION_FILE.read_text())["preferred"]
    if not LEVELS.new_level(MAP, is_partitioned_world=False):
        raise RuntimeError("Could not create the source import level")
    LOADER = unreal.TokyoImportLibrary.begin_shibuya_import(region["sourceRoot"], region["gridCodes"], True)
    if not LOADER:
        raise RuntimeError("PLATEAU rejected the dataset root or selection")
    report("importing", gridCodes=region["gridCodes"], sourceRoot=region["sourceRoot"])
    TICK_HANDLE = unreal.register_slate_post_tick_callback(tick)
except Exception:
    finish(traceback.format_exc())
