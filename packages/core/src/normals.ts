// 実装は photospace-runtime (loader.ts) へ移動した。配信済みパッケージからの
// 実行時導出を可能にするためで、core からは従来どおりの名前で再エクスポートする。
export { computeNormals, worldPosition, type NormalRaster } from "photospace-runtime";
