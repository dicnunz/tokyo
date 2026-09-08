using UnrealBuildTool;

public class TokyoEditor : ModuleRules
{
    public TokyoEditor(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
        bEnableExceptions = true;
        PublicDependencyModuleNames.AddRange(new[] { "Core", "CoreUObject", "Engine", "UnrealEd" });
        PrivateDependencyModuleNames.AddRange(new[] {
            "Tokyo", "PLATEAURuntime", "PLATEAURuntimeBPLibraries", "AssetRegistry",
            "AssetTools", "Json", "JsonUtilities", "PhysicsCore", "MeshDescription"
        });
    }
}
