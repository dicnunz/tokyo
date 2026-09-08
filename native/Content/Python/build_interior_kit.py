"""Synchronous editor entry point used by the native packaging pipeline."""
import import_interior_kit

result = import_interior_kit.run()
if result.get("state") != "imported" or not result.get("nativeImportVerified"):
    raise RuntimeError("The interior kit did not pass its native import checks")
