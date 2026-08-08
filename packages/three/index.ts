import * as THREE from "three";
import { loadPackageStaged, worldPositionFromMeta } from "depthbake-runtime";
import type {
  PackageComponent,
  PartialDepthbakePackage,
  DepthbakeMeta,
} from "depthbake-runtime";

// 自前のシェーダーを書くための材料。depthbake-runtime からの再エクスポートで、
// 利用者が2パッケージからimportしなくて済むようにする。
export {
  GLSL_SNIPPETS,
  loadPackageStaged,
  worldPosition,
  worldPositionFromMeta,
  computeSkyMask,
  computeEdgeMask,
  computeNormals,
} from "depthbake-runtime";
export type {
  DepthbakeMeta,
  DepthbakePackage,
  PartialDepthbakePackage,
  StagedDepthbakePackage,
  PackageComponent,
  RasterF32,
  NormalRaster,
} from "depthbake-runtime";

/**
 * GLSL_SNIPPETS が要求する uniform 一式。スニペットは uDep/uDRes/uTanF/uFar という
 * 名前を前提に書かれているため、スニペットと uniform は対で提供する
 * (three/examples/jsm の *Shader が {uniforms, vertexShader, fragmentShader} を
 * セットで出すのと同じ考え方)。名前は既存 examples から変えていない。
 *
 * 同梱されないマップの sampler は null になる。ShaderMaterial は宣言されていない
 * uniform を無視するので、mask/normal を使わないシェーダーへそのまま渡してよい。
 */
export interface DepthbakeUniforms {
  /** 写真 */
  uImg: { value: THREE.Texture | null };
  /** depth.png (RG16パックのままのRGBA8。dsp8()でシェーダー内復元する) */
  uDep: { value: THREE.Texture | null };
  /** normal.png (RGB=法線xyzの0..255エンコード) */
  uNrm: { value: THREE.Texture | null };
  /** mask.png (R=空, G=エッジ信頼度) */
  uMsk: { value: THREE.Texture | null };
  /** depth.png の解像度。dsp8() の手動バイリニアに必要 */
  uDRes: { value: THREE.Vector2 };
  /** tan(fovDeg/2)。wpos() の視錐台スケール */
  uTanF: { value: number };
  /** meta.camera.farRange。視差→Z変換のレンジ */
  uFar: { value: number };
  /** meta.sky.threshold。これ未満の視差を空とみなす */
  uSky: { value: number };
  /** 写真のアスペクト比 */
  uAspect: { value: number };
}

export interface DepthbakeAsset {
  /** need で除外した場合は undefined */
  photo?: THREE.Texture;
  depth?: THREE.Texture;
  /** mask.png 同梱かつ need 対象時のみ */
  mask?: THREE.Texture;
  /** normal.png 同梱かつ need 対象時のみ */
  normal?: THREE.Texture;
  meta: DepthbakeMeta;
  /** 写真のアスペクト比 (meta.source 由来) */
  aspect: number;
  uniforms: DepthbakeUniforms;
  /**
   * depthbake-runtime のパッケージ。CPU側のFloat32 (depth / skyMask / edgeMask /
   * normal) へ降りるための口で、遅延評価される。GPUへ流すだけなら触らなくてよい。
   */
  package: PartialDepthbakePackage;
  /**
   * 生成した THREE.Texture を破棄する。three の texture.dispose() と同じく
   * ImageBitmap は閉じない (閉じると package の遅延Float32が壊れるため)。
   * Bitmap は参照が切れた時点でGCに任せる。
   */
  dispose(): void;
}

export interface DepthbakeLoaderOptions {
  /** 読み込む構成要素。省略時は同梱されているものすべて */
  need?: readonly PackageComponent[];
  /**
   * 写真テクスチャの colorSpace。既定は SRGBColorSpace で、three のカラー
   * マネジメントに変換を任せる一般的なパイプライン向け。
   * シェーダー内で pow(rgb, 2.2) 等の手動sRGB復元を行う場合は NoColorSpace を
   * 指定すること (両方で変換すると二重になる)。
   */
  photoColorSpace?: THREE.ColorSpace;
  /** 写真テクスチャの異方性フィルタリング。既定は three のデフォルト */
  anisotropy?: number;
  /** 中断シグナル。ルート遷移やStrictModeの二重マウントで進行中のロードを捨てる */
  signal?: AbortSignal;
}

/** onProgress が報せるロード段階。loaded/total は段階数(バイト数ではない) */
export type DepthbakeLoadStage = "meta" | "photo" | "depth" | "mask" | "normal";

/** データ用マップ(depth/mask/normal)共通のテクスチャ設定 */
function dataTexture(bitmap: ImageBitmap, nearest: boolean): THREE.Texture {
  const texture = new THREE.Texture(bitmap);
  // RG16パックの depth は、R/G をまたいだ補間が値を壊すため NEAREST 必須。
  // シェーダー側は dsp8() の手動バイリニアで読む (docs/package-format.md)。
  texture.magFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter;
  texture.minFilter = nearest ? THREE.NearestFilter : THREE.LinearFilter;
  texture.generateMipmaps = false;
  // 色管理にピクセル値を触らせない。これらは色ではなくデータ
  texture.colorSpace = THREE.NoColorSpace;
  // three.js は ImageBitmap 由来テクスチャの flipY を無視するため、全マップとも
  // row0=最上段のまま無反転でアップロードされる (false は意図の明示)。
  // 向きの整合はシェーダー側で取る — dsp8() 内の 1.0-uv.y がそれ。
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

function createAsset(
  pkg: PartialDepthbakePackage,
  options: DepthbakeLoaderOptions,
): DepthbakeAsset {
  const { meta } = pkg;
  const aspect = meta.source.width / meta.source.height;

  let photo: THREE.Texture | undefined;
  if (pkg.photo) {
    photo = new THREE.Texture(pkg.photo);
    photo.colorSpace = options.photoColorSpace ?? THREE.SRGBColorSpace;
    if (options.anisotropy !== undefined) photo.anisotropy = options.anisotropy;
    photo.needsUpdate = true;
  }

  const depth = pkg.depthBitmap ? dataTexture(pkg.depthBitmap, true) : undefined;
  const mask = pkg.maskBitmap ? dataTexture(pkg.maskBitmap, false) : undefined;
  const normal = pkg.normalBitmap ? dataTexture(pkg.normalBitmap, false) : undefined;

  const uniforms: DepthbakeUniforms = {
    uImg: { value: photo ?? null },
    uDep: { value: depth ?? null },
    uNrm: { value: normal ?? null },
    uMsk: { value: mask ?? null },
    uDRes: { value: new THREE.Vector2(pkg.depthWidth, pkg.depthHeight) },
    uTanF: { value: Math.tan((meta.camera.fovDeg * Math.PI) / 360) },
    uFar: { value: meta.camera.farRange },
    uSky: { value: meta.sky.threshold },
    uAspect: { value: aspect },
  };

  return {
    photo,
    depth,
    mask,
    normal,
    meta,
    aspect,
    uniforms,
    package: pkg,
    dispose() {
      photo?.dispose();
      depth?.dispose();
      mask?.dispose();
      normal?.dispose();
    },
  };
}

/**
 * Depthbake パッケージを three.js のテクスチャ + uniform として読み込む。
 *
 * THREE.Loader を継承しているので GLTFLoader と同じ規約で使え、
 * LoadingManager にもそのまま乗る (ヒーロー画像のプログレス表示など)。
 *
 * ```ts
 * const asset = await new DepthbakeLoader().loadAsync("/out/hero/");
 * const material = new THREE.ShaderMaterial({ uniforms: asset.uniforms, ... });
 * ```
 *
 * withCredentials / requestHeader は runtime の requestInit へ透過する。
 * crossOrigin は fetch に対応するオプションが無いため効かない。
 */
export class DepthbakeLoader extends THREE.Loader<DepthbakeAsset> {
  private options: DepthbakeLoaderOptions = {};

  /** 読み込む構成要素を絞る。指定外はフェッチもデコードもされない */
  setNeed(need: readonly PackageComponent[]): this {
    this.options.need = need;
    return this;
  }

  /** 写真テクスチャの colorSpace を指定する (既定 SRGBColorSpace) */
  setPhotoColorSpace(colorSpace: THREE.ColorSpace): this {
    this.options.photoColorSpace = colorSpace;
    return this;
  }

  /** 写真テクスチャの異方性フィルタリングを指定する */
  setAnisotropy(anisotropy: number): this {
    this.options.anisotropy = anisotropy;
    return this;
  }

  /** 中断シグナルを指定する。ルート遷移や二重マウントで進行中のロードを捨てる */
  setSignal(signal: AbortSignal): this {
    this.options.signal = signal;
    return this;
  }

  /**
   * パッケージディレクトリのURLを読み込む。
   *
   * onProgress は meta / photo / depth / mask / normal の**段階**が届くたびに
   * 発火する(loaded/total は段階数でバイト数ではないため lengthComputable=false)。
   * ヒーロー用途のローディング表示にはこれで足りる。
   */
  load(
    url: string,
    onLoad: (asset: DepthbakeAsset) => void,
    onProgress?: (event: ProgressEvent) => void,
    onError?: (err: unknown) => void,
  ): void {
    const resolved = this.path ? this.path + url : url;
    this.manager.itemStart(resolved);

    // THREE.Loader の withCredentials / requestHeader を fetch へ透過する
    const hasHeaders = Object.keys(this.requestHeader).length > 0;
    const requestInit: RequestInit | undefined =
      this.withCredentials || hasHeaders
        ? {
            ...(this.withCredentials ? { credentials: "include" as const } : {}),
            ...(hasHeaders ? { headers: this.requestHeader } : {}),
          }
        : undefined;

    const staged = loadPackageStaged(resolved, {
      need: this.options.need,
      signal: this.options.signal,
      requestInit,
    });

    if (onProgress) {
      const stages: Array<[DepthbakeLoadStage, Promise<unknown>]> = [
        ["meta", staged.meta],
        ["photo", staged.photo],
        ["depth", staged.depthBitmap],
        ["mask", staged.maskBitmap],
        ["normal", staged.normalBitmap],
      ];
      let done = 0;
      for (const [, promise] of stages) {
        promise.then(
          () => {
            done += 1;
            onProgress(
              new ProgressEvent("progress", {
                lengthComputable: false,
                loaded: done,
                total: stages.length,
              }),
            );
          },
          () => {}, // 失敗はonErrorが扱う。ここで握って未処理rejectionを作らない
        );
      }
    }

    staged.ready
      .then((pkg) => {
        onLoad(createAsset(pkg, this.options));
      })
      .catch((error: unknown) => {
        if (onError) onError(error);
        else console.error(error);
        this.manager.itemError(resolved);
      })
      .finally(() => {
        this.manager.itemEnd(resolved);
      });
  }
}

/**
 * cover 表示のための tan(fov/2) を求める。画面が写真より横長なら横FOVを、
 * 縦長なら縦FOVを写真に合わせて切り出す (CSS の object-fit: cover 相当)。
 *
 * @param baseTanHalf meta.camera.fovDeg 由来の tan(fov/2)
 * @param frameZoom   追いズーム。1未満で寄る。視差で写真外周が露出するのを防ぐ
 */
export function coverFitTanHalf(
  baseTanHalf: number,
  photoAspect: number,
  viewAspect: number,
  frameZoom: number,
): number {
  return baseTanHalf * Math.min(1, photoAspect / viewAspect) * frameZoom;
}

/**
 * 手前から quantile 分位の視差を返す。視差は大きいほど近いので、
 * 昇順ソートの (1 - quantile) 位置を取る。
 * 被写体の代表深度(注視深度)を求めるのに使う。
 */
export function quantileDisparity(depth: Float32Array, quantile: number): number {
  if (depth.length === 0) throw new Error("depthが空です");
  const sorted = Float32Array.from(depth).sort();
  const index = Math.floor(sorted.length * (1 - quantile));
  return sorted[Math.min(Math.max(index, 0), sorted.length - 1)];
}

export interface DepthbakeCameraOptions {
  /** 追いズーム。1未満で寄る。既定 0.82 */
  frameZoom?: number;
  /** 注視深度を取る分位。既定 0.1 (手前から10%) */
  pivotQuantile?: number;
  near?: number;
  far?: number;
}

/**
 * パッケージの meta に合わせた PerspectiveCamera。
 * FOV は meta.camera.fovDeg 由来で、setSize() が cover 表示になるよう再計算する。
 *
 * ```ts
 * const camera = new DepthbakeCamera(asset);
 * camera.setSize(window.innerWidth, window.innerHeight);
 * camera.position.set(x * 0.1 * camera.pivotZ, y * 0.055 * camera.pivotZ, 0);
 * camera.lookAt(0, 0, -camera.pivotZ);
 * ```
 */
export class DepthbakeCamera extends THREE.PerspectiveCamera {
  /** 追いズーム。変更後は setSize() を呼び直すこと */
  frameZoom: number;
  readonly asset: DepthbakeAsset;

  private baseTanHalf: number;
  private photoAspect: number;
  private pivotQuantile: number;
  private cachedPivotZ: number | undefined;

  constructor(asset: DepthbakeAsset, options: DepthbakeCameraOptions = {}) {
    super(asset.meta.camera.fovDeg, asset.aspect, options.near ?? 0.05, options.far ?? 60);
    this.asset = asset;
    this.frameZoom = options.frameZoom ?? 0.82;
    this.pivotQuantile = options.pivotQuantile ?? 0.1;
    this.baseTanHalf = Math.tan((asset.meta.camera.fovDeg * Math.PI) / 360);
    this.photoAspect = asset.aspect;
  }

  /** ビューポートサイズに合わせて cover 表示になるよう FOV とアスペクトを更新する */
  setSize(width: number, height: number): void {
    const viewAspect = width / height;
    const tanHalf = coverFitTanHalf(this.baseTanHalf, this.photoAspect, viewAspect, this.frameZoom);
    this.fov = (Math.atan(tanHalf) * 360) / Math.PI;
    this.aspect = viewAspect;
    this.updateProjectionMatrix();
  }

  /**
   * 注視深度(カメラ原点からの距離、正値)。被写体の代表的な奥行きで、
   * パララックス振幅や光源距離をアセット非依存にスケールするのに使う。
   *
   * 初回アクセスで depth をCPU復元するため、それまでは need:["photo","depth"] の
   * 軽量ロードパスのコストを一切増やさない。
   */
  get pivotZ(): number {
    if (this.cachedPivotZ === undefined) {
      const depth = this.asset.package.depth;
      if (!depth) {
        throw new Error('pivotZ には depth が必要です (setNeed に "depth" を含めてください)');
      }
      const disparity = quantileDisparity(depth, this.pivotQuantile);
      this.cachedPivotZ = -worldPositionFromMeta(this.asset.meta, 0.5, 0.5, disparity)[2];
    }
    return this.cachedPivotZ;
  }
}
