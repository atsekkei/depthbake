import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  outDir: "dist",
  clean: true,
  // photospace-core は private ワークスペースパッケージなので npm には公開しない。
  // 外部 import のまま publish すると install 時に依存解決が失敗するため、CLI にバンドルする。
  // photospace-runtime は公開パッケージだが、core が導出関数(masks/normals)を
  // 再エクスポートしているだけなので依存に追加せず一緒にバンドルする。
  noExternal: ["photospace-core", "photospace-runtime"],
  // @huggingface/transformers はネイティブ/WASM を含む大型依存。バンドルせず external に残し、
  // CLI の dependencies として install させる(core 経由で transitive に必要)。
  external: ["@huggingface/transformers", "onnxruntime-node", "sharp"],
});
