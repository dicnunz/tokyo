#pragma once

#include "CoreMinimal.h"
#include "GameFramework/PlayerController.h"
#include "TokyoPlayerController.generated.h"

UCLASS()
class TOKYO_API ATokyoPlayerController : public APlayerController
{
    GENERATED_BODY()

public:
    UFUNCTION(BlueprintCallable, Category = "Tokyo|Input")
    void CaptureMouse();

    UFUNCTION(BlueprintCallable, Category = "Tokyo|Input")
    void ReleaseMouse();

    UFUNCTION(BlueprintPure, Category = "Tokyo|Input")
    bool IsMouseCaptured() const { return bMouseCaptured; }

protected:
    virtual void BeginPlay() override;
    virtual void SetupInputComponent() override;

private:
    bool bMouseCaptured = false;
};
