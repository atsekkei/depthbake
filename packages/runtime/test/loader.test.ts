import test from "node:test";
import assert from "node:assert/strict";
import {
  computeEdgeMask,
  computeNormals,
  computeSkyMask,
  packageMapFiles,
  photoFileCandidates,
  type PhotoSpaceMeta,
  type PhotoSpaceMetaV2,
} from "../loader.ts";

function meta(photo?: PhotoSpaceMeta["photo"]): PhotoSpaceMeta {
  return {
    version: 1,
    source: { file: "source.jpg", width: 1, height: 1 },
    photo,
    depth: {
      width: 1,
      height: 1,
      space: "disparity",
      orientation: "near=1",
      normalization: { min: 0, max: 1 },
    },
    camera: { fovDeg: 55, farRange: 12 },
    sky: { threshold: 0.03 },
    model: { name: "test", revision: "test" },
    bakedAt: "2026-01-01T00:00:00.000Z",
    sourceHash: "hash",
  };
}

function metaV2(fields?: Partial<PhotoSpaceMetaV2>): PhotoSpaceMetaV2 {
  return { ...meta(), ...fields, version: 2 };
}

test("photoFileCandidates keeps legacy AVIF default", () => {
  assert.deepEqual(photoFileCandidates(meta()), ["photo.avif"]);
});

test("photoFileCandidates uses sources in order and removes duplicate legacy file", () => {
  assert.deepEqual(
    photoFileCandidates(meta({
      file: "photo.avif",
      sources: [
        { file: "photo.avif", type: "image/avif" },
        { file: "photo.webp", type: "image/webp" },
      ],
    })),
    ["photo.avif", "photo.webp"],
  );
});

test("photoFileCandidates falls back to the mandatory photo.jpg on v2", () => {
  assert.deepEqual(photoFileCandidates(metaV2()), ["photo.jpg"]);
  assert.deepEqual(
    photoFileCandidates(metaV2({
      photo: {
        file: "photo.avif",
        sources: [
          { file: "photo.avif", type: "image/avif" },
          { file: "photo.webp", type: "image/webp" },
          { file: "photo.jpg", type: "image/jpeg" },
        ],
      },
    })),
    ["photo.avif", "photo.webp", "photo.jpg"],
  );
});

test("packageMapFiles requires every map on v1", () => {
  assert.deepEqual(packageMapFiles(meta()), { mask: "mask.png", normal: "normal.png" });
});

test("packageMapFiles returns only the maps declared by v2 meta", () => {
  assert.deepEqual(packageMapFiles(metaV2()), { mask: undefined, normal: undefined });
  assert.deepEqual(
    packageMapFiles(metaV2({ mask: { file: "mask.png" }, normal: { file: "normal.png" } })),
    { mask: "mask.png", normal: "normal.png" },
  );
});

test("packageMapFiles rejects unsupported versions", () => {
  assert.throws(() => packageMapFiles({ ...meta(), version: 3 } as unknown as PhotoSpaceMeta), /version/);
});

// mask.png/normal.png非同梱パッケージ向けの実行時導出(coreの焼き込みと同一実装)

test("computeSkyMask flags pixels below the threshold as sky", () => {
  const depth = { width: 2, height: 1, data: new Float32Array([0.01, 0.5]) };
  assert.deepEqual(Array.from(computeSkyMask(depth, 0.03)), [1, 0]);
});

test("computeEdgeMask returns ~1 (non-edge) on a flat depth field", () => {
  const depth = { width: 3, height: 3, data: new Float32Array(9).fill(0.5) };
  for (const v of computeEdgeMask(depth)) assert.ok(v > 0.99);
});

test("computeEdgeMask drops toward 0 at a sharp depth discontinuity", () => {
  const data = new Float32Array([0.9, 0.9, 0.1, 0.1]);
  const edge = computeEdgeMask({ width: 4, height: 1, data });
  assert.ok(edge[1] < 0.1);
  assert.ok(edge[2] < 0.1);
});

test("computeNormals points toward the camera (+z) on a flat depth field", () => {
  const depth = { width: 4, height: 4, data: new Float32Array(16).fill(0.5) };
  const { nx, ny, nz } = computeNormals(depth, 55, 12);
  const center = 1 * 4 + 1;
  assert.ok(Math.abs(nx[center]) < 0.2);
  assert.ok(Math.abs(ny[center]) < 0.2);
  assert.ok(nz[center] > 0.9);
});
