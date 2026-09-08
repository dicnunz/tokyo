#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Character.h"
#include "TokyoCharacter.generated.h"

class UCameraComponent;

/** PLATEAU ESU coordinates are centimetres: +X east, +Y south, +Z up. */
UCLASS(Blueprintable)
class TOKYO_API ATokyoCharacter : public ACharacter
{
    GENERATED_BODY()

public:
    ATokyoCharacter();
    virtual void Tick(float DeltaSeconds) override;
    virtual void SetupPlayerInputComponent(UInputComponent* PlayerInputComponent) override;

    /** A streaming/import controller can hold movement until collision is ready. */
    UFUNCTION(BlueprintCallable, Category = "Tokyo|World")
    void SetTerrainReady(bool bReady);

    /** Trace down from a known native position and place the entire capsule safely. */
    UFUNCTION(BlueprintCallable, Category = "Tokyo|World")
    bool StartAtVerifiedGround(FVector TraceOriginCm, FRotator ViewRotation);

    /** Teleport an eye position; walking destinations snap to a verified floor below. */
    UFUNCTION(BlueprintCallable, Category = "Tokyo|World")
    bool TeleportToNativePosition(FVector EyePositionCm, FRotator ViewRotation, bool bStartFlying);

    /** Enabling uses flying physics. Disabling requires nearby ground and clearance. */
    UFUNCTION(BlueprintCallable, Category = "Tokyo|Movement")
    bool SetFlightEnabled(bool bEnabled);

    UFUNCTION(BlueprintCallable, Category = "Tokyo|Input")
    void ResetLocomotionInput();

    UFUNCTION(BlueprintPure, Category = "Tokyo|Movement")
    bool IsFlightEnabled() const { return bFlying; }

    UFUNCTION(BlueprintPure, Category = "Tokyo|World")
    bool IsReadyForMovement() const { return bTerrainReady && bLocalStreamingReady && !bAwaitingGround; }

    UFUNCTION(BlueprintPure, Category = "Tokyo|World")
    bool IsLocalStreamingReady() const { return bLocalStreamingReady; }

    UFUNCTION(BlueprintPure, Category = "Tokyo|World")
    FString GetMovementStatus() const;

    UFUNCTION(BlueprintPure, Category = "Tokyo|World")
    FVector GetNativeEyePosition() const;

    UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "Tokyo|Camera")
    TObjectPtr<UCameraComponent> FirstPersonCamera;

    UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "Tokyo|World")
    FVector LastVerifiedGroundCm = FVector::ZeroVector;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Tokyo|Movement", meta = (ClampMin = "1", Units = "cm/s"))
    float WalkingSpeedCm = 240.0f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Tokyo|Movement", meta = (ClampMin = "1", Units = "cm/s"))
    float RunningSpeedCm = 520.0f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Tokyo|Movement", meta = (ClampMin = "1", Units = "cm/s"))
    float FlyingSpeedCm = 1800.0f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Tokyo|Movement", meta = (ClampMin = "1", Units = "cm/s"))
    float FastFlyingSpeedCm = 5000.0f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Tokyo|Movement", meta = (ClampMin = "0", Units = "cm"))
    float MaximumLandingDropCm = 300.0f;

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Tokyo|World", meta = (ClampMin = "100", Units = "cm"))
    float MaximumSpawnTraceCm = 100000.0f;

    UPROPERTY(EditDefaultsOnly, BlueprintReadOnly, Category = "Tokyo|World")
    FName StreetRuntimeGrid = TEXT("Tokyo");

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Tokyo|World", meta = (ClampMin = "1000", ClampMax = "2500", Units = "cm"))
    float LocalStreamingRadiusCm = 1000.0f;

protected:
    virtual void BeginPlay() override;

private:
    bool bTerrainReady = true;
    bool bLocalStreamingReady = false;
    bool bAwaitingGround = true;
    bool bFlying = false;
    bool bRunning = false;
    bool bResumeFlightWhenReady = false;
    float GroundRetrySeconds = 0.0f;
    double StatusUntilSeconds = 0.0;
    FString TransientStatus;
    FVector HeldStreamingLookAheadCm = FVector::ZeroVector;

    void MoveForward(float Value);
    void MoveRight(float Value);
    void MoveVertical(float Value);
    void Turn(float Value);
    void LookUp(float Value);
    void StartRunning();
    void StopRunning();
    void StartJumping();
    void EndJumping();
    void ToggleFlight();
    bool AcceptsMovementInput() const;
    void RefreshMovementSpeeds();
    void HoldForGround();
    void UpdateLocalStreamingGate();
    bool IsAreaStreamingReady(const FVector& PositionCm, const FVector& LookAheadCm) const;
    bool TryAcquireGround();
    bool TryLand();
    bool HasCapsuleClearance(const FVector& CapsuleCentreCm) const;
    bool HasClearCapsulePath(const FVector& StartCm, const FVector& EndCm) const;
    bool FindGroundPlacement(const FVector& TraceOriginCm, float MaximumDropCm,
                             FVector& OutCapsuleCentreCm, FVector& OutFloorCm) const;
    void ApplyPlacement(const FVector& CapsuleCentreCm, const FRotator& ViewRotation, bool bUseFlight);
    void ShowStatus(const FString& Message, float DurationSeconds = 4.0f);
};
