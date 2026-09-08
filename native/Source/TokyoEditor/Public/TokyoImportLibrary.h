#pragma once

#include "CoreMinimal.h"
#include "Kismet/BlueprintFunctionLibrary.h"
#include "TokyoImportLibrary.generated.h"

class APLATEAUCityModelLoader;

/** Editor only: imports original CityGML and prepares individually streamable features. */
UCLASS()
class TOKYOEDITOR_API UTokyoImportLibrary : public UBlueprintFunctionLibrary
{
    GENERATED_BODY()
public:
    UFUNCTION(BlueprintCallable, Category="Tokyo|Import")
    static APLATEAUCityModelLoader* BeginShibuyaImport(
        const FString& SourceDirectory, const TArray<FString>& GridCodes,
        bool bIncludeUnderground = true);

    /** Returns geographic coordinates as ESU centimetres relative to Shibuya Crossing. */
    UFUNCTION(BlueprintCallable, Category="Tokyo|Import")
    static FVector ProjectLocation(double Latitude, double Longitude, double Height = 0.0);

    /** Poll from the editor tick. Does not block the editor while native import runs. */
    UFUNCTION(BlueprintCallable, Category="Tokyo|Import")
    static FString ImportStatusJson(APLATEAUCityModelLoader* Loader);

    /** Converts transient SDK meshes/materials to saved assets, keeping only visible LODs. */
    UFUNCTION(BlueprintCallable, Category="Tokyo|Import")
    static int32 BakeVisibleFeatures(const FString& AssetRoot = TEXT("/Game/Tokyo/Source"));

    UFUNCTION(BlueprintCallable, Category="Tokyo|Import")
    static bool ConfigurePartitionWorld();
};
