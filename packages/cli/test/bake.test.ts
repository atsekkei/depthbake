import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runBake } from "../src/bake.ts";

async function captureConsoleError<T>(fn: () => Promise<T>): Promise<{ result: T; messages: string[] }> {
  const original = console.error;
  const messages: string[] = [];
  console.error = (...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  };
  try {
    return { result: await fn(), messages };
  } finally {
    console.error = original;
  }
}

async function captureConsoleLog<T>(fn: () => Promise<T>): Promise<{ result: T; messages: string[] }> {
  const original = console.log;
  const messages: string[] = [];
  console.log = (...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  };
  try {
    return { result: await fn(), messages };
  } finally {
    console.log = original;
  }
}

test("runBake reports failure when no input files match", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "photospace-bake-"));
  const pattern = path.join(dir, "*.jpg");
  const { result, messages } = await captureConsoleError(() => runBake([pattern], { out: path.join(dir, "out") }));

  assert.equal(result.failed, 1);
  assert.match(messages.join("\n"), /入力ファイルが見つかりませんでした/);
  assert.match(messages.join("\n"), new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("runBake dry-run resolves outputs without decoding images or loading the model", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "photospace-bake-"));
  const input = path.join(dir, "hero.jpg");
  await writeFile(input, "not an image");

  const { result, messages } = await captureConsoleLog(() => runBake([input], { out: path.join(dir, "out"), dryRun: true }));

  assert.equal(result.failed, 0);
  assert.equal(result.dryRun, true);
  assert.equal(result.files[0].status, "pending");
  assert.equal(result.files[0].input, input);
  assert.equal(result.files[0].output, path.join(dir, "out", "hero"));
  assert.ok(messages.some((message) => message.includes("plan")));
});

test("runBake quiet suppresses dry-run human output", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "photospace-bake-"));
  const input = path.join(dir, "hero.jpg");
  await writeFile(input, "not an image");

  const { result, messages } = await captureConsoleLog(() => runBake([input], { out: path.join(dir, "out"), dryRun: true, quiet: true }));

  assert.equal(result.failed, 0);
  assert.deepEqual(messages, []);
});

test("runBake detects output-name collisions before loading inputs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "photospace-bake-"));
  const a = path.join(dir, "campaign-a");
  const b = path.join(dir, "campaign-b");
  await mkdir(a);
  await mkdir(b);
  const first = path.join(a, "hero.jpg");
  const second = path.join(b, "hero.png");
  await writeFile(first, "not an image");
  await writeFile(second, "not an image");

  const { result, messages } = await captureConsoleError(() =>
    runBake([path.join(dir, "*", "hero.*")], { out: path.join(dir, "out") }),
  );

  const output = path.join(dir, "out", "hero");
  const message = messages.join("\n");
  assert.equal(result.failed, 2);
  assert.match(message, /出力先が衝突する入力があります/);
  assert.match(message, new RegExp(output.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(message, new RegExp(first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(message, new RegExp(second.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
