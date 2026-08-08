import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { DEFAULT_CONFIG, type DepthbakeMeta } from "depthbake-core";
import { encodeMaps, encodePhotoSources, loadSourcePhoto, writePackage } from "../src/io.ts";

function testMeta(): DepthbakeMeta {
  return {
    version: 2,
    source: { file: "source.jpg", width: 4, height: 4 },
    depth: { width: 4, height: 4, space: "disparity", orientation: "near=1", normalization: { min: 0, max: 1 } },
    camera: { fovDeg: 55, farRange: 12 },
    sky: { threshold: 0.03 },
    model: { name: "test", revision: "test" },
    bakedAt: "2026-01-01T00:00:00.000Z",
    sourceHash: "hash",
  };
}

test("encodeMaps reports the exact combined PNG size", async () => {
  const rgba = new Uint8ClampedArray(4 * 4 * 4).fill(127);
  const maps = await encodeMaps({
    depthRgba: rgba,
    maskRgba: rgba,
    normalRgba: rgba,
    width: 4,
    height: 4,
    compressionLevel: 9,
  });
  assert.equal(maps.totalBytes, maps.depth.byteLength + maps.mask!.byteLength + maps.normal!.byteLength);
  assert.ok(maps.totalBytes > 0);
});

test("encodeMaps encodes only the provided maps", async () => {
  const rgba = new Uint8ClampedArray(4 * 4 * 4).fill(127);
  const maps = await encodeMaps({ depthRgba: rgba, width: 4, height: 4, compressionLevel: 9 });
  assert.equal(maps.mask, undefined);
  assert.equal(maps.normal, undefined);
  assert.equal(maps.totalBytes, maps.depth.byteLength);
});

test("encodeMaps drops the constant alpha channel and keeps RGB values", async () => {
  const rgba = new Uint8ClampedArray([10, 20, 0, 255, 30, 40, 0, 255, 50, 60, 0, 255, 70, 80, 0, 255]);
  const maps = await encodeMaps({ depthRgba: rgba, width: 2, height: 2, compressionLevel: 9 });
  const { data, info } = await sharp(maps.depth).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.channels, 3);
  assert.deepEqual([...data], [10, 20, 0, 30, 40, 0, 50, 60, 0, 70, 80, 0]);
});

test("encodeMaps stays lossless beyond 256 unique colors (no palette quantization)", async () => {
  // RG16勾配で4096ユニーク色を作る。パレットPNG(最大256色)化すると必ず値が壊れる
  const w = 64, h = 64;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = Math.floor((i / (w * h - 1)) * 65535);
    rgba[i * 4] = v >> 8;
    rgba[i * 4 + 1] = v & 255;
    rgba[i * 4 + 2] = 0;
    rgba[i * 4 + 3] = 255;
  }
  const maps = await encodeMaps({ depthRgba: rgba, width: w, height: h, compressionLevel: 9 });
  const { data, info } = await sharp(maps.depth).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.channels, 3);
  for (let i = 0; i < w * h; i++) {
    assert.equal(data[i * 3] * 256 + data[i * 3 + 1], rgba[i * 4] * 256 + rgba[i * 4 + 1]);
  }
});

test("writePackage omits mask/normal files when not bundled", async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), "depthbake-io-"));
  const rgba = new Uint8ClampedArray(4 * 4 * 4).fill(127);
  const maps = await encodeMaps({ depthRgba: rgba, width: 4, height: 4, compressionLevel: 9, effort: 7 });
  await writePackage({
    outDir,
    photoSources: [{ file: "photo.jpg", type: "image/jpeg", bytes: new Uint8Array([1]), width: 4, height: 4 }],
    maps,
    meta: testMeta(),
  });
  assert.deepEqual((await readdir(outDir)).sort(), ["depth.png", "meta.json", "photo.jpg"]);
});

test("writePackage publishes only the new package files and cleans temporary directories", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "depthbake-io-"));
  const outDir = path.join(root, "package");
  await writeFile(path.join(root, "unrelated.txt"), "keep");

  const rgba = new Uint8ClampedArray(4 * 4 * 4).fill(127);
  const fullMaps = await encodeMaps({
    depthRgba: rgba,
    maskRgba: rgba,
    normalRgba: rgba,
    width: 4,
    height: 4,
    compressionLevel: 9,
  });
  await writePackage({
    outDir,
    photoSources: [
      { file: "photo.webp", type: "image/webp", bytes: new Uint8Array([1]), width: 4, height: 4 },
      { file: "photo.jpg", type: "image/jpeg", bytes: new Uint8Array([2]), width: 4, height: 4 },
    ],
    maps: fullMaps,
    meta: testMeta(),
  });

  const depthOnlyMaps = await encodeMaps({ depthRgba: rgba, width: 4, height: 4, compressionLevel: 9 });
  await writePackage({
    outDir,
    photoSources: [{ file: "photo.jpg", type: "image/jpeg", bytes: new Uint8Array([3]), width: 4, height: 4 }],
    maps: depthOnlyMaps,
    meta: testMeta(),
  });

  assert.deepEqual((await readdir(outDir)).sort(), ["depth.png", "meta.json", "photo.jpg"]);
  assert.deepEqual((await readdir(root)).sort(), ["package", "unrelated.txt"]);
});

test("writePackage keeps the existing package when a new write fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "depthbake-io-"));
  const outDir = path.join(root, "package");
  const rgba = new Uint8ClampedArray(4 * 4 * 4).fill(127);
  const maps = await encodeMaps({ depthRgba: rgba, width: 4, height: 4, compressionLevel: 9 });

  await writePackage({
    outDir,
    photoSources: [{ file: "photo.jpg", type: "image/jpeg", bytes: new Uint8Array([1]), width: 4, height: 4 }],
    maps,
    meta: testMeta(),
  });

  await assert.rejects(
    writePackage({
      outDir,
      photoSources: [{ file: "nested/photo.jpg", type: "image/jpeg", bytes: new Uint8Array([2]), width: 4, height: 4 }],
      maps,
      meta: testMeta(),
    }),
  );

  assert.deepEqual((await readdir(outDir)).sort(), ["depth.png", "meta.json", "photo.jpg"]);
  assert.deepEqual((await readdir(root)).sort(), ["package"]);
});

test("encodePhotoSources emits configured formats at one bounded resolution", async () => {
  const input = await sharp({
    create: { width: 8, height: 4, channels: 3, background: { r: 20, g: 40, b: 60 } },
  }).png().toBuffer();
  const sources = await encodePhotoSources(input, {
    ...DEFAULT_CONFIG.photo,
    maxSize: 4,
    formats: ["avif", "webp", "jpeg"],
  });

  assert.deepEqual(sources.map(({ file }) => file), ["photo.avif", "photo.webp", "photo.jpg"]);
  for (const source of sources) {
    assert.equal(source.width, 4);
    assert.equal(source.height, 2);
    assert.ok(source.bytes.byteLength > 0);
  }
});

for (const orientation of [6, 8]) {
  test(`loadSourcePhoto normalizes EXIF orientation ${orientation} for baking and model input`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "depthbake-io-"));
    const file = path.join(dir, `orientation-${orientation}.jpg`);
    const input = await sharp({
      create: { width: 3, height: 5, channels: 3, background: { r: 20, g: 40, b: 60 } },
    })
      .jpeg()
      .withMetadata({ orientation })
      .toBuffer();
    await writeFile(file, input);

    const photo = await loadSourcePhoto(file);
    assert.equal(photo.width, 5);
    assert.equal(photo.height, 3);

    assert.ok(photo.input instanceof Blob);
    const modelInput = Buffer.from(await photo.input.arrayBuffer());
    const modelMeta = await sharp(modelInput).metadata();
    assert.equal(modelMeta.width, 5);
    assert.equal(modelMeta.height, 3);

    const encoded = await encodePhotoSources(photo.bytes, {
      ...DEFAULT_CONFIG.photo,
      formats: ["jpeg"],
      maxSize: 64,
    });
    assert.equal(encoded[0].width, 5);
    assert.equal(encoded[0].height, 3);
  });
}
