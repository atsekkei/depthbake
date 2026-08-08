import "./style.css";
import { Viewer } from "./viewer/gl.ts";
import { bindDropzone } from "./ui/dropzone.ts";
import { bindButtonGroup, bindSlider } from "./ui/controls.ts";
import { downloadPackage, rasterizeToCanvas } from "./ui/exports.ts";
import { loadDepthModel, estimateDepth, type DepthModel, normalizeDisparity, DEFAULT_CONFIG, type PhotoFormat, type PhotoSpaceConfig, type RasterF32 } from "photospace-core";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const cv = $<HTMLCanvasElement>("cv");
const drop = $<HTMLElement>("drop");
const dropStack = drop.parentElement as HTMLElement;
const fileInput = $<HTMLInputElement>("file");
const statusEl = $<HTMLElement>("status");
const bar = $<HTMLElement>("bar");
const barIn = bar.firstElementChild as HTMLElement;
const errBox = $<HTMLElement>("err");
const stage = $<HTMLElement>("stage");
const expPkgBtn = $<HTMLButtonElement>("expPkg");
const packageForm = $<HTMLFormElement>("packageForm");

interface LoadedPhoto {
  img: HTMLImageElement;
  fileName: string;
  /** モデル推論に渡したdata URL。SourcePhoto.inputとして再利用する(bakeFromDisparityでは未使用) */
  url: string;
  bytes: Uint8Array;
  /** フル解像度のRGBA(ガイド画像に使用) */
  rgba: Uint8ClampedArray;
  /** モデル推論直後の正規化済み(0..1)disparity */
  lowResDisparity: RasterF32;
  normalization: { min: number; max: number };
}

let viewer: Viewer | null = null;
let depther: DepthModel | null = null;
let ready = false;
let currentPhoto: LoadedPhoto | null = null;

function fail(msg: string): void {
  errBox.style.display = "block";
  errBox.textContent = msg;
  statusEl.textContent = "Error";
}

bindButtonGroup(["m0", "m1", "m2"], (i) => viewer && (viewer.state.mode = i as 0 | 1 | 2));
bindButtonGroup(["v0", "v1", "v2"], (i) => viewer && (viewer.state.view = i as 0 | 1 | 2));
bindSlider("fov", "fovV", (v) => viewer && (viewer.state.fov = v), (v) => v + "°");
bindSlider("far", "farV", (v) => viewer && (viewer.state.far = v), (v) => v.toFixed(1).replace(/\.0$/, ""));
bindSlider("sky", "skyV", (v) => viewer && (viewer.state.sky = v), (v) => v.toFixed(3).replace(/^0/, ""));

bindDropzone(drop, fileInput, loadImage);

// 空状態に戻さず直接ファイル選択を開く。差し替えは1クリックで済む
$<HTMLButtonElement>("rst").onclick = () => fileInput.click();

async function getModel(): Promise<DepthModel> {
  if (depther) return depther;
  statusEl.textContent = "Loading model…";
  barIn.style.transform = "scaleX(0)";
  bar.style.display = "block";
  depther = await loadDepthModel({
    onProgress: (p) => {
      if (p.status === "progress" && p.total) {
        const progress = Math.round(p.progress ?? 0);
        barIn.style.transform = `scaleX(${progress / 100})`;
        bar.setAttribute("aria-valuenow", String(progress));
      }
    },
  });
  statusEl.textContent = "Model ready";
  bar.style.display = "none";
  return depther;
}

async function loadImage(file: File): Promise<void> {
  errBox.style.display = "none";
  const url = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(new Error("Failed to read the file"));
    r.readAsDataURL(file);
  });
  const img = new Image();
  try {
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("Failed to decode the image"));
      img.src = url;
    });
  } catch (e) {
    fail((e as Error).message + " — try a WebGPU/WASM-capable browser (latest Chrome/Edge recommended).");
    return;
  }

  let model: DepthModel;
  try {
    model = await getModel();
  } catch (e) {
    fail("Failed to load the model. Check your network connection and use a WebGPU/WASM-capable browser. " + (e as Error).message);
    return;
  }

  statusEl.textContent = "Estimating depth…";
  await new Promise((r) => setTimeout(r, 30));
  let result;
  try {
    result = await estimateDepth(model, url);
  } catch (e) {
    fail("Depth estimation failed: " + (e as Error).message);
    return;
  }
  const { data, min, max } = normalizeDisparity(result.raw);

  const rgba = rasterizeToCanvas(img, img.naturalWidth, img.naturalHeight)
    .getContext("2d")!
    .getImageData(0, 0, img.naturalWidth, img.naturalHeight).data;
  currentPhoto = {
    img,
    fileName: file.name,
    url,
    bytes: new Uint8Array(await file.arrayBuffer()),
    rgba,
    lowResDisparity: { width: result.width, height: result.height, data },
    normalization: { min, max },
  };

  if (!viewer) viewer = new Viewer(cv);
  viewer.loadImageAndDepth(img, img.naturalWidth, img.naturalHeight, data, result.width, result.height);

  dropStack.style.display = "none";
  cv.style.display = "block";
  viewer.fitCanvas(stage);
  ready = true;
  statusEl.textContent = "Running — move cursor over the photo";
  viewer.start();
}

addEventListener("resize", () => {
  if (ready) viewer?.fitCanvas(stage);
});

function setPointerFromEvent(e: PointerEvent): void {
  if (!viewer) return;
  const r = cv.getBoundingClientRect();
  const u = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
  const v = Math.min(Math.max(1 - (e.clientY - r.top) / r.height, 0), 1);
  viewer.setPointerTarget(u, v);
}
cv.addEventListener("pointermove", setPointerFromEvent);
cv.addEventListener("pointerdown", setPointerFromEvent);

packageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!packageForm.reportValidity()) return;
  if (!currentPhoto || !viewer) {
    fail("Load an image first.");
    return;
  }
  const photo = currentPhoto;
  // JPEGは必須の最終フォールバックとして常に含める(UI側もchecked+disabled)
  const formats: PhotoFormat[] = [
    ...($<HTMLInputElement>("fmtAvif").checked ? (["avif"] as const) : []),
    ...($<HTMLInputElement>("fmtWebp").checked ? (["webp"] as const) : []),
    "jpeg",
  ];
  const mapMaxMb = $<HTMLInputElement>("mapMaxMb").valueAsNumber;
  const config: PhotoSpaceConfig = {
    ...DEFAULT_CONFIG,
    camera: { fovDeg: viewer.state.fov, farRange: viewer.state.far },
    sky: { threshold: viewer.state.sky },
    depth: { maxSize: $<HTMLInputElement>("mapMaxSize").valueAsNumber },
    maps: {
      ...DEFAULT_CONFIG.maps,
      maxBytes: mapMaxMb === 0 ? 0 : Math.round(mapMaxMb * 1_000_000),
      mask: $<HTMLInputElement>("mapMask").checked,
      normal: $<HTMLInputElement>("mapNormal").checked,
    },
    photo: {
      ...DEFAULT_CONFIG.photo,
      maxSize: $<HTMLInputElement>("photoMaxSize").valueAsNumber,
      formats,
    },
  };

  errBox.style.display = "none";
  const prevLabel = expPkgBtn.textContent;
  expPkgBtn.disabled = true;
  expPkgBtn.textContent = "Baking…";
  statusEl.textContent = "Baking package…";
  try {
    const summary = await downloadPackage({
      photo: {
        fileName: photo.fileName,
        bytes: photo.bytes,
        input: photo.url,
        width: photo.img.naturalWidth,
        height: photo.img.naturalHeight,
        rgba: photo.rgba,
      },
      photoSource: photo.img,
      lowResDisparity: photo.lowResDisparity,
      normalization: photo.normalization,
      config,
    });
    statusEl.textContent = `Downloaded ${(summary.zipBytes / 1_000_000).toFixed(1)} MB · maps ${(summary.mapBytes / 1_000_000).toFixed(1)} MB at ${summary.mapWidth}×${summary.mapHeight}`;
  } catch (e) {
    fail((e as Error).message);
  } finally {
    expPkgBtn.disabled = false;
    expPkgBtn.textContent = prevLabel;
  }
});
