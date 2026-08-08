import { cp } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const outDir = "../../dist-relight";

export default defineConfig({
  root,
  base: "./",
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
  plugins: [
    {
      name: "copy-depthbake-package",
      async closeBundle() {
        await cp(resolve(root, "bust.depthbake"), resolve(root, outDir, "bust.depthbake"), {
          recursive: true,
        });
      },
    },
  ],
});
