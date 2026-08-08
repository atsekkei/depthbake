# Package format (version 2)

The `bake` command of [`photospace-cli`](../packages/cli) writes photo variants and the package files into one directory per photo. The "Package (.zip)" button in the browser demo generates the same format directly with `photospace-core` and bundles it into a zip.

```
out/<name>/
├── photo.jpg     # Required final fallback candidate
├── photo.avif    # Optional candidate (preferred when present)
├── photo.webp    # Optional candidate
├── depth.png     # Required. Disparity (RG16 packed)
├── mask.png      # Optional. Sky mask (R) + edge mask (G); present iff meta.mask exists
├── normal.png    # Optional. World-space normals (RGB); present iff meta.normal exists
└── meta.json     # Required. Camera & normalization parameters + file manifest
```

Required files are `photo.jpg`, `depth.png`, and `meta.json`. `loadPackage()` fails when `depth.png` is missing, no photo candidate can be decoded, a map declared by `meta.json` is missing, or `meta.json.version` is unsupported.

`meta.photo.sources` lists photo candidates in preference order. The runtime fetches and decodes each candidate until one succeeds, always keeping `photo.jpg` as the final candidate — JPEG is the one format every encoder (canvas and sharp) and decoder supports, which is why it is mandatory. `photo.file` duplicates the first candidate for older runtimes. The CLI emits every configured format and rejects configs whose `photo.formats` lacks `jpeg`; browser export bundles the requested formats its canvas encoder supports and always includes JPEG.

`mask.png` and `normal.png` are opt-in (CLI `--mask` / `--normal` flags or `maps.mask` / `maps.normal` in the config; checkboxes in the browser demo) and off by default. Their presence is declared by the `mask` / `normal` fields in `meta.json` — the runtime only fetches what is declared. Note that `sky.threshold` stays in `meta.json` regardless: sky can be derived in-shader from disparity alone, without `mask.png` (see `examples/three-scene`).

All included maps share one resolution. `maps.maxBytes` is an encoding-time constraint, not metadata: when the combined PNG size of the included maps exceeds it, they are all rebaked at a smaller common resolution and the actual dimensions are recorded in `depth.width` / `depth.height`.

## meta.json

```ts
interface PhotoSpaceMeta {
  version: 2;
  source: { file: string; width: number; height: number };
  photo?: {
    file: string; // First candidate
    width?: number;
    height?: number;
    sources?: Array<{
      file: string;
      type: "image/avif" | "image/webp" | "image/jpeg";
    }>;
  };
  depth: {
    width: number;
    height: number;
    space: "disparity";
    orientation: "near=1";
    normalization: { min: number; max: number };
  };
  mask?: { file: string };   // Present iff mask.png is bundled
  normal?: { file: string }; // Present iff normal.png is bundled
  camera: { fovDeg: number; farRange: number };
  sky: { threshold: number };
  model: { name: string; revision: string };
  bakedAt: string; // ISO8601
  sourceHash: string; // sha256(photoBytes + configJson), used by the CLI to skip re-baking
}
```

- `depth.space: "disparity"` / `orientation: "near=1"`: stores disparity (larger value = nearer), not depth. `depth.normalization` records the raw disparity range the model output (post-inference, pre-normalization); `depth.png` itself holds normalized (0..1) values.
- `camera.fovDeg` / `camera.farRange`: the only parameters needed for the disparity → world-space conversion. `z` is derived with the formula below (`toZ`).

  ```
  disp = mix(1/farRange, 1, d)   // d: normalized disparity in 0..1
  z    = 1 / disp
  x    = (u*2-1) * aspect * tan(fovDeg/2) * z
  y    = (v*2-1) *          tan(fovDeg/2) * z
  ```

- `sky.threshold`: records, as-is, the threshold below which disparity is treated as sky. Used to generate the R channel of `mask.png` when bundled, and usable for in-shader sky detection when not.

## depth.png — RG16 packing of disparity

An 8-bit PNG can only represent 256 levels, producing banding artifacts in depth, so a 16-bit value is split across two channels.

```
R = (d16 >> 8) & 0xff   // high 8 bits
G =  d16       & 0xff   // low 8 bits
B = 0
d16 = round(clamp01(d) * 65535)
```

Recovered with `d = (R*256 + G) / 65535`. The GPU's bilinear interpolation cannot be used on this packing (interpolation across R/G breaks), so sampling in a shader requires NEAREST + manual bilinear (see `photospace-runtime`'s `GLSL_SNIPPETS.unpackAndSampleDepth`).

## mask.png (optional)

```
R = round(clamp01(skyMask)  * 255)  // 1 = sky
G = round(clamp01(edgeMask) * 255)  // 1 = non-edge (approaches 0 near silhouettes)
B = 0
```

## normal.png (optional)

World-space normals (-1..1) are mapped to 0..1 with `n*0.5+0.5` and stored in RGB.

## Map PNG channels

The alpha channel of every map is unused, so encoders may write either RGB (3-channel) or RGBA (with A=255) PNGs — the CLI writes RGB, while the browser demo's canvas encoder emits RGBA. Decoders always see the same values: browser decoding (`getImageData` / `texImage2D`) expands RGB PNGs to RGBA with A=255.

Encoders must not emit palette (indexed) PNGs: quantizing to ≤256 colors corrupts the RG16 depth packing (and degrades the other maps). CLI ≤0.2.x accidentally palettized its maps via sharp's `effort` option; 0.3.0 fixes this.

## Version 1 (legacy)

Version 1 differs from version 2 only in which files are required; the raster encodings are identical.

- `depth.png`, `mask.png`, and `normal.png` were all required, and `meta.json` had no `mask` / `normal` fields — their presence was assumed. `loadPackage()` fails on a v1 package with any map missing.
- No photo candidate was mandatory. Packages without `meta.photo` default to `photo.avif`; `photo.jpg` may be absent.

## Compatibility policy

`meta.json.version` is bumped only when the format changes in a backward-incompatible way. `photospace-runtime` reads versions 1 and 2 and throws on anything else. Note the inverse does not hold: runtimes ≤0.1.x fetch `mask.png` / `normal.png` unconditionally, so they can only read v2 packages baked with both maps enabled.
