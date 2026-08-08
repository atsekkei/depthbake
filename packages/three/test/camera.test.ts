import test from "node:test";
import assert from "node:assert/strict";
import {
  coverFitTanHalf,
  quantileDisparity,
  PhotoSpaceCamera,
  type PhotoSpaceAsset,
} from "../index.ts";
import type { PhotoSpaceMeta, PartialPhotoSpacePackage } from "photospace-runtime";

const FOV_DEG = 55;
const FAR_RANGE = 12;

function meta(width = 1600, height = 1000): PhotoSpaceMeta {
  return {
    version: 2,
    source: { file: "source.jpg", width, height },
    depth: {
      width: 4,
      height: 4,
      space: "disparity",
      orientation: "near=1",
      normalization: { min: 0, max: 1 },
    },
    camera: { fovDeg: FOV_DEG, farRange: FAR_RANGE },
    sky: { threshold: 0.03 },
    model: { name: "test", revision: "test" },
    bakedAt: "2026-01-01T00:00:00.000Z",
    sourceHash: "hash",
  };
}

/** テクスチャを作らずに PhotoSpaceCamera だけを検証するための最小アセット */
function fakeAsset(depth?: Float32Array, width = 1600, height = 1000): PhotoSpaceAsset {
  const m = meta(width, height);
  return {
    meta: m,
    aspect: width / height,
    uniforms: undefined as unknown as PhotoSpaceAsset["uniforms"],
    package: { meta: m, depth, depthWidth: 4, depthHeight: 4 } as PartialPhotoSpacePackage,
    dispose() {},
  };
}

test("coverFitTanHalf: ビューが写真より横長なら横FOVを写真に合わせて切り出す", () => {
  const base = Math.tan((FOV_DEG * Math.PI) / 360);
  // 写真16:10、ビュー20:10 → ビューのほうが横長なので縮める
  const wide = coverFitTanHalf(base, 1.6, 2.0, 1);
  assert.ok(wide < base);
  assert.equal(wide, base * (1.6 / 2.0));
});

test("coverFitTanHalf: ビューが写真より縦長なら縦FOVをそのまま使う", () => {
  const base = Math.tan((FOV_DEG * Math.PI) / 360);
  // 写真16:10、ビュー10:16 → min(1, 1.6/0.625)=1 で base のまま
  assert.equal(coverFitTanHalf(base, 1.6, 0.625, 1), base);
});

test("coverFitTanHalf: frameZoom<1 は寄る(tanHalfが小さくなる)", () => {
  const base = Math.tan((FOV_DEG * Math.PI) / 360);
  assert.equal(coverFitTanHalf(base, 1.6, 1.6, 0.82), base * 0.82);
  assert.ok(coverFitTanHalf(base, 1.6, 1.6, 0.82) < coverFitTanHalf(base, 1.6, 1.6, 1));
});

// Float32Arrayに入れた時点で値はfloat32に丸まるので、期待値も同じ丸めを通す
const f32 = Math.fround;

test("quantileDisparity: 視差は大=近なので手前分位は昇順ソートの後ろから取る", () => {
  const depth = Float32Array.from([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
  // quantile=0.1 → index floor(10*0.9)=9 → 最大値
  assert.equal(quantileDisparity(depth, 0.1), f32(0.9));
  // quantile=0.5 → index 5
  assert.equal(quantileDisparity(depth, 0.5), f32(0.5));
  // 手前(=大きい視差)側を取っていることの確認
  assert.ok(quantileDisparity(depth, 0.1) > quantileDisparity(depth, 0.9));
});

test("quantileDisparity: 入力を破壊しない", () => {
  const depth = Float32Array.from([0.9, 0.1, 0.5]);
  quantileDisparity(depth, 0.1);
  assert.deepEqual(Array.from(depth), [f32(0.9), f32(0.1), f32(0.5)]);
});

test("quantileDisparity: 境界の分位でも範囲外アクセスしない", () => {
  const depth = Float32Array.from([0.2, 0.4, 0.6]);
  assert.equal(quantileDisparity(depth, 0), f32(0.6));
  assert.equal(quantileDisparity(depth, 1), f32(0.2));
});

test("PhotoSpaceCamera: 初期FOVはmeta.camera.fovDeg", () => {
  const camera = new PhotoSpaceCamera(fakeAsset());
  assert.equal(camera.fov, FOV_DEG);
  assert.equal(camera.aspect, 1.6);
});

test("PhotoSpaceCamera: setSizeでcover-fitのFOVとアスペクトになる", () => {
  const camera = new PhotoSpaceCamera(fakeAsset(), { frameZoom: 1 });
  camera.setSize(2000, 1000); // ビュー20:10 は写真16:10より横長
  assert.equal(camera.aspect, 2);
  const expected = (Math.atan(coverFitTanHalf(Math.tan((FOV_DEG * Math.PI) / 360), 1.6, 2, 1)) * 360) / Math.PI;
  assert.ok(Math.abs(camera.fov - expected) < 1e-10);
  assert.ok(camera.fov < FOV_DEG);
});

test("PhotoSpaceCamera: pivotZは注視深度をワールド距離で返し、キャッシュされる", () => {
  const depth = Float32Array.from([0, 0.25, 0.5, 0.75]);
  const asset = fakeAsset(depth);
  const camera = new PhotoSpaceCamera(asset, { pivotQuantile: 0.1 });

  // quantile=0.1 → index floor(4*0.9)=3 → 視差0.75
  // z = 1 / mix(1/far, 1, d)
  const d = 0.75;
  const expected = 1 / ((1 - d) / FAR_RANGE + d);
  assert.ok(Math.abs(camera.pivotZ - expected) < 1e-6);

  // 2回目以降はdepthを読まない(depthを外しても同じ値が返る)
  (asset.package as { depth?: Float32Array }).depth = undefined;
  assert.ok(Math.abs(camera.pivotZ - expected) < 1e-6);
});

test("PhotoSpaceCamera: depth未ロードならpivotZは理由の分かるエラーを投げる", () => {
  const camera = new PhotoSpaceCamera(fakeAsset(undefined));
  assert.throws(() => camera.pivotZ, /depth/);
});
