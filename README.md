# Depthbake

[![depthbake-cli on npm](https://img.shields.io/npm/v/depthbake-cli?label=depthbake-cli)](https://www.npmjs.com/package/depthbake-cli)
[![depthbake-runtime on npm](https://img.shields.io/npm/v/depthbake-runtime?label=depthbake-runtime)](https://www.npmjs.com/package/depthbake-runtime)
[![depthbake-three on npm](https://img.shields.io/npm/v/depthbake-three?label=depthbake-three)](https://www.npmjs.com/package/depthbake-three)

https://github.com/user-attachments/assets/6c365f60-f97d-4a50-b25d-e14a48d6000f

A local-first depth image pipeline for the creative web.

Depthbake turns still images into portable, depth-aware assets for WebGL, three.js, and custom creative coding workflows. Bake a lightweight package locally (`photo.jpg` + optional AVIF/WebP candidates / `depth.png` / `meta.json`, plus opt-in `mask.png` / `normal.png`), then drive the result with pointer, scroll, shaders, lighting, particles, or your own runtime.

**Live demo: [depthbake.pages.dev](https://depthbake.pages.dev)**

- **Browser baker** (the root app in this repo): drop in a photo, estimate depth in-browser (WebGPU/WASM), preview depth-aware effects, and export a `.depthbake` package. Everything runs locally; nothing is uploaded to a server. Export controls let you set photo/map resolution, cap the combined map PNG size, and bundle AVIF/WebP/JPEG photo variants supported by the browser.
- **[`depthbake-cli`](packages/cli)**: runs the same inference and packing logic in Node to batch-bake production packages from a folder of images. Distributed on npm as [`depthbake-cli`](https://www.npmjs.com/package/depthbake-cli).
- **[`depthbake-runtime`](packages/runtime)**: a lightweight, renderer-agnostic loader that reads the package, selects the first decodable photo candidate, exposes GPU-ready map bitmaps, and recovers world-space positions for three.js, raw WebGL, Canvas2D, or custom shaders. Distributed on npm as [`depthbake-runtime`](https://www.npmjs.com/package/depthbake-runtime).
- **[`depthbake-three`](packages/three)**: a `THREE.Loader` that turns a package into ready-to-use three.js textures and a matching uniform bundle, plus a cover-fit `DepthbakeCamera`. It doesn't ship a default effect or motion system — write your own shader against `asset.uniforms`. Distributed on npm as [`depthbake-three`](https://www.npmjs.com/package/depthbake-three).

## What it is for

Depthbake is meant for creative developers and studios building image-led websites: brand hero visuals, exhibition sites, photographer portfolios, travel and hotel pages, music or film promos, and other cases where a still image needs to become an interactive WebGL surface rather than a baked video.

It is not just a parallax preset. The package gives you depth as creative input, so the same still image can drive:

- pointer or scroll parallax
- depth-based relighting
- particles and splats
- fog, blur, and color grading
- typography occlusion or reveal effects
- shader transitions and displacement

## Five-minute start

```bash
npx depthbake-cli bake ./photos --out ./out
```

```ts
import * as THREE from "three";
import { DepthbakeLoader, DepthbakeCamera } from "depthbake-three";

const asset = await new DepthbakeLoader().loadAsync("/out/hero/");
const camera = new DepthbakeCamera(asset); // cover-fit THREE.PerspectiveCamera

// asset.photo / asset.depth are ready-to-use THREE.Texture instances, and
// asset.uniforms is a bundle your own shader can consume directly.
console.log(asset.meta, asset.uniforms);
```

See [`examples/hero`](examples/hero) for the full copy-paste template (pointer follow, idle autopilot, reduced-motion), and [`examples/three-scene`](examples/three-scene), [`examples/depth-splats`](examples/depth-splats), [`examples/relight`](examples/relight) for complete three.js demos — all built on [`depthbake-three`](packages/three).

## Repository layout

```
.
├── src/                 # Browser demo app (Vite, private)
├── examples/three-scene # three.js scene that loads a package into a custom shader
├── examples/depth-splats # depth-placed point cloud / splat demo
├── examples/relight     # depth + normal driven relighting demo
├── examples/hero         # copy-paste starter template (pointer follow, idle, reduced-motion)
├── public/sample/source # A sample pre-baked package
└── packages/
    ├── core/            # Shared inference / normalization / upsampling / packing logic (private, used by both the viewer and the CLI)
    ├── cli/              → published as depthbake-cli
    ├── runtime/          → published as depthbake-runtime
    └── three/            → published as depthbake-three
```

`packages/core` is an internal package shared by the viewer app and the CLI; it is not published to npm (`private: true`). The CLI bundles it at build time.

## Setup

```bash
pnpm install
```

Requires Node 20+ (the CLI depends on the native binaries of `sharp` and `onnxruntime-node`).

## Running the browser demo

```bash
pnpm dev
```

On first run the depth estimation model (~25–50MB, [`onnx-community/depth-anything-v2-small`](https://huggingface.co/onnx-community/depth-anything-v2-small)) is downloaded in the browser. It uses WebGPU where available and falls back to WASM otherwise.

## Using the CLI

```bash
npx depthbake-cli bake ./photos --out ./out
```

Or install it globally with `npm install -g depthbake-cli`. See [`packages/cli/README.md`](packages/cli/README.md) for details.

## Package format

The package the CLI writes and the runtime reads is specified in [`docs/package-format.md`](docs/package-format.md).

## Model license

The default model `onnx-community/depth-anything-v2-small` is Apache-2.0 and permitted for commercial use. The Base/Large variants of Depth Anything V2 are CC-BY-NC-4.0 (non-commercial only), so always check each model card's license before switching models.

## Tests & type-checking

```bash
pnpm test        # Unit tests in packages/*/test and src/*/*.test.ts
pnpm typecheck   # Type-check every workspace, including the root app
```

## License

MIT
