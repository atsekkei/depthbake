import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../src/bake.ts";

async function writeConfig(json: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "photospace-config-"));
  const file = path.join(dir, "config.json");
  await writeFile(file, JSON.stringify(json));
  return file;
}

test("loadConfig defaults include jpeg and disable extra maps", async () => {
  const config = await loadConfig();
  assert.ok(config.photo.formats.includes("jpeg"));
  assert.equal(config.maps.mask, false);
  assert.equal(config.maps.normal, false);
});

test("loadConfig rejects photo.formats without jpeg", async () => {
  const file = await writeConfig({ photo: { formats: ["avif"] } });
  await assert.rejects(loadConfig(file), /jpeg/);
});

test("loadConfig rejects non-boolean maps.mask", async () => {
  const file = await writeConfig({ maps: { mask: "yes" } });
  await assert.rejects(loadConfig(file), /maps\.mask/);
});

test("loadConfig defaults model.dtype to fp32 and accepts q8", async () => {
  assert.equal((await loadConfig()).model.dtype, "fp32");
  const file = await writeConfig({ model: { dtype: "q8" } });
  assert.equal((await loadConfig(file)).model.dtype, "q8");
});

test("loadConfig rejects unknown model.dtype", async () => {
  const file = await writeConfig({ model: { dtype: "fp64" } });
  await assert.rejects(loadConfig(file), /model\.dtype/);
});

test("loadConfig applies flag overrides on top of config values", async () => {
  const file = await writeConfig({ maps: { mask: false, normal: true } });
  const config = await loadConfig(file, { mask: true });
  assert.equal(config.maps.mask, true);
  assert.equal(config.maps.normal, true);
});

test("loadConfig rejects unknown top-level and nested config keys", async () => {
  const topLevel = await writeConfig({ photos: {} });
  await assert.rejects(loadConfig(topLevel), /photos.*未知の設定キー.*\{\}/);

  const nested = await writeConfig({ photo: { jpegQality: 80 } });
  await assert.rejects(loadConfig(nested), /photo\.jpegQality.*未知の設定キー.*80/);
});

test("loadConfig rejects invalid section types", async () => {
  const file = await writeConfig({ camera: "wide" });
  await assert.rejects(loadConfig(file), /camera.*オブジェクト.*"wide"/);
});

test("loadConfig validates version, camera, and sky fields with path and value", async () => {
  await assert.rejects(loadConfig(await writeConfig({ version: 2 })), /version.*1.*2/);
  await assert.rejects(loadConfig(await writeConfig({ camera: { fovDeg: 180 } })), /camera\.fovDeg.*180/);
  await assert.rejects(loadConfig(await writeConfig({ camera: { farRange: 0 } })), /camera\.farRange.*0/);
  await assert.rejects(loadConfig(await writeConfig({ sky: { threshold: 2 } })), /sky\.threshold.*2/);
});

test("loadConfig rejects invalid field types and non-integer integer fields", async () => {
  await assert.rejects(loadConfig(await writeConfig({ depth: { maxSize: 128.5 } })), /depth\.maxSize.*128\.5/);
  await assert.rejects(loadConfig(await writeConfig({ maps: { maxBytes: "1000" } })), /maps\.maxBytes.*"1000"/);
  await assert.rejects(loadConfig(await writeConfig({ maps: { pngCompressionLevel: 4.5 } })), /maps\.pngCompressionLevel.*4\.5/);
  await assert.rejects(loadConfig(await writeConfig({ photo: { maxSize: 100.5 } })), /photo\.maxSize.*100\.5/);
  await assert.rejects(loadConfig(await writeConfig({ photo: { webpQuality: "75" } })), /photo\.webpQuality.*"75"/);
});
