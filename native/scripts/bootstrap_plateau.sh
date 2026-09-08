#!/bin/sh
set -eu
project=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
plugin="$project/Plugins/PLATEAU-SDK-for-Unreal"
revision=9ff2d57bbc02045e81440692550ae26038e6ad90
if [ -e "$plugin" ]; then
  echo "Plugin path already exists; inspect it before replacing or updating it: $plugin" >&2
  exit 1
fi
mkdir -p "$project/Plugins"
GIT_LFS_SKIP_SMUDGE=1 git clone --no-checkout https://github.com/yuukiiwai/PLATEAU-SDK-for-Unreal.git "$plugin"
GIT_LFS_SKIP_SMUDGE=1 git -C "$plugin" checkout --detach "$revision"
test "$(git -C "$plugin" rev-parse HEAD)" = "$revision"
git -C "$plugin" apply --check "$project/patches/plateau-local.patch"
git -C "$plugin" apply "$project/patches/plateau-local.patch"
printf '%s\n' 'SDK source and local patch installed. Native build remains unverified.' 'Fetch the required upstream LFS assets with the command in README.md.'
