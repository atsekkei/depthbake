import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { formatInspectionHuman, inspectPackage, validatePackages } from "../src/package.ts";

async function writeTestPackage(options: { stale?: boolean; omitDepth?: boolean } = {}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "photospace-package-"));
  const photo = await sharp({
    create: { width: 4, height: 2, channels: 3, background: { r: 20, g: 40, b: 60 } },
  })
    .jpeg()
    .toBuffer();
  const depthRgb = Buffer.alloc(2 * 1 * 3);
  depthRgb[0] = 0;
  depthRgb[1] = 0;
  depthRgb[2] = 0;
  depthRgb[3] = 255;
  depthRgb[4] = 255;
  depthRgb[5] = 0;
  const depth = await sharp(depthRgb, { raw: { width: 2, height: 1, channels: 3 } }).png({ palette: false }).toBuffer();
  const mask = await sharp(Buffer.alloc(2 * 1 * 3, 255), { raw: { width: 2, height: 1, channels: 3 } }).png({ palette: false }).toBuffer();
  const meta = {
    version: 2,
    source: { file: "source.jpg", width: 4, height: 2 },
    photo: {
      file: "photo.jpg",
      width: 4,
      height: 2,
      sources: [{ file: "photo.jpg", type: "image/jpeg" }],
    },
    depth: {
      width: 2,
      height: 1,
      space: "disparity",
      orientation: "near=1",
      normalization: { min: 0, max: 1 },
    },
    mask: { file: "mask.png" },
    camera: { fovDeg: 55, farRange: 12 },
    sky: { threshold: 0.03 },
    model: { name: "test-model", revision: "test-revision" },
    bakedAt: "2026-01-01T00:00:00.000Z",
    sourceHash: "hash",
  };
  await writeFile(path.join(dir, "photo.jpg"), photo);
  if (!options.omitDepth) await writeFile(path.join(dir, "depth.png"), depth);
  await writeFile(path.join(dir, "mask.png"), mask);
  await writeFile(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  if (options.stale) await writeFile(path.join(dir, "normal.png"), mask);
  return dir;
}

test("inspectPackage summarizes a valid package", async () => {
  const dir = await writeTestPackage();
  const result = await inspectPackage(dir);

  assert.equal(result.valid, true);
  assert.equal(result.version, 2);
  assert.equal(result.photo?.formats[0].file, "photo.jpg");
  assert.equal(result.photo?.formats[0].width, 4);
  assert.equal(result.depth?.width, 2);
  assert.equal(result.maps.mask?.file, "mask.png");
  assert.equal(result.model?.name, "test-model");
  assert.ok(result.totalBytes > 0);
  assert.match(formatInspectionHuman(result), /test-model@test-revision/);
});

test("validatePackages reports missing declared files and stale artifacts", async () => {
  const missing = await writeTestPackage({ omitDepth: true });
  const stale = await writeTestPackage({ stale: true });
  const results = await validatePackages([missing, stale]);

  assert.equal(results[0].valid, false);
  assert.ok(results[0].errors.some((error) => error.includes("depth.png") && error.includes("missing")));
  assert.equal(results[1].valid, false);
  assert.ok(results[1].errors.some((error) => error.includes("normal.png") && error.includes("stale")));
});

test("validatePackages returns an invalid result for missing package directories", async () => {
  const dir = path.join(tmpdir(), "photospace-package-does-not-exist");
  const [result] = await validatePackages([dir]);

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("does not exist")));
});

test("inspectPackage validates size budgets and depth RG16 packing", async () => {
  const dir = await writeTestPackage();
  await writeFile(path.join(dir, "depth.png"), await sharp(Buffer.from([0, 0, 1]), { raw: { width: 1, height: 1, channels: 3 } }).png().toBuffer());
  const result = await inspectPackage(dir, { maxBytes: 1 });

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("B channel")));
  assert.ok(result.errors.some((error) => error.includes("exceeds budget")));
});
