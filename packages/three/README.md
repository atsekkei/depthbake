# depthbake-three

three.js loader for [Depthbake](https://github.com/atsekkei/depthbake) depth-aware creative web assets.

It turns a baked Depthbake package into three.js textures and a matching uniform bundle, so you can write your own shader instead of re-deriving the texture setup on every project. It deliberately does **not** ship a default effect, a motion system, or input binders — those belong to your project.

## Install

```bash
npm install depthbake-three three
```

`three` is a peer dependency (>=0.152).

## Use

```ts
import * as THREE from "three";
import { DepthbakeLoader, GLSL_SNIPPETS } from "depthbake-three";

const asset = await new DepthbakeLoader().setNeed(["photo", "depth"]).loadAsync("/out/hero/");

const material = new THREE.ShaderMaterial({
  uniforms: asset.uniforms,
  glslVersion: THREE.GLSL3,
  fragmentShader: `
    uniform sampler2D uImg, uDep;
    uniform vec2 uDRes;
    uniform float uTanF, uFar, uAspect;
    in vec2 vUv;
    out vec4 fragColor;

    ${GLSL_SNIPPETS.unpackAndSampleDepthRgba8}
    ${GLSL_SNIPPETS.worldPosition}

    void main() {
      float d = dsp8(uDep, uDRes, vUv);
      vec3 pos = wpos(vUv, d, uAspect, uTanF, uFar);
      vec3 col = texture(uImg, vUv).rgb; // linear, because the photo texture is sRGB
      // Do your compositing in linear space, then encode on the way out.
      fragColor = linearToOutputTexel(vec4(col, 1.0));
    }
  `,
  vertexShader: `
    out vec2 vUv;
    void main() {
      vUv = vec2(uv.x, 1.0 - uv.y);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
});
```

`DepthbakeLoader` extends `THREE.Loader`, so it follows the same conventions as `GLTFLoader` and works with `THREE.LoadingManager`:

```ts
const manager = new THREE.LoadingManager(onLoad, onProgress);
const asset = await new DepthbakeLoader(manager).loadAsync("/out/hero/");
```

## What the loader handles for you

These are all silent-failure cases — nothing throws when you get them wrong, the result is just subtly incorrect:

- `depth.png` is an RG16 packing, so GPU bilinear filtering across R/G corrupts the value. The depth texture is uploaded with `NearestFilter` and no mipmaps; sample it with `GLSL_SNIPPETS.unpackAndSampleDepthRgba8` (`dsp8`), which does the bilinear filtering manually.
- three.js ignores `flipY` for `ImageBitmap`-backed textures, so every map arrives with row 0 at the top. `dsp8` compensates with `1.0 - uv.y`.
- Maps are data, not color: they are uploaded with `NoColorSpace` so color management never touches the pixel values.
- `uTanF` / `uFar` / `uSky` / `uAspect` are derived from `meta.json`.

## What you have to handle: output color space

This one the loader cannot hide, because it belongs to your shader.

The photo texture is uploaded as `SRGBColorSpace` (the default, and what built-in materials like `MeshBasicMaterial` expect), so `texture(uImg, uv)` returns **linear** values. Do your compositing in linear space — that is where addition, multiplication and blending are physically correct — and encode on the way out:

```glsl
fragColor = linearToOutputTexel(vec4(col, 1.0));
```

`linearToOutputTexel()` is injected by three.js into every non-raw fragment shader, so there is nothing to import. Skip it and your render is silently darker than the source photo — the linear value goes straight to a buffer that is displayed as sRGB.

`#include <colorspace_fragment>` does the same thing, but its body is `gl_FragColor = linearToOutputTexel( gl_FragColor );`, so it does not work with a GLSL3 shader that declares its own `out vec4 fragColor`. Call the function directly instead.

If you would rather work in encoded space and do the conversion yourself (as `examples/relight` does, with `pow(rgb, 2.2)` and `pow(col, 1.0/2.2)`), pass `setPhotoColorSpace(THREE.NoColorSpace)` so three does not convert as well.

## Animating with GSAP / ScrollTrigger

`depthbake-three` doesn't own a "motion" object, so there's no vocabulary to fight GSAP over — tween whatever plain object you already have, and read it back wherever you drive the camera or uniforms:

```ts
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
gsap.registerPlugin(ScrollTrigger);

const asset = await new DepthbakeLoader().loadAsync("/out/hero/");
const camera = new DepthbakeCamera(asset);

const scroll = { progress: 0 };
gsap.to(scroll, {
  progress: 1,
  ease: "none",
  scrollTrigger: { trigger: "#hero", start: "top top", end: "bottom top", scrub: true },
});

function render() {
  // pivotZ is the subject's depth, so this dollies in by a fraction of it
  // regardless of how far away the subject actually is.
  camera.position.z = scroll.progress * camera.pivotZ * 0.3;
  camera.lookAt(0, 0, -camera.pivotZ);
  renderer.render(scene, camera);
  requestAnimationFrame(render);
}
```

The same pattern applies to `asset.uniforms` — e.g. `gsap.to(asset.uniforms.uFar, { value: ..., scrollTrigger: {...} })` to scrub the depth range a shader reads. There's nothing `depthbake-three`-specific about the GSAP side; it's a plain object and a `THREE.PerspectiveCamera`.

## API

### `DepthbakeLoader`

| Method | Description |
| --- | --- |
| `loadAsync(url)` / `load(url, onLoad, onProgress, onError)` | Load a package directory. `onProgress` fires per stage (meta, photo, depth, mask, normal), so `loaded`/`total` count stages, not bytes. |
| `setNeed(components)` | Limit what is fetched: `"photo"`, `"depth"`, `"mask"`, `"normal"`. Anything omitted is neither fetched nor decoded. |
| `setPhotoColorSpace(colorSpace)` | Defaults to `SRGBColorSpace`. Pass `NoColorSpace` when your shader does its own sRGB decode (e.g. `pow(rgb, 2.2)`) — otherwise the conversion is applied twice. |
| `setAnisotropy(n)` | Anisotropic filtering for the photo texture. |
| `setSignal(signal)` | Abort an in-flight load — route changes, React StrictMode double mounts. Rejects with an `AbortError`. |

`withCredentials` and `requestHeader`, inherited from `THREE.Loader`, are forwarded to `fetch`. `crossOrigin` is not, because `fetch` has no equivalent option.

### Painting before the depth map arrives

A depth map is routinely 5–15× the size of the photo, so waiting for the whole package before drawing anything costs you LCP on a hero image. Load in stages instead — `loadPackageStaged` is re-exported from `depthbake-runtime`:

```ts
import { loadPackageStaged } from "depthbake-three";

const staged = loadPackageStaged("/out/hero/");
showStillImage(await staged.photo); // paint now
const asset = await staged.ready;   // upgrade to interactive when depth lands
```

The resolved `DepthbakeAsset` has `photo` / `depth` / `mask` / `normal` textures (undefined when not bundled or excluded by `setNeed`), `meta`, `aspect`, `uniforms`, `dispose()`, and `package` — the underlying `depthbake-runtime` package, which lazily exposes CPU-side `Float32Array` data when you need it.

`dispose()` disposes the textures. Like `THREE.Texture.dispose()`, it does not close the source `ImageBitmap`s, so `asset.package`'s lazy fields stay usable.

### `DepthbakeCamera`

A `THREE.PerspectiveCamera` whose FOV comes from `meta.camera.fovDeg`.

```ts
const camera = new DepthbakeCamera(asset);
camera.setSize(window.innerWidth, window.innerHeight); // cover fit
camera.position.set(x * 0.1 * camera.pivotZ, y * 0.055 * camera.pivotZ, 0);
camera.lookAt(0, 0, -camera.pivotZ);
```

- `setSize(w, h)` recomputes the FOV so the photo covers the viewport (`object-fit: cover`), tightened by `frameZoom` (default `0.82`) so parallax never exposes the edges of the photo.
- `pivotZ` is the subject's representative depth, taken from the 10th percentile of disparity from the near side. Use it to scale parallax amplitude or light distance independently of the asset. It is computed lazily on first access, so the light `setNeed(["photo", "depth"])` path pays nothing until you ask.

### Re-exports

`GLSL_SNIPPETS`, `worldPosition`, `worldPositionFromMeta`, `computeSkyMask`, `computeEdgeMask`, and `computeNormals` are re-exported from `depthbake-runtime` so you don't have to import from two packages.

## License

MIT
