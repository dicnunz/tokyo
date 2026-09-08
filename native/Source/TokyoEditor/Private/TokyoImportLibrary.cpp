#include "TokyoImportLibrary.h"
#include "AssetCompilingManager.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "Components/StaticMeshComponent.h"
#include "Editor.h"
#include "EditorBuildUtils.h"
#include "Engine/StaticMesh.h"
#include "Engine/Texture2D.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "Import/PLATEAUImportModelRuntimeAPI.h"
#include "Materials/MaterialInstanceConstant.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "Misc/SecureHash.h"
#include "Misc/ScopeExit.h"
#include "PhysicsEngine/BodySetup.h"
#include "PLATEAUCityModelLoader.h"
#include "PLATEAUInstancedCityModel.h"
#include "PLATEAUGeometry.h"
#include "Serialization/JsonSerializer.h"
#include "TextureCompiler.h"
#include "UObject/SavePackage.h"
#include "UObject/UObjectIterator.h"
#include "UObject/UnrealType.h"
#include "WorldPartition/WorldPartition.h"
#include "WorldPartition/WorldPartitionRuntimeSpatialHash.h"

namespace
{
FPLATEAUGeoReference ShibuyaReference()
{
    FPLATEAUGeoReference Reference;
    FPLATEAUGeoCoordinate Origin;
    Origin.Latitude = 35.6595;
    Origin.Longitude = 139.7005;
    Origin.Height = 0.0;
    Reference.ReferencePoint = UPLATEAUGeoReferenceBlueprintLibrary::Project(Reference, Origin);
    Reference.UpdateNativeData();
    return Reference;
}

bool SaveAsset(UObject* Asset)
{
    UPackage* Package = Asset->GetOutermost();
    const FString Filename = FPackageName::LongPackageNameToFilename(
        Package->GetName(), FPackageName::GetAssetPackageExtension());
    Asset->SetFlags(RF_Public | RF_Standalone);
    Package->MarkPackageDirty();
    FSavePackageArgs Args;
    Args.TopLevelFlags = RF_Public | RF_Standalone;
    Args.SaveFlags = SAVE_NoError;
    return UPackage::SavePackage(Package, Asset, *Filename, Args);
}

FString AssetName(const FString& Prefix, const UObject* Source)
{
    return Prefix + FMD5::HashAnsiString(*Source->GetPathName());
}

UMaterialInterface* BakeMaterial(UMaterialInterface* Source, const FString& Root,
    TMap<UMaterialInterface*, UMaterialInterface*>& Cache)
{
    if (!Source) return nullptr;
    if (UMaterialInterface** Found = Cache.Find(Source)) return *Found;
    UMaterialInstanceDynamic* Dynamic = Cast<UMaterialInstanceDynamic>(Source);
    if (!Dynamic)
    {
        Cache.Add(Source, Source);
        return Source;
    }
    const FString Name = AssetName(TEXT("MI_"), Source);
    UPackage* Package = CreatePackage(*(Root / TEXT("Materials") / Name));
    UMaterialInstanceConstant* Material = NewObject<UMaterialInstanceConstant>(
        Package, *Name, RF_Public | RF_Standalone);
    // Constant assets survive cooking and can be baked into distant HLOD materials.
    Material->SetParentEditorOnly(Dynamic->Parent);
    for (const FScalarParameterValue& Value : Dynamic->ScalarParameterValues)
        Material->SetScalarParameterValueEditorOnly(Value.ParameterInfo, Value.ParameterValue);
    for (const FVectorParameterValue& Value : Dynamic->VectorParameterValues)
        Material->SetVectorParameterValueEditorOnly(Value.ParameterInfo, Value.ParameterValue);
    for (const FTextureParameterValue& Value : Dynamic->TextureParameterValues)
        Material->SetTextureParameterValueEditorOnly(Value.ParameterInfo, Value.ParameterValue);
    Material->PostEditChange();
    FAssetRegistryModule::AssetCreated(Material);
    if (!SaveAsset(Material)) return nullptr;
    Cache.Add(Source, Material);
    return Material;
}

bool IsVisibleInHierarchy(const USceneComponent* Component)
{
    for (const USceneComponent* Current = Component; Current; Current = Current->GetAttachParent())
        if (!Current->IsVisible() || Current->bHiddenInGame) return false;
    return true;
}
}

FVector UTokyoImportLibrary::ProjectLocation(double Latitude, double Longitude, double Height)
{
    FPLATEAUGeoReference Reference = ShibuyaReference();
    FPLATEAUGeoCoordinate Position;
    Position.Latitude = Latitude;
    Position.Longitude = Longitude;
    Position.Height = Height;
    return UPLATEAUGeoReferenceBlueprintLibrary::Project(Reference, Position);
}

APLATEAUCityModelLoader* UTokyoImportLibrary::BeginShibuyaImport(
    const FString& SourceDirectory, const TArray<FString>& GridCodes, bool bIncludeUnderground)
{
    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    if (!World || GridCodes.IsEmpty() || !FPaths::DirectoryExists(SourceDirectory / TEXT("udx")))
    {
        UE_LOG(LogTemp, Error, TEXT("Tokyo import needs an editor world and a native CityGML root containing udx."));
        return nullptr;
    }
    TMap<EPLATEAUCityModelPackage, FPackageInfoSettings> Settings;
    auto Add = [&Settings](EPLATEAUCityModelPackage Type, int32 Minimum, int32 Maximum)
    {
        FPackageInfoSettings Value;
        Value.bImport = true;
        Value.bTextureImport = true;
        Value.bIncludeAttrInfo = true;
        Value.bEnableTexturePacking = true;
        Value.TexturePackingResolution = EPLATEAUTexturePackingResolution::H4096W4096;
        Value.MinLod = Minimum;
        Value.MaxLod = Maximum;
        Value.Granularity = static_cast<int32>(EPLATEAUMeshGranularity::PerPrimaryFeatureObject);
        Settings.Add(Type, Value);
    };
    Add(EPLATEAUCityModelPackage::Building, 1, 4);
    Add(EPLATEAUCityModelPackage::Road, 1, 3);
    Add(EPLATEAUCityModelPackage::Relief, 1, 1);
    FPackageInfoSettings& Relief = Settings[EPLATEAUCityModelPackage::Relief];
    Relief.bAttachMapTile = true;
    Relief.MapTileUrl = TEXT("http://127.0.0.1:5173/api/tokyo-ortho/{z}/{x}/{y}.png");
    Relief.ZoomLevel = 19;
    Add(EPLATEAUCityModelPackage::CityFurniture, 1, 3);
    Add(EPLATEAUCityModelPackage::Vegetation, 1, 3);
    Add(EPLATEAUCityModelPackage::Bridge, 1, 3);
    Add(EPLATEAUCityModelPackage::Railway, 1, 3);
    Add(EPLATEAUCityModelPackage::WaterBody, 1, 3);
    Add(EPLATEAUCityModelPackage::Track, 1, 3);
    Add(EPLATEAUCityModelPackage::Square, 1, 3);
    Add(EPLATEAUCityModelPackage::Tunnel, 1, 4);
    if (bIncludeUnderground) Add(EPLATEAUCityModelPackage::UndergroundBuilding, 1, 4);
    // The local source service provides original Tokyo orthophotography for the measured terrain.
    APLATEAUCityModelLoader* Loader = UPLATEAUImportModelRuntimeAPI::GetCityModelLoaderLocal(
        World, SourceDirectory, GridCodes, 9, ShibuyaReference().ReferencePoint, Settings);
    if (Loader)
    {
        Loader->SetActorLabel(TEXT("Tokyo Native Shibuya Import"));
        for (const auto Package : UPLATEAUImportSettings::GetAllPackages())
            Loader->ImportSettings->GetFeatureSettingsRef(Package).bSetCollider = true;
        Loader->LoadModel();
    }
    return Loader;
}

FString UTokyoImportLibrary::ImportStatusJson(APLATEAUCityModelLoader* Loader)
{
    TSharedRef<FJsonObject> Result = MakeShared<FJsonObject>();
    Result->SetBoolField(TEXT("valid"), IsValid(Loader));
    if (IsValid(Loader))
    {
        Result->SetNumberField(TEXT("phase"), static_cast<int32>(Loader->Phase));
        Result->SetBoolField(TEXT("finished"), Loader->Phase == ECityModelLoadingPhase::Finished);
        Result->SetNumberField(TEXT("total"), Loader->Status.TotalGmlCount);
        Result->SetNumberField(TEXT("loaded"), Loader->Status.LoadedGmlCount);
        TArray<TSharedPtr<FJsonValue>> Failed;
        for (const FString& Path : Loader->Status.FailedGmls) Failed.Add(MakeShared<FJsonValueString>(Path));
        Result->SetArrayField(TEXT("failed"), Failed);
    }
    FString Json;
    FJsonSerializer::Serialize(Result, TJsonWriterFactory<>::Create(&Json));
    return Json;
}

int32 UTokyoImportLibrary::BakeVisibleFeatures(const FString& AssetRoot)
{
    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    if (!World || !AssetRoot.StartsWith(TEXT("/Game/"))) return -1;
    FAssetCompilingManager::Get().FinishAllCompilation();
    TArray<APLATEAUInstancedCityModel*> Models;
    for (TActorIterator<APLATEAUInstancedCityModel> It(World); It; ++It) Models.Add(*It);
    struct FSourceState { AActor* Actor; bool bHidden; bool bCollision; };
    TArray<FSourceState> HiddenSources;
    TArray<AActor*> CreatedActors;
    bool bCommitted = false;
    ON_SCOPE_EXIT
    {
        if (!bCommitted)
        {
            for (AActor* Actor : CreatedActors) if (IsValid(Actor)) World->DestroyActor(Actor);
            for (const FSourceState& State : HiddenSources)
            {
                State.Actor->SetActorHiddenInGame(State.bHidden);
                State.Actor->SetActorEnableCollision(State.bCollision);
            }
        }
    };
    TMap<UMaterialInterface*, UMaterialInterface*> Materials;
    TMap<UStaticMesh*, UStaticMesh*> Meshes;
    int32 Count = 0;
    for (APLATEAUInstancedCityModel* Model : Models)
    {
        TInlineComponentArray<UStaticMeshComponent*> Components(Model);
        for (UStaticMeshComponent* Component : Components)
        {
            if (!Component->GetStaticMesh()) continue;
            if (!IsVisibleInHierarchy(Component))
            {
                // SDK filtering only adjusts Visibility traces. Hidden LOD shells must not block Pawn.
                Component->SetCollisionEnabled(ECollisionEnabled::NoCollision);
                continue;
            }
            UStaticMesh* SourceMesh = Component->GetStaticMesh();
            UStaticMesh* Mesh = Meshes.FindRef(SourceMesh);
            if (!Mesh)
            {
                const FString Name = AssetName(TEXT("SM_"), SourceMesh);
                UPackage* Package = CreatePackage(*(AssetRoot / TEXT("Meshes") / Name));
                Mesh = DuplicateObject<UStaticMesh>(SourceMesh, Package, *Name);
                Mesh->SetFlags(RF_Public | RF_Standalone);
                for (FStaticMaterial& Slot : Mesh->GetStaticMaterials())
                {
                    UMaterialInterface* Baked = BakeMaterial(Slot.MaterialInterface, AssetRoot, Materials);
                    if (Slot.MaterialInterface && !Baked) return -1;
                    Slot.MaterialInterface = Baked;
                }
                Mesh->CreateBodySetup();
                Mesh->GetBodySetup()->CollisionTraceFlag = CTF_UseComplexAsSimple;
                Mesh->GetBodySetup()->InvalidatePhysicsData();
                Mesh->GetBodySetup()->CreatePhysicsMeshes();
                FAssetRegistryModule::AssetCreated(Mesh);
                if (!SaveAsset(Mesh)) return -1;
                Meshes.Add(SourceMesh, Mesh);
            }
            const FTransform Transform = Component->GetComponentTransform();
            AActor* Feature = World->SpawnActor<AActor>();
            if (!Feature) return -1;
            CreatedActors.Add(Feature);
            Feature->SetActorLabel(Component->GetName());
            Feature->Tags.Add(TEXT("TokyoSourceFeature"));
            Feature->SetRuntimeGrid(TEXT("Tokyo"));
            const FPLATEAUCityObjectInfo Info = Model->GetCityObjectInfo(Component);
            Feature->Tags.Add(FName(*(TEXT("GML:") + Info.ID)));
            Feature->Tags.Add(FName(*(TEXT("Source:") + Info.GmlName)));
            // Duplicate the concrete SDK component class so serialized building metadata is retained.
            UStaticMeshComponent* Copy = DuplicateObject<UStaticMeshComponent>(Component, Feature);
            Copy->DetachFromComponent(FDetachmentTransformRules::KeepWorldTransform);
            Copy->SetStaticMesh(Mesh);
            for (int32 Slot = 0; Slot < Component->GetNumMaterials(); ++Slot)
            {
                UMaterialInterface* Source = Component->GetMaterial(Slot);
                UMaterialInterface* Baked = BakeMaterial(Source, AssetRoot, Materials);
                if (Source && !Baked) return -1;
                Copy->SetMaterial(Slot, Baked);
            }
            Feature->SetRootComponent(Copy);
            Feature->AddInstanceComponent(Copy);
            Copy->SetMobility(EComponentMobility::Static);
            Copy->SetCollisionEnabled(ECollisionEnabled::QueryAndPhysics);
            Copy->SetCollisionObjectType(ECC_WorldStatic);
            Copy->SetCollisionResponseToAllChannels(ECR_Block);
            Copy->SetGenerateOverlapEvents(false);
            Copy->RegisterComponent();
            Feature->SetActorTransform(Transform);
            Feature->SetIsSpatiallyLoaded(true);
            ++Count;
        }
    }
    // The SDK pins every source texture and disables streaming to avoid blurry reloads.
    // Rebuild mip/UV streaming data from the original source before releasing that pin.
    TArray<UTexture*> Textures;
    for (TObjectIterator<UTexture2D> It; It; ++It)
    {
        UTexture2D* Texture = *It;
        if (!Texture->GetOutermost()->GetName().StartsWith(TEXT("/Game/PLATEAU/Textures/"))) continue;
        if (!Texture->Source.IsValid()) return -1;
        Texture->PreEditChange(nullptr);
        Texture->NeverStream = false;
        Texture->MipGenSettings = TMGS_FromTextureGroup;
        Texture->LODGroup = TEXTUREGROUP_World;
        Texture->LODBias = 0;
        Texture->Filter = TF_Default;
        Texture->PostEditChange();
        Textures.Add(Texture);
    }
    FTextureCompilingManager::Get().FinishCompilation(Textures);
    for (UTexture* Texture : Textures)
    {
        UTexture2D* Image = CastChecked<UTexture2D>(Texture);
        if (!Image->GetPlatformData() ||
            (Image->Source.GetSizeX() > 1 && Image->GetPlatformData()->Mips.Num() < 2))
        {
            UE_LOG(LogTemp, Error, TEXT("Texture mip generation failed: %s"), *Image->GetPathName());
            return -1;
        }
        if (!SaveAsset(Image)) return -1;
        if (Image->IsRooted()) Image->RemoveFromRoot();
    }
    for (APLATEAUInstancedCityModel* Model : Models)
    {
        HiddenSources.Add({Model, Model->IsHidden(), Model->GetActorEnableCollision()});
        Model->SetActorHiddenInGame(true);
        Model->SetActorEnableCollision(false);
    }
    if (!FEditorBuildUtils::EditorBuildTextureStreaming(World, VMI_Unknown)) return -1;
    // Commit only after mesh, material, texture mip, package and streaming-data checks succeed.
    for (APLATEAUInstancedCityModel* Model : Models) World->DestroyActor(Model);
    bCommitted = true;
    UE_LOG(LogTemp, Display, TEXT("Tokyo baked %d visible source features for World Partition."), Count);
    return Count;
}

bool UTokyoImportLibrary::ConfigurePartitionWorld()
{
    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    UWorldPartition* Partition = World ? World->GetWorldPartition() : nullptr;
    if (!Partition) return false;
    // Edit the serialized map property as well as the project defaults. This is
    // the same property exposed by World Settings, which is protected in C++.
    FObjectPropertyBase* RuntimeProperty = FindFProperty<FObjectPropertyBase>(Partition->GetClass(), TEXT("RuntimeHash"));
    UWorldPartitionRuntimeSpatialHash* Hash = RuntimeProperty
        ? Cast<UWorldPartitionRuntimeSpatialHash>(RuntimeProperty->GetObjectPropertyValue_InContainer(Partition)) : nullptr;
    if (!Hash) return false;
    FArrayProperty* GridProperty = FindFProperty<FArrayProperty>(Hash->GetClass(), TEXT("Grids"));
    FStructProperty* GridStruct = GridProperty ? CastField<FStructProperty>(GridProperty->Inner) : nullptr;
    if (!GridStruct || GridStruct->Struct != FSpatialHashRuntimeGrid::StaticStruct()) return false;
    Hash->Modify();
    TArray<FSpatialHashRuntimeGrid>* Grids = GridProperty->ContainerPtrToValuePtr<TArray<FSpatialHashRuntimeGrid>>(Hash);
    Grids->Reset();
    FSpatialHashRuntimeGrid& Grid = Grids->AddDefaulted_GetRef();
    Grid.GridName = TEXT("Tokyo");
    Grid.CellSize = 12800;
    Grid.LoadingRange = 38400.0f;
    Grid.bBlockOnSlowStreaming = false;
    Grid.Priority = 0;
    FPropertyChangedEvent Changed(GridProperty, EPropertyChangeType::ValueSet);
    Hash->PostEditChangeProperty(Changed);
    World->MarkPackageDirty();
    return Grids->Num() == 1 && (*Grids)[0].GridName == TEXT("Tokyo") && (*Grids)[0].CellSize == 12800;
}
