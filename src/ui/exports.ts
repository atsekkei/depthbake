import {
  bakeFromDisparity,
  computeSourceHash,
  nextMapMaxSize,
  type BakedPackage,
  type SourcePhoto,
  type PhotoFormat,
  type PhotoMimeType,
  type PhotoSpaceConfig,
  type RasterF32,
} from "photospace-core";
import { createZip } from "./zip.ts";

export function rasterizeToCanvas(source: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function encodePng(rgba: Uint8ClampedArray<ArrayBuffer>, width: number, height: number): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.putImageData(new ImageData(rgba, width, height), 0, 0);
  const blob = await canvasToBlob(canvas, "image/png");
  if (!blob) throw new Error("depth/mask/normal PNG のエンコードに失敗しました。");
  return new Uint8Array(await blob.arrayBuffer());
}

/** canvasが実際に生成できた指定形式をすべて同梱する。JPEGは必須のため常に候補へ加える。 */
const PHOTO_ENCODE_CANDIDATES: Record<PhotoFormat, { name: string; type: PhotoMimeType }> = {
  avif: { name: "photo.avif", type: "image/avif" },
  webp: { name: "photo.webp", type: "image/webp" },
  jpeg: { name: "photo.jpg", type: "image/jpeg" },
};

interface EncodedPhoto {
  name: string;
  type: PhotoMimeType;
  bytes: Uint8Array;
  width: number;
  height: number;
}

function photoQuality(config: PhotoSpaceConfig["photo"], format: PhotoFormat): number {
  if (format === "avif") return config.avifQuality / 100;
  if (format === "webp") return config.webpQuality / 100;
  return config.jpegQuality / 100;
}

async function encodePhotoSources(
  canvas: HTMLCanvasElement,
  config: PhotoSpaceConfig["photo"],
): Promise<EncodedPhoto[]> {
  const encoded: EncodedPhoto[] = [];
  // photo.jpgは必須の最終フォールバック。configにjpegがなくても構造的に含める。
  for (const format of new Set<PhotoFormat>([...config.formats, "jpeg"])) {
    const candidate = PHOTO_ENCODE_CANDIDATES[format];
    const blob = await canvasToBlob(canvas, candidate.type, photoQuality(config, format));
    if (blob && blob.type === candidate.type) {
      encoded.push({
        ...candidate,
        bytes: new Uint8Array(await blob.arrayBuffer()),
        width: canvas.width,
        height: canvas.height,
      });
    } else if (format === "jpeg") {
      // JPEGはcanvas実装の必須形式なので、ここに来るのは実装異常のみ
      throw new Error("写真のエンコードに失敗しました。");
    }
  }
  return encoded;
}

function fitLongEdge(width: number, height: number, maxSize: number): [number, number] {
  const scale = Math.min(1, maxSize / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

export interface ExportPackageInput {
  /** meta.jsonのsource情報・ハッシュ計算・ガイド画像に使うフル解像度の写真情報 */
  photo: SourcePhoto;
  /** 写真の再エンコードに使う描画ソース(読み込み済みのHTMLImageElement等) */
  photoSource: CanvasImageSource;
  /** モデル推論直後の正規化済み(0..1)disparity。推論を再実行せず既存の結果を再利用する */
  lowResDisparity: RasterF32;
  normalization: { min: number; max: number };
  config: PhotoSpaceConfig;
}

export interface PackageExportSummary {
  zipBytes: number;
  mapBytes: number;
  mapWidth: number;
  mapHeight: number;
  photoWidth: number;
  photoHeight: number;
  photoFormats: PhotoFormat[];
}

/**
 * 写真候補とdepth.png/meta.json(+オプションのmask/normal)をブラウザだけで組み立て、
 * zipとしてダウンロードする。容量上限を超えたマップは同じ長辺へまとめて縮小し、位置対応を維持する。
 */
export async function downloadPackage(input: ExportPackageInput): Promise<PackageExportSummary> {
  const requestedHash = await computeSourceHash(input.photo.bytes, input.config);
  let mapMaxSize = input.config.depth.maxSize;
  let baked: BakedPackage;
  let depthBytes: Uint8Array;
  let maskBytes: Uint8Array | undefined;
  let normalBytes: Uint8Array | undefined;
  let mapBytes: number;
  while (true) {
    const effectiveConfig: PhotoSpaceConfig = {
      ...input.config,
      depth: { ...input.config.depth, maxSize: mapMaxSize },
    };
    baked = await bakeFromDisparity(input.photo, input.lowResDisparity, input.normalization, {
      config: effectiveConfig,
      // 再試行時に写真バイト列のSHA-256を再計算しないよう、計算済みハッシュを渡す
      sourceHash: requestedHash,
    });
    [depthBytes, maskBytes, normalBytes] = await Promise.all([
      encodePng(baked.depthRgba, baked.depthWidth, baked.depthHeight),
      baked.maskRgba ? encodePng(baked.maskRgba, baked.depthWidth, baked.depthHeight) : undefined,
      baked.normalRgba ? encodePng(baked.normalRgba, baked.depthWidth, baked.depthHeight) : undefined,
    ]);
    mapBytes = depthBytes.byteLength + (maskBytes?.byteLength ?? 0) + (normalBytes?.byteLength ?? 0);
    if (input.config.maps.maxBytes <= 0 || mapBytes <= input.config.maps.maxBytes) break;
    const actualMaxSize = Math.max(baked.depthWidth, baked.depthHeight);
    if (actualMaxSize <= 64) {
      throw new Error(`Map size limit (${input.config.maps.maxBytes} bytes) cannot be met at minimum resolution.`);
    }
    mapMaxSize = nextMapMaxSize(actualMaxSize, mapBytes, input.config.maps.maxBytes);
  }

  const [photoW, photoH] = fitLongEdge(input.photo.width, input.photo.height, input.config.photo.maxSize);
  const photoCanvas = rasterizeToCanvas(input.photoSource, photoW, photoH);
  const photos = await encodePhotoSources(photoCanvas, input.config.photo);
  const firstPhoto = photos[0];
  const meta = {
    ...baked.meta,
    photo: {
      file: firstPhoto.name,
      width: firstPhoto.width,
      height: firstPhoto.height,
      sources: photos.map(({ name: file, type }) => ({ file, type })),
    },
  };
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta, null, 2));

  const zip = createZip([
    ...photos.map((photo) => ({ name: photo.name, data: photo.bytes })),
    { name: "depth.png", data: depthBytes },
    ...(maskBytes ? [{ name: "mask.png", data: maskBytes }] : []),
    ...(normalBytes ? [{ name: "normal.png", data: normalBytes }] : []),
    { name: "meta.json", data: metaBytes },
  ]);

  const baseName = input.photo.fileName.replace(/\.[^.]+$/, "") || "photospace";
  const a = document.createElement("a");
  a.download = `${baseName}.photospace.zip`;
  a.href = URL.createObjectURL(zip);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);

  return {
    zipBytes: zip.size,
    mapBytes,
    mapWidth: baked.depthWidth,
    mapHeight: baked.depthHeight,
    photoWidth: firstPhoto.width,
    photoHeight: firstPhoto.height,
    photoFormats: photos.map((photo) => {
      if (photo.type === "image/avif") return "avif";
      if (photo.type === "image/webp") return "webp";
      return "jpeg";
    }),
  };
}
