import { access, mkdir, mkdtemp, rename, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type {
  SourcePhoto,
  DepthbakeConfig,
  DepthbakeMeta,
  PhotoFormat,
  PhotoMimeType,
} from "depthbake-core";

/** 元画像ファイルを読み込み、bakePhoto()へ渡せる形(RGBAピクセル込み)に変換する */
export async function loadSourcePhoto(filePath: string): Promise<SourcePhoto> {
  const bytes = await readFile(filePath);
  const normalized = sharp(bytes).rotate();
  const [{ data, info }, modelInput] = await Promise.all([
    normalized.clone().ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    normalized.clone().png().toBuffer(),
  ]);
  return {
    fileName: path.basename(filePath),
    bytes,
    input: new Blob([modelInput], { type: "image/png" }),
    width: info.width,
    height: info.height,
    rgba: data,
  };
}

/** 既存出力のmeta.json。旧versionの可能性があるため、スキップ判定に使う項目だけの型で返す */
export async function readExistingMeta(outDir: string): Promise<{ version?: number; sourceHash?: string } | null> {
  try {
    const text = await readFile(path.join(outDir, "meta.json"), "utf-8");
    return JSON.parse(text) as { version?: number; sourceHash?: string };
  } catch {
    return null;
  }
}

export interface EncodedMaps {
  depth: Uint8Array;
  mask?: Uint8Array;
  normal?: Uint8Array;
  totalBytes: number;
}

/**
 * パック済みRGBAラスタをRGB(3ch)PNGとして書き出す。Aは全マップで定数255のため落とす。
 * ブラウザ側のデコードはgetImageData/texImage2Dが常にRGBAへ展開するので互換が保たれる。
 *
 * palette:falseは必須。sharpはeffort等のパレット系オプションを渡すと暗黙にpalette:trueへ
 * 切り替わり、256色への非可逆量子化でRG16深度が壊れる(かつては effort:10 がこれを踏んでいた)。
 * 非パレットPNGにeffortは効かないため、圧縮の調整はcompressionLevelのみで行う。
 */
async function encodeMapPng(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  compressionLevel: number,
): Promise<Uint8Array> {
  return sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), {
    raw: { width, height, channels: 4 },
  })
    .removeAlpha()
    .png({ compressionLevel, palette: false })
    .toBuffer();
}

/** 渡されたマップだけPNGエンコードする。totalBytesは同梱マップの合計。 */
export async function encodeMaps(input: {
  depthRgba: Uint8ClampedArray;
  maskRgba?: Uint8ClampedArray;
  normalRgba?: Uint8ClampedArray;
  width: number;
  height: number;
  compressionLevel: number;
}): Promise<EncodedMaps> {
  const { width, height, compressionLevel } = input;
  const [depth, mask, normal] = await Promise.all([
    encodeMapPng(input.depthRgba, width, height, compressionLevel),
    input.maskRgba ? encodeMapPng(input.maskRgba, width, height, compressionLevel) : undefined,
    input.normalRgba ? encodeMapPng(input.normalRgba, width, height, compressionLevel) : undefined,
  ]);
  const totalBytes = depth.byteLength + (mask?.byteLength ?? 0) + (normal?.byteLength ?? 0);
  return { depth, mask, normal, totalBytes };
}

export interface EncodedPhotoSource {
  file: string;
  type: PhotoMimeType;
  bytes: Uint8Array;
  width: number;
  height: number;
}

const PHOTO_OUTPUTS: Record<PhotoFormat, { file: string; type: PhotoMimeType }> = {
  avif: { file: "photo.avif", type: "image/avif" },
  webp: { file: "photo.webp", type: "image/webp" },
  jpeg: { file: "photo.jpg", type: "image/jpeg" },
};

export async function encodePhotoSources(
  photoBytes: Uint8Array,
  config: DepthbakeConfig["photo"],
): Promise<EncodedPhotoSource[]> {
  const formats = [...new Set(config.formats)];
  if (formats.length === 0) throw new Error("photo.formatsには1形式以上を指定してください。");

  return Promise.all(
    formats.map(async (format) => {
      let pipeline = sharp(Buffer.from(photoBytes)).rotate().resize({
        width: config.maxSize,
        height: config.maxSize,
        fit: "inside",
        withoutEnlargement: true,
      });
      if (format === "avif") pipeline = pipeline.avif({ quality: config.avifQuality });
      else if (format === "webp") pipeline = pipeline.webp({ quality: config.webpQuality });
      else pipeline = pipeline.jpeg({ quality: config.jpegQuality, mozjpeg: true });

      const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
      return { ...PHOTO_OUTPUTS[format], bytes: data, width: info.width, height: info.height };
    }),
  );
}

export interface WritePackageInput {
  outDir: string;
  photoSources: EncodedPhotoSource[];
  maps: EncodedMaps;
  meta: DepthbakeMeta;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function publishPackageDirectory(tmpDir: string, outDir: string): Promise<void> {
  const parent = path.dirname(outDir);
  const backupDir = await mkdtemp(path.join(parent, `.${path.basename(outDir)}.prev-`));
  await rm(backupDir, { recursive: true, force: true });

  let movedExisting = false;
  try {
    if (await pathExists(outDir)) {
      await rename(outDir, backupDir);
      movedExisting = true;
    }
    await rename(tmpDir, outDir);
    await rm(backupDir, { recursive: true, force: true });
  } catch (e) {
    if (movedExisting && !(await pathExists(outDir))) {
      await rename(backupDir, outDir).catch(() => undefined);
    }
    throw e;
  }
}

/** エンコード済みの写真候補とdepth(+同梱マップ)/meta.jsonを書き出す。 */
export async function writePackage(input: WritePackageInput): Promise<void> {
  const outDir = path.resolve(input.outDir);
  const parent = path.dirname(outDir);
  await mkdir(parent, { recursive: true });
  const tmpDir = await mkdtemp(path.join(parent, `.${path.basename(outDir)}.tmp-`));
  const declaredFiles = [
    ...input.photoSources.map((source) => ({ file: source.file, bytes: source.bytes })),
    { file: "depth.png", bytes: input.maps.depth },
    ...(input.maps.mask ? [{ file: "mask.png", bytes: input.maps.mask }] : []),
    ...(input.maps.normal ? [{ file: "normal.png", bytes: input.maps.normal }] : []),
    { file: "meta.json", bytes: Buffer.from(JSON.stringify(input.meta, null, 2)) },
  ];

  const writes = [
    ...declaredFiles.map(({ file, bytes }) => writeFile(path.join(tmpDir, file), bytes)),
  ];
  try {
    await Promise.all(writes);
    await Promise.all(
      declaredFiles.map(async ({ file }) => {
        if (!(await pathExists(path.join(tmpDir, file)))) {
          throw new Error(`パッケージ書き出しに失敗しました: ${file} が作成されていません。`);
        }
      }),
    );
    await publishPackageDirectory(tmpDir, outDir);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
