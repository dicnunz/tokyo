import test from 'node:test';
import assert from 'node:assert/strict';
import { DataArrayTexture, DataTexture, LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace, Vector3 } from 'three';
import { createTextureArrayStorage, uploadTextureArrayLayer } from '../src/texture-array-storage.ts';

test('GPU-only arrays reserve complete native mip chains without CPU pixel buffers', () => {
  const texture = createTextureArrayStorage(256, 128, 64, 9);
  assert.equal(texture.image.data, null);
  assert.equal(texture.source.dataReady, false);
  assert.equal(texture.generateMipmaps, false);
  assert.equal(texture.version, 1);
  assert.deepEqual(texture.mipmaps.map(m => [m.width, m.height, m.data]), [
    [256, 128, null], [128, 64, null], [64, 32, null], [32, 16, null],
    [16, 8, null], [8, 4, null], [4, 2, null], [2, 1, null], [1, 1, null],
  ]);
  assert.equal(texture.layerUpdates.size, 0);
  texture.dispose();
});

test('packed layer copies preserve byte subviews and reuse CPU-only staging without retaining pixels', () => {
  const texture = createTextureArrayStorage(6, 4, 64);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = texture.magFilter = LinearFilter;
  texture.anisotropy = 8;
  const backing = new Uint8Array(6 * 4 * 4 + 16);
  const pixels = backing.subarray(8, -8);
  pixels.forEach((_, i) => { pixels[i] = (i * 79 + 11) % 256; });
  const before = pixels.slice();
  const sources: DataTexture[] = [];
  const renderer = {
    copyTextureToTexture(source: DataTexture, destination: DataArrayTexture, region: unknown, position: Vector3, sourceLevel: number, destinationLevel: number) {
      assert.equal(source.version, 0, 'staging must never be marked for a GPU upload');
      assert.equal(source.image.data, pixels, 'copy the original subview without expansion or re-encoding');
      assert.equal(source.image.width, 6);
      assert.equal(source.image.height, 4);
      assert.equal(destination, texture);
      assert.equal(region, null);
      assert.deepEqual(position.toArray(), [0, 0, sources.length ? 3 : 63]);
      assert.equal(sourceLevel, 0);
      assert.equal(destinationLevel, 0);
      sources.push(source);
    },
  };
  uploadTextureArrayLayer(renderer as any, texture, 63, pixels);
  assert.equal(sources[0].image.data, null, 'staging releases its buffer immediately after a copy');
  uploadTextureArrayLayer(renderer as any, texture, 3, pixels);
  assert.equal(sources[0], sources[1], 'one staging object per renderer');
  assert.equal(sources[1].image.data, null);
  assert.deepEqual(pixels, before);
  assert.equal(texture.image.data, null);
  assert.equal(texture.version, 1, 'copying does not trigger full array uploads');
  assert.equal(texture.colorSpace, SRGBColorSpace);
  assert.equal(texture.minFilter, LinearFilter);
  assert.equal(texture.magFilter, LinearFilter);
  assert.equal(texture.anisotropy, 8);
  texture.dispose();
});

test('native mip copies use the allocated dimensions and keep the source level zero', () => {
  const texture = createTextureArrayStorage(8, 4, 2, 4);
  texture.minFilter = LinearMipmapLinearFilter;
  const calls: number[][] = [];
  const renderer = {
    copyTextureToTexture(source: DataTexture, destination: DataArrayTexture, _region: unknown, position: Vector3, sourceLevel: number, destinationLevel: number) {
      assert.equal(destination, texture);
      assert.equal(sourceLevel, 0, 'nonzero source levels would use the GPU source-copy branch');
      calls.push([source.image.width, source.image.height, position.z, destinationLevel]);
    },
  };
  for (let level = 0; level < 4; level++) {
    const width = Math.max(1, 8 >> level), height = Math.max(1, 4 >> level);
    uploadTextureArrayLayer(renderer as any, texture, 1, new Uint8Array(width * height * 4), level);
  }
  assert.deepEqual(calls, [[8, 4, 1, 0], [4, 2, 1, 1], [2, 1, 1, 2], [1, 1, 1, 3]]);
  assert.equal(texture.minFilter, LinearMipmapLinearFilter);
  texture.dispose();
});

test('canvas pixel arrays are copied directly without conversion', () => {
  const texture = createTextureArrayStorage(2, 2, 1), pixels = new Uint8ClampedArray(16);
  pixels.set([12, 143, 221, 255]);
  const renderer = { copyTextureToTexture(source: DataTexture) { assert.equal(source.image.data, pixels); } };
  uploadTextureArrayLayer(renderer as any, texture, 0, pixels);
  assert.equal(texture.image.data, null);
  texture.dispose();
});

test('invalid storage and uploads fail before issuing GPU work', () => {
  for (const dimensions of [[0, 2, 2], [2, -1, 2], [2, 2, 1.5], [2, 2, 2, 3]]) {
    assert.throws(() => createTextureArrayStorage(dimensions[0], dimensions[1], dimensions[2], dimensions[3]), RangeError);
  }
  const texture = createTextureArrayStorage(2, 2, 2);
  const renderer = { copyTextureToTexture() { assert.fail('invalid data must not reach WebGL'); } };
  const pixels = new Uint8Array(16);
  for (const layer of [-1, 2, .5, NaN]) assert.throws(() => uploadTextureArrayLayer(renderer, texture, layer, pixels), RangeError);
  assert.throws(() => uploadTextureArrayLayer(renderer, texture, 0, pixels.subarray(1)), RangeError);
  assert.throws(() => uploadTextureArrayLayer(renderer, texture, 0, pixels, 1), RangeError);
  texture.source.dataReady = true;
  assert.throws(() => uploadTextureArrayLayer(renderer, texture, 0, pixels), TypeError);
  texture.source.dataReady = false; texture.generateMipmaps = true;
  assert.throws(() => uploadTextureArrayLayer(renderer, texture, 0, pixels), TypeError);
  texture.dispose();
});

test('failed copies release staging pixels and allow subsequent copies', () => {
  const texture = createTextureArrayStorage(2, 2, 2), pixels = new Uint8Array(16);
  let source: DataTexture | undefined, shouldFail = true;
  const renderer = { copyTextureToTexture(staging: DataTexture) { source = staging; if (shouldFail) throw new Error('context lost'); } };
  assert.throws(() => uploadTextureArrayLayer(renderer as any, texture, 0, pixels), /context lost/);
  assert.equal(source!.image.data, null);
  shouldFail = false;
  uploadTextureArrayLayer(renderer as any, texture, 1, pixels);
  assert.equal(source!.image.data, null);
  texture.dispose();
});
