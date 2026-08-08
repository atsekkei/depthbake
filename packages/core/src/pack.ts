import type { ModelDtype } from "./depth.ts";

export interface PhotoSpaceMeta {
  version: 2;
  source: { file: string; width: number; height: number };
  /**
   * パッケージ内の写真候補。sourcesは優先順、fileは旧runtime向けにその第一候補を複製する。
   * version 2ではphoto.jpgが必ず候補に含まれる(必須の最終フォールバック)。
   */
  photo?: {
    /** 旧runtime向けの第一候補。sources追加後も後方互換のため保持する。 */
    file: string;
    width?: number;
    height?: number;
    sources?: Array<{ file: string; type: PhotoMimeType }>;
  };
  depth: {
    width: number;
    height: number;
    space: "disparity";
    orientation: "near=1";
    normalization: { min: number; max: number };
  };
  /** 存在する場合のみmask.pngが同梱されている */
  mask?: { file: string };
  /** 存在する場合のみnormal.pngが同梱されている */
  normal?: { file: string };
  camera: { fovDeg: number; farRange: number };
  /** mask.pngがなくてもシェーダー内の空判定に使うためトップレベルに置く */
  sky: { threshold: number };
  model: { name: string; revision: string };
  bakedAt: string;
  /** CLIの再実行スキップ判定に使う (写真バイト列 + config.json のハッシュ) */
  sourceHash: string;
}

export type PhotoFormat = "avif" | "webp" | "jpeg";
export type PhotoMimeType = "image/avif" | "image/webp" | "image/jpeg";

export interface PhotoSpaceConfig {
  version: 1;
  camera: { fovDeg: number; farRange: number };
  sky: { threshold: number };
  depth: { maxSize: number };
  /** dtypeはNode(CLI)推論の重み精度。fp32が品質基準、q8等の量子化で高速化できる */
  model: { dtype: ModelDtype };
  /**
   * 同梱するマップは同じ解像度を共有する。maxBytesは同梱マップの合計、0は無制限。
   * mask/normalはオプトイン(既定false)で、有効時のみ生成・同梱される。
   */
  maps: { maxBytes: number; pngCompressionLevel: number; mask: boolean; normal: boolean };
  photo: {
    maxSize: number;
    formats: PhotoFormat[];
    avifQuality: number;
    webpQuality: number;
    jpegQuality: number;
  };
}

export const DEFAULT_CONFIG: PhotoSpaceConfig = {
  version: 1,
  camera: { fovDeg: 55, farRange: 12 },
  sky: { threshold: 0.03 },
  depth: { maxSize: 1024 },
  model: { dtype: "fp32" },
  maps: { maxBytes: 1_500_000, pngCompressionLevel: 9, mask: false, normal: false },
  photo: {
    maxSize: 2048,
    formats: ["avif", "webp", "jpeg"],
    avifQuality: 50,
    webpQuality: 75,
    jpegQuality: 82,
  },
};

/** R=上位8bit, G=下位8bit, B=0, A=255 の RGBA ラスタへパックする */
export function packDepthRG16(depth01: Float32Array): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(depth01.length * 4);
  for (let i = 0; i < depth01.length; i++) {
    const v = Math.round(clamp01(depth01[i]) * 65535);
    out[i * 4] = v >> 8;
    out[i * 4 + 1] = v & 255;
    out[i * 4 + 2] = 0;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** packDepthRG16 の逆変換。d = (R*256 + G) / 65535 */
export function unpackDepthRG16(rgba: Uint8Array | Uint8ClampedArray): Float32Array {
  const count = rgba.length / 4;
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const v = rgba[i * 4] * 256 + rgba[i * 4 + 1];
    out[i] = v / 65535;
  }
  return out;
}

/** R=空マスク, G=エッジマスク, B=0, A=255 の RGBA ラスタへパックする */
export function packMask(sky01: Float32Array, edge01: Float32Array): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(sky01.length * 4);
  for (let i = 0; i < sky01.length; i++) {
    out[i * 4] = Math.round(clamp01(sky01[i]) * 255);
    out[i * 4 + 1] = Math.round(clamp01(edge01[i]) * 255);
    out[i * 4 + 2] = 0;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** 法線 (-1..1) を RGB (0..255) へパックする。n*0.5+0.5 */
export function packNormal(nx: Float32Array, ny: Float32Array, nz: Float32Array): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(nx.length * 4);
  for (let i = 0; i < nx.length; i++) {
    out[i * 4] = Math.round(clamp01(nx[i] * 0.5 + 0.5) * 255);
    out[i * 4 + 1] = Math.round(clamp01(ny[i] * 0.5 + 0.5) * 255);
    out[i * 4 + 2] = Math.round(clamp01(nz[i] * 0.5 + 0.5) * 255);
    out[i * 4 + 3] = 255;
  }
  return out;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** sha256(photoBytes + configJson) を16進文字列で返す。CLIの再実行スキップ判定に使う */
export async function computeSourceHash(
  photoBytes: Uint8Array,
  config: PhotoSpaceConfig,
  cryptoImpl: { subtle: SubtleCrypto } = crypto,
): Promise<string> {
  const configBytes = new TextEncoder().encode(JSON.stringify(config));
  const combined = new Uint8Array(photoBytes.length + configBytes.length);
  combined.set(photoBytes, 0);
  combined.set(configBytes, photoBytes.length);
  const digest = await cryptoImpl.subtle.digest("SHA-256", combined);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
