import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { glob } from "glob";
import {
  bakeFromDisparity,
  loadDepthModel,
  estimateDepth,
  normalizeDisparity,
  DEFAULT_CONFIG,
  MODEL_DTYPES,
  computeSourceHash,
  nextMapMaxSize,
  type PhotoSpaceConfig,
  type PhotoFormat,
  type ModelDtype,
  type DepthModel,
  type BakedPackage,
  type SourcePhoto,
} from "photospace-core";
import {
  encodeMaps,
  encodePhotoSources,
  loadSourcePhoto,
  readExistingMeta,
  writePackage,
  type EncodedMaps,
} from "./io.ts";

const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "avif", "tiff"];

export interface BakeCommandOptions {
  config?: string;
  out: string;
  /** config値に対する上書き有効化(--mask / --normal フラグ) */
  mask?: boolean;
  normal?: boolean;
  force?: boolean;
  dryRun?: boolean;
  json?: boolean;
  quiet?: boolean;
}

export interface ConfigOverrides {
  mask?: boolean;
  normal?: boolean;
}

type ConfigRecord = Record<string, unknown>;

function formatConfigValue(value: unknown): string {
  const json = JSON.stringify(value);
  return json === undefined ? String(value) : json;
}

function configError(pathName: string, value: unknown, message: string): never {
  throw new Error(`${pathName}: ${message} (value: ${formatConfigValue(value)})`);
}

function isConfigRecord(value: unknown): value is ConfigRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKnownKeys(value: ConfigRecord, pathName: string, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) configError(pathName ? `${pathName}.${key}` : key, value[key], "未知の設定キーです");
  }
}

function optionalSection(raw: ConfigRecord, key: string, allowed: readonly string[]): ConfigRecord | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (!isConfigRecord(value)) configError(key, value, "オブジェクトで指定してください");
  assertKnownKeys(value, key, allowed);
  return value;
}

function validateOptionalNumber(
  section: ConfigRecord | undefined,
  pathName: string,
  min: number,
  max: number,
  opts: { integer?: boolean; exclusiveMin?: boolean; exclusiveMax?: boolean } = {},
): void {
  if (!section) return;
  const key = pathName.split(".").at(-1)!;
  const value = section[key];
  if (value === undefined) return;
  const minOk = opts.exclusiveMin ? Number(value) > min : Number(value) >= min;
  const maxOk = opts.exclusiveMax ? Number(value) < max : Number(value) <= max;
  if (typeof value !== "number" || !Number.isFinite(value) || !minOk || !maxOk) {
    const minText = opts.exclusiveMin ? `${min}より大きい値` : `${min}以上`;
    const maxText = opts.exclusiveMax ? `${max}未満` : `${max}以下`;
    configError(pathName, value, `${minText}かつ${maxText}の数値で指定してください`);
  }
  if (opts.integer && !Number.isInteger(value)) {
    configError(pathName, value, "整数で指定してください");
  }
}

function validateOptionalBoolean(section: ConfigRecord | undefined, pathName: string): void {
  if (!section) return;
  const key = pathName.split(".").at(-1)!;
  const value = section[key];
  if (value !== undefined && typeof value !== "boolean") {
    configError(pathName, value, "true/falseで指定してください");
  }
}

export function validateConfigSchema(raw: unknown): asserts raw is Partial<PhotoSpaceConfig> {
  if (!isConfigRecord(raw)) configError("config", raw, "オブジェクトで指定してください");
  assertKnownKeys(raw, "", ["version", "camera", "sky", "depth", "model", "maps", "photo"]);

  if (raw.version !== undefined && raw.version !== 1) {
    configError("version", raw.version, "1を指定してください");
  }

  const camera = optionalSection(raw, "camera", ["fovDeg", "farRange"]);
  validateOptionalNumber(camera, "camera.fovDeg", 0, 180, { exclusiveMin: true, exclusiveMax: true });
  validateOptionalNumber(camera, "camera.farRange", 0, Number.MAX_SAFE_INTEGER, { exclusiveMin: true });

  const sky = optionalSection(raw, "sky", ["threshold"]);
  validateOptionalNumber(sky, "sky.threshold", 0, 1);

  const depth = optionalSection(raw, "depth", ["maxSize"]);
  validateOptionalNumber(depth, "depth.maxSize", 64, 8192, { integer: true });

  const model = optionalSection(raw, "model", ["dtype"]);
  if (model?.dtype !== undefined && (typeof model.dtype !== "string" || !MODEL_DTYPES.includes(model.dtype as ModelDtype))) {
    configError("model.dtype", model.dtype, `${MODEL_DTYPES.join("/")} のいずれかで指定してください`);
  }

  const maps = optionalSection(raw, "maps", ["maxBytes", "pngCompressionLevel", "mask", "normal"]);
  validateOptionalNumber(maps, "maps.maxBytes", 0, Number.MAX_SAFE_INTEGER, { integer: true });
  validateOptionalNumber(maps, "maps.pngCompressionLevel", 0, 9, { integer: true });
  validateOptionalBoolean(maps, "maps.mask");
  validateOptionalBoolean(maps, "maps.normal");

  const photo = optionalSection(raw, "photo", ["maxSize", "formats", "avifQuality", "webpQuality", "jpegQuality"]);
  validateOptionalNumber(photo, "photo.maxSize", 64, 16384, { integer: true });
  validateOptionalNumber(photo, "photo.avifQuality", 0, 100);
  validateOptionalNumber(photo, "photo.webpQuality", 0, 100);
  validateOptionalNumber(photo, "photo.jpegQuality", 0, 100);

  const formats = photo?.formats;
  const supported = new Set<PhotoFormat>(["avif", "webp", "jpeg"]);
  if (formats !== undefined) {
    if (!Array.isArray(formats) || formats.some((format) => typeof format !== "string" || !supported.has(format as PhotoFormat))) {
      configError("photo.formats", formats, "avif/webp/jpeg の配列で指定してください");
    }
    if (!formats.includes("jpeg")) {
      configError("photo.formats", formats, "jpegを含めてください");
    }
  }
}

export async function loadConfig(configPath?: string, overrides: ConfigOverrides = {}): Promise<PhotoSpaceConfig> {
  const raw: unknown = configPath ? JSON.parse(await readFile(configPath, "utf-8")) : {};
  validateConfigSchema(raw);
  const formats = raw.photo?.formats ?? DEFAULT_CONFIG.photo.formats;
  const config: PhotoSpaceConfig = {
    ...DEFAULT_CONFIG,
    ...raw,
    camera: { ...DEFAULT_CONFIG.camera, ...raw.camera },
    sky: { ...DEFAULT_CONFIG.sky, ...raw.sky },
    depth: { ...DEFAULT_CONFIG.depth, ...raw.depth },
    model: { ...DEFAULT_CONFIG.model, ...raw.model },
    maps: {
      ...DEFAULT_CONFIG.maps,
      ...raw.maps,
      ...(overrides.mask !== undefined ? { mask: overrides.mask } : {}),
      ...(overrides.normal !== undefined ? { normal: overrides.normal } : {}),
    },
    photo: { ...DEFAULT_CONFIG.photo, ...raw.photo, formats },
  };
  return config;
}

async function resolveInputFiles(patterns: string[]): Promise<string[]> {
  const results = new Set<string>();
  for (const pattern of patterns) {
    let isDir = false;
    try {
      isDir = (await stat(pattern)).isDirectory();
    } catch {
      // not an existing path; treat as glob pattern
    }
    const matches = isDir
      ? await glob(`${pattern.replace(/\/$/, "")}/*.{${IMAGE_EXTENSIONS.join(",")}}`, { nocase: true })
      : await glob(pattern, { nocase: true });
    for (const m of matches) results.add(path.resolve(m));
  }
  return [...results].sort();
}

type PreparedInput =
  | { kind: "skip"; baseName: string }
  | { kind: "error"; baseName: string; error: Error }
  | { kind: "photo"; baseName: string; outDir: string; photo: SourcePhoto; sourceHash: string };

export interface BakeFileResult {
  input: string;
  output: string;
  status: "baked" | "skipped" | "failed" | "pending";
  message?: string;
}

export interface BakeRunResult {
  total: number;
  baked: number;
  skipped: number;
  failed: number;
  dryRun: boolean;
  files: BakeFileResult[];
}

interface ResolvedInput {
  file: string;
  baseName: string;
  outDir: string;
}

function resolveOutputPaths(files: string[], outRoot: string): ResolvedInput[] {
  return files.map((file) => {
    const baseName = path.basename(file).replace(/\.[^.]+$/, "");
    return {
      file,
      baseName,
      outDir: path.join(outRoot, baseName),
    };
  });
}

function findOutputCollisions(inputs: ResolvedInput[]): Map<string, ResolvedInput[]> {
  const byOutDir = new Map<string, ResolvedInput[]>();
  for (const input of inputs) {
    const existing = byOutDir.get(input.outDir);
    if (existing) {
      existing.push(input);
    } else {
      byOutDir.set(input.outDir, [input]);
    }
  }
  for (const [outDir, group] of byOutDir) {
    if (group.length < 2) byOutDir.delete(outDir);
  }
  return byOutDir;
}

function formatOutputCollisions(collisions: Map<string, ResolvedInput[]>): string {
  const blocks: string[] = [];
  for (const [outDir, inputs] of collisions) {
    blocks.push(`  ${outDir}\n${inputs.map((input) => `    - ${input.file}`).join("\n")}`);
  }
  return `出力先が衝突する入力があります。別名のファイルを使うか出力先を分けてください。\n${blocks.join("\n")}`;
}

/** 入力1枚の読み込み・スキップ判定・デコード。前の写真の推論と重ねて先読みできるよう独立させている */
async function prepareInput(input: ResolvedInput, config: PhotoSpaceConfig, force = false): Promise<PreparedInput> {
  const { file, baseName, outDir } = input;
  try {
    const photoBytes = await readFile(file);
    const sourceHash = await computeSourceHash(photoBytes, config);
    const existing = await readExistingMeta(outDir);
    // configはハッシュに含まれるため通常は自動でリベイクされるが、旧version出力の温存を明示的に防ぐ
    if (!force && existing?.sourceHash === sourceHash && existing.version === 2) {
      return { kind: "skip", baseName };
    }
    const photo = await loadSourcePhoto(file);
    return { kind: "photo", baseName, outDir, photo, sourceHash };
  } catch (e) {
    return { kind: "error", baseName, error: e as Error };
  }
}

/**
 * 推論からマップPNGエンコードまで。maps.maxBytes超過時は解像度を下げて再試行する。
 * sourceHashは計算済みの値を渡し、再試行時に写真バイト列のSHA-256を再計算しない。
 */
async function bakeWithSizeLimit(
  model: DepthModel,
  photo: SourcePhoto,
  config: PhotoSpaceConfig,
  sourceHash: string,
): Promise<{ baked: BakedPackage; maps: EncodedMaps }> {
  const result = await estimateDepth(model, photo.input);
  const normalized = normalizeDisparity(result.raw);
  const lowRes = { width: result.width, height: result.height, data: normalized.data };

  let mapMaxSize = config.depth.maxSize;
  while (true) {
    const effectiveConfig: PhotoSpaceConfig = {
      ...config,
      depth: { ...config.depth, maxSize: mapMaxSize },
    };
    const baked = await bakeFromDisparity(photo, lowRes, { min: normalized.min, max: normalized.max }, {
      config: effectiveConfig,
      sourceHash,
    });
    const maps = await encodeMaps({
      depthRgba: baked.depthRgba,
      maskRgba: baked.maskRgba,
      normalRgba: baked.normalRgba,
      width: baked.depthWidth,
      height: baked.depthHeight,
      compressionLevel: config.maps.pngCompressionLevel,
    });
    if (config.maps.maxBytes <= 0 || maps.totalBytes <= config.maps.maxBytes) return { baked, maps };
    const actualMaxSize = Math.max(baked.depthWidth, baked.depthHeight);
    if (actualMaxSize <= 64) {
      throw new Error(`maps.maxBytes=${config.maps.maxBytes}を最小解像度でも満たせませんでした。`);
    }
    mapMaxSize = nextMapMaxSize(actualMaxSize, maps.totalBytes, config.maps.maxBytes);
  }
}

/** 写真の各フォーマットへのエンコードとパッケージ書き出し。次の写真の推論と重ねて実行される */
async function finalizePackage(
  prepared: { photo: SourcePhoto; outDir: string },
  baked: BakedPackage,
  maps: EncodedMaps,
  config: PhotoSpaceConfig,
): Promise<void> {
  const photoSources = await encodePhotoSources(prepared.photo.bytes, config.photo);
  const firstPhoto = photoSources[0];
  // meta.sourceHashはbakeFromDisparityへ渡した計算済みハッシュが既に入っている
  baked.meta.photo = {
    file: firstPhoto.file,
    width: firstPhoto.width,
    height: firstPhoto.height,
    sources: photoSources.map(({ file, type }) => ({ file, type })),
  };
  await writePackage({
    outDir: prepared.outDir,
    photoSources,
    maps,
    meta: baked.meta,
  });
}

/**
 * `photospace bake` の本体。推論は1枚ずつ直列だが、次の写真の読み込み・デコード(先読み1枚)と
 * 前の写真のエンコード・書き出し(後段1枚)を推論とオーバーラップさせる小さなパイプラインで回す。
 * 1枚失敗しても他ファイルの処理は継続する。
 */
function createProgressReporter(enabled: boolean): ((p: { status: string; progress?: number; total?: number }) => void) | undefined {
  if (!enabled) return undefined;
  let lastLine = "";
  return (p) => {
    const pct = p.progress !== undefined ? ` ${Math.round(p.progress)}%` : "";
    const total = p.total !== undefined ? ` / ${p.total}` : "";
    const line = `model ${p.status}${pct}${total}`;
    if (line === lastLine) return;
    lastLine = line;
    console.error(line);
  };
}

export async function runBake(patterns: string[], opts: BakeCommandOptions): Promise<BakeRunResult> {
  const log = (...args: unknown[]) => {
    if (!opts.quiet && !opts.json) console.log(...args);
  };
  const fail = (files: BakeFileResult[] = []): BakeRunResult => ({
    total: files.length,
    baked: 0,
    skipped: 0,
    failed: Math.max(1, files.filter((file) => file.status === "failed").length || files.length),
    dryRun: opts.dryRun === true,
    files,
  });

  const config = await loadConfig(opts.config, { mask: opts.mask, normal: opts.normal });
  const files = await resolveInputFiles(patterns);

  if (files.length === 0) {
    console.error("入力ファイルが見つかりませんでした:", patterns.join(", "));
    return fail();
  }

  const outRoot = path.resolve(opts.out);
  const inputs = resolveOutputPaths(files, outRoot);
  const initialFiles: BakeFileResult[] = inputs.map((input) => ({
    input: input.file,
    output: input.outDir,
    status: opts.dryRun ? "pending" : "failed",
  }));
  const collisions = findOutputCollisions(inputs);
  if (collisions.size > 0) {
    console.error(formatOutputCollisions(collisions));
    return {
      total: inputs.length,
      baked: 0,
      skipped: 0,
      failed: inputs.length,
      dryRun: opts.dryRun === true,
      files: initialFiles.map((file) => ({ ...file, status: "failed", message: "output path collision" })),
    };
  }

  if (opts.dryRun) {
    log(`${inputs.length}枚を処理できます(config: ${opts.config ?? "既定値"})`);
    for (const input of inputs) log(`plan  ${input.file} -> ${input.outDir}`);
    return {
      total: inputs.length,
      baked: 0,
      skipped: 0,
      failed: 0,
      dryRun: true,
      files: initialFiles,
    };
  }

  log(`${files.length}枚を処理します(config: ${opts.config ?? "既定値"})`);
  const model = await loadDepthModel({
    dtype: config.model.dtype,
    onProgress: createProgressReporter(Boolean(process.stdout.isTTY && !opts.quiet && !opts.json)),
  });

  let failed = 0;
  let skipped = 0;
  let bakedCount = 0;
  let pendingFinalize: Promise<void> | null = null;
  const results = new Map<string, BakeFileResult>();
  let nextPrepared = prepareInput(inputs[0], config, opts.force);
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    const prepared = await nextPrepared;
    // 先読み: 現在の写真の推論中に次の写真の読み込み・デコードを進める
    if (i + 1 < inputs.length) nextPrepared = prepareInput(inputs[i + 1], config, opts.force);

    if (prepared.kind === "skip") {
      log(`skip  ${prepared.baseName} (変更なし)`);
      skipped++;
      results.set(input.file, { input: input.file, output: input.outDir, status: "skipped", message: "unchanged" });
      continue;
    }
    if (prepared.kind === "error") {
      failed++;
      console.error(`FAIL  ${prepared.baseName}:`, prepared.error.message);
      results.set(input.file, { input: input.file, output: input.outDir, status: "failed", message: prepared.error.message });
      continue;
    }

    let result;
    try {
      result = await bakeWithSizeLimit(model, prepared.photo, config, prepared.sourceHash);
    } catch (e) {
      failed++;
      console.error(`FAIL  ${prepared.baseName}:`, (e as Error).message);
      results.set(input.file, { input: input.file, output: input.outDir, status: "failed", message: (e as Error).message });
      continue;
    }

    // 後段は1枚分だけ先行を許す(並列度は固定)。前の書き出し完了を待ってから次を投入する
    if (pendingFinalize) await pendingFinalize;
    pendingFinalize = finalizePackage(prepared, result.baked, result.maps, config).then(
      () => {
        bakedCount++;
        results.set(input.file, { input: input.file, output: input.outDir, status: "baked" });
        log(`bake  ${prepared.baseName} -> ${prepared.outDir}`);
      },
      (e: Error) => {
        failed++;
        results.set(input.file, { input: input.file, output: input.outDir, status: "failed", message: e.message });
        console.error(`FAIL  ${prepared.baseName}:`, e.message);
      },
    );
  }
  if (pendingFinalize) await pendingFinalize;

  const fileResults = inputs.map((input) =>
    results.get(input.file) ?? { input: input.file, output: input.outDir, status: "failed" as const, message: "unknown result" },
  );
  log(`完了: ${bakedCount}件ベイク / ${skipped}件スキップ / ${failed}件失敗`);
  return { total: files.length, baked: bakedCount, skipped, failed, dryRun: false, files: fileResults };
}
