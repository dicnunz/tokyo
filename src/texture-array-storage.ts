import { DataArrayTexture, DataTexture, RGBAFormat, UnsignedByteType, Vector3 } from 'three';
import type { WebGLRenderer } from 'three';

type UploadRenderer = Pick<WebGLRenderer, 'copyTextureToTexture'>;
type Staging = { texture: DataTexture; position: Vector3 };
const stagingByRenderer = new WeakMap<UploadRenderer, Staging>();

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
}

/**
 * Allocates texture storage on first GPU use without retaining a CPU pixel mirror.
 * Configure colorSpace, filters and anisotropy normally before first use. Native
 * mip levels reserve storage only; upload every level used by the sampler.
 *
 * Keep generateMipmaps=false: regenerating an array's mipmaps touches every
 * resident layer. Configure anisotropy with renderer.capabilities.getMaxAnisotropy().
 *
 * Context restoration allocates empty storage. Before displaying restored arrays,
 * callers must invalidate ownership/ready flags and replay their resident source
 * tiles with uploadTextureArrayLayer. This utility deliberately retains no pixels
 * for automatic replay. Do not addLayerUpdate() on an array with null image.data.
 *
 * Verified with Three 0.185.1 in Chrome: five independent sRGB mip levels read back
 * byte-for-byte, untouched layers remained zero, no GL error, and staging uploads
 * did not increase the GPU texture count. Reproduction:
 * work/capture-research/texture-research/null-array-test.html.
 * @see https://threejs.org/docs/pages/Source.html#dataReady
 * @see https://threejs.org/docs/pages/WebGLRenderer.html#copyTextureToTexture
 */
export function createTextureArrayStorage(width: number, height: number, layers: number, mipLevels = 1) {
  positiveInteger(width, 'width');
  positiveInteger(height, 'height');
  positiveInteger(layers, 'layers');
  positiveInteger(mipLevels, 'mipLevels');
  if (mipLevels > 1 + Math.floor(Math.log2(Math.max(width, height)))) {
    throw new RangeError('mipLevels exceeds the complete mip chain');
  }

  const texture = new DataArrayTexture(null, width, height, layers);
  texture.source.dataReady = false;
  texture.generateMipmaps = false;
  if (mipLevels > 1) {
    // WebGLTextures uses the descriptor count for texStorage3D. With dataReady
    // false it never attempts a CPU upload from these empty descriptors.
    texture.mipmaps = Array.from({ length: mipLevels }, (_, level) => ({
      width: Math.max(1, Math.floor(width / 2 ** level)),
      height: Math.max(1, Math.floor(height / 2 ** level)),
      data: null,
    })) as unknown as DataArrayTexture['mipmaps'];
  }
  texture.needsUpdate = true;
  return texture;
}

/**
 * Copies one complete RGBA8 layer at one mip level, including packed mip images
 * when mipLevel=0. Source bytes and caller texture settings remain unchanged.
 *
 * Three r185 copies an uninitialized DataTexture directly with texSubImage3D.
 * The staging texture must never be rendered or passed to initTexture: either
 * would select Three's GPU-to-GPU path and create a redundant GPU texture.
 * WebGL consumes the buffer synchronously, so its reference is released on return.
 */
export function uploadTextureArrayLayer(
  renderer: UploadRenderer,
  texture: DataArrayTexture,
  layer: number,
  pixels: Uint8Array | Uint8ClampedArray,
  mipLevel = 0,
) {
  if (texture.image.data !== null || texture.source.dataReady !== false) {
    throw new TypeError('Destination must use GPU-only texture array storage');
  }
  if (texture.format !== RGBAFormat || texture.type !== UnsignedByteType) {
    throw new TypeError('Texture array uploads require RGBA unsigned-byte storage');
  }
  if (texture.generateMipmaps || texture.flipY || texture.premultiplyAlpha) {
    throw new TypeError('Texture array uploads require explicit mipmaps and unmodified source bytes');
  }
  if (!Number.isInteger(layer) || layer < 0 || layer >= texture.image.depth) {
    throw new RangeError('Texture array layer is outside allocated storage');
  }
  if (!Number.isInteger(mipLevel) || mipLevel < 0 || mipLevel >= Math.max(1, texture.mipmaps.length)) {
    throw new RangeError('Texture array mip level is outside allocated storage');
  }
  const width = Math.max(1, Math.floor(texture.image.width / 2 ** mipLevel));
  const height = Math.max(1, Math.floor(texture.image.height / 2 ** mipLevel));
  if (pixels.byteLength !== width * height * 4) {
    throw new RangeError('Pixel buffer must contain exactly one complete RGBA layer');
  }

  let staging = stagingByRenderer.get(renderer);
  if (!staging) {
    staging = { texture: new DataTexture(null, 1, 1), position: new Vector3() };
    stagingByRenderer.set(renderer, staging);
  }
  staging.texture.image = { data: pixels, width, height };
  staging.position.set(0, 0, layer);
  try {
    // Destination initialization is handled by Three's copy method. The staging
    // texture stays at version 0 and never receives GPU storage or needsUpdate.
    renderer.copyTextureToTexture(staging.texture, texture, null, staging.position, 0, mipLevel);
  } finally {
    staging.texture.image.data = null;
  }
}
