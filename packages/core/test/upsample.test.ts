import { test } from "node:test";
import assert from "node:assert/strict";
import { rgbaToGrayF32, bilinearResizeF32, resizeRgbaToGrayF32, type RasterF32 } from "../src/upsample.ts";

test("rgbaToGrayF32 applies the luma weights and normalizes to 0..1", () => {
  const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 255]);
  const gray = rgbaToGrayF32(rgba, 2, 1);
  assert.ok(Math.abs(gray.data[0] - 0.299) < 1e-6);
  assert.equal(gray.data[1], 0);
});

test("bilinearResizeF32 preserves a flat raster's value", () => {
  const src: RasterF32 = { width: 2, height: 2, data: new Float32Array([1, 1, 1, 1]) };
  const resized = bilinearResizeF32(src, 4, 4);
  assert.equal(resized.width, 4);
  assert.equal(resized.height, 4);
  for (const v of resized.data) assert.ok(Math.abs(v - 1) < 1e-6);
});

test("resizeRgbaToGrayF32 matches gray-then-resize", () => {
  const srcW = 6;
  const srcH = 4;
  const rgba = new Uint8ClampedArray(srcW * srcH * 4);
  for (let i = 0; i < srcW * srcH; i++) {
    rgba[i * 4] = (i * 37) % 256;
    rgba[i * 4 + 1] = (i * 91) % 256;
    rgba[i * 4 + 2] = (i * 149) % 256;
    rgba[i * 4 + 3] = 255;
  }
  const dstW = 3;
  const dstH = 2;
  const expected = bilinearResizeF32(rgbaToGrayF32(rgba, srcW, srcH), dstW, dstH);
  const actual = resizeRgbaToGrayF32(rgba, srcW, srcH, dstW, dstH);
  assert.equal(actual.width, dstW);
  assert.equal(actual.height, dstH);
  for (let i = 0; i < expected.data.length; i++) {
    assert.ok(Math.abs(actual.data[i] - expected.data[i]) < 1e-5);
  }
});

test("resizeRgbaToGrayF32 matches rgbaToGrayF32 when sizes are equal", () => {
  const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30, 255, 200, 100, 50, 255]);
  const expected = rgbaToGrayF32(rgba, 2, 2);
  const actual = resizeRgbaToGrayF32(rgba, 2, 2, 2, 2);
  for (let i = 0; i < expected.data.length; i++) {
    assert.ok(Math.abs(actual.data[i] - expected.data[i]) < 1e-6);
  }
});

test("bilinearResizeF32 is a no-op when target size matches source", () => {
  const src: RasterF32 = { width: 2, height: 2, data: new Float32Array([0, 1, 2, 3]) };
  const resized = bilinearResizeF32(src, 2, 2);
  for (let i = 0; i < src.data.length; i++) {
    assert.ok(Math.abs(resized.data[i] - src.data[i]) < 1e-6);
  }
});
