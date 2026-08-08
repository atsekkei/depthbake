import test from "node:test";
import assert from "node:assert/strict";
import { loadPackage, loadPackageStaged } from "../loader.ts";
import type { PhotoSpaceMeta } from "../loader.ts";

/**
 * 段階ロードの検証。ブラウザAPI(location / createImageBitmap / Response)を
 * 差し替えて、fetchの順序・中断・未awaitのrejection処理だけを見る。
 */

const META: PhotoSpaceMeta = {
  version: 2,
  source: { file: "photo.jpg", width: 960, height: 640 },
  photo: { file: "photo.jpg", sources: [{ file: "photo.jpg", type: "image/jpeg" }] },
  depth: {
    width: 8,
    height: 8,
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

interface Route {
  delayMs?: number;
  status?: number;
}

/** ファイル名 → 遅延/ステータス。未登録のURLは404扱い */
function installFetch(routes: Record<string, Route>): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const file = url.slice(url.lastIndexOf("/") + 1);
    calls.push(file);
    const route = routes[file];
    if (!route) return { ok: false, status: 404 } as Response;

    if (route.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, route.delayMs);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    }
    if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const status = route.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => META,
      blob: async () => ({ size: 1 }) as Blob,
    } as Response;
  }) as typeof fetch;

  return { calls, restore: () => { globalThis.fetch = original; } };
}

function installBrowserGlobals(): () => void {
  const g = globalThis as Record<string, unknown>;
  const hadLocation = "location" in g;
  const prevLocation = g.location;
  const prevCreate = g.createImageBitmap;
  g.location = { href: "https://example.test/" };
  g.createImageBitmap = async () => ({ width: 8, height: 8, close() {} }) as unknown as ImageBitmap;
  return () => {
    if (hadLocation) g.location = prevLocation;
    else delete g.location;
    g.createImageBitmap = prevCreate;
  };
}

const ALL_OK: Record<string, Route> = {
  "meta.json": {},
  "photo.jpg": {},
  "depth.png": {},
};

test("photoはdepthの完了を待たずに解決する", async () => {
  const restoreGlobals = installBrowserGlobals();
  // depth.pngは実パッケージで写真の5〜15倍重い。それを待たずに描き始められること
  const { restore } = installFetch({
    "meta.json": {},
    "photo.jpg": { delayMs: 5 },
    "depth.png": { delayMs: 120 },
  });
  try {
    const pkg = loadPackageStaged("/out/hero/", { need: ["photo", "depth"] });
    const order: string[] = [];
    const photo = pkg.photo.then(() => order.push("photo"));
    const ready = pkg.ready.then(() => order.push("ready"));
    await photo;
    assert.deepEqual(order, ["photo"], "photoの時点でreadyはまだ解決していない");
    await ready;
    assert.deepEqual(order, ["photo", "ready"]);
  } finally {
    restore();
    restoreGlobals();
  }
});

test("needで除外した要素のpromiseはundefinedで解決し、フェッチもされない", async () => {
  const restoreGlobals = installBrowserGlobals();
  const { calls, restore } = installFetch(ALL_OK);
  try {
    const pkg = loadPackageStaged("/out/hero/", { need: ["photo"] });
    assert.equal(await pkg.depthBitmap, undefined);
    assert.equal(await pkg.maskBitmap, undefined);
    assert.equal(await pkg.normalBitmap, undefined);
    assert.notEqual(await pkg.photo, undefined);
    await pkg.ready;
    assert.deepEqual(calls.sort(), ["meta.json", "photo.jpg"]);
  } finally {
    restore();
    restoreGlobals();
  }
});

test("signalで進行中のfetchが中断される", async () => {
  const restoreGlobals = installBrowserGlobals();
  const { restore } = installFetch({
    "meta.json": {},
    "photo.jpg": { delayMs: 200 },
    "depth.png": { delayMs: 200 },
  });
  try {
    const controller = new AbortController();
    const pkg = loadPackageStaged("/out/hero/", {
      need: ["photo", "depth"],
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(pkg.ready, (error: Error) => error.name === "AbortError");
    await assert.rejects(pkg.photo, (error: Error) => error.name === "AbortError");
  } finally {
    restore();
    restoreGlobals();
  }
});

test("中断時は写真の残り候補を試さない", async () => {
  const restoreGlobals = installBrowserGlobals();
  const original = globalThis.fetch;
  const calls: string[] = [];
  // avif → webp → jpg の3候補を持つmeta。中断は「この候補がダメ」ではないので
  // 次の候補へフォールバックしてはいけない
  const multi = {
    ...META,
    photo: {
      file: "photo.avif",
      sources: [
        { file: "photo.avif", type: "image/avif" },
        { file: "photo.webp", type: "image/webp" },
        { file: "photo.jpg", type: "image/jpeg" },
      ],
    },
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const file = url.slice(url.lastIndexOf("/") + 1);
    calls.push(file);
    if (file === "meta.json") {
      return { ok: true, status: 200, json: async () => multi } as Response;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 200);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      });
    });
    return { ok: true, status: 200, blob: async () => ({ size: 1 }) as Blob } as Response;
  }) as typeof fetch;
  try {
    const controller = new AbortController();
    const pkg = loadPackageStaged("/out/hero/", { need: ["photo"], signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(pkg.photo, (error: Error) => error.name === "AbortError");
    assert.deepEqual(calls, ["meta.json", "photo.avif"], "中断後に次の候補を取りに行かない");
  } finally {
    globalThis.fetch = original;
    restoreGlobals();
  }
});

test("未awaitのstageがrejectしてもunhandled rejectionにならない", async () => {
  const restoreGlobals = installBrowserGlobals();
  // depth.pngだけ404。photoしか使わない利用者を再現する
  const { restore } = installFetch({ "meta.json": {}, "photo.jpg": {} });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const pkg = loadPackageStaged("/out/hero/", { need: ["photo", "depth"] });
    assert.notEqual(await pkg.photo, undefined);
    // depthBitmap と ready は誰もawaitしない。イベントループを数回回して確認する
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    restore();
    restoreGlobals();
  }
});

test("未awaitでもstage promise自体は従来どおりrejectする", async () => {
  const restoreGlobals = installBrowserGlobals();
  const { restore } = installFetch({ "meta.json": {}, "photo.jpg": {} });
  try {
    const pkg = loadPackageStaged("/out/hero/", { need: ["photo", "depth"] });
    await new Promise((resolve) => setTimeout(resolve, 0)); // 先にrejectさせる
    await assert.rejects(pkg.depthBitmap, /depth\.png/);
    await assert.rejects(pkg.ready, /depth\.png/);
  } finally {
    restore();
    restoreGlobals();
  }
});

test("loadPackageは段階APIのready相当で、従来どおり全部揃ってから解決する", async () => {
  const restoreGlobals = installBrowserGlobals();
  const { calls, restore } = installFetch(ALL_OK);
  try {
    const pkg = await loadPackage("/out/hero/", { need: ["photo", "depth"] });
    assert.equal(pkg.meta.version, 2);
    assert.equal(pkg.depthWidth, 8);
    assert.equal(pkg.depthHeight, 8);
    assert.notEqual(pkg.photo, undefined);
    assert.notEqual(pkg.depthBitmap, undefined);
    assert.equal(pkg.maskBitmap, undefined);
    assert.deepEqual(calls.sort(), ["depth.png", "meta.json", "photo.jpg"]);
  } finally {
    restore();
    restoreGlobals();
  }
});

test("未対応versionはマップを取りに行く前にrejectする", async () => {
  const restoreGlobals = installBrowserGlobals();
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const file = url.slice(url.lastIndexOf("/") + 1);
    calls.push(file);
    return {
      ok: true,
      status: 200,
      json: async () => ({ ...META, version: 99 }),
      blob: async () => ({ size: 1 }) as Blob,
    } as Response;
  }) as typeof fetch;
  try {
    const pkg = loadPackageStaged("/out/hero/");
    await assert.rejects(pkg.ready, /version/);
    assert.deepEqual(calls, ["meta.json"], "meta.json以外はフェッチされない");
  } finally {
    globalThis.fetch = original;
    restoreGlobals();
  }
});
