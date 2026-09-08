#include "TokyoPlayerController.h"

#include "TokyoCharacter.h"
#include "Camera/PlayerCameraManager.h"
#include "Components/InputComponent.h"

void ATokyoPlayerController::BeginPlay()
{
    Super::BeginPlay();
    if (PlayerCameraManager)
    {
        PlayerCameraManager->ViewPitchMin = -85.0f;
        PlayerCameraManager->ViewPitchMax = 85.0f;
    }
    CaptureMouse();
}

void ATokyoPlayerController::SetupInputComponent()
{
    Super::SetupInputComponent();
    check(InputComponent);
    InputComponent->BindAction(TEXT("ReleaseMouse"), IE_Pressed, this, &ATokyoPlayerController::ReleaseMouse);
    InputComponent->BindAction(TEXT("CaptureMouse"), IE_Pressed, this, &ATokyoPlayerController::CaptureMouse);
}

void ATokyoPlayerController::CaptureMouse()
{
    if (!IsLocalController()) return;
    FInputModeGameOnly Mode;
    Mode.SetConsumeCaptureMouseDown(false);
    SetInputMode(Mode);
    bShowMouseCursor = false;
    ResetIgnoreLookInput();
    ResetIgnoreMoveInput();
    bMouseCaptured = true;
}

void ATokyoPlayerController::ReleaseMouse()
{
    if (!IsLocalController() || !bMouseCaptured) return;
    if (ATokyoCharacter* Character = Cast<ATokyoCharacter>(GetPawn()))
    {
        Character->ResetLocomotionInput();
    }
    FInputModeGameAndUI Mode;
    Mode.SetLockMouseToViewportBehavior(EMouseLockMode::DoNotLock);
    Mode.SetHideCursorDuringCapture(false);
    SetInputMode(Mode);
    bShowMouseCursor = true;
    SetIgnoreLookInput(true);
    SetIgnoreMoveInput(true);
    bMouseCaptured = false;
}
