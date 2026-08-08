/**
 * photospace CLI が書き出す meta.json の型。version 1(旧形式)と2の両方を読む。
 * v2の書き込み側の型は packages/core/src/pack.ts の PhotoSpaceMeta と同じ形。
 * runtime はビルド後に単体で配布されるため、コア側の型をimportせずここに複製している。
 */
interface PhotoSpaceMetaShared {
  source: { file: string; width: number; height: number };
  /** fileは旧runtime向け第一候補。新runtimeはsourcesを記載順にデコードする。 */
  photo?: {
    file: string;
    width?: number;
    height?: number;
    sources?: Array<{ file: string; type: string }>;
  };
  depth: {
    width: number;
    height: number;
    space: "disparity";
    orientation: "near=1";
    normalization: { min: number; max: number };
  };
  camera: { fovDeg: number; farRange: number };
  sky: { threshold: number };
  model: { name: string; revision: string };
  bakedAt: string;
  sourceHash: string;
}

/** v1: mask.png/normal.pngが常に同梱され、metaに宣言フィールドを持たない */
export interface PhotoSpaceMetaV1 extends PhotoSpaceMetaShared {
  version: 1;
}

/** v2: photo.jpgが必須の最終フォールバック。mask/normalはフィールドが存在する場合のみ同梱 */
export interface PhotoSpaceMetaV2 extends PhotoSpaceMetaShared {
  version: 2;
  mask?: { file: string };
  normal?: { file: string };
}

export type PhotoSpaceMeta = PhotoSpaceMetaV1 | PhotoSpaceMetaV2;

/** 幅・高さ付きFloat32ラスタ(coreのRasterF32と同形。深度・マスク類の共通表現) */
export interface RasterF32 {
  width: number;
  height: number;
  data: Float32Array;
}

/**
 * エッジマスクの感度。深度勾配のどこからエッジとみなすかの閾値で、
 * meta.json化されるsky.thresholdと違い調整UIを持たず固定値とする
 * (現index.htmlプロトタイプの既定値 uEdge=0.05 を踏襲)。
 */
const EDGE_THRESHOLD = 0.05;

/**
 * depth < threshold の画素を空とみなす (1=空, 0=非空)。
 * mask.pngのRチャンネルはこの関数の焼き込み結果なので、mask.png非同梱の
 * パッケージでもdepthとmeta.sky.thresholdから同じものを導出できる。
 */
export function computeSkyMask(depth: RasterF32, threshold: number): Float32Array {
  const out = new Float32Array(depth.data.length);
  for (let i = 0; i < out.length; i++) {
    out[i] = depth.data[i] < threshold ? 1 : 0;
  }
  return out;
}

/**
 * 深度の勾配(不連続度)からエッジマスクを算出する。値が小さいほどシルエット(輪郭)。
 * mask.pngのGチャンネル相当。現行ビューワのシェーダー内 rel/edge 計算のCPU移植。
 */
export function computeEdgeMask(depth: RasterF32, threshold = EDGE_THRESHOLD): Float32Array {
  const { width: w, height: h, data } = depth;
  const out = new Float32Array(data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const d = Math.max(data[i], 1e-4);
      const xr = Math.min(x + 1, w - 1);
      const xl = Math.max(x - 1, 0);
      const yd = Math.min(y + 1, h - 1);
      const yu = Math.max(y - 1, 0);
      const dx = (data[y * w + xr] - data[y * w + xl]) * 0.5;
      const dy = (data[yd * w + x] - data[yu * w + x]) * 0.5;
      const rel = Math.sqrt(dx * dx + dy * dy) / d;
      // smoothstep(threshold, threshold*3, rel) の 1-x 版
      const t = clamp01((rel - threshold) / (threshold * 2));
      const smooth = t * t * (3 - 2 * t);
      out[i] = 1 - smooth;
    }
  }
  return out;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export interface NormalRaster {
  width: number;
  height: number;
  nx: Float32Array;
  ny: Float32Array;
  nz: Float32Array;
}

/**
 * 深度 + カメラFOVから、被写体表面のワールド法線を計算する。
 * normal.pngはこの関数の焼き込み結果(CLIは量子化前のfloat深度から計算する点だけが違い、
 * 実用上は同等)なので、normal.png非同梱のパッケージでも導出できる。
 * シェーダーだけで足りる場合は GLSL_SNIPPETS.screenSpaceNormal を参照。
 */
export function computeNormals(depth: RasterF32, fovDeg: number, farRange: number): NormalRaster {
  const { width: w, height: h, data } = depth;
  const aspect = w / h;
  const tanHalfFov = Math.tan((fovDeg * Math.PI) / 360);

  const nx = new Float32Array(w * h);
  const ny = new Float32Array(w * h);
  const nz = new Float32Array(w * h);

  const pos = (x: number, y: number): [number, number, number] => {
    const xi = Math.min(Math.max(x, 0), w - 1);
    const yi = Math.min(Math.max(y, 0), h - 1);
    const u = (xi + 0.5) / w;
    const v = (yi + 0.5) / h;
    return worldPosition(u, v, data[yi * w + xi], aspect, tanHalfFov, farRange);
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = pos(x, y);
      const pxr = pos(x + 1, y);
      const pxl = pos(x - 1, y);
      const pyd = pos(x, y + 1);
      const pyu = pos(x, y - 1);
      const dPosX: [number, number, number] = [
        (pxr[0] - pxl[0]) * 0.5,
        (pxr[1] - pxl[1]) * 0.5,
        (pxr[2] - pxl[2]) * 0.5,
      ];
      const dPosY: [number, number, number] = [
        (pyd[0] - pyu[0]) * 0.5,
        (pyd[1] - pyu[1]) * 0.5,
        (pyd[2] - pyu[2]) * 0.5,
      ];
      let n = cross(dPosX, dPosY);
      n = normalize(n);
      if (dot(n, [-p[0], -p[1], -p[2]]) < 0) {
        n = [-n[0], -n[1], -n[2]];
      }
      const i = y * w + x;
      nx[i] = n[0];
      ny[i] = n[1];
      nz[i] = n[2];
    }
  }

  return { width: w, height: h, nx, ny, nz };
}

function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize(v: [number, number, number]): [number, number, number] {
  const len = Math.sqrt(dot(v, v)) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

/** depth.png(R=上位8bit, G=下位8bit)を復元する。d = (R*256 + G) / 65535 */
function unpackDepthRG16(rgba: Uint8Array | Uint8ClampedArray): Float32Array {
  const count = rgba.length / 4;
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const v = rgba[i * 4] * 256 + rgba[i * 4 + 1];
    out[i] = v / 65535;
  }
  return out;
}

function toZ(d: number, far: number): number {
  const disp = (1 - d) / far + d; // mix(1/far, 1, d)
  return 1 / disp;
}

/** uv(0..1)と視差dから、現行ビューワのwpos()と同じ式でワールド座標を求める */
export function worldPosition(
  u: number,
  v: number,
  d: number,
  aspect: number,
  tanHalfFov: number,
  farRange: number,
): [number, number, number] {
  const z = toZ(d, farRange);
  const sx = (u * 2 - 1) * aspect * tanHalfFov;
  const sy = (v * 2 - 1) * tanHalfFov;
  return [sx * z, sy * z, -z];
}

/** loadPackageで選択ロードできる構成要素 */
export type PackageComponent = "photo" | "depth" | "mask" | "normal";

export interface LoadPackageOptions {
  /**
   * 読み込む構成要素。省略時は同梱されているものすべて(従来互換)。
   * 指定外の要素はフェッチもデコードもされず、対応するフィールドはundefinedになる。
   */
  need?: readonly PackageComponent[];
  /**
   * 中断シグナル。進行中のfetchをすべて中断する。
   * 注意: createImageBitmapは中断できないため、デコードに入った分は完走する。
   */
  signal?: AbortSignal;
  /**
   * fetchへ渡す追加オプション(credentials / headers / cache など)。
   * signalはこちらに含めるよりoptions.signalを使うこと(両方あればoptions.signalが勝つ)。
   */
  requestInit?: RequestInit;
}

/**
 * needで要素をスキップした場合の型。photo/depthもundefinedになりうる。
 * Float32Array系フィールド(depth/skyMask/edgeMask/normal)は初回アクセス時に
 * 対応するImageBitmapからCPU復元される遅延getter(以降はキャッシュ)。
 * GPUへBitmapを直接アップロードするだけの利用者はCPU復元コストを一切払わない。
 * 注意: *Bitmapをclose()するのは、対応する遅延フィールドへアクセスした後にすること。
 */
export interface PartialPhotoSpacePackage {
  meta: PhotoSpaceMeta;
  /** meta.photo.sourcesのうち最初にデコードできた写真(テクスチャソースとしてそのまま使える) */
  photo?: ImageBitmap;
  /**
   * デコード済みdepth.png(RG16パックのままのRGBA8)。テクスチャとして直接アップロードし、
   * GLSL_SNIPPETS.unpackAndSampleDepthRgba8(dsp8)でシェーダー内復元できる。
   */
  depthBitmap?: ImageBitmap;
  /** 復元済みの視差値(0..1)。depthWidth x depthHeight。遅延評価 */
  readonly depth?: Float32Array;
  depthWidth: number;
  depthHeight: number;
  /** デコード済みmask.png(R=空, G=エッジ)。mask.png同梱かつneed対象時のみ */
  maskBitmap?: ImageBitmap;
  /** デコード済みnormal.png(RGB=法線xyzの0..255エンコード)。normal.png同梱かつneed対象時のみ */
  normalBitmap?: ImageBitmap;
  /** 0..1 (1=空)。mask.png同梱時のみ(v1パッケージは常に同梱)。遅延評価 */
  readonly skyMask?: Float32Array;
  /** 0..1 (1=非エッジ、現行ビューワのedge変数と同じ極性)。mask.png同梱時のみ。遅延評価 */
  readonly edgeMask?: Float32Array;
  /** normal.png同梱時のみ(v1パッケージは常に同梱)。遅延評価 */
  readonly normal?: { nx: Float32Array; ny: Float32Array; nz: Float32Array };
}

/** need未指定(全部読む)時の型。photo/depthは必ず存在する */
export interface PhotoSpacePackage extends PartialPhotoSpacePackage {
  photo: ImageBitmap;
  depthBitmap: ImageBitmap;
  readonly depth: Float32Array;
}

/** optionsからfetchへ渡すRequestInitを作る。signalはrequestInit内のものより優先する */
function requestInitFor(options: LoadPackageOptions): RequestInit | undefined {
  if (!options.requestInit && !options.signal) return undefined;
  const init: RequestInit = { ...options.requestInit };
  if (options.signal) init.signal = options.signal;
  return init;
}

/**
 * 未awaitのstage promiseがrejectしてもunhandled rejectionにしない。
 * 段階APIでは「photoだけawaitしてdepthは使わない」が正当な使い方なので、
 * 誰も見ていないrejectionでプロセスやページのエラーハンドラを叩かないようにする。
 * catchするのは別の派生promiseなので、返すpromise自体は従来どおりrejectする。
 */
function markHandled<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  return promise;
}

async function fetchMeta(base: string, init?: RequestInit): Promise<PhotoSpaceMeta> {
  const response = await fetch(new URL("meta.json", base), init);
  if (!response.ok) throw new Error(`meta.jsonを取得できませんでした (${response.status})`);
  return (await response.json()) as PhotoSpaceMeta;
}

/** データ用マップ(depth/mask/normal)のフェッチ+デコード。色管理によるピクセル値変換を無効化する */
async function fetchDataBitmap(url: string, init?: RequestInit): Promise<ImageBitmap> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`画像を取得できませんでした: ${url} (${response.status})`);
  const blob = await response.blob();
  return createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
}

/** ImageBitmapをRGBAラスタへ展開する(遅延CPU復元用) */
function rasterizeBitmap(bitmap: ImageBitmap): Uint8ClampedArray {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
}

/** metaから取得すべきマップファイル名を決める。v1は全マップ必須、v2は宣言されたものだけ */
export function packageMapFiles(meta: PhotoSpaceMeta): { mask?: string; normal?: string } {
  if (meta.version === 1) return { mask: "mask.png", normal: "normal.png" };
  if (meta.version === 2) return { mask: meta.mask?.file, normal: meta.normal?.file };
  throw new Error(`未対応のパッケージversionです: ${(meta as { version: number }).version}`);
}

export function photoFileCandidates(meta: PhotoSpaceMeta): string[] {
  const files = meta.photo?.sources?.map((source) => source.file) ?? [];
  if (meta.photo) files.push(meta.photo.file);
  // v2はphoto.jpgが必須なので常に最終候補へ。v1は従来どおりphoto.avifを既定にする。
  files.push(meta.version === 2 ? "photo.jpg" : (meta.photo?.file ?? "photo.avif"));
  return [...new Set(files)];
}

async function fetchPhotoBitmap(
  base: string,
  meta: PhotoSpaceMeta,
  init?: RequestInit,
): Promise<ImageBitmap> {
  const failures: string[] = [];
  for (const file of photoFileCandidates(meta)) {
    try {
      const response = await fetch(new URL(file, base), init);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await createImageBitmap(await response.blob());
    } catch (error) {
      // 中断は「この候補が使えない」ではないので、次の候補へ進まずそのまま投げる。
      // 包んでしまうと呼び出し側が error.name === "AbortError" で判別できなくなる
      if (init?.signal?.aborted || (error as Error).name === "AbortError") throw error;
      failures.push(`${file}: ${(error as Error).message}`);
    }
  }
  throw new Error(`写真をデコードできませんでした (${failures.join(", ")})`);
}

/** mask.pngのRGBAラスタをsky(R)/edge(G)のFloat32ペアへ復元する */
function unpackMask(rgba: Uint8ClampedArray): { sky: Float32Array; edge: Float32Array } {
  const count = rgba.length / 4;
  const sky = new Float32Array(count);
  const edge = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    sky[i] = rgba[i * 4] / 255;
    edge[i] = rgba[i * 4 + 1] / 255;
  }
  return { sky, edge };
}

/** normal.pngのRGBAラスタを-1..1の法線成分へ復元する */
function unpackNormal(rgba: Uint8ClampedArray): { nx: Float32Array; ny: Float32Array; nz: Float32Array } {
  const count = rgba.length / 4;
  const nx = new Float32Array(count);
  const ny = new Float32Array(count);
  const nz = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    nx[i] = (rgba[i * 4] / 255) * 2 - 1;
    ny[i] = (rgba[i * 4 + 1] / 255) * 2 - 1;
    nz[i] = (rgba[i * 4 + 2] / 255) * 2 - 1;
  }
  return { nx, ny, nz };
}

/**
 * 段階ロードの結果。各構成要素が届いた順に個別のpromiseとして解決する。
 *
 * ヒーロービジュアル用途では depth.png が写真の5〜15倍重いことが普通なので、
 * 全部揃うまで待つと最初の1ピクセルを描くまでに写真の何倍もの時間がかかる。
 * photoだけ先にawaitして描画を確定し(LCP)、depth到着後にインタラクティブへ
 * 昇格する、という組み立てができるようにする。
 *
 * ```ts
 * const pkg = loadPackageStaged("/out/hero/", { signal });
 * paint(await pkg.photo);          // ここでLCP確定
 * enableParallax(await pkg.ready); // 揃ってから昇格
 * ```
 *
 * needで除外した要素のpromiseはundefinedで解決する(rejectしない)。
 */
export interface StagedPhotoSpacePackage {
  readonly meta: Promise<PhotoSpaceMeta>;
  readonly photo: Promise<ImageBitmap | undefined>;
  readonly depthBitmap: Promise<ImageBitmap | undefined>;
  readonly maskBitmap: Promise<ImageBitmap | undefined>;
  readonly normalBitmap: Promise<ImageBitmap | undefined>;
  /** 全構成要素が揃ったパッケージ。loadPackage()が返すものと同じ */
  readonly ready: Promise<PartialPhotoSpacePackage>;
}

/** 取得済みのビットマップ群から、Float32を遅延復元するパッケージを組み立てる */
function buildPackage(
  meta: PhotoSpaceMeta,
  photo: ImageBitmap | undefined,
  depthBitmap: ImageBitmap | undefined,
  maskBitmap: ImageBitmap | undefined,
  normalBitmap: ImageBitmap | undefined,
): PartialPhotoSpacePackage {
  // Float32復元は初回アクセス時に行い、以降はキャッシュを返す。
  // Bitmapをテクスチャへ直接アップロードするだけの利用者はこのコストを払わない。
  let depthCache: Float32Array | undefined;
  let maskCache: { sky: Float32Array; edge: Float32Array } | undefined;
  let normalCache: { nx: Float32Array; ny: Float32Array; nz: Float32Array } | undefined;

  const pkg: PartialPhotoSpacePackage = {
    meta,
    photo,
    depthBitmap,
    maskBitmap,
    normalBitmap,
    depthWidth: meta.depth.width,
    depthHeight: meta.depth.height,
    get depth() {
      if (!depthBitmap) return undefined;
      return (depthCache ??= unpackDepthRG16(rasterizeBitmap(depthBitmap)));
    },
    get skyMask() {
      if (!maskBitmap) return undefined;
      return (maskCache ??= unpackMask(rasterizeBitmap(maskBitmap))).sky;
    },
    get edgeMask() {
      if (!maskBitmap) return undefined;
      return (maskCache ??= unpackMask(rasterizeBitmap(maskBitmap))).edge;
    },
    get normal() {
      if (!normalBitmap) return undefined;
      return (normalCache ??= unpackNormal(rasterizeBitmap(normalBitmap)));
    },
  };
  return pkg;
}

/**
 * baseUrl配下のパッケージを段階的に読み込む。同期で返り、fetchは即座に始まる。
 * 各構成要素は届いた順に個別のpromiseとして解決するので、全部揃うのを待たずに
 * 使い始められる(詳細は StagedPhotoSpacePackage)。
 */
export function loadPackageStaged(
  baseUrl: string | URL,
  options: LoadPackageOptions = {},
): StagedPhotoSpacePackage {
  const normalized = typeof baseUrl === "string" && !baseUrl.endsWith("/") ? baseUrl + "/" : baseUrl;
  const base = new URL(normalized, location.href).toString();
  const init = requestInitFor(options);
  const need = new Set<PackageComponent>(options.need ?? ["photo", "depth", "mask", "normal"]);

  const meta = markHandled(fetchMeta(base, init));
  // 未対応versionはどのマップを取りに行くより先に弾く(loadPackageの従来の順序を保つ)
  const checked = markHandled(meta.then((m) => ({ meta: m, files: packageMapFiles(m) })));

  const stage = <T>(wanted: boolean, fn: (c: { meta: PhotoSpaceMeta; files: { mask?: string; normal?: string } }) => Promise<T> | T) =>
    markHandled(wanted ? checked.then(fn) : Promise.resolve(undefined as T | undefined));

  const photo = stage(need.has("photo"), ({ meta }) => fetchPhotoBitmap(base, meta, init));
  const depthBitmap = stage(need.has("depth"), () =>
    fetchDataBitmap(new URL("depth.png", base).toString(), init),
  );
  const maskBitmap = stage(need.has("mask"), ({ files }) =>
    files.mask ? fetchDataBitmap(new URL(files.mask, base).toString(), init) : undefined,
  );
  const normalBitmap = stage(need.has("normal"), ({ files }) =>
    files.normal ? fetchDataBitmap(new URL(files.normal, base).toString(), init) : undefined,
  );

  const ready = markHandled(
    Promise.all([meta, photo, depthBitmap, maskBitmap, normalBitmap]).then(([m, p, d, mk, n]) =>
      buildPackage(m, p, d, mk, n),
    ),
  );

  return { meta, photo, depthBitmap, maskBitmap, normalBitmap, ready };
}

/** baseUrl配下の写真/depth.png/meta.json(+metaが宣言するmask/normal)を読み込む */
export function loadPackage(baseUrl: string | URL): Promise<PhotoSpacePackage>;
/** need指定時はスキップした要素がundefinedになる(PartialPhotoSpacePackage) */
export function loadPackage(baseUrl: string | URL, options: LoadPackageOptions): Promise<PartialPhotoSpacePackage>;
export function loadPackage(baseUrl: string | URL, options?: LoadPackageOptions): Promise<PhotoSpacePackage> {
  // need未指定時はphoto/depthが必ず埋まるため、公開型としてはPhotoSpacePackageに一致する
  return loadPackageStaged(baseUrl, options).ready as Promise<PhotoSpacePackage>;
}

/** meta.json の camera 情報を使い、uv+視差からワールド座標を逆算する */
export function worldPositionFromMeta(meta: PhotoSpaceMeta, u: number, v: number, disparity: number): [number, number, number] {
  const aspect = meta.source.width / meta.source.height;
  const tanHalfFov = Math.tan((meta.camera.fovDeg * Math.PI) / 360);
  return worldPosition(u, v, disparity, aspect, tanHalfFov, meta.camera.farRange);
}

/**
 * 自前のシェーダーに埋め込めるGLSLスニペット。RG16パックはGPUのバイリニア補間が使えないため、
 * NEARESTサンプリング + 手動バイリニア(dsp)で読む必要がある(現行ビューワと同じ方式)。
 * 使用側はuDep(sampler2D)とuDRes(vec2)のuniformを用意すること。
 */
export const GLSL_SNIPPETS = {
  /**
   * depthBitmap(RG16パックのままのRGBA8テクスチャ)をシェーダー内で復元する版。
   * texelFetchの正規化値(byte/255)から d = (R*256+G)*255/65535 を復元する。
   * CPU側のFloat32化(pkg.depth)を踏まずに済む。dspと同じく手動バイリニア。
   * テクスチャはNEAREST・flipYなしでアップロードすること。
   */
  unpackAndSampleDepthRgba8: `
float dsp8t(sampler2D uDep, ivec2 p){
  vec2 rg=texelFetch(uDep,p,0).rg;
  return (rg.x*256.0+rg.y)*255.0/65535.0;
}
float dsp8(sampler2D uDep, vec2 uDRes, vec2 uv){
  vec2 stx=vec2(uv.x,1.0-uv.y)*uDRes-0.5;
  vec2 f=fract(stx);
  ivec2 i0=ivec2(floor(stx));
  ivec2 mx=ivec2(uDRes)-1;
  float a=dsp8t(uDep,clamp(i0,ivec2(0),mx));
  float b=dsp8t(uDep,clamp(i0+ivec2(1,0),ivec2(0),mx));
  float c=dsp8t(uDep,clamp(i0+ivec2(0,1),ivec2(0),mx));
  float d=dsp8t(uDep,clamp(i0+ivec2(1,1),ivec2(0),mx));
  return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
}`.trim(),
  /**
   * ワールド座標(wpos)からスクリーン空間微分で法線を導出する(フラグメントシェーダー専用)。
   * normal.pngの焼き込みが不要なケースの代替。computeNormalsのシェーダー版に相当。
   */
  screenSpaceNormal: `
vec3 nrm(vec3 pos){
  vec3 n=normalize(cross(dFdx(pos),dFdy(pos)));
  return dot(n,-pos)<0.0?-n:n;
}`.trim(),
  unpackAndSampleDepth: `
float dsp(sampler2D uDep, vec2 uDRes, vec2 uv){
  vec2 stx=vec2(uv.x,1.0-uv.y)*uDRes-0.5;
  vec2 f=fract(stx);
  ivec2 i0=ivec2(floor(stx));
  ivec2 mx=ivec2(uDRes)-1;
  float a=texelFetch(uDep,clamp(i0,ivec2(0),mx),0).r;
  float b=texelFetch(uDep,clamp(i0+ivec2(1,0),ivec2(0),mx),0).r;
  float c=texelFetch(uDep,clamp(i0+ivec2(0,1),ivec2(0),mx),0).r;
  float d=texelFetch(uDep,clamp(i0+ivec2(1,1),ivec2(0),mx),0).r;
  return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
}`.trim(),
  worldPosition: `
float toZ(float d, float uFar){return 1.0/mix(1.0/uFar,1.0,d);}
vec3 wpos(vec2 uv, float d, float aspect, float uTanF, float uFar){
  float z=toZ(d,uFar);
  vec2 s=(uv*2.-1.)*vec2(aspect,1.)*uTanF;
  return vec3(s*z,-z);
}`.trim(),
};
