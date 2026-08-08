import * as THREE from "three";
import { PhotoSpaceLoader, quantileDisparity, worldPositionFromMeta, GLSL_SNIPPETS } from "photospace-three";

/**
 * relight — 写真をカーソルで照らし直すデモ。
 * depth+metaから各ピクセルのワールド座標を、normal.pngからワールド法線を復元し、
 * カーソル直下に浮かべた点光源でBlinn-Phongライティングを合成する。深度サーフェスへの
 * スクリーン空間レイマーチで接触影も落とす。mask.pngはエッジ(法線が信用できない
 * 深度不連続部)の照明減衰と空のライティング除外に使う。
 * 無操作時は光源がちょうどLOOP_SECONDS周期で被写体を周回しつつ色温度が
 * 夕陽⇄月光を往復する — 画面録画がそのままループ動画になる。UIは一切描画しない。
 */

// ── チューニング定数 ─────────────────────────
const LOOP_SECONDS = 5; // 自動軌道の周期 = 録画ループ長
const POINTER_IDLE_MS = 2500; // この時間ポインタが止まると自動軌道へ戻る
const AMBIENT = 0.12; // 環境光。暗部の底(アルベドに乗る)
const DIFFUSE_GAIN = 1.6; // 拡散反射の強さ
const DIFFUSE_WRAP = 0.18; // wrap lighting(half-Lambert)。深度ノイズ由来の陰影ノイズを緩和しつつ大理石の柔らかさを出す
const SPEC_STRENGTH = 0.4; // 鏡面反射の強さ
const SPEC_POWER = 44.0; // 鏡面反射の集中度。大理石は低め=広いハイライト
const NORMAL_BLUR_TEXELS = 5.0; // 法線ブラーの半径(depthテクセル)。ベイク時のguided filterが写真の模様を深度へ写し込むため、高周波を落とし低周波形状だけで照らす
const NORMAL_BLUR_TAPS = 12; // ブラーのタップ数(Vogel螺旋。格子状のタップはモアレを生む)
const EXPOSURE = 1.15; // トーンマップ 1-exp(-col*EXPOSURE)。白飛びをソフトに丸める
const LIGHT_Z = 0.5; // 光源を置く深度(注視深度pivotZに対する比)。<1で常に被写体より手前
const LIGHT_SWING = 1.9; // カーソル→光源xyの増幅。>1で光が画角の外側まで回り込み、サイドライティングが作れる
const LIGHT_RANGE = 0.75; // 点光源の距離減衰半径(注視深度pivotZに対する比)
const WARM: [number, number, number] = [1.0, 0.6, 0.3]; // 夕陽
const COOL: [number, number, number] = [0.45, 0.62, 1.0]; // 月光
const LIGHT_CENTER = { u: 0.5, v: 0.42 }; // 自動軌道の中心(被写体の顔あたり)
const LIGHT_ORBIT_U = 0.46; // 自動軌道の横半径(uv空間)
const LIGHT_ORBIT_V = 0.24; // 自動軌道の縦半径
const SHADOW_STEPS = 12; // 接触影のレイマーチ回数。0で影を無効化
const SHADOW_STRENGTH = 0.5; // 影の濃さ
const SHADOW_REACH = 0.25; // 光源までの距離の何割をマーチするか(接触影なので短め)
const SHADOW_BIAS = 0.05; // 自己遮蔽を防ぐ深度バイアス
const PIVOT_QUANTILE = 0.1; // 注視深度 = 手前からこの分位のZ(≒被写体)
// 前景/背景の境界帯(ブラーディスク内の視差レンジが大きい)は深度・法線とも
// 信用できないので照明を減衰し、シルエット外周のハローを抑える。閾値は
// 顔面内の通常の深度変化(鼻と頬の差など)を誤って潰さない程度に緩くとる
const HALO_RANGE_MIN = 0.15;
const HALO_RANGE_MAX = 0.45;
const HALO_DISC_SCALE = 1.0; // 深度レンジ検出ディスクの半径倍率(法線ブラー半径に対する比)
const CANVAS_VIEWPORT_SCALE = 0.7; // 画面内に白い余白を残す表示倍率
const DEBUG_HELPER_SIZE = 0.06; // NDC空間でのライトhelperの表示サイズ

async function main(): Promise<void> {
  // ライティングをリニア空間で行うため、色管理はシェーダー内で手動sRGB復元/変換する
  // (setPhotoColorSpaceでNoColorSpaceを指定し、three側の自動変換を止める)
  const asset = await new PhotoSpaceLoader()
    .setNeed(["photo", "depth", "mask", "normal"])
    .setPhotoColorSpace(THREE.NoColorSpace)
    .loadAsync("./bust.photospace/");
  if (!asset.normal || !asset.mask) {
    throw new Error("このデモは mask.png / normal.png 同梱パッケージが必要です(bake時に --mask --normal)");
  }

  // 注視深度: 手前からPIVOT_QUANTILE分位の視差(視差は大=近)を代表深度にする
  const pivotDisparity = quantileDisparity(asset.package.depth!, PIVOT_QUANTILE);
  const pivotZ = -worldPositionFromMeta(asset.meta, 0.5, 0.5, pivotDisparity)[2];
  console.info(`[relight] pivotZ=${pivotZ.toFixed(2)}`);

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  document.getElementById("app")!.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // asset.uniforms が uImg/uDep/uNrm/uMsk/uDRes/uTanF/uFar/uSky/uAspect を埋める。
  // このシーン固有のものだけを足す
  const uniforms = {
    ...asset.uniforms,
    uCur: { value: new THREE.Vector2(LIGHT_CENTER.u, LIGHT_CENTER.v) },
    uLightColor: { value: new THREE.Vector3(...WARM) },
    uPivot: { value: pivotZ },
  };
  const aspect = asset.aspect;

  const material = new THREE.ShaderMaterial({
    uniforms,
    glslVersion: THREE.GLSL3,
    vertexShader: `
      out vec2 vUv;
      void main() {
        vUv = vec2(uv.x, 1.0 - uv.y);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      uniform sampler2D uImg, uDep, uNrm, uMsk;
      uniform vec2 uDRes, uCur;
      uniform vec3 uLightColor;
      uniform float uTanF, uFar, uAspect, uPivot;
      in vec2 vUv;
      out vec4 fragColor;

      ${GLSL_SNIPPETS.unpackAndSampleDepthRgba8}
      ${GLSL_SNIPPETS.worldPosition}

      // 全テクスチャはImageBitmap由来でflipYが効かず、row0=最上段のまま無反転で
      // アップロードされる。vUv(t空間: y=0が画面上端)でそのままサンプルすれば整合する。
      vec4 mapTex(sampler2D t, vec2 uv) { return texture(t, uv); }

      // dsp8()は内部でuvを1.0-uv.yと解釈する(GL標準の下原点uv前提)ため、
      // t空間のuvは反転を打ち消して渡す
      float dspT(sampler2D uDep, vec2 uDRes, vec2 uvT) {
        return dsp8(uDep, uDRes, vec2(uvT.x, 1.0 - uvT.y));
      }

      // normal.pngのブラー+mask.pngの侵食を1ループで行う。
      // 法線: 写真の模様が深度へ写り込んだ高周波ノイズを均す。タップはVogel螺旋
      // (黄金角)に配置する — 格子状のタップは網目状のモアレを生む。
      // マスク: 近傍のmin採用で減衰帯を広げ、シルエット外周の「深度が前景と背景の
      // 中間に落ちる帯」が照らされて出るハローを抑える
      // nAgree: ディスク内の法線の合意度(累積ベクトル長/タップ数)。ノイズ領域で低下する
      vec3 blurNormalErodeMask(vec2 uv, out vec2 msk, out float dRange, out float nAgree) {
        vec2 px = vec2(1.0) / uDRes;
        vec3 acc = mapTex(uNrm, uv).rgb * 2.0 - 1.0;
        vec2 m = mapTex(uMsk, uv).rg;
        msk = vec2(m.r, m.g);
        float d = dspT(uDep, uDRes, uv);
        float dNear = d;
        float dFar = d;
        for (int i = 0; i < ${NORMAL_BLUR_TAPS}; i++) {
          float r = ${NORMAL_BLUR_TEXELS.toFixed(2)} * sqrt((float(i) + 0.5) / float(${NORMAL_BLUR_TAPS}));
          float a = float(i) * 2.39996; // 黄金角
          vec2 offsetUv = uv + vec2(cos(a), sin(a)) * r * px;
          acc += mapTex(uNrm, offsetUv).rgb * 2.0 - 1.0;
          vec2 mo = mapTex(uMsk, offsetUv).rg;
          msk = vec2(max(msk.x, mo.x), min(msk.y, mo.y)); // 空は膨張、エッジ信頼度は侵食
          // 深度レンジの検出は法線ブラーより広いディスクで行う(遷移帯が広いため)
          float dTap = dspT(uDep, uDRes, uv + vec2(cos(a), sin(a)) * r * ${HALO_DISC_SCALE.toFixed(2)} * px);
          dNear = max(dNear, dTap);
          dFar = min(dFar, dTap);
        }
        dRange = dNear - dFar; // 前景と背景が同居するディスクほど大きい
        nAgree = length(acc) / float(${NORMAL_BLUR_TAPS} + 1);
        return normalize(acc);
      }

      // wpos()の逆変換: ワールド座標→uv(スクリーン空間レイマーチ用)
      vec2 toUv(vec3 p) { return (p.xy / (-p.z) / (uTanF * vec2(uAspect, 1.0)) + 1.0) * 0.5; }

      void main() {
        vec2 uv = vUv;
        float d0 = dspT(uDep, uDRes, uv);
        vec3 alb = pow(texture(uImg, uv).rgb, vec3(2.2)); // sRGB→リニア
        vec2 msk; // R=空(1=空), G=エッジ信頼度(1=非エッジ)
        float dRange; // ブラーディスク内の視差レンジ
        float nAgree;
        vec3 n = blurNormalErodeMask(uv, msk, dRange, nAgree);
        vec3 pos = wpos(uv, d0, uAspect, uTanF, uFar);

        // 光源: カーソルuvを被写体より手前の固定深度面(LIGHT_Z*pivotZ)へ投影した点。
        // サーフェス追従にしないのは、カーソルが背景上にあるとき光源が被写体の
        // 奥へ回り込んでしまうため
        float zL = ${LIGHT_Z.toFixed(3)} * uPivot;
        vec3 lp = vec3((uCur * 2.0 - 1.0) * vec2(uAspect, 1.0) * uTanF * zL * ${LIGHT_SWING.toFixed(2)}, -zL);

        vec3 lv = lp - pos;
        float dist = length(lv);
        vec3 l = lv / dist;
        float rr = dist / (${LIGHT_RANGE.toFixed(3)} * uPivot);
        float att = 1.0 / (1.0 + rr * rr);
        // wrap lighting: 陰影の境界を柔らかく回す(w=0で純Lambert)
        float w = ${DIFFUSE_WRAP.toFixed(3)};
        float diff = max((dot(n, l) + w) / (1.0 + w), 0.0);
        vec3 h = normalize(l + normalize(-pos));
        // 法線の合意度が低い(=深度ノイズ)領域はスペキュラを消す。アルベドに乗らない
        // スペキュラは灰色の壁でも白く光り、ノイズが綿状のハイライトになるため
        float spec = pow(max(dot(n, h), 0.0), ${SPEC_POWER.toFixed(1)}) * smoothstep(0.75, 0.95, nAgree);

        // 接触影: フラグメントから光源方向へ短くレイマーチし、深度サーフェスに潜ったら遮蔽
        float occ = 0.0;
        for (int i = 1; i <= ${SHADOW_STEPS}; i++) {
          float t = float(i) / float(${Math.max(SHADOW_STEPS, 1)});
          vec3 p = mix(pos, lp, t * ${SHADOW_REACH.toFixed(3)});
          vec2 suv = toUv(p);
          if (suv != clamp(suv, 0.0, 1.0)) break;
          float dz = -p.z - toZ(dspT(uDep, uDRes, suv), uFar);
          // 遠くのヒットほど弱く(接触影らしさ)。ソフトな立ち上がりでバンディングを防ぐ
          occ = max(occ, smoothstep(${SHADOW_BIAS.toFixed(3)}, ${(SHADOW_BIAS * 4).toFixed(3)}, dz) * (1.0 - t));
        }
        float shadow = 1.0 - ${SHADOW_STRENGTH.toFixed(3)} * occ;

        // ハロー抑制: 前景と背景が同居する境界帯(視差レンジ大)を照明から外す
        float haloFree = 1.0 - smoothstep(${HALO_RANGE_MIN.toFixed(3)}, ${HALO_RANGE_MAX.toFixed(3)}, dRange);

        // エッジ+遷移帯で照明を減衰し、空はライティング除外
        float conf = msk.g * (1.0 - msk.r) * haloFree;
        vec3 direct = (${DIFFUSE_GAIN.toFixed(3)} * diff * alb + ${SPEC_STRENGTH.toFixed(3)} * spec)
          * uLightColor * att * shadow * conf;
        vec3 col = alb * ${AMBIENT.toFixed(3)} + direct;
        col = 1.0 - exp(-col * ${EXPOSURE.toFixed(3)});
        fragColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0); // リニア→sRGB
      }
    `,
  });

  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));

  const debugHelper = createLightDebugHelper();
  scene.add(debugHelper);
  let debugVisible = false;
  debugHelper.visible = debugVisible;
  document.body.dataset.debugLight = String(debugVisible);

  addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.code !== "KeyD" || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    debugVisible = !debugVisible;
    debugHelper.visible = debugVisible;
    document.body.dataset.debugLight = String(debugVisible);
  });

  function resize(): void {
    const maxW = window.innerWidth * CANVAS_VIEWPORT_SCALE;
    const maxH = window.innerHeight * CANVAS_VIEWPORT_SCALE;
    let w = maxW;
    let h = w / aspect;
    if (h > maxH) {
      h = maxH;
      w = h * aspect;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h);
  }
  resize();
  addEventListener("resize", resize);

  // ── 光源軌道: ポインタ追従 ⇄ 楕円自動軌道(LOOP_SECONDS周期) ──
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const pointer = { u: LIGHT_CENTER.u, v: LIGHT_CENTER.v, lastMoveMs: Number.NEGATIVE_INFINITY };
  renderer.domElement.addEventListener("pointermove", (e: PointerEvent) => {
    const r = renderer.domElement.getBoundingClientRect();
    pointer.u = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
    pointer.v = Math.min(Math.max((e.clientY - r.top) / r.height, 0), 1);
    pointer.lastMoveMs = performance.now();
  });

  const smoothed = { u: LIGHT_CENTER.u, v: LIGHT_CENTER.v, pointerWeight: 0 };
  let prevMs = performance.now();
  function animate(nowMs: number): void {
    const dt = Math.min(0.05, (nowMs - prevMs) / 1000);
    prevMs = nowMs;
    const phase = ((nowMs / 1000 / LOOP_SECONDS) % 1) * Math.PI * 2;

    // 自動軌道は楕円周回。reduced-motion時は左上の定位置キーライトで静止する
    const autoU = reducedMotion.matches
      ? LIGHT_CENTER.u - LIGHT_ORBIT_U * 0.6
      : LIGHT_CENTER.u + Math.cos(phase) * LIGHT_ORBIT_U;
    const autoV = reducedMotion.matches
      ? LIGHT_CENTER.v - LIGHT_ORBIT_V * 0.8
      : LIGHT_CENTER.v + Math.sin(phase) * LIGHT_ORBIT_V;

    // ポインタが動いていれば追従し、止まってしばらくで自動軌道へ滑らかに戻す
    const pointerActive = nowMs - pointer.lastMoveMs < POINTER_IDLE_MS ? 1 : 0;
    smoothed.pointerWeight += (pointerActive - smoothed.pointerWeight) * (1 - Math.exp(-dt / 0.6));
    const targetU = autoU * (1 - smoothed.pointerWeight) + pointer.u * smoothed.pointerWeight;
    const targetV = autoV * (1 - smoothed.pointerWeight) + pointer.v * smoothed.pointerWeight;
    const k = 1 - Math.exp(-dt / 0.15);
    smoothed.u += (targetU - smoothed.u) * k;
    smoothed.v += (targetV - smoothed.v) * k;
    uniforms.uCur.value.set(smoothed.u, smoothed.v);

    // 色温度は軌道と同周期で夕陽⇄月光を往復(cosなのでループ境界もシームレス)
    const warmth = reducedMotion.matches ? 1 : 0.5 + 0.5 * Math.cos(phase);
    uniforms.uLightColor.value.set(
      COOL[0] + (WARM[0] - COOL[0]) * warmth,
      COOL[1] + (WARM[1] - COOL[1]) * warmth,
      COOL[2] + (WARM[2] - COOL[2]) * warmth,
    );
    updateLightDebugHelper(debugHelper, smoothed.u, smoothed.v, uniforms.uLightColor.value);

    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);
}

main().catch((e) => {
  console.error(e);
  document.getElementById("app")!.textContent = `読み込みに失敗しました: ${(e as Error).message}`;
});

function createLightDebugHelper(): THREE.Group {
  const group = new THREE.Group();
  group.renderOrder = 10;

  const ringMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.72, 1, 48), ringMaterial);
  ring.scale.setScalar(DEBUG_HELPER_SIZE);
  ring.renderOrder = 10;
  group.add(ring);

  const crossMaterial = new THREE.LineBasicMaterial({
    color: 0xffffff,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const crossGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-DEBUG_HELPER_SIZE, 0, 0),
    new THREE.Vector3(DEBUG_HELPER_SIZE, 0, 0),
    new THREE.Vector3(0, -DEBUG_HELPER_SIZE, 0),
    new THREE.Vector3(0, DEBUG_HELPER_SIZE, 0),
  ]);
  const cross = new THREE.LineSegments(crossGeometry, crossMaterial);
  cross.renderOrder = 11;
  group.add(cross);

  const controlMaterial = new THREE.LineBasicMaterial({
    color: 0x111111,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const controlGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, 0),
  ]);
  const controlLine = new THREE.Line(controlGeometry, controlMaterial);
  controlLine.renderOrder = 9;
  controlLine.userData.positions = controlGeometry.getAttribute("position") as THREE.BufferAttribute;
  group.add(controlLine);

  return group;
}

function updateLightDebugHelper(group: THREE.Group, u: number, v: number, color: THREE.Vector3): void {
  const helperU = 0.5 + (u - 0.5) * LIGHT_SWING;
  const helperV = 0.5 + (v - 0.5) * LIGHT_SWING;
  group.position.set(helperU * 2 - 1, 1 - helperV * 2, -0.01);

  const ring = group.children[0] as THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  ring.material.color.setRGB(color.x, color.y, color.z);

  const controlLine = group.children[2] as THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  const positions = controlLine.userData.positions as THREE.BufferAttribute;
  positions.setXYZ(0, 0, 0, 0);
  positions.setXYZ(1, (u - helperU) * 2, (helperV - v) * 2, 0);
  positions.needsUpdate = true;
}
