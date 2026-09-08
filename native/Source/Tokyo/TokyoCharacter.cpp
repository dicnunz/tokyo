#include "TokyoCharacter.h"

#include "Tokyo.h"
#include "TokyoPlayerController.h"
#include "Camera/CameraComponent.h"
#include "Components/CapsuleComponent.h"
#include "Components/InputComponent.h"
#include "Engine/World.h"
#include "GameFramework/CharacterMovementComponent.h"
#include "WorldPartition/WorldPartition.h"
#include "WorldPartition/WorldPartitionRuntimeCell.h"
#include "WorldPartition/WorldPartitionRuntimeSpatialHash.h"
#include "WorldPartition/WorldPartitionStreamingSource.h"
#include "WorldPartition/WorldPartitionSubsystem.h"

namespace TokyoMovement
{
    constexpr float CapsuleRadiusCm = 34.0f;
    constexpr float CapsuleHalfHeightCm = 88.0f;
    constexpr float FloorClearanceCm = 2.0f;
    // 88 cm half-height + 2 cm floor clearance + 80 cm eye offset = 170 cm.
    constexpr float CameraOffsetCm = 80.0f;
    constexpr float GroundRetryInterval = 0.25f;
    constexpr float StreamingLookAheadSeconds = 0.25f;
    constexpr float MaximumLookAheadCm = 1500.0f;
}

ATokyoCharacter::ATokyoCharacter()
{
    PrimaryActorTick.bCanEverTick = true;
    SpawnCollisionHandlingMethod = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
    GetCapsuleComponent()->InitCapsuleSize(TokyoMovement::CapsuleRadiusCm, TokyoMovement::CapsuleHalfHeightCm);
    GetCapsuleComponent()->SetCollisionProfileName(TEXT("Pawn"));
    BaseEyeHeight = TokyoMovement::CameraOffsetCm;
    bUseControllerRotationPitch = false;
    bUseControllerRotationYaw = true;
    bUseControllerRotationRoll = false;

    FirstPersonCamera = CreateDefaultSubobject<UCameraComponent>(TEXT("FirstPersonCamera"));
    FirstPersonCamera->SetupAttachment(GetCapsuleComponent());
    FirstPersonCamera->SetRelativeLocation(FVector(0.0, 0.0, TokyoMovement::CameraOffsetCm));
    FirstPersonCamera->bUsePawnControlRotation = true;
    FirstPersonCamera->FieldOfView = 80.0f;

    UCharacterMovementComponent* Movement = GetCharacterMovement();
    // The pawn's local streaming check must run before physics. Disable the
    // default movement-before-owner dependency so the explicit order cannot cycle.
    Movement->bTickBeforeOwner = false;
    Movement->bOrientRotationToMovement = false;
    Movement->MaxWalkSpeed = WalkingSpeedCm;
    Movement->MaxFlySpeed = FlyingSpeedCm;
    Movement->MaxAcceleration = 1800.0f;
    Movement->BrakingDecelerationWalking = 1800.0f;
    Movement->BrakingDecelerationFlying = 1600.0f;
    Movement->GroundFriction = 7.0f;
    Movement->BrakingFrictionFactor = 1.0f;
    Movement->JumpZVelocity = 420.0f;
    Movement->AirControl = 0.25f;
    Movement->MaxStepHeight = 35.0f;
    Movement->SetWalkableFloorAngle(48.0f);
    Movement->bEnablePhysicsInteraction = false;
    Movement->DefaultLandMovementMode = MOVE_Walking;
    Movement->SetMovementMode(MOVE_None);
}

void ATokyoCharacter::BeginPlay()
{
    Super::BeginPlay();
    GetCharacterMovement()->AddTickPrerequisiteActor(this);
    HoldForGround();
    UpdateLocalStreamingGate();
    TryAcquireGround();
}

void ATokyoCharacter::Tick(float DeltaSeconds)
{
    UpdateLocalStreamingGate();
    Super::Tick(DeltaSeconds);
    if (!IsReadyForMovement() && bTerrainReady && bLocalStreamingReady)
    {
        GroundRetrySeconds += DeltaSeconds;
        if (GroundRetrySeconds >= TokyoMovement::GroundRetryInterval)
        {
            GroundRetrySeconds = 0.0f;
            TryAcquireGround();
        }
    }
}

void ATokyoCharacter::SetupPlayerInputComponent(UInputComponent* PlayerInputComponent)
{
    Super::SetupPlayerInputComponent(PlayerInputComponent);
    check(PlayerInputComponent);
    PlayerInputComponent->BindAxis(TEXT("MoveForward"), this, &ATokyoCharacter::MoveForward);
    PlayerInputComponent->BindAxis(TEXT("MoveRight"), this, &ATokyoCharacter::MoveRight);
    PlayerInputComponent->BindAxis(TEXT("FlyVertical"), this, &ATokyoCharacter::MoveVertical);
    PlayerInputComponent->BindAxis(TEXT("Turn"), this, &ATokyoCharacter::Turn);
    PlayerInputComponent->BindAxis(TEXT("LookUp"), this, &ATokyoCharacter::LookUp);
    PlayerInputComponent->BindAction(TEXT("Run"), IE_Pressed, this, &ATokyoCharacter::StartRunning);
    PlayerInputComponent->BindAction(TEXT("Run"), IE_Released, this, &ATokyoCharacter::StopRunning);
    PlayerInputComponent->BindAction(TEXT("Jump"), IE_Pressed, this, &ATokyoCharacter::StartJumping);
    PlayerInputComponent->BindAction(TEXT("Jump"), IE_Released, this, &ATokyoCharacter::EndJumping);
    PlayerInputComponent->BindAction(TEXT("ToggleFlight"), IE_Pressed, this, &ATokyoCharacter::ToggleFlight);
}

bool ATokyoCharacter::AcceptsMovementInput() const
{
    const ATokyoPlayerController* Player = Cast<ATokyoPlayerController>(Controller);
    return IsReadyForMovement() && Controller && (!Player || Player->IsMouseCaptured());
}

void ATokyoCharacter::MoveForward(float Value)
{
    if (!AcceptsMovementInput() || FMath::IsNearlyZero(Value)) return;
    const FRotator View = Controller->GetControlRotation();
    const FRotator Direction = bFlying ? View : FRotator(0.0, View.Yaw, 0.0);
    AddMovementInput(Direction.Vector(), Value);
}

void ATokyoCharacter::MoveRight(float Value)
{
    if (!AcceptsMovementInput() || FMath::IsNearlyZero(Value)) return;
    const FRotator Heading(0.0, Controller->GetControlRotation().Yaw, 0.0);
    AddMovementInput(FRotationMatrix(Heading).GetUnitAxis(EAxis::Y), Value);
}

void ATokyoCharacter::MoveVertical(float Value)
{
    if (AcceptsMovementInput() && bFlying) AddMovementInput(FVector::UpVector, Value);
}

void ATokyoCharacter::Turn(float Value)
{
    const ATokyoPlayerController* Player = Cast<ATokyoPlayerController>(Controller);
    if (Controller && (!Player || Player->IsMouseCaptured())) AddControllerYawInput(Value);
}

void ATokyoCharacter::LookUp(float Value)
{
    const ATokyoPlayerController* Player = Cast<ATokyoPlayerController>(Controller);
    if (Controller && (!Player || Player->IsMouseCaptured())) AddControllerPitchInput(Value);
}

void ATokyoCharacter::StartRunning()
{
    bRunning = AcceptsMovementInput();
    RefreshMovementSpeeds();
}

void ATokyoCharacter::StopRunning()
{
    bRunning = false;
    RefreshMovementSpeeds();
}

void ATokyoCharacter::RefreshMovementSpeeds()
{
    GetCharacterMovement()->MaxWalkSpeed = bRunning ? RunningSpeedCm : WalkingSpeedCm;
    GetCharacterMovement()->MaxFlySpeed = bRunning ? FastFlyingSpeedCm : FlyingSpeedCm;
}

void ATokyoCharacter::StartJumping()
{
    if (AcceptsMovementInput() && !bFlying) Jump();
}

void ATokyoCharacter::EndJumping()
{
    StopJumping();
}

void ATokyoCharacter::ToggleFlight()
{
    if (AcceptsMovementInput()) SetFlightEnabled(!bFlying);
}

void ATokyoCharacter::HoldForGround()
{
    bAwaitingGround = true;
    GroundRetrySeconds = 0.0f;
    ResetLocomotionInput();
    GetCharacterMovement()->DisableMovement();
}

void ATokyoCharacter::ResetLocomotionInput()
{
    bRunning = false;
    StopJumping();
    ConsumeMovementInputVector();
    GetCharacterMovement()->StopMovementImmediately();
    RefreshMovementSpeeds();
}

void ATokyoCharacter::SetTerrainReady(bool bReady)
{
    if (!bReady)
    {
        if (!bAwaitingGround) bResumeFlightWhenReady = bFlying;
        bTerrainReady = false;
        HoldForGround();
        return;
    }
    bTerrainReady = true;
    UpdateLocalStreamingGate();
    if (bAwaitingGround) TryAcquireGround();
}

bool ATokyoCharacter::IsAreaStreamingReady(const FVector& PositionCm, const FVector& LookAheadCm) const
{
    UWorld* World = GetWorld();
    if (!World || PositionCm.ContainsNaN() || LookAheadCm.ContainsNaN()) return false;
    const UWorldPartition* Partition = World->GetWorldPartition();
    if (!Partition || !World->IsGameWorld()) return true;

    const UWorldPartitionRuntimeSpatialHash* Hash = Cast<UWorldPartitionRuntimeSpatialHash>(Partition->RuntimeHash);
    // A filter for a misspelled/missing grid otherwise matches no cells and can
    // report success. Inspect generated runtime grids, not editor-only Grids.
    if (!Hash || !Hash->GetStreamingGridByName(StreetRuntimeGrid)) return false;
    const UWorldPartitionSubsystem* Streaming = World->GetSubsystem<UWorldPartitionSubsystem>();
    if (!Streaming) return false;

    TArray<FWorldPartitionStreamingQuerySource> Queries;
    Queries.Reserve(2);
    const auto AddQuery = [this, &Queries](const FVector& Location)
    {
        FWorldPartitionStreamingQuerySource& Query = Queries.Emplace_GetRef();
        Query.bSpatialQuery = true;
        Query.bUseGridLoadingRange = false;
        Query.bDataLayersOnly = false;
        Query.bIncludeAnyDataLayer = true;
        Query.Location = Location;
        Query.Radius = FMath::Clamp(LocalStreamingRadiusCm, 1000.0f, 2500.0f);
        Query.TargetBehavior = EStreamingSourceTargetBehavior::Include;
        Query.TargetGrids.Add(StreetRuntimeGrid);
    };
    AddQuery(PositionCm);
    if (!LookAheadCm.IsNearlyZero()) AddQuery(PositionCm + LookAheadCm);
    // Only nearby source cells are required. The PlayerController's normal
    // streaming source continues preloading 384 m; distant HLODs do not gate input.
    return Streaming->IsStreamingCompleted(EWorldPartitionRuntimeCellState::Activated, Queries, false);
}

void ATokyoCharacter::UpdateLocalStreamingGate()
{
    const FVector LookAhead = bLocalStreamingReady
        ? (GetVelocity() * TokyoMovement::StreamingLookAheadSeconds).GetClampedToMaxSize(TokyoMovement::MaximumLookAheadCm)
        : HeldStreamingLookAheadCm;
    const bool bReadyNow = IsAreaStreamingReady(GetActorLocation(), LookAhead);
    if (!bReadyNow)
    {
        if (bLocalStreamingReady)
        {
            if (!bAwaitingGround) bResumeFlightWhenReady = bFlying;
            HeldStreamingLookAheadCm = LookAhead;
            HoldForGround();
        }
        bLocalStreamingReady = false;
        return;
    }
    if (!bLocalStreamingReady) GroundRetrySeconds = TokyoMovement::GroundRetryInterval;
    bLocalStreamingReady = true;
    HeldStreamingLookAheadCm = FVector::ZeroVector;
}

bool ATokyoCharacter::HasCapsuleClearance(const FVector& CapsuleCentreCm) const
{
    if (!GetWorld() || CapsuleCentreCm.ContainsNaN()) return false;
    const UCapsuleComponent* Capsule = GetCapsuleComponent();
    FCollisionQueryParams Params(SCENE_QUERY_STAT(TokyoCapsuleClearance), false, this);
    const FCollisionShape Shape = FCollisionShape::MakeCapsule(
        Capsule->GetScaledCapsuleRadius(), Capsule->GetScaledCapsuleHalfHeight());
    return !GetWorld()->OverlapBlockingTestByProfile(CapsuleCentreCm, FQuat::Identity,
        Capsule->GetCollisionProfileName(), Shape, Params);
}

bool ATokyoCharacter::HasClearCapsulePath(const FVector& StartCm, const FVector& EndCm) const
{
    if (!GetWorld()) return false;
    const UCapsuleComponent* Capsule = GetCapsuleComponent();
    FCollisionQueryParams Params(SCENE_QUERY_STAT(TokyoLandingPath), false, this);
    FHitResult Hit;
    return !GetWorld()->SweepSingleByProfile(Hit, StartCm, EndCm, FQuat::Identity,
        Capsule->GetCollisionProfileName(), FCollisionShape::MakeCapsule(
            Capsule->GetScaledCapsuleRadius(), Capsule->GetScaledCapsuleHalfHeight()), Params);
}

bool ATokyoCharacter::FindGroundPlacement(const FVector& TraceOriginCm, float MaximumDropCm,
                                        FVector& OutCapsuleCentreCm, FVector& OutFloorCm) const
{
    if (!GetWorld() || TraceOriginCm.ContainsNaN() || !FMath::IsFinite(MaximumDropCm) || MaximumDropCm <= 0.0f)
        return false;
    FCollisionQueryParams Params(SCENE_QUERY_STAT(TokyoGroundPlacement), false, this);
    FHitResult FloorHit;
    const FVector TraceEnd = TraceOriginCm - FVector::UpVector * MaximumDropCm;
    if (!GetWorld()->LineTraceSingleByChannel(FloorHit, TraceOriginCm, TraceEnd, ECC_Pawn, Params)
        || FloorHit.bStartPenetrating || !GetCharacterMovement()->IsWalkable(FloorHit))
        return false;

    const float HalfHeight = GetCapsuleComponent()->GetScaledCapsuleHalfHeight();
    const float Radius = GetCapsuleComponent()->GetScaledCapsuleRadius();
    // A capsule's bottom is spherical: a sloping surface requires extra vertical
    // separation. A flat-floor offset alone would incorrectly reject ramps.
    const double SlopeLift = Radius * (1.0 / FMath::Max(FloorHit.ImpactNormal.Z, 0.01) - 1.0);
    OutFloorCm = FloorHit.ImpactPoint;
    OutCapsuleCentreCm = OutFloorCm + FVector::UpVector * (HalfHeight + SlopeLift + TokyoMovement::FloorClearanceCm);
    if (!HasCapsuleClearance(OutCapsuleCentreCm)) return false;

    // Verify the same capsule and collision profile used by CharacterMovement.
    FHitResult SupportHit;
    const FCollisionShape Shape = FCollisionShape::MakeCapsule(GetCapsuleComponent()->GetScaledCapsuleRadius(), HalfHeight);
    return GetWorld()->SweepSingleByProfile(SupportHit, OutCapsuleCentreCm,
            OutCapsuleCentreCm - FVector::UpVector * 6.0f, FQuat::Identity,
            GetCapsuleComponent()->GetCollisionProfileName(), Shape, Params)
        && !SupportHit.bStartPenetrating && GetCharacterMovement()->IsWalkable(SupportHit);
}

void ATokyoCharacter::ApplyPlacement(const FVector& CapsuleCentreCm, const FRotator& ViewRotation, bool bUseFlight)
{
    GetCharacterMovement()->StopMovementImmediately();
    ConsumeMovementInputVector();
    SetActorLocationAndRotation(CapsuleCentreCm, FRotator(0.0, ViewRotation.Yaw, 0.0), false, nullptr, ETeleportType::TeleportPhysics);
    if (Controller) Controller->SetControlRotation(FRotator(FMath::ClampAngle(ViewRotation.Pitch, -85.0, 85.0), ViewRotation.Yaw, 0.0));
    bAwaitingGround = false;
    bLocalStreamingReady = true;
    HeldStreamingLookAheadCm = FVector::ZeroVector;
    bFlying = bUseFlight;
    bResumeFlightWhenReady = bUseFlight;
    GetCharacterMovement()->SetMovementMode(bUseFlight ? MOVE_Flying : MOVE_Walking);
    RefreshMovementSpeeds();
}

bool ATokyoCharacter::StartAtVerifiedGround(FVector TraceOriginCm, FRotator ViewRotation)
{
    if (!bTerrainReady || ViewRotation.ContainsNaN() || !IsAreaStreamingReady(TraceOriginCm, FVector::ZeroVector)) return false;
    FVector CapsuleCentre, Ground;
    if (!FindGroundPlacement(TraceOriginCm, MaximumSpawnTraceCm, CapsuleCentre, Ground)) return false;
    LastVerifiedGroundCm = Ground;
    ApplyPlacement(CapsuleCentre, ViewRotation, false);
    UE_LOG(LogTokyo, Log, TEXT("Ground verified at %s; eye %s"), *Ground.ToString(), *GetNativeEyePosition().ToString());
    return true;
}

bool ATokyoCharacter::TryAcquireGround()
{
    if (!bTerrainReady || !bLocalStreamingReady) return false;
    if (bResumeFlightWhenReady)
    {
        if (!HasCapsuleClearance(GetActorLocation())) return false;
        ApplyPlacement(GetActorLocation(), GetControlRotation(), true);
        return true;
    }
    return StartAtVerifiedGround(GetActorLocation() + FVector::UpVector * 100.0f, GetControlRotation());
}

bool ATokyoCharacter::TeleportToNativePosition(FVector EyePositionCm, FRotator ViewRotation, bool bStartFlying)
{
    if (!bTerrainReady || EyePositionCm.ContainsNaN() || ViewRotation.ContainsNaN()
        || !IsAreaStreamingReady(EyePositionCm, FVector::ZeroVector)) return false;
    if (!bStartFlying) return StartAtVerifiedGround(EyePositionCm, ViewRotation);
    const FVector CapsuleCentre = EyePositionCm - FVector::UpVector * FirstPersonCamera->GetRelativeLocation().Z;
    if (!HasCapsuleClearance(CapsuleCentre)) return false;
    ApplyPlacement(CapsuleCentre, ViewRotation, true);
    return true;
}

bool ATokyoCharacter::TryLand()
{
    const float HalfHeight = GetCapsuleComponent()->GetScaledCapsuleHalfHeight();
    const FVector Feet = GetActorLocation() - FVector::UpVector * (HalfHeight - 1.0f);
    FVector LandingCentre, Ground;
    if (!FindGroundPlacement(Feet, MaximumLandingDropCm, LandingCentre, Ground))
    {
        ShowStatus(FString::Printf(TEXT("Descend within %.1f m of a clear walkable surface, then press F."), MaximumLandingDropCm / 100.0f));
        return false;
    }
    if (!HasClearCapsulePath(GetActorLocation(), LandingCentre))
    {
        ShowStatus(TEXT("Move clear of the obstacle below before landing."));
        return false;
    }
    LastVerifiedGroundCm = Ground;
    ApplyPlacement(LandingCentre, GetControlRotation(), false);
    ShowStatus(TEXT("Walking"), 1.5f);
    return true;
}

bool ATokyoCharacter::SetFlightEnabled(bool bEnabled)
{
    if (!IsReadyForMovement()) return false;
    if (bEnabled == bFlying) return true;
    if (!bEnabled) return TryLand();
    StopJumping();
    GetCharacterMovement()->StopMovementImmediately();
    bFlying = true;
    bResumeFlightWhenReady = true;
    GetCharacterMovement()->SetMovementMode(MOVE_Flying);
    RefreshMovementSpeeds();
    ShowStatus(TEXT("Flying: E up, Q down. F lands near a clear surface."), 4.0f);
    return true;
}

FVector ATokyoCharacter::GetNativeEyePosition() const
{
    return FirstPersonCamera->GetComponentLocation();
}

void ATokyoCharacter::ShowStatus(const FString& Message, float DurationSeconds)
{
    TransientStatus = Message;
    StatusUntilSeconds = GetWorld() ? GetWorld()->GetTimeSeconds() + DurationSeconds : 0.0;
}

FString ATokyoCharacter::GetMovementStatus() const
{
    if (!bTerrainReady || !bLocalStreamingReady || bAwaitingGround) return TEXT("Loading the streets around you...");
    if (GetWorld() && GetWorld()->GetTimeSeconds() < StatusUntilSeconds) return TransientStatus;
    return bFlying ? TEXT("Flying") : TEXT("Walking");
}
