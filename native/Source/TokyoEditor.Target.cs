using UnrealBuildTool;
using System.Collections.Generic;

public class TokyoEditorTarget : TargetRules
{
    public TokyoEditorTarget(TargetInfo Target) : base(Target)
    {
        Type = TargetType.Editor;
        DefaultBuildSettings = BuildSettingsVersion.Latest;
        IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
        ExtraModuleNames.Add("Tokyo");
        ExtraModuleNames.Add("TokyoEditor");
    }
}
