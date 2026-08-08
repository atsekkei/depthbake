/**
 * 画像容量は概ね画素数に比例するため、実測バイト比の平方根から次の長辺を求める。
 * 予測誤差で再超過しにくいよう5%の余裕を持たせ、必ず1px以上縮小する。
 */
export function nextMapMaxSize(currentSize: number, actualBytes: number, maxBytes: number, minSize = 64): number {
  if (![currentSize, actualBytes, maxBytes, minSize].every(Number.isFinite)) {
    throw new Error("Map sizing values must be finite numbers.");
  }
  if (currentSize <= minSize) return minSize;
  if (actualBytes <= maxBytes) return currentSize;
  const estimated = Math.floor(currentSize * Math.sqrt(maxBytes / actualBytes) * 0.95);
  return Math.max(minSize, Math.min(currentSize - 1, estimated));
}
