#include "TokyoGameMode.h"

#include "TokyoCharacter.h"
#include "TokyoHUD.h"
#include "TokyoPlayerController.h"

ATokyoGameMode::ATokyoGameMode()
{
    DefaultPawnClass = ATokyoCharacter::StaticClass();
    PlayerControllerClass = ATokyoPlayerController::StaticClass();
    HUDClass = ATokyoHUD::StaticClass();
    bStartPlayersAsSpectators = false;
}
