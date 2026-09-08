#pragma once

#include "CoreMinimal.h"
#include "GameFramework/HUD.h"
#include "TokyoHUD.generated.h"

UCLASS()
class TOKYO_API ATokyoHUD : public AHUD
{
    GENERATED_BODY()

public:
    virtual void DrawHUD() override;

private:
    float SmoothedFrameSeconds = 0.0f;
};
