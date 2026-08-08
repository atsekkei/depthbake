import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const outDir = "../../dist-three-scene";

export default defineConfig({
  root,
  base: "./",
  // main.tsが読む /sample/source/ (リポジトリ共通のサンプルパッケージ)をdev/buildの両方で配信する
  publicDir: resolve(root, "../../public"),
  server: {
    host: "127.0.0.1",
  },
  preview: {
    host: "127.0.0.1",
  },
  build: {
    outDir,
    emptyOutDir: true,
  },
});
