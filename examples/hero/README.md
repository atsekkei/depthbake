# hero

The copy-paste starting point for a Depthbake hero image. Unlike the other
examples, this one isn't tuned to be a striking demo — it's deliberately
plain so the two judgment calls it makes are easy to see and easy to lift
into your own project:

1. **Frame-rate-independent smoothing.** Use exponential smoothing,
   `alpha = 1 - exp(-dt / tau)`, not a fixed-alpha lerp
   (`x += (target - x) * 0.1`). A fixed alpha is implicitly tuned for 60Hz —
   on a slower device or a throttled tab it either crawls or overshoots.
   `tau` is "seconds until the gap closes to 1/e", so the same constant
   produces the same motion regardless of frame rate.
2. **`prefers-reduced-motion` stops the autopilot orbit, not pointer
   response.** When the user's cursor moves, the camera should still follow
   it — that's a direct response to their input, not the kind of ambient
   motion the media query is about. Only the idle autopilot (the orbit that
   plays when nobody's touching anything) is gated behind the check.

This does **not** ship as a `DepthbakeMesh` component. Freezing this into a
component would present "one hero effect" as the library's opinion, when the
shader and the motion curve are exactly the parts every project wants to
change. Copy the file and edit it.

## What it renders

A mesh whose vertices are reconstructed from `depth.png` in the vertex
shader (`wpos()`, from `GLSL_SNIPPETS`) instead of a flat plane, viewed
through a `DepthbakeCamera` that drifts with the pointer — real
depth-driven parallax with about 30 lines of shader.

## Run

```bash
pnpm dev:hero
```

Build / preview:

```bash
pnpm build:hero
pnpm preview:hero
```

## Full source

`index.html` and `vite.config.ts` are boilerplate (see
[`examples/depth-splats`](../depth-splats) for the same shape). This is all of
[`main.ts`](./main.ts):

```ts
import * as THREE from "three";
import { DepthbakeLoader, DepthbakeCamera, GLSL_SNIPPETS } from "depthbake-three";

/**
 * examples/hero — コピペ用の最小テンプレート。
 * 効果自体はdepthから復元した頂点を持つメッシュにポインタ追従のパララックスを
 * 掛けるだけの単純なものだが、ここで見せたいのは絵ではなく2つの「正しい書き方」:
 *
 * 1. 指数平滑 `1 - exp(-dt/tau)` を使う。固定alphaのlerp(x += (target-x)*0.1など)は
 *    60Hz前提になり、低フレームレート環境ではカクつく
 * 2. prefers-reduced-motion では自動軌道だけ止め、ポインタへの追従は残す。
 *    ユーザー操作への応答を止めるのはアクセシビリティ上望ましくない
 *
 * DepthbakeMeshのようなコンポーネントとして固めず、コピペ前提のテンプレートとして
 * 出しているのは改造されることが前提だから。シェーダーもモーションも
 * 手元のプロジェクトに合わせて書き換えてよい。
 */

// ── チューニング定数 ─────────────────────────
const SEGMENTS = 128; // 深度メッシュの分割数。多いほど滑らかだが頂点シェーダーのコストが増える
const POINTER_TAU = 0.15; // ポインタ追従の時定数(秒)。小さいほど速く追従する
const IDLE_TAU = 0.6; // ポインタ⇄自動軌道の切替の時定数(秒)
const IDLE_MS = 2500; // この時間ポインタが止まると自動軌道へ戻る
const ORBIT_SECONDS = 6; // 自動軌道の周期
const PARALLAX_X = 0.1; // カメラ振幅(注視深度pivotZに対する比)
const PARALLAX_Y = 0.055;

async function main(): Promise<void> {
  const asset = await new DepthbakeLoader().setNeed(["photo", "depth"]).loadAsync("./maiko.depthbake/");

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  document.getElementById("app")!.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new DepthbakeCamera(asset);

  // depthから頂点位置を復元するメッシュ。PlaneGeometryのposition属性自体は使わず、
  // uv+depthから毎頂点wpos()でワールド座標を計算し直す(uv/indexの供給元として使う)
  const geometry = new THREE.PlaneGeometry(1, 1, SEGMENTS, SEGMENTS);
  const material = new THREE.ShaderMaterial({
    uniforms: { ...asset.uniforms },
    glslVersion: THREE.GLSL3,
    // depthの急な段差では頂点変位で裏向きの面ができうるため、シルエット際の
    // 抜けを避けてDoubleSideにする
    side: THREE.DoubleSide,
    vertexShader: `
      uniform sampler2D uDep;
      uniform vec2 uDRes;
      uniform float uTanF, uFar, uAspect;
      out vec2 vUv;

      ${GLSL_SNIPPETS.unpackAndSampleDepthRgba8}
      ${GLSL_SNIPPETS.worldPosition}

      void main() {
        vUv = vec2(uv.x, 1.0 - uv.y);
        // depthとワールド座標は生のuv(反転前)で揃える。vUvで呼ぶと色は正しい行を
        // 読む一方、dsp8()内部の反転が打ち消し合ってvUvと逆の行を読んでしまい、
        // 深度と頂点Yがどちらも色サンプルと食い違って画像が上下反転する
        float d = dsp8(uDep, uDRes, uv);
        vec3 pos = wpos(uv, d, uAspect, uTanF, uFar);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      uniform sampler2D uImg;
      in vec2 vUv;
      out vec4 fragColor;
      void main() {
        // uImgはSRGBColorSpace指定なのでtexture()はリニア値を返す。
        // linearToOutputTexel()はthree.jsが非rawシェーダーへ注入する関数
        fragColor = linearToOutputTexel(texture(uImg, vUv));
      }
    `,
  });
  scene.add(new THREE.Mesh(geometry, material));

  function resize(): void {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.setSize(window.innerWidth, window.innerHeight); // cover-fit
  }
  resize();
  addEventListener("resize", resize);

  // ── カメラ軌道: ポインタ追従 ⇄ 自動軌道(無操作IDLE_MS後に復帰) ──
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const pointer = { x: 0, y: 0, lastMoveMs: Number.NEGATIVE_INFINITY };
  addEventListener("pointermove", (e: PointerEvent) => {
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -((e.clientY / window.innerHeight) * 2 - 1);
    pointer.lastMoveMs = performance.now();
  });

  const smoothed = { x: 0, y: 0, pointerWeight: 0 };
  let prevMs = performance.now();
  function animate(nowMs: number): void {
    const dt = Math.min(0.05, (nowMs - prevMs) / 1000);
    prevMs = nowMs;

    // 自動軌道はreduced-motionで停止する。ポインタ追従はユーザー操作への応答なので止めない
    const auto = reducedMotion.matches ? { x: 0, y: 0 } : autoOrbit(nowMs);

    // ポインタが動いていれば追従し、止まってしばらくで自動軌道へ滑らかに戻す
    const pointerActive = nowMs - pointer.lastMoveMs < IDLE_MS ? 1 : 0;
    smoothed.pointerWeight += (pointerActive - smoothed.pointerWeight) * (1 - Math.exp(-dt / IDLE_TAU));
    const targetX = auto.x * (1 - smoothed.pointerWeight) + pointer.x * smoothed.pointerWeight;
    const targetY = auto.y * (1 - smoothed.pointerWeight) + pointer.y * smoothed.pointerWeight;

    // フレームレート非依存の指数平滑。tauは「目標との差が1/eになるまでの秒数」で、
    // dtに応じてalphaが自動で変わる(固定alphaのlerpは60Hz前提になる)
    const k = 1 - Math.exp(-dt / POINTER_TAU);
    smoothed.x += (targetX - smoothed.x) * k;
    smoothed.y += (targetY - smoothed.y) * k;

    camera.position.set(smoothed.x * PARALLAX_X * camera.pivotZ, smoothed.y * PARALLAX_Y * camera.pivotZ, 0);
    camera.lookAt(0, 0, -camera.pivotZ);

    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);
}

/** 無操作時の8の字より単純な、控えめな楕円軌道 */
function autoOrbit(nowMs: number): { x: number; y: number } {
  const phase = ((nowMs / 1000 / ORBIT_SECONDS) % 1) * Math.PI * 2;
  return { x: Math.sin(phase) * 0.6, y: Math.sin(phase * 2) * 0.3 };
}

main().catch((e) => {
  const message = `読み込みに失敗しました: ${(e as Error).message}`;
  document.getElementById("app")!.textContent = message;
});
```

## Photo credit

[`maiko.depthbake`](./maiko.depthbake) is baked from a photo by
[Tianshu Liu](https://unsplash.com/ja/@tianshu?utm_source=unsplash&utm_medium=referral&utm_content=creditCopyText)
on
[Unsplash](https://unsplash.com/ja/%E5%86%99%E7%9C%9F/%E5%BB%BA%E7%89%A9%E3%81%AE%E8%BF%91%E3%81%8F%E3%81%A7%E7%9F%B3%E6%B2%B9%E5%82%98%E3%82%92%E6%8C%81%E3%81%A4%E5%A5%B3%E6%80%A7-khQY5Eu-aa0?utm_source=unsplash&utm_medium=referral&utm_content=creditCopyText).
