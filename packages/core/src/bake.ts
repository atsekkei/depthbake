import { estimateDepth, type DepthModel, MODEL_NAME, MODEL_REVISION } from "./depth.ts";
import { normalizeDisparity } from "./normalize.ts";
import { guidedUpsampleDepth, type RasterF32 } from "./upsample.ts";
import { computeSkyMask, computeEdgeMask } from "./masks.ts";
import { computeNormals } from "./normals.ts";
import { packDepthRG16, packMask, packNormal, computeSourceHash, type PhotoSpaceConfig, type PhotoSpaceMeta } from "./pack.ts";

export interface SourcePhoto {
  /** パッケージ名やmeta.jsonのsource.fileに使うファイル名 */
  fileName: string;
  /** 元画像のバイト列(ハッシュ計算とphoto.avif生成に使用) */
  bytes: Uint8Array;
  /** モデル推論への入力(ブラウザ: data URL、Node CLI: 正規化済み画像Blob) */
  input: string | URL | Blob;
  width: number;
  height: number;
  /** 元解像度のRGBAピクセル(ガイド画像に使用) */
  rgba: Uint8ClampedArray | Uint8Array;
}

export interface BakedPackage {
  meta: PhotoSpaceMeta;
  /** RG16パック済み深度 (RGBA raster, depth.width x depth.height) */
  depthRgba: Uint8ClampedArray<ArrayBuffer>;
  /** R=空マスク, G=エッジマスク (RGBA raster, depth解像度)。config.maps.mask有効時のみ */
  maskRgba?: Uint8ClampedArray<ArrayBuffer>;
  /** 法線 (RGBA raster, depth解像度)。config.maps.normal有効時のみ */
  normalRgba?: Uint8ClampedArray<ArrayBuffer>;
  depthWidth: number;
  depthHeight: number;
}

export interface BakeOptions {
  model: DepthModel;
  config: PhotoSpaceConfig;
  guidedFilter?: { radius?: number; eps?: number };
}

export interface BakeFromDisparityOptions {
  config: PhotoSpaceConfig;
  guidedFilter?: { radius?: number; eps?: number };
  /**
   * 計算済みのsourceHash(computeSourceHashの結果)。容量キャップ超過時の再試行のように
   * 同一写真へ繰り返し呼ぶ場合、写真バイト列のSHA-256再計算を省くため呼び出し元から渡せる。
   * 省略時は内部で計算する。
   */
  sourceHash?: string;
}

/** 長辺がmaxSizeになるようリサイズ後の(width,height)を計算する */
function fitLongEdge(width: number, height: number, maxSize: number): [number, number] {
  const scale = maxSize / Math.max(width, height);
  if (scale >= 1) return [width, height];
  return [Math.round(width * scale), Math.round(height * scale)];
}

/**
 * 正規化済み(0..1)の低解像度disparityから、エッジ整合アップサンプリングと
 * (config.maps で有効な場合のみ)マスク・法線の生成を行い、
 * 写真候補を除くラスタデータと meta.json を返す。
 * 推論自体(estimateDepth)はこの関数の外で行う想定 — ビューワのようにdisparityを
 * 既に持っている呼び出し元が、モデル推論を再実行せずに済むようbakePhotoから切り出したもの。
 */
export async function bakeFromDisparity(
  photo: SourcePhoto,
  lowRes: RasterF32,
  normalization: { min: number; max: number },
  opts: BakeFromDisparityOptions,
): Promise<BakedPackage> {
  const { config } = opts;

  const [depthW, depthH] = fitLongEdge(photo.width, photo.height, config.depth.maxSize);
  const upsampled = guidedUpsampleDepth(
    lowRes,
    photo.rgba,
    photo.width,
    photo.height,
    depthW,
    depthH,
    opts.guidedFilter,
  );

  // マスク・法線はオプトイン。無効時は計算自体をスキップする(最大でdepth解像度分の処理が省ける)。
  let maskRgba: Uint8ClampedArray<ArrayBuffer> | undefined;
  if (config.maps.mask) {
    const sky = computeSkyMask(upsampled, config.sky.threshold);
    const edge = computeEdgeMask(upsampled);
    maskRgba = packMask(sky, edge);
  }
  let normalRgba: Uint8ClampedArray<ArrayBuffer> | undefined;
  if (config.maps.normal) {
    const normals = computeNormals(upsampled, config.camera.fovDeg, config.camera.farRange);
    normalRgba = packNormal(normals.nx, normals.ny, normals.nz);
  }

  const sourceHash = opts.sourceHash ?? (await computeSourceHash(photo.bytes, config));

  const meta: PhotoSpaceMeta = {
    version: 2,
    source: { file: photo.fileName, width: photo.width, height: photo.height },
    depth: {
      width: depthW,
      height: depthH,
      space: "disparity",
      orientation: "near=1",
      normalization,
    },
    ...(maskRgba ? { mask: { file: "mask.png" } } : {}),
    ...(normalRgba ? { normal: { file: "normal.png" } } : {}),
    camera: { fovDeg: config.camera.fovDeg, farRange: config.camera.farRange },
    sky: { threshold: config.sky.threshold },
    model: { name: MODEL_NAME, revision: MODEL_REVISION },
    bakedAt: new Date().toISOString(),
    sourceHash,
  };

  return {
    meta,
    depthRgba: packDepthRG16(upsampled.data),
    maskRgba,
    normalRgba,
    depthWidth: depthW,
    depthHeight: depthH,
  };
}

/** 推論→正規化→bakeFromDisparity の一連の処理を行う(CLIなど推論から自前で行う呼び出し元向け) */
export async function bakePhoto(photo: SourcePhoto, opts: BakeOptions): Promise<BakedPackage> {
  const { width: rawW, height: rawH, raw } = await estimateDepth(opts.model, photo.input);
  const { data, min, max } = normalizeDisparity(raw);
  const lowRes: RasterF32 = { width: rawW, height: rawH, data };
  return bakeFromDisparity(photo, lowRes, { min, max }, opts);
}
