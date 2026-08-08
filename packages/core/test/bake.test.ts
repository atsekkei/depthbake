import { test } from "node:test";
import assert from "node:assert/strict";
import { bakeFromDisparity, type SourcePhoto } from "../src/bake.ts";
import { DEFAULT_CONFIG, type PhotoSpaceConfig } from "../src/pack.ts";

const photo: SourcePhoto = {
  fileName: "photo.jpg",
  bytes: new Uint8Array([1, 2, 3]),
  input: "unused",
  width: 4,
  height: 4,
  rgba: new Uint8Array(4 * 4 * 4).fill(128),
};
const lowRes = { width: 2, height: 2, data: new Float32Array([0, 0.25, 0.5, 1]) };

test("bakeFromDisparity omits mask/normal by default", async () => {
  const baked = await bakeFromDisparity(photo, lowRes, { min: 0, max: 1 }, { config: DEFAULT_CONFIG });
  assert.equal(baked.meta.version, 2);
  assert.equal(baked.meta.mask, undefined);
  assert.equal(baked.meta.normal, undefined);
  assert.equal(baked.maskRgba, undefined);
  assert.equal(baked.normalRgba, undefined);
  assert.equal(baked.depthRgba.length, baked.depthWidth * baked.depthHeight * 4);
});

test("bakeFromDisparity uses a precomputed sourceHash when provided", async () => {
  const computed = await bakeFromDisparity(photo, lowRes, { min: 0, max: 1 }, { config: DEFAULT_CONFIG });
  const provided = await bakeFromDisparity(photo, lowRes, { min: 0, max: 1 }, {
    config: DEFAULT_CONFIG,
    sourceHash: "precomputed-hash",
  });
  assert.equal(provided.meta.sourceHash, "precomputed-hash");
  // 省略時は従来どおり内部で計算される
  assert.match(computed.meta.sourceHash!, /^[0-9a-f]{64}$/);
});

test("bakeFromDisparity declares and returns maps when enabled", async () => {
  const config: PhotoSpaceConfig = {
    ...DEFAULT_CONFIG,
    maps: { ...DEFAULT_CONFIG.maps, mask: true, normal: true },
  };
  const baked = await bakeFromDisparity(photo, lowRes, { min: 0, max: 1 }, { config });
  assert.deepEqual(baked.meta.mask, { file: "mask.png" });
  assert.deepEqual(baked.meta.normal, { file: "normal.png" });
  const size = baked.depthWidth * baked.depthHeight * 4;
  assert.equal(baked.maskRgba?.length, size);
  assert.equal(baked.normalRgba?.length, size);
});
