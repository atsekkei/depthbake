export interface RasterF32 {
  width: number;
  height: number;
  data: Float32Array;
}

/** RGBA(Uint8)をグレースケール輝度のFloat32ラスタへ変換する */
export function rgbaToGrayF32(rgba: ArrayLike<number>, width: number, height: number): RasterF32 {
  const data = new Float32Array(width * height);
  for (let i = 0; i < data.length; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    data[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }
  return { width, height, data };
}

/**
 * バイリニアリサイズ。出力側の各画素から入力側の対応座標を逆算してサンプリングするため、
 * 入力解像度の大小に関わらず計算量は出力画素数に比例する。
 */
export function bilinearResizeF32(src: RasterF32, dstW: number, dstH: number): RasterF32 {
  const out = new Float32Array(dstW * dstH);
  const sx = src.width / dstW;
  const sy = src.height / dstH;
  for (let y = 0; y < dstH; y++) {
    const fy = Math.min(Math.max((y + 0.5) * sy - 0.5, 0), src.height - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, src.height - 1);
    const ty = fy - y0;
    for (let x = 0; x < dstW; x++) {
      const fx = Math.min(Math.max((x + 0.5) * sx - 0.5, 0), src.width - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(x0 + 1, src.width - 1);
      const tx = fx - x0;
      const a = src.data[y0 * src.width + x0];
      const b = src.data[y0 * src.width + x1];
      const c = src.data[y1 * src.width + x0];
      const d = src.data[y1 * src.width + x1];
      out[y * dstW + x] = lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
    }
  }
  return { width: dstW, height: dstH, data: out };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * RGBA(Uint8)を目標解像度へバイリニア縮小しながらグレースケール輝度のFloat32ラスタへ変換する。
 * バイリニア補間も輝度変換も線形なので「グレー化→リサイズ」と結果は同一だが、
 * 元解像度での全画素グレー化を省けるため計算量は出力画素数のみに比例する。
 */
export function resizeRgbaToGrayF32(
  rgba: ArrayLike<number>,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): RasterF32 {
  const out = new Float32Array(dstW * dstH);
  const sx = srcW / dstW;
  const sy = srcH / dstH;
  for (let y = 0; y < dstH; y++) {
    const fy = Math.min(Math.max((y + 0.5) * sy - 0.5, 0), srcH - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, srcH - 1);
    const ty = fy - y0;
    for (let x = 0; x < dstW; x++) {
      const fx = Math.min(Math.max((x + 0.5) * sx - 0.5, 0), srcW - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(x0 + 1, srcW - 1);
      const tx = fx - x0;
      const ia = (y0 * srcW + x0) * 4;
      const ib = (y0 * srcW + x1) * 4;
      const ic = (y1 * srcW + x0) * 4;
      const id = (y1 * srcW + x1) * 4;
      const r = lerp(lerp(rgba[ia], rgba[ib], tx), lerp(rgba[ic], rgba[id], tx), ty);
      const g = lerp(lerp(rgba[ia + 1], rgba[ib + 1], tx), lerp(rgba[ic + 1], rgba[id + 1], tx), ty);
      const b = lerp(lerp(rgba[ia + 2], rgba[ib + 2], tx), lerp(rgba[ic + 2], rgba[id + 2], tx), ty);
      out[y * dstW + x] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    }
  }
  return { width: dstW, height: dstH, data: out };
}

/** Summed-area table を使った O(wh) の box filter (平均値) */
function boxFilterMean(data: Float32Array, w: number, h: number, radius: number): Float32Array {
  const sat = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += data[y * w + x];
      sat[(y + 1) * (w + 1) + (x + 1)] = sat[y * (w + 1) + (x + 1)] + rowSum;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(h - 1, y + radius);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(w - 1, x + radius);
      const sum =
        sat[(y1 + 1) * (w + 1) + (x1 + 1)] -
        sat[y0 * (w + 1) + (x1 + 1)] -
        sat[(y1 + 1) * (w + 1) + x0] +
        sat[y0 * (w + 1) + x0];
      const count = (x1 - x0 + 1) * (y1 - y0 + 1);
      out[y * w + x] = sum / count;
    }
  }
  return out;
}

export interface GuidedFilterOptions {
  /** box filterの半径(画素)。既定8 */
  radius?: number;
  /** 分散の正則化項。既定1e-3 */
  eps?: number;
}

/**
 * ガイド画像(元写真の輝度)を使ったガイデッドフィルタ。
 * 深度そのものを直接ぼかさず、ガイドとの線形関係(a,b)を平滑化してから適用することで、
 * 被写体のシルエット(輪郭)に深度をスナップさせる。
 */
export function guidedFilter(guide: RasterF32, input: RasterF32, opts: GuidedFilterOptions = {}): RasterF32 {
  const { width: w, height: h } = guide;
  const radius = opts.radius ?? 8;
  const eps = opts.eps ?? 1e-3;
  const I = guide.data;
  const p = input.data;

  const II = new Float32Array(w * h);
  const Ip = new Float32Array(w * h);
  for (let i = 0; i < I.length; i++) {
    II[i] = I[i] * I[i];
    Ip[i] = I[i] * p[i];
  }

  const meanI = boxFilterMean(I, w, h, radius);
  const meanP = boxFilterMean(p, w, h, radius);
  const corrI = boxFilterMean(II, w, h, radius);
  const corrIp = boxFilterMean(Ip, w, h, radius);

  const a = new Float32Array(w * h);
  const b = new Float32Array(w * h);
  for (let i = 0; i < a.length; i++) {
    const varI = corrI[i] - meanI[i] * meanI[i];
    const covIp = corrIp[i] - meanI[i] * meanP[i];
    const ai = covIp / (varI + eps);
    a[i] = ai;
    b[i] = meanP[i] - ai * meanI[i];
  }

  const meanA = boxFilterMean(a, w, h, radius);
  const meanB = boxFilterMean(b, w, h, radius);

  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) {
    out[i] = meanA[i] * I[i] + meanB[i];
  }
  return { width: w, height: h, data: out };
}

/**
 * 低解像度の深度を、元写真をガイドにしたガイデッドフィルタで目標解像度へアップサンプリングする。
 * 単純バイリニアでは輪郭がにじむため、guide/depth双方を目標解像度へ合わせてからフィルタする。
 */
export function guidedUpsampleDepth(
  depthLowRes: RasterF32,
  guideRgba: ArrayLike<number>,
  guideWidth: number,
  guideHeight: number,
  targetWidth: number,
  targetHeight: number,
  opts?: GuidedFilterOptions,
): RasterF32 {
  const guideAtTarget = resizeRgbaToGrayF32(guideRgba, guideWidth, guideHeight, targetWidth, targetHeight);
  const depthAtTarget = bilinearResizeF32(depthLowRes, targetWidth, targetHeight);
  return guidedFilter(guideAtTarget, depthAtTarget, opts);
}
