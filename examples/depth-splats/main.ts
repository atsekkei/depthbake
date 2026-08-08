import * as THREE from "three";
import { DepthbakeLoader, DepthbakeCamera, worldPositionFromMeta } from "depthbake-three";
import type { PartialDepthbakePackage } from "depthbake-three";

/**
 * README冒頭の動画用ヒーローデモ。
 * 写真をGaussian Splatting風に数万点のパーティクルへ重要度サンプリングし、
 * 各点をdepthからワールド座標へ復元してZ配置する。カーソル追従(無操作時は
 * ちょうどLOOP_SECONDS周期の自動軌道)のパララックスで奥行きを見せる。
 * UIは一切描画しない — 画面録画がそのままループ動画になる。
 */

// ── チューニング定数(値は暫定。好みで調整) ─────────────────────────
const LOOP_SECONDS = 5; // 自動軌道の周期 = 録画ループ長
const TARGET_POINTS = 90_000; // 目標パーティクル数(概算)
const SPARSE_WEIGHT = 0.4; // 平坦部の採択率下限(1で均一サンプリング)
const GRAD_GAIN = 6.0; // 輝度勾配→重要度の増幅
const OVERLAP = 2.7; // 点サイズ/点間隔 比。大=写真寄り、小=点描寄り
const GAUSS_SHARP = 1.6; // スプライトのガウス減衰。大=シャープ
const ALPHA_BOOST = 1.3; // ガウス中心部の不透明度の底上げ。隙間から背景色が透けるのを抑える
const RAY_JITTER = 0.012; // 視線方向の深度ノイズ(深度の量子化層をほどく)
const BREATHE = 0.004; // 静止時の微小呼吸(0で無効)。周期はLOOP_SECONDS
const FRAME_ZOOM = 0.82; // cover表示への追いズーム。視差で写真外周が見えるのを防ぐ
const PARALLAX_X = 0.1; // カメラ振幅(被写体距離に対する比)
const PARALLAX_Y = 0.055;
const DEPTH_SNAP = 0.12; // これ以上の深度差は不連続とみなし補間せず最近傍へスナップ
const PIVOT_QUANTILE = 0.1; // 注視深度 = 手前からこの分位のZ(≒被写体)
const POINTER_IDLE_MS = 2500; // この時間ポインタが止まると自動軌道へ戻る

/** 再現性のための決定的PRNG (mulberry32) */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * depth解像度のマップをuv(u:左→右, t:上→下)でバイリニアサンプルする。
 * snapThreshold指定時、4texelの深度差が閾値を超える不連続部では補間せず
 * 最近傍texelへスナップする(前景と背景の中間に点が浮くのを防ぐ)。
 */
function makeMapSampler(
  map: Float32Array,
  width: number,
  height: number,
  snapThreshold?: number,
): (u: number, t: number) => number {
  return (u, t) => {
    const fx = Math.min(Math.max(u * width - 0.5, 0), width - 1);
    const fy = Math.min(Math.max(t * height - 0.5, 0), height - 1);
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, width - 1);
    const y1 = Math.min(y0 + 1, height - 1);
    const a = map[y0 * width + x0];
    const b = map[y0 * width + x1];
    const c = map[y1 * width + x0];
    const d = map[y1 * width + x1];
    const tx = fx - x0;
    const ty = fy - y0;
    if (snapThreshold !== undefined) {
      const lo = Math.min(a, b, c, d);
      const hi = Math.max(a, b, c, d);
      if (hi - lo > snapThreshold) {
        return map[(ty < 0.5 ? y0 : y1) * width + (tx < 0.5 ? x0 : x1)];
      }
    }
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };
}

interface ParticleCloud {
  geometry: THREE.BufferGeometry;
  count: number;
}

/**
 * 写真を重要度サンプリングして深度配置済みのパーティクル群を作る。
 * photo/depthはDepthbakeLoaderのsetNeedで要求済みなので必ず存在する
 */
function buildParticles(pkg: PartialDepthbakePackage): ParticleCloud {
  const rng = mulberry32(0x9e3779b9);
  const { meta } = pkg;
  const photo = pkg.photo!;
  const depth = pkg.depth!;
  const aspect = meta.source.width / meta.source.height;
  const tanHalfFov = Math.tan((meta.camera.fovDeg * Math.PI) / 360);

  // 写真を作業解像度に落として色と輝度勾配(=重要度)を読む
  const workW = Math.min(1600, photo.width);
  const workH = Math.max(1, Math.round(workW / aspect));
  const canvas = new OffscreenCanvas(workW, workH);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(photo, 0, 0, workW, workH);
  const rgba = ctx.getImageData(0, 0, workW, workH).data;

  const lum = new Float32Array(workW * workH);
  for (let i = 0; i < lum.length; i++) {
    lum[i] = (rgba[i * 4] * 0.2126 + rgba[i * 4 + 1] * 0.7152 + rgba[i * 4 + 2] * 0.0722) / 255;
  }
  const grad = new Float32Array(workW * workH);
  for (let y = 1; y < workH - 1; y++) {
    for (let x = 1; x < workW - 1; x++) {
      const i = y * workW + x;
      grad[i] = Math.abs(lum[i + 1] - lum[i - 1]) + Math.abs(lum[i + workW] - lum[i - workW]);
    }
  }

  const sampleDepth = makeMapSampler(depth, pkg.depthWidth, pkg.depthHeight, DEPTH_SNAP);
  const sampleSky = pkg.skyMask
    ? makeMapSampler(pkg.skyMask, pkg.depthWidth, pkg.depthHeight)
    : undefined;
  const sampleEdge = pkg.edgeMask
    ? makeMapSampler(pkg.edgeMask, pkg.depthWidth, pkg.depthHeight)
    : undefined;

  // 低スペック環境では点数を落とす(描画は軽いが生成と転送を軽くする)
  const target =
    navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4
      ? Math.round(TARGET_POINTS * 0.6)
      : TARGET_POINTS;

  // ジッタ付き層化グリッドで候補を撒き、重要度に比例した確率で採択して
  // 合計がほぼtargetになるよう正規化する
  const cols = Math.round(Math.sqrt(target * 2.2 * aspect));
  const rows = Math.round(cols / aspect);
  const candidateCount = cols * rows;
  const candU = new Float32Array(candidateCount);
  const candT = new Float32Array(candidateCount);
  const candW = new Float32Array(candidateCount);
  let sumW = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      const u = (i + rng()) / cols;
      const t = (j + rng()) / rows;
      candU[k] = u;
      candT[k] = t;
      const isSky = sampleSky
        ? sampleSky(u, t) > 0.5
        : sampleDepth(u, t) < meta.sky.threshold;
      if (isSky) continue; // 空は点にしない(抜けが輪郭を立たせる)
      const px = Math.min(workW - 2, Math.max(1, Math.round(u * workW)));
      const py = Math.min(workH - 2, Math.max(1, Math.round(t * workH)));
      let g = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          g = Math.max(g, grad[(py + dy) * workW + (px + dx)]);
        }
      }
      const importance = Math.min(1, g * GRAD_GAIN);
      const w = SPARSE_WEIGHT + (1 - SPARSE_WEIGHT) * importance;
      candW[k] = w;
      sumW += w;
    }
  }
  const scale = Math.min(1, target / sumW);

  const positions = new Float32Array(candidateCount * 3);
  const colors = new Float32Array(candidateCount * 3);
  const sizes = new Float32Array(candidateCount);
  const rands = new Float32Array(candidateCount);
  const cellWidthUv = 1 / cols;
  let count = 0;
  for (let k = 0; k < candidateCount; k++) {
    const p = candW[k] * scale;
    if (p <= 0 || rng() >= p) continue;
    const u = candU[k];
    const t = candT[k];
    const d = sampleDepth(u, t);
    // v=1-t: runtimeのwpos規約(v=0が画像下端)に合わせ、ワールド+Yを画面上向きにする
    const [wx, wy, wz] = worldPositionFromMeta(meta, u, 1 - t, d);
    // 視線方向のジッタ: 静止時の見た目(投影位置)を変えずに深度の層だけをほどく
    const m = 1 + (rng() * 2 - 1) * RAY_JITTER;
    positions[count * 3] = wx * m;
    positions[count * 3 + 1] = wy * m;
    positions[count * 3 + 2] = wz * m;

    const ci = (Math.min(workH - 1, Math.floor(t * workH)) * workW + Math.min(workW - 1, Math.floor(u * workW))) * 4;
    colors[count * 3] = rgba[ci] / 255;
    colors[count * 3 + 1] = rgba[ci + 1] / 255;
    colors[count * 3 + 2] = rgba[ci + 2] / 255;

    // 点サイズ = ローカル点間隔 × OVERLAP。採択率が低い場所ほど間隔が広いので補償する
    const spacingWorld = cellWidthUv * 2 * tanHalfFov * aspect * -wz * m;
    let size = spacingWorld * OVERLAP * Math.min(2, 1 / Math.sqrt(p));
    if (sampleEdge) size *= 0.55 + 0.45 * sampleEdge(u, t); // 深度エッジの点は縮めて筋状の浮きを抑える
    sizes[count] = size;
    rands[count] = rng();
    count++;
  }

  // 通常ブレンドで重ねるため奥→手前に一度だけソートしておく(点は静的、カメラの動きは微小)
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  order.sort((a, b) => positions[a * 3 + 2] - positions[b * 3 + 2]);

  const sortedPos = new Float32Array(count * 3);
  const sortedCol = new Float32Array(count * 3);
  const sortedSize = new Float32Array(count);
  const sortedRand = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const src = order[i];
    sortedPos.set(positions.subarray(src * 3, src * 3 + 3), i * 3);
    sortedCol.set(colors.subarray(src * 3, src * 3 + 3), i * 3);
    sortedSize[i] = sizes[src];
    sortedRand[i] = rands[src];
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(sortedPos, 3));
  geometry.setAttribute("aColor", new THREE.BufferAttribute(sortedCol, 3));
  geometry.setAttribute("aSize", new THREE.BufferAttribute(sortedSize, 1));
  geometry.setAttribute("aRand", new THREE.BufferAttribute(sortedRand, 1));
  return { geometry, count };
}

async function main(): Promise<void> {
  // skyMask/edgeMaskの導出にmaskが要る。normal.pngはbuildParticlesが使わないので外す
  const asset = await new DepthbakeLoader().setNeed(["photo", "depth", "mask"]).loadAsync("./maiko.depthbake/");

  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
  renderer.setClearColor(0x050607, 1);
  document.getElementById("app")!.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new DepthbakeCamera(asset, { frameZoom: FRAME_ZOOM, pivotQuantile: PIVOT_QUANTILE });

  const { geometry, count } = buildParticles(asset.package);
  console.info(`[depth-splats] ${count.toLocaleString()} points, pivotZ=${camera.pivotZ.toFixed(2)}`);

  const uniforms = {
    uScale: { value: 1 }, // drawingBuffer高さ / (2*tan(fov/2)) — resizeで更新
    uT: { value: 0 }, // ループ位相 0..1
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    vertexShader: `
      attribute vec3 aColor;
      attribute float aSize;
      attribute float aRand;
      uniform float uScale;
      uniform float uT;
      varying vec3 vColor;
      varying float vFade;
      const float TAU = 6.28318530718;
      void main() {
        vColor = aColor;
        // 視線方向の微小呼吸。周期=ループ長なので録画がシームレスに繋がる
        vec3 p = position * (1.0 + ${BREATHE.toFixed(4)} * sin(TAU * (uT + aRand)));
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float px = aSize * uScale / -mv.z;
        vFade = clamp(px, 0.0, 1.0); // 1px未満の点はアルファで面積補償
        gl_PointSize = max(px, 1.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      precision highp float;
      varying vec3 vColor;
      varying float vFade;
      void main() {
        vec2 q = gl_PointCoord * 2.0 - 1.0;
        float r2 = dot(q, q);
        if (r2 > 1.0) discard;
        float alpha = min(1.0, ${ALPHA_BOOST.toFixed(2)} * exp(-r2 * ${GAUSS_SHARP.toFixed(2)}));
        gl_FragColor = vec4(vColor, alpha * vFade * vFade);
      }
    `,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  scene.add(points);

  function resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h);
    // cover: 画面が写真より横長なら横FOVを、縦長なら縦FOVを写真に合わせて切り出す
    camera.setSize(w, h);
    const tanHalf = Math.tan((camera.fov * Math.PI) / 360);
    const buffer = renderer.getDrawingBufferSize(new THREE.Vector2());
    uniforms.uScale.value = buffer.y / (2 * tanHalf);
  }
  resize();
  addEventListener("resize", resize);

  // ── カメラ軌道: ポインタ追従 ⇄ 8の字自動軌道(LOOP_SECONDS周期) ──
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
    const loopT = (nowMs / 1000 / LOOP_SECONDS) % 1;
    const phase = loopT * Math.PI * 2;

    // 自動軌道は8の字。reduced-motion時は停止し、ポインタ操作のみ効かせる
    const auto = reducedMotion.matches ? 0 : 1;
    const autoX = Math.sin(phase) * auto;
    const autoY = Math.sin(phase * 2) * 0.5 * auto;

    // ポインタが動いていれば追従し、止まってしばらくで自動軌道へ滑らかに戻す。
    // 指数平滑なので常に「いま表示している値」から次の目標へ向かう(中断可能)
    const pointerActive = nowMs - pointer.lastMoveMs < POINTER_IDLE_MS ? 1 : 0;
    smoothed.pointerWeight += (pointerActive - smoothed.pointerWeight) * (1 - Math.exp(-dt / 0.6));
    const targetX = autoX * (1 - smoothed.pointerWeight) + pointer.x * smoothed.pointerWeight;
    const targetY = autoY * (1 - smoothed.pointerWeight) + pointer.y * smoothed.pointerWeight;
    const k = 1 - Math.exp(-dt / 0.22);
    smoothed.x += (targetX - smoothed.x) * k;
    smoothed.y += (targetY - smoothed.y) * k;

    camera.position.set(smoothed.x * PARALLAX_X * camera.pivotZ, smoothed.y * PARALLAX_Y * camera.pivotZ, 0);
    camera.lookAt(0, 0, -camera.pivotZ);
    uniforms.uT.value = loopT;
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);
}

main().catch((e) => {
  console.error(e);
  document.getElementById("app")!.textContent = `読み込みに失敗しました: ${(e as Error).message}`;
});
