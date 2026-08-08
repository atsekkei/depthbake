import { test } from "node:test";
import assert from "node:assert/strict";
import { packDepthRG16, unpackDepthRG16, packMask, packNormal, computeSourceHash, DEFAULT_CONFIG } from "../src/pack.ts";

test("packDepthRG16/unpackDepthRG16 round-trips within RG16 precision", () => {
  const input = new Float32Array([0, 0.25, 0.5, 0.75, 1]);
  const packed = packDepthRG16(input);
  const restored = unpackDepthRG16(packed);
  for (let i = 0; i < input.length; i++) {
    assert.ok(Math.abs(restored[i] - input[i]) <= 1 / 65535, `index ${i}: ${restored[i]} vs ${input[i]}`);
  }
});

test("packDepthRG16 clamps out-of-range values", () => {
  const packed = packDepthRG16(new Float32Array([-1, 2]));
  const restored = unpackDepthRG16(packed);
  assert.equal(restored[0], 0);
  assert.equal(restored[1], 1);
});

test("packDepthRG16 splits high/low bytes across R/G channels", () => {
  // d16 = 65535 -> R=255,G=255 ; d16 = 256 -> R=1,G=0
  const packed = packDepthRG16(new Float32Array([1, 256 / 65535]));
  assert.equal(packed[0], 255); // R of first pixel
  assert.equal(packed[1], 255); // G of first pixel
  assert.equal(packed[4], 1); // R of second pixel
  assert.equal(packed[5], 0); // G of second pixel
});

test("packMask writes sky to R and edge to G, alpha always 255", () => {
  const sky = new Float32Array([0, 1, 0.5]);
  const edge = new Float32Array([1, 0, 0.5]);
  const packed = packMask(sky, edge);
  assert.deepEqual(
    [...packed],
    [0, 255, 0, 255, 255, 0, 0, 255, 128, 128, 0, 255],
  );
});

test("packNormal maps -1..1 to 0..255 via n*0.5+0.5", () => {
  const nx = new Float32Array([-1, 0, 1]);
  const ny = new Float32Array([0, 0, 0]);
  const nz = new Float32Array([0, 0, 0]);
  const packed = packNormal(nx, ny, nz);
  assert.equal(packed[0], 0); // -1 -> 0
  assert.equal(packed[4], 128); // 0 -> 127.5 rounds to 128
  assert.equal(packed[8], 255); // 1 -> 255
});

test("computeSourceHash is deterministic and input-sensitive", async () => {
  const bytesA = new Uint8Array([1, 2, 3]);
  const bytesB = new Uint8Array([1, 2, 4]);
  const hashA1 = await computeSourceHash(bytesA, DEFAULT_CONFIG);
  const hashA2 = await computeSourceHash(bytesA, DEFAULT_CONFIG);
  const hashB = await computeSourceHash(bytesB, DEFAULT_CONFIG);
  assert.equal(hashA1, hashA2);
  assert.notEqual(hashA1, hashB);
  assert.match(hashA1, /^[0-9a-f]{64}$/);
});

test("computeSourceHash changes when config changes", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const hashDefault = await computeSourceHash(bytes, DEFAULT_CONFIG);
  const hashOther = await computeSourceHash(bytes, { ...DEFAULT_CONFIG, sky: { threshold: 0.5 } });
  assert.notEqual(hashDefault, hashOther);
});
