# photospace-runtime

[![npm](https://img.shields.io/npm/v/photospace-runtime)](https://www.npmjs.com/package/photospace-runtime)

A lightweight runtime for using Photospace packages in creative web projects.

It reads a package baked by [`photospace-cli`](https://github.com/atsekkei/photospace/tree/main/packages/cli), selects a decodable AVIF/WebP/JPEG photo candidate, exposes GPU-ready depth/mask/normal bitmaps, and provides helpers for recovering world-space positions. It is renderer-agnostic, so it works with three.js, raw WebGL, Canvas2D, or custom shaders.

## Install

```bash
npm install photospace-runtime
```

## Usage

```ts
import { loadPackage, worldPositionFromMeta } from "photospace-runtime";

const pkg = await loadPackage("/sample/source/");
// pkg.photo:       ImageBitmap
// pkg.depthBitmap: ImageBitmap — decoded depth.png, still RG16-packed; upload as an RGBA8
//                  texture and unpack in-shader with GLSL_SNIPPETS.unpackAndSampleDepthRgba8
// pkg.depth:       Float32Array (0..1, depthWidth x depthHeight) — lazy: unpacked on the CPU
//                  on first access, then cached
// pkg.skyMask / pkg.edgeMask: Float32Array (0..1) | undefined — only when mask.png is bundled (lazy)
// pkg.normal:      { nx, ny, nz: Float32Array } (-1..1) | undefined — only when normal.png is bundled (lazy)

// Load only what you need — skipped components are neither fetched nor decoded:
const light = await loadPackage("/sample/source/", { need: ["photo", "depth"] });

const [x, y, z] = worldPositionFromMeta(pkg.meta, u, v, disparity);
```

`loadPackage(baseUrl)` tries the photo candidates in `meta.photo.sources` in order (a version 2 package always ends with the mandatory `photo.jpg`), while fetching the map files declared by `meta.json` in parallel. Version 1 packages are still supported: all maps are fetched unconditionally and packages without `photo.sources` default to `photo.avif`.

The decoded PNGs are exposed as `ImageBitmap`s (`depthBitmap` / `maskBitmap` / `normalBitmap`) so GPU renderers can upload them directly. The `Float32Array` views (`depth` / `skyMask` / `edgeMask` / `normal`) are lazy getters: the CPU unpack runs on first access and is cached, so pure-GPU consumers never pay for it. If you `close()` a bitmap, do it only after reading the corresponding lazy field.

To wire it directly into your own shader, use `GLSL_SNIPPETS.unpackAndSampleDepthRgba8` (direct RGBA8 upload) or `GLSL_SNIPPETS.unpackAndSampleDepth` (Float32 `DataTexture` from `pkg.depth`), plus `GLSL_SNIPPETS.worldPosition`. Because the RG16 packing cannot use the GPU's bilinear interpolation, both sample with NEAREST plus manual bilinear filtering.

See [`examples/three-scene`](https://github.com/atsekkei/photospace/tree/main/examples/three-scene) for a three.js implementation.

> **Browser-only.** The loader relies on `fetch`, `createImageBitmap`, and `OffscreenCanvas`, so it runs in the browser (or a Worker), not in Node. To bake packages from Node, use [`photospace-cli`](https://github.com/atsekkei/photospace/tree/main/packages/cli).

## API

Full type definitions ship in `dist/loader.d.ts`; this is a summary of the public surface.

### `loadPackage(baseUrl: string | URL, options?: LoadPackageOptions)`

Fetches and decodes the package under `baseUrl`. A trailing `/` is added to `baseUrl` if missing, and it is resolved against `location.href`, so both relative (`"/sample/source/"`) and absolute URLs work.

Without `options` it returns a `PhotoSpacePackage` (`photo` / `depthBitmap` / `depth` guaranteed). With `options.need` it returns a `PartialPhotoSpacePackage` where skipped components are `undefined`:

```ts
type PackageComponent = "photo" | "depth" | "mask" | "normal";

interface LoadPackageOptions {
  need?: readonly PackageComponent[]; // default: everything bundled (backward compatible)
}

interface PartialPhotoSpacePackage {
  meta: PhotoSpaceMeta;              // parsed meta.json (version 1 or 2)
  photo?: ImageBitmap;               // decoded photo, ready as a texture source
  depthBitmap?: ImageBitmap;         // decoded depth.png (still RG16-packed RGBA8) for direct GPU upload
  readonly depth?: Float32Array;     // disparity 0..1 (1 = near); lazy CPU unpack, cached
  depthWidth: number;
  depthHeight: number;
  maskBitmap?: ImageBitmap;          // decoded mask.png (R = sky, G = edge)
  normalBitmap?: ImageBitmap;        // decoded normal.png
  readonly skyMask?: Float32Array;   // 0..1 (1 = sky); only when mask.png is bundled; lazy
  readonly edgeMask?: Float32Array;  // 0..1 (1 = non-edge); only when mask.png is bundled; lazy
  readonly normal?: { nx: Float32Array; ny: Float32Array; nz: Float32Array }; // each -1..1; lazy
}

interface PhotoSpacePackage extends PartialPhotoSpacePackage {
  photo: ImageBitmap;
  depthBitmap: ImageBitmap;
  readonly depth: Float32Array;
}
```

`depth` is recovered from the RG16-packed `depth.png` as `(R * 256 + G) / 65535`. All arrays are row-major and share the same `depthWidth * depthHeight` length. The lazy fields rasterize their bitmap once on first access — check `pkg.maskBitmap !== undefined` if you only want to know whether a map is bundled without paying for the unpack.

### Deriving maps at runtime

`mask.png` / `normal.png` are baked purely from depth + camera meta, so packages can ship without them (smaller downloads, and under a `maps.maxBytes` cap the freed budget raises the depth resolution). The same functions the CLI bakes with are exported here:

```ts
import { computeSkyMask, computeEdgeMask, computeNormals } from "photospace-runtime";

const depth = { width: pkg.depthWidth, height: pkg.depthHeight, data: pkg.depth };
const sky = computeSkyMask(depth, pkg.meta.sky.threshold); // sky mask as the CLI bakes it
const edge = computeEdgeMask(depth);                       // edge mask as the CLI bakes it
const { nx, ny, nz } = computeNormals(depth, pkg.meta.camera.fovDeg, pkg.meta.camera.farRange);
```

In a fragment shader, `GLSL_SNIPPETS.screenSpaceNormal` derives the same normal from the world position without any CPU work (see `examples/three-scene`). Baking the maps into the package is only worth it when you want to skip this runtime derivation cost (or need the maps before the first frame); the CLI bakes from the pre-quantization float depth, which is visually identical.

### `worldPositionFromMeta(meta, u, v, disparity): [x, y, z]`

Reconstructs a world-space position from a UV coordinate (`0..1`) and a disparity value, using only `camera.fovDeg` / `camera.farRange` from `meta`. The result is in a right-handed, camera-space frame looking down **−Z** (matching the viewer and the `GLSL_SNIPPETS.worldPosition` output).

### `GLSL_SNIPPETS`

GLSL (ES 3.0 / WebGL2) source strings you can concatenate into your own shader:

- `unpackAndSampleDepthRgba8` — defines `float dsp8(sampler2D uDep, vec2 uDRes, vec2 uv)` for a texture uploaded directly from `pkg.depthBitmap` (RGBA8, NEAREST, `flipY: false`). Unpacks `(R*256+G)*255/65535` per texel with a manual bilinear blend. This is the cheapest path: no CPU unpack at all.
- `unpackAndSampleDepth` — defines `float dsp(sampler2D uDep, vec2 uDRes, vec2 uv)` for a Float32 `DataTexture` built from `pkg.depth`. Same manual bilinear sampling.
- `worldPosition` — defines `float toZ(float d, float uFar)` and `vec3 wpos(vec2 uv, float d, float aspect, float uTanF, float uFar)`, the shader-side equivalent of `worldPositionFromMeta` (`uTanF = tan(fovDeg * π / 360)`).
- `screenSpaceNormal` — defines `vec3 nrm(vec3 pos)` (fragment shader only), deriving the surface normal from `wpos` output via `cross(dFdx, dFdy)` — the in-shader replacement for a baked `normal.png`.

```glsl
// fragment shader
${GLSL_SNIPPETS.unpackAndSampleDepthRgba8}
${GLSL_SNIPPETS.worldPosition}
${GLSL_SNIPPETS.screenSpaceNormal}
// ... later:
float d = dsp8(uDep, uDRes, uv);
vec3 p = wpos(uv, d, aspect, uTanF, uFar);
vec3 n = nrm(p);
```

### Types

`PhotoSpaceMeta`, `PhotoSpacePackage`, `PartialPhotoSpacePackage`, `LoadPackageOptions`, `PackageComponent`, `RasterF32`, and `NormalRaster` are exported for TypeScript consumers. `PhotoSpaceMeta` mirrors `meta.json` — see [`docs/package-format.md`](https://github.com/atsekkei/photospace/blob/main/docs/package-format.md) for the field-by-field spec.

## Package format

[`docs/package-format.md`](https://github.com/atsekkei/photospace/blob/main/docs/package-format.md) documents the fields in detail along with the compatibility policy. The `version` field in `meta.json` guards against future format changes; this loader reads versions 1 and 2 and throws on anything else.

> **Breaking change in 0.2.0:** `skyMask`, `edgeMask`, and `normal` are now optional — version 2 packages bundle `mask.png` / `normal.png` only when baked with them enabled. Runtimes ≤0.1.x cannot read v2 packages baked without both maps.

> **Changed in 0.3.0:** `depth` / `skyMask` / `edgeMask` / `normal` are now lazy getters backed by the new `depthBitmap` / `maskBitmap` / `normalBitmap` fields — values are identical, but the CPU unpack happens on first access instead of at load. New: `loadPackage(url, { need })` selective loading, `GLSL_SNIPPETS.unpackAndSampleDepthRgba8` / `screenSpaceNormal`, and the map-derivation functions `computeSkyMask` / `computeEdgeMask` / `computeNormals`.

## Building from source

```bash
pnpm install
pnpm --filter photospace-runtime build
```

This builds `loader.ts` into `dist/loader.js` (ESM) + `dist/loader.d.ts`.

## License

MIT
