# Tokyo for Unreal

Unreal 5.8 source for a Shibuya import using PLATEAU CityGML, first-person walking and flight, World Partition, and deterministic interior-layout generation.

**This native component has not been compiled, rendered, packaged, or performance-tested in Unreal.** The original goal covers all of Tokyo Metropolis; this Shibuya implementation does not meet that goal. Generated interiors are authored layouts, not surveyed interiors.

## Source

- `Source/`: gameplay and editor import modules.
- `Content/Python/`: editor import and partition helpers.
- `scripts/`: build orchestration and layout generation/verification.
- `patches/`: local changes against PLATEAU SDK commit `9ff2d57bbc02045e81440692550ae26038e6ad90`.

The SDK patch changes the Blueprint enum value to fit `uint8` and gives texture assets a source-path identity. It includes the existing texture-identity automation test. The pinned code comes from an Unreal 5.8 compatibility contribution; it is not a verified native build.

## Prerequisites

The build helper checks for Unreal 5.8, Xcode 26.1.1 with Metal tools, both SDK Mac libraries, and at least 25 GiB free. Python layout tools additionally require Shapely. Git LFS is needed for the upstream plugin assets.

```sh
./scripts/bootstrap_plateau.sh
git -C Plugins/PLATEAU-SDK-for-Unreal lfs pull \
  --include='Content/**,Resources/**,Source/ThirdParty/lib/macos/**'
python3 scripts/build_native.py --preflight --engine /path/to/UE_5.8
```

Preflight exits with status 1 and lists missing requirements. It does not download an engine or city data. Reports are written under `Saved/Tokyo/`.

CityGML, imagery, generated data, and authored asset binaries are omitted from this repository. The existing pipeline needs these external inputs:

```text
$TOKYO_WORKSPACE/
  work/unreal-migration/data/import-region.json
  outputs/tokyo-unreal-source-assets/InteriorKit/manifest.json
  outputs/tokyo-unreal-source-assets/InteriorKit/... referenced asset files
native/Content/SourceData/shibuya-buildings.json
```

Set `TOKYO_WORKSPACE` to a directory containing that original input layout; the default is `native/External`. The ingest manifest's `preferred.sourceRoot` must resolve to the extracted CityGML directory containing `udx/`. Asset manifest references must resolve to the separately obtained authored assets. These inputs are required to reproduce the import; this source archive does not generate them from a clean clone.

The photography bake also expects the original source service at `http://127.0.0.1:5173/api/tokyo-ortho/{z}/{x}/{y}.png`. A native import cannot proceed without that service and the external inputs.

Once all prerequisites are present, the existing build entry point is:

```sh
TOKYO_WORKSPACE=/path/to/source-workspace python3 scripts/build_native.py --engine /path/to/UE_5.8
```

Actual engine compilation, import/reload, collision, texture correctness, playable interiors, and performance remain unverified. Python syntax checks and preflight are source checks only.

## Third-party code

The SDK is fetched from [yuukiiwai/PLATEAU-SDK-for-Unreal](https://github.com/yuukiiwai/PLATEAU-SDK-for-Unreal/tree/9ff2d57bbc02045e81440692550ae26038e6ad90), associated with [compatibility PR 323](https://github.com/Synesthesias/PLATEAU-SDK-for-Unreal/pull/323). Its [MIT license](patches/PLATEAU-LICENSE.md) and [third-party notices](patches/PLATEAU-ThirdPartyNotices.md) are preserved. Unreal Engine is obtained separately under Epic's terms. City data, imagery, and authored assets retain their respective rights; none are included here.
