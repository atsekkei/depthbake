import { pipeline, env, type PretrainedModelOptions, type DepthEstimationPipeline } from "@huggingface/transformers";

export const MODEL_NAME = "onnx-community/depth-anything-v2-small";
export const MODEL_REVISION = "main";

/** transformers.jsのdtype指定のうち、configで選択を許可する集合 */
export const MODEL_DTYPES = ["fp32", "fp16", "q8", "int8", "uint8", "q4", "q4f16", "bnb4"] as const;
export type ModelDtype = (typeof MODEL_DTYPES)[number];

export interface DepthEstimationResult {
  width: number;
  height: number;
  raw: Float32Array;
}

export interface ProgressEvent {
  status: string;
  progress?: number;
  total?: number;
}

export type DepthModel = DepthEstimationPipeline;

/**
 * ブラウザではWebGPU→WASMの順でフォールバック、Node(CLI)ではCPUバックエンドを使う。
 * transformers.jsは環境を自動判別してonnxruntime-web/onnxruntime-nodeを切り替える。
 * opts.dtypeはNode(CLI)のCPU推論にのみ適用される。ブラウザのWebGPU=fp32 / WASM=q8は
 * バックエンドごとの品質・速度の実測に基づく固定値のため上書きしない。
 */
export async function loadDepthModel(opts?: {
  onProgress?: (p: ProgressEvent) => void;
  dtype?: ModelDtype;
}): Promise<DepthModel> {
  const isBrowser = typeof window !== "undefined";
  const progress_callback = opts?.onProgress
    ? (p: ProgressEvent) => opts.onProgress!(p)
    : undefined;

  if (isBrowser && !globalThis.crossOriginIsolated) {
    // マルチスレッドWASMはSharedArrayBufferを要求するため、COOP/COEPヘッダーのない
    // (=クロスオリジン分離されていない)ページではシングルスレッドに固定する。
    // onnxruntime-webにも自前のSAB検出フォールバックがあるが、意図を明示しておく。
    // 分離済み環境ではマルチスレッドの性能を活かすため固定しない。
    // ※ DevToolsに出る「SharedArrayBuffer ... cross-origin isolated」警告は
    //   onnxruntime-webのWASMグルーが起動時に共有メモリをprobeするためのもので、
    //   この設定に関わらず表示される非致命的なwarning。
    const wasm = env.backends.onnx?.wasm;
    if (wasm) wasm.numThreads = 1;
  }

  const candidates: PretrainedModelOptions[] = isBrowser
    ? [
        { device: "webgpu", dtype: "fp32" },
        { device: "wasm", dtype: "q8" },
      ]
    : [{ device: "cpu", dtype: opts?.dtype ?? "fp32" }];

  if (isBrowser && !("gpu" in navigator)) {
    candidates.shift();
  }

  let lastError: unknown;
  for (const opt of candidates) {
    try {
      return await pipeline("depth-estimation", MODEL_NAME, {
        ...opt,
        ...(progress_callback ? { progress_callback } : {}),
      });
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

/** モデル出力(視差テンソル)をFloat32Arrayへ展開する */
export async function estimateDepth(
  model: DepthModel,
  input: string | URL | Blob,
): Promise<DepthEstimationResult> {
  const out = await model(input);
  const result = Array.isArray(out) ? out[0] : out;
  const dims = result.predicted_depth.dims;
  const height = dims[dims.length - 2];
  const width = dims[dims.length - 1];
  const raw = Float32Array.from(result.predicted_depth.data as ArrayLike<number>);
  return { width, height, raw };
}
