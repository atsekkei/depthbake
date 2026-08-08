export interface NormalizeResult {
  data: Float32Array;
  min: number;
  max: number;
}

/** モデルの生の視差値を記録しつつ 0..1 へ正規化する */
export function normalizeDisparity(raw: ArrayLike<number>): NormalizeResult {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min || 1;
  const data = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    data[i] = (raw[i] - min) / range;
  }
  return { data, min, max };
}
