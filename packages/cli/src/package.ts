import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

type MetaRecord = Record<string, unknown>;

export interface PackageFileSummary {
  file: string;
  bytes: number;
}

export interface PackageInspection {
  path: string;
  valid: boolean;
  errors: string[];
  version?: number;
  source?: { file: string; width: number; height: number };
  photo?: {
    width?: number;
    height?: number;
    formats: Array<{ file: string; type?: string; width?: number; height?: number; bytes?: number }>;
  };
  depth?: {
    file: string;
    width?: number;
    height?: number;
    encoding: "rg16-disparity";
    bytes?: number;
  };
  maps: {
    mask?: { file: string; width?: number; height?: number; bytes?: number };
    normal?: { file: string; width?: number; height?: number; bytes?: number };
  };
  files: PackageFileSummary[];
  totalBytes: number;
  model?: { name: string; revision: string };
  sourceHash?: string;
}

type PhotoFormatSummary = NonNullable<PackageInspection["photo"]>["formats"][number];
type MapSummary = NonNullable<PackageInspection["maps"]["mask"]>;

export interface ValidatePackagesOptions {
  maxBytes?: number;
}

function isRecord(value: unknown): value is MetaRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, pathName: string, errors: string[]): MetaRecord | undefined {
  if (isRecord(value)) return value;
  errors.push(`${pathName}: object expected`);
  return undefined;
}

function requireString(record: MetaRecord, key: string, pathName: string, errors: string[]): string | undefined {
  const value = record[key];
  if (typeof value === "string") return value;
  errors.push(`${pathName}.${key}: string expected`);
  return undefined;
}

function requireNumber(record: MetaRecord, key: string, pathName: string, errors: string[]): number | undefined {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  errors.push(`${pathName}.${key}: finite number expected`);
  return undefined;
}

function requireInteger(record: MetaRecord, key: string, pathName: string, errors: string[]): number | undefined {
  const value = requireNumber(record, key, pathName, errors);
  if (value !== undefined && !Number.isInteger(value)) errors.push(`${pathName}.${key}: integer expected`);
  return value;
}

function optionalDeclaredFile(record: MetaRecord | undefined, pathName: string, errors: string[]): string | undefined {
  if (!record) return undefined;
  const file = requireString(record, "file", pathName, errors);
  if (file && path.basename(file) !== file) errors.push(`${pathName}.file: package files must be direct children (${file})`);
  return file;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const s = await stat(filePath);
    return s.isFile();
  } catch {
    return false;
  }
}

async function fileBytes(filePath: string): Promise<number | undefined> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return undefined;
  }
}

async function imageMetadata(filePath: string): Promise<{ width?: number; height?: number; channels?: number }> {
  const meta = await sharp(filePath).metadata();
  return { width: meta.width, height: meta.height, channels: meta.channels };
}

async function validateDepthPacking(filePath: string, errors: string[]): Promise<void> {
  const { data, info } = await sharp(filePath).raw().toBuffer({ resolveWithObject: true });
  if (info.channels < 3) {
    errors.push("depth.png: RGB channels are required for RG16 packing");
    return;
  }
  for (let i = 0; i < info.width * info.height; i++) {
    if (data[i * info.channels + 2] !== 0) {
      errors.push("depth.png: B channel must be zero for RG16 packing");
      return;
    }
  }
}

function parseMetaSchema(raw: unknown): {
  errors: string[];
  version?: number;
  source?: { file: string; width: number; height: number };
  photo?: { file?: string; width?: number; height?: number; sources: Array<{ file: string; type?: string }> };
  depth?: { width: number; height: number };
  mask?: string;
  normal?: string;
  model?: { name: string; revision: string };
  sourceHash?: string;
} {
  const errors: string[] = [];
  const meta = asRecord(raw, "meta", errors);
  if (!meta) return { errors };

  const version = requireInteger(meta, "version", "meta", errors);
  if (version !== undefined && version !== 1 && version !== 2) errors.push(`meta.version: unsupported version ${version}`);

  const sourceRecord = asRecord(meta.source, "meta.source", errors);
  const sourceFile = sourceRecord ? requireString(sourceRecord, "file", "meta.source", errors) : undefined;
  const sourceWidth = sourceRecord ? requireInteger(sourceRecord, "width", "meta.source", errors) : undefined;
  const sourceHeight = sourceRecord ? requireInteger(sourceRecord, "height", "meta.source", errors) : undefined;

  const depthRecord = asRecord(meta.depth, "meta.depth", errors);
  const depthWidth = depthRecord ? requireInteger(depthRecord, "width", "meta.depth", errors) : undefined;
  const depthHeight = depthRecord ? requireInteger(depthRecord, "height", "meta.depth", errors) : undefined;
  if (depthRecord?.space !== "disparity") errors.push("meta.depth.space: expected disparity");
  if (depthRecord?.orientation !== "near=1") errors.push("meta.depth.orientation: expected near=1");
  const normalization = asRecord(depthRecord?.normalization, "meta.depth.normalization", errors);
  if (normalization) {
    requireNumber(normalization, "min", "meta.depth.normalization", errors);
    requireNumber(normalization, "max", "meta.depth.normalization", errors);
  }

  const photoRecord = meta.photo === undefined ? undefined : asRecord(meta.photo, "meta.photo", errors);
  const photoFile = photoRecord ? optionalDeclaredFile(photoRecord, "meta.photo", errors) : undefined;
  const photoWidth = photoRecord?.width === undefined ? undefined : requireInteger(photoRecord, "width", "meta.photo", errors);
  const photoHeight = photoRecord?.height === undefined ? undefined : requireInteger(photoRecord, "height", "meta.photo", errors);
  const sources: Array<{ file: string; type?: string }> = [];
  if (photoRecord?.sources !== undefined) {
    if (!Array.isArray(photoRecord.sources)) {
      errors.push("meta.photo.sources: array expected");
    } else {
      for (const [index, source] of photoRecord.sources.entries()) {
        const sourceRecord = asRecord(source, `meta.photo.sources.${index}`, errors);
        if (!sourceRecord) continue;
        const file = optionalDeclaredFile(sourceRecord, `meta.photo.sources.${index}`, errors);
        const type = sourceRecord.type;
        if (type !== undefined && typeof type !== "string") errors.push(`meta.photo.sources.${index}.type: string expected`);
        if (typeof type === "string" && !["image/avif", "image/webp", "image/jpeg"].includes(type)) {
          errors.push(`meta.photo.sources.${index}.type: unsupported type ${type}`);
        }
        if (file) sources.push({ file, type: typeof type === "string" ? type : undefined });
      }
    }
  }

  const mask = optionalDeclaredFile(meta.mask === undefined ? undefined : asRecord(meta.mask, "meta.mask", errors), "meta.mask", errors);
  const normal = optionalDeclaredFile(meta.normal === undefined ? undefined : asRecord(meta.normal, "meta.normal", errors), "meta.normal", errors);

  const modelRecord = asRecord(meta.model, "meta.model", errors);
  const modelName = modelRecord ? requireString(modelRecord, "name", "meta.model", errors) : undefined;
  const modelRevision = modelRecord ? requireString(modelRecord, "revision", "meta.model", errors) : undefined;
  const cameraRecord = asRecord(meta.camera, "meta.camera", errors);
  if (cameraRecord) {
    const fovDeg = requireNumber(cameraRecord, "fovDeg", "meta.camera", errors);
    const farRange = requireNumber(cameraRecord, "farRange", "meta.camera", errors);
    if (fovDeg !== undefined && (fovDeg <= 0 || fovDeg >= 180)) errors.push(`meta.camera.fovDeg: expected > 0 and < 180 (${fovDeg})`);
    if (farRange !== undefined && farRange <= 0) errors.push(`meta.camera.farRange: expected > 0 (${farRange})`);
  }
  const skyRecord = asRecord(meta.sky, "meta.sky", errors);
  if (skyRecord) {
    const threshold = requireNumber(skyRecord, "threshold", "meta.sky", errors);
    if (threshold !== undefined && (threshold < 0 || threshold > 1)) errors.push(`meta.sky.threshold: expected 0..1 (${threshold})`);
  }
  requireString(meta, "bakedAt", "meta", errors);
  const sourceHash = requireString(meta, "sourceHash", "meta", errors);

  return {
    errors,
    version,
    source: sourceFile && sourceWidth !== undefined && sourceHeight !== undefined
      ? { file: sourceFile, width: sourceWidth, height: sourceHeight }
      : undefined,
    photo: { file: photoFile, width: photoWidth, height: photoHeight, sources },
    depth: depthWidth !== undefined && depthHeight !== undefined ? { width: depthWidth, height: depthHeight } : undefined,
    mask,
    normal,
    model: modelName && modelRevision ? { name: modelName, revision: modelRevision } : undefined,
    sourceHash,
  };
}

function photoCandidates(version: number | undefined, photo: ReturnType<typeof parseMetaSchema>["photo"]): Array<{ file: string; type?: string }> {
  const files = [
    ...(photo?.sources ?? []),
    ...(photo?.file ? [{ file: photo.file }] : []),
    { file: version === 2 ? "photo.jpg" : (photo?.file ?? "photo.avif") },
  ];
  return unique(files.map((candidate) => candidate.file)).map((file) => files.find((candidate) => candidate.file === file)!);
}

export async function inspectPackage(packagePath: string, options: ValidatePackagesOptions = {}): Promise<PackageInspection> {
  const root = path.resolve(packagePath);
  const errors: string[] = [];
  let dirEntries: string[];
  try {
    dirEntries = await readdir(root);
  } catch (e) {
    const message = (e as NodeJS.ErrnoException).code === "ENOENT"
      ? "package directory does not exist"
      : (e as Error).message;
    return {
      path: root,
      valid: false,
      errors: [message],
      maps: {},
      files: [],
      totalBytes: 0,
    };
  }
  const files: PackageFileSummary[] = [];
  for (const file of dirEntries) {
    const filePath = path.join(root, file);
    const s = await stat(filePath);
    if (s.isFile()) files.push({ file, bytes: s.size });
  }

  const metaPath = path.join(root, "meta.json");
  let parsed = parseMetaSchema(undefined);
  if (!(await fileExists(metaPath))) {
    errors.push("meta.json: required file is missing");
  } else {
    try {
      parsed = parseMetaSchema(JSON.parse(await readFile(metaPath, "utf-8")));
      errors.push(...parsed.errors);
    } catch (e) {
      errors.push(`meta.json: ${(e as Error).message}`);
    }
  }

  const declared = new Set(["meta.json"]);
  const photos = photoCandidates(parsed.version, parsed.photo);
  for (const photo of photos) declared.add(photo.file);
  declared.add("depth.png");
  if (parsed.version === 1) {
    declared.add("mask.png");
    declared.add("normal.png");
  }
  if (parsed.mask) declared.add(parsed.mask);
  if (parsed.normal) declared.add(parsed.normal);

  for (const file of declared) {
    if (!(await fileExists(path.join(root, file)))) errors.push(`${file}: declared file is missing`);
  }
  for (const file of files) {
    if (!declared.has(file.file)) errors.push(`${file.file}: undeclared stale file`);
  }

  const photoSummaries: PhotoFormatSummary[] = [];
  for (const photo of photos) {
    const filePath = path.join(root, photo.file);
    const bytes = await fileBytes(filePath);
    const summary: PhotoFormatSummary = { ...photo, bytes };
    if (bytes !== undefined) {
      try {
        const meta = await imageMetadata(filePath);
        summary.width = meta.width;
        summary.height = meta.height;
        if (parsed.photo?.width !== undefined && meta.width !== parsed.photo.width) errors.push(`${photo.file}: width does not match meta.photo.width`);
        if (parsed.photo?.height !== undefined && meta.height !== parsed.photo.height) errors.push(`${photo.file}: height does not match meta.photo.height`);
      } catch (e) {
        errors.push(`${photo.file}: ${(e as Error).message}`);
      }
    }
    photoSummaries.push(summary);
  }

  const depthPath = path.join(root, "depth.png");
  const depthBytes = await fileBytes(depthPath);
  const depth: PackageInspection["depth"] = { file: "depth.png", encoding: "rg16-disparity", bytes: depthBytes };
  if (depthBytes !== undefined) {
    try {
      const meta = await imageMetadata(depthPath);
      depth.width = meta.width;
      depth.height = meta.height;
      if (parsed.depth?.width !== undefined && meta.width !== parsed.depth.width) errors.push("depth.png: width does not match meta.depth.width");
      if (parsed.depth?.height !== undefined && meta.height !== parsed.depth.height) errors.push("depth.png: height does not match meta.depth.height");
      await validateDepthPacking(depthPath, errors);
    } catch (e) {
      errors.push(`depth.png: ${(e as Error).message}`);
    }
  }

  const maps: PackageInspection["maps"] = {};
  for (const [kind, file] of Object.entries({ mask: parsed.version === 1 ? "mask.png" : parsed.mask, normal: parsed.version === 1 ? "normal.png" : parsed.normal })) {
    if (!file) continue;
    const mapPath = path.join(root, file);
    const bytes = await fileBytes(mapPath);
    const summary: MapSummary = { file, bytes };
    if (bytes !== undefined) {
      try {
        const meta = await imageMetadata(mapPath);
        summary.width = meta.width;
        summary.height = meta.height;
        if (parsed.depth?.width !== undefined && meta.width !== parsed.depth.width) errors.push(`${file}: width does not match meta.depth.width`);
        if (parsed.depth?.height !== undefined && meta.height !== parsed.depth.height) errors.push(`${file}: height does not match meta.depth.height`);
      } catch (e) {
        errors.push(`${file}: ${(e as Error).message}`);
      }
    }
    if (kind === "mask") maps.mask = summary;
    else maps.normal = summary;
  }

  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  if (options.maxBytes !== undefined && totalBytes > options.maxBytes) {
    errors.push(`package size ${totalBytes} exceeds budget ${options.maxBytes}`);
  }

  return {
    path: root,
    valid: errors.length === 0,
    errors,
    version: parsed.version,
    source: parsed.source,
    photo: { width: parsed.photo?.width, height: parsed.photo?.height, formats: photoSummaries },
    depth,
    maps,
    files: files.sort((a, b) => a.file.localeCompare(b.file)),
    totalBytes,
    model: parsed.model,
    sourceHash: parsed.sourceHash,
  };
}

export async function validatePackages(paths: string[], options: ValidatePackagesOptions = {}): Promise<PackageInspection[]> {
  return Promise.all(paths.map((packagePath) => inspectPackage(packagePath, options)));
}

export function formatInspectionHuman(result: PackageInspection): string {
  const lines = [
    `${result.path}`,
    `  version: ${result.version ?? "unknown"}`,
    `  photo: ${result.photo?.width ?? "?"}x${result.photo?.height ?? "?"} ${result.photo?.formats.map((source) => source.file).join(", ") ?? ""}`,
    `  depth: ${result.depth?.width ?? "?"}x${result.depth?.height ?? "?"} ${result.depth?.encoding ?? ""}`,
    `  maps: ${[result.maps.mask?.file, result.maps.normal?.file].filter(Boolean).join(", ") || "none"}`,
    `  model: ${result.model ? `${result.model.name}@${result.model.revision}` : "unknown"}`,
    `  sourceHash: ${result.sourceHash ?? "unknown"}`,
    `  size: ${result.totalBytes} bytes`,
  ];
  for (const file of result.files) lines.push(`    ${file.file}: ${file.bytes} bytes`);
  if (!result.valid) lines.push(...result.errors.map((error) => `  ERROR: ${error}`));
  return lines.join("\n");
}
