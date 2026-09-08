#include "TokyoHUD.h"

#include "TokyoCharacter.h"
#include "TokyoPlayerController.h"
#include "Engine/Canvas.h"
#include "Engine/Engine.h"
#include "Engine/World.h"

void ATokyoHUD::DrawHUD()
{
    Super::DrawHUD();
    if (!Canvas || !GEngine || !GetWorld()) return;
    const float FrameSeconds = FMath::Max(GetWorld()->GetDeltaSeconds(), 0.00001f);
    SmoothedFrameSeconds = SmoothedFrameSeconds > 0.0f
        ? FMath::Lerp(SmoothedFrameSeconds, FrameSeconds, 1.0f - FMath::Exp(-FrameSeconds * 2.5f))
        : FrameSeconds;
    const ATokyoPlayerController* Player = Cast<ATokyoPlayerController>(GetOwningPlayerController());
    const ATokyoCharacter* Character = Player ? Cast<ATokyoCharacter>(Player->GetPawn()) : nullptr;
    const float Width = Canvas->ClipX;
    const float Height = Canvas->ClipY;
    const float Scale = FMath::Clamp(Width / 1440.0f, 0.8f, 1.4f);
    const float Margin = 22.0f * Scale;
    const FLinearColor Cream(0.96f, 0.96f, 0.90f, 1.0f);
    const FLinearColor Muted(0.76f, 0.84f, 0.85f, 1.0f);
    UFont* Font = GEngine->GetSmallFont();
    const FString Status = Character ? Character->GetMovementStatus() : TEXT("Preparing the Tokyo player...");

    float StatusWidth = 0.0f, StatusHeight = 0.0f;
    GetTextSize(Status, StatusWidth, StatusHeight, Font, Scale);
    const float PanelWidth = FMath::Min(Width - Margin * 2.0f + 20.0f, FMath::Max(420.0f * Scale, StatusWidth + 20.0f));
    DrawRect(FLinearColor(0.025f, 0.045f, 0.06f, 0.82f), Margin - 10.0f, Margin - 8.0f, PanelWidth, 66.0f * Scale);
    DrawText(TEXT("TOKYO / SHIBUYA"), Cream, Margin, Margin, Font, 1.15f * Scale);
    DrawText(Status, Muted, Margin, Margin + 26.0f * Scale, Font, Scale);
    DrawText(FString::Printf(TEXT("%.0f fps"), 1.0f / SmoothedFrameSeconds), Cream,
        FMath::Max(Margin, Width - 92.0f * Scale), Margin, Font, Scale);

    const FString Controls = Player && !Player->IsMouseCaptured()
        ? TEXT("Click to resume mouse control")
        : TEXT("WASD move   Mouse look   Shift faster   Space jump   F fly / land   E up / Q down   Esc release mouse");
    DrawRect(FLinearColor(0.025f, 0.045f, 0.06f, 0.8f), 0.0f, Height - 43.0f * Scale, Width, 43.0f * Scale);
    DrawText(Controls, Cream, Margin, Height - 29.0f * Scale, Font, Scale);

    if (Character && Character->IsReadyForMovement() && Player && Player->IsMouseCaptured())
    {
        const float X = Width * 0.5f, Y = Height * 0.5f;
        DrawLine(X - 3.0f, Y, X + 3.0f, Y, FLinearColor(1.0f, 1.0f, 1.0f, 0.6f));
        DrawLine(X, Y - 3.0f, X, Y + 3.0f, FLinearColor(1.0f, 1.0f, 1.0f, 0.6f));
    }
}
