"""Validate and save the explicit streaming grid after World Partition conversion."""
import json
from pathlib import Path
import traceback
import unreal

report = Path(unreal.Paths.project_dir()).resolve() / "Saved/Tokyo/partition-report.json"
try:
    levels = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
    if not levels.load_level("/Game/Tokyo/Maps/Shibuya_WP"):
        raise RuntimeError("Converted Shibuya map could not be opened")
    if not unreal.TokyoImportLibrary.configure_partition_world():
        raise RuntimeError("Converted map does not contain the expected configurable spatial hash")
    if not levels.save_current_level():
        raise RuntimeError("Converted map streaming grid could not be saved")
    report.write_text(json.dumps({"state": "configured", "grid": "Tokyo", "cellSizeCm": 12800,
        "loadingRangeCm": 38400, "blockOnSlowStreaming": False, "runtimeTested": False}, indent=2))
except Exception:
    error = traceback.format_exc()
    report.write_text(json.dumps({"state": "failed", "error": error}, indent=2))
    unreal.log_error(error)
