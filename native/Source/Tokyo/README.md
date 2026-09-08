# Tokyo native movement

The `Tokyo` runtime module provides `ATokyoCharacter`, `ATokyoPlayerController`, `ATokyoHUD`, and `ATokyoGameMode`. It creates no city geometry or template props. Select `/Script/Tokyo.TokyoGameMode` as the default game mode in the project engine configuration.

Controls: WASD moves, mouse looks, Shift runs or accelerates flight, Space jumps while walking, F switches flight and landing, E/Q changes flight altitude, Escape releases mouse control, and a click captures it again. Input mappings are in `Config/DefaultInput.ini`; no input assets or plugins are needed.

Coordinates follow PLATEAU ESU: centimetres, +X east, +Y south, +Z up. The capsule radius is 34 cm and its half-height is 88 cm. Camera offset is 80 cm; the explicit 2 cm standing clearance produces a 170 cm eye height on a flat floor. Unreal may adjust floor separation slightly during walking. Walking speed is 2.4 m/s, running is 5.2 m/s, flight is 18 m/s, and fast flight is 50 m/s. Blueprint properties expose these values.

`CharacterMovement` remains responsible for acceleration, braking, stairs, walking slopes, capsule collision, jumping, gravity, and flight. Ground acquisition uses the Pawn collision channel and capsule profile. It verifies walkability, compensates the standing capsule for floor slope, checks full capsule clearance, and confirms capsule support. Visible imported meshes must block Pawn queries and have real collision. A visually present mesh without collision does not release the loading hold.

The pawn starts with movement disabled and retries its downward ground probe four times per second. Before each movement-component update it also checks that the `Tokyo` World Partition grid has activated source cells within 10 m of the player and a short velocity lookahead of up to 15 m. This local gate does not wait for distant HLODs or replace the controller's 384 m preload source. It verifies that the named runtime grid exists before using a filtered completion query. The camera remains free while movement waits; a held flight preserves its position and mode. The blocked lookahead is retained during the hold so stopping velocity cannot prematurely release the gate.

Place `PlayerStart` over the desired street with a clear vertical path to its ground surface. Its automatic probe begins 100 cm above the capsule centre and extends down at most 1 km. Ground detection verifies a physical walkable surface; selection of the intended street comes from the imported source and the editor's starting position. Nonpartitioned editor source maps continue using the ground check alone.

## Integration hooks

- `SetTerrainReady(false)` stops input, velocity, and physics before an external controller removes or rebuilds collision. Set it to true after collision is available. This explicit flag remains independent from automatic World Partition readiness. A held flight resumes at the same capsule position once local cells are active and that space is clear. A held walk reacquires its floor. Use this hook for collision rebuilds that do not change World Partition activation.
- `StartAtVerifiedGround(TraceOriginCm, ViewRotation)` traces down from the supplied native position and returns true only after safe ground placement. This is suitable for editor automation or a Blueprint startup controller. It preserves a failed attempt's original position.
- `TeleportToNativePosition(EyePositionCm, ViewRotation, bStartFlying)` accepts an eye position, validates activated local cells and the destination capsule, and preserves the requested mode. Walking destinations snap to verified ground below the supplied eye position. Flight destinations preserve that eye position. A failed teleport leaves the pawn in place. An external travel controller must preload a distant destination before invoking this hook.
- `SetFlightEnabled(false)` checks ground within 3 m below the current feet and sweeps the full capsule to the proposed standing position. Obstructions or missing support keep the character flying and display the reason.
- `IsReadyForMovement`, `IsLocalStreamingReady`, `IsFlightEnabled`, `GetNativeEyePosition`, `GetMovementStatus`, and `LastVerifiedGroundCm` expose runtime diagnostics. `ResetLocomotionInput` clears held run/jump state and velocity when an interface releases input.

The HUD shows mode/loading state, controls, and smoothed frame rate. It uses engine fonts and Canvas drawing, without UI assets. Mouse release stops user movement; it does not pause the world. Editor Play-in-Editor may reserve Escape for stopping play; verify the release interaction in the standalone native game.

## Validation status and native checks

Written and statically checked September 5, 2026. No Unreal build, header-tool pass, native physics test, or native rendering test has run yet because the engine/toolchain installation is still pending. Static validation checks the module/target names, generated-header ordering, input mapping coverage, and API declaration/definition pairing; it is not compilation proof.

After the engine is installed, build `TokyoEditor` and `Tokyo`, then verify against the imported collision:

1. With ground absent, startup remains stationary in `MOVE_None`. Once collision loads, spawn reaches a clear floor and the eye is approximately 170 cm above it.
2. Walk/run/jump on streets, ramps, stairs, and beside walls. Confirm capsule blocking and clear mouse look.
3. Fly into walls and roofs to verify blocking; land near clear ground; attempt landing above a ceiling, obstacle, steep face, and empty data to confirm flight remains active.
4. Hold and restore terrain while walking and flying. Verify that flight resumes at the same position and that walking resumes on verified support. Delay a nearby World Partition cell and confirm movement stops before entry, the view stays responsive, and distant HLOD loading alone causes no hold. A missing `Tokyo` grid must keep movement held. An external false terrain flag must stay effective when local cells become ready.
5. Try a valid flight teleport and an obstructed teleport; confirm the failed attempt preserves the original position.
6. Release and recapture the mouse while running and flying. Check that run state does not stick and no template assets appear.

API references checked September 5, 2026: [CharacterMovementComponent](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Engine/UCharacterMovementComponent), [native input mappings](https://dev.epicgames.com/documentation/en-us/unreal-engine/input-overview-in-unreal-engine), [UInputComponent](https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/UInputComponent), and [AHUD](https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/AHUD). The implementation uses their documented engine interfaces; compilation and behavior still require the chosen engine installation.

The local streaming gate uses the UE5.8 [WorldPartition subsystem query overload](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Engine/UWorldPartitionSubsystem), [query-source fields](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Engine/FWorldPartitionStreamingQuerySou-), [generated runtime-grid lookup](https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/UWorldPartitionRuntimeSpatialHas-), and [movement tick-order setting](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Engine/UMovementComponent), checked September 5, 2026.
