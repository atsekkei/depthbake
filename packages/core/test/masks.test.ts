import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSkyMask, computeEdgeMask } from "../src/masks.ts";
import type { RasterF32 } from "../src/upsample.ts";

test("computeSkyMask flags pixels below the threshold as sky", () => {
  const depth: RasterF32 = { width: 3, height: 1, data: new Float32Array([0.01, 0.1, 0.5]) };
  const sky = computeSkyMask(depth, 0.03);
  assert.deepEqual([...sky], [1, 0, 0]);
});

test("computeEdgeMask returns ~1 (non-edge) on a flat depth field", () => {
  const depth: RasterF32 = { width: 3, height: 3, data: new Float32Array(9).fill(1) };
  const edge = computeEdgeMask(depth);
  for (const v of edge) assert.ok(Math.abs(v - 1) < 1e-6);
});

test("computeEdgeMask drops toward 0 at a sharp depth discontinuity", () => {
  // left half near, right half far: a strong gradient at the boundary
  const data = new Float32Array([1, 1, 1, 0.1, 0.1, 0.1]);
  const depth: RasterF32 = { width: 6, height: 1, data };
  const edge = computeEdgeMask(depth);
  assert.ok(edge[2] < 0.5, `expected boundary pixel to read as an edge, got ${edge[2]}`);
  assert.ok(edge[0] > 0.9, `expected interior pixel to read as non-edge, got ${edge[0]}`);
});
