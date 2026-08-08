import { VS, FS } from "./shaders.ts";

export interface ViewerState {
  mode: 0 | 1 | 2;
  view: 0 | 1 | 2;
  fov: number;
  far: number;
  sky: number;
  rad: number;
  edg: number;
}

export const DEFAULT_VIEWER_STATE: ViewerState = {
  mode: 0,
  view: 0,
  fov: 55,
  far: 12,
  sky: 0.03,
  rad: 1.0,
  edg: 0.05,
};

function mkProg(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram();
  const v = gl.createShader(gl.VERTEX_SHADER)!;
  gl.shaderSource(v, vs);
  gl.compileShader(v);
  const f = gl.createShader(gl.FRAGMENT_SHADER)!;
  gl.shaderSource(f, fs);
  gl.compileShader(f);
  if (!gl.getShaderParameter(f, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(f) ?? "shader compile failed");
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "program link failed");
  return p;
}

interface UniformLocations {
  uImg: WebGLUniformLocation | null;
  uDep: WebGLUniformLocation | null;
  uRes: WebGLUniformLocation | null;
  uDRes: WebGLUniformLocation | null;
  uCur: WebGLUniformLocation | null;
  uT: WebGLUniformLocation | null;
  uTanF: WebGLUniformLocation | null;
  uFar: WebGLUniformLocation | null;
  uRad: WebGLUniformLocation | null;
  uSky: WebGLUniformLocation | null;
  uEdge: WebGLUniformLocation | null;
  uMode: WebGLUniformLocation | null;
  uView: WebGLUniformLocation | null;
}

/** 現index.htmlのWebGL2プレビュー(波紋/トーチ/等距離帯 x 結果/深度/法線ビュー)を抽出したクラス */
export class Viewer {
  readonly canvas: HTMLCanvasElement;
  readonly state: ViewerState = { ...DEFAULT_VIEWER_STATE };

  private cursorTarget: [number, number] = [0.5, 0.5];
  private cursorSmoothed: [number, number] = [0.5, 0.5];
  private lastMoveAt = performance.now();

  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private uniforms: UniformLocations;
  private texImg: WebGLTexture | null = null;
  private texDep: WebGLTexture | null = null;
  private imgW = 0;
  private imgH = 0;
  private depW = 0;
  private depH = 0;
  private raf = 0;
  private readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2");
    if (!gl) throw new Error("WebGL2に未対応のブラウザです。");
    this.gl = gl;
    this.prog = mkProg(gl, VS, FS);
    this.uniforms = {
      uImg: gl.getUniformLocation(this.prog, "uImg"),
      uDep: gl.getUniformLocation(this.prog, "uDep"),
      uRes: gl.getUniformLocation(this.prog, "uRes"),
      uDRes: gl.getUniformLocation(this.prog, "uDRes"),
      uCur: gl.getUniformLocation(this.prog, "uCur"),
      uT: gl.getUniformLocation(this.prog, "uT"),
      uTanF: gl.getUniformLocation(this.prog, "uTanF"),
      uFar: gl.getUniformLocation(this.prog, "uFar"),
      uRad: gl.getUniformLocation(this.prog, "uRad"),
      uSky: gl.getUniformLocation(this.prog, "uSky"),
      uEdge: gl.getUniformLocation(this.prog, "uEdge"),
      uMode: gl.getUniformLocation(this.prog, "uMode"),
      uView: gl.getUniformLocation(this.prog, "uView"),
    };
  }

  loadImageAndDepth(img: TexImageSource, imgW: number, imgH: number, depthData: Float32Array, depW: number, depH: number): void {
    const gl = this.gl;
    this.imgW = imgW;
    this.imgH = imgH;
    this.depW = depW;
    this.depH = depH;

    if (this.texImg) gl.deleteTexture(this.texImg);
    if (this.texDep) gl.deleteTexture(this.texDep);

    this.texImg = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texImg);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    this.texDep = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texDep);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, depW, depH, 0, gl.RED, gl.FLOAT, depthData);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  get depthWidth(): number {
    return this.depW;
  }

  get depthHeight(): number {
    return this.depH;
  }

  fitCanvas(stage: HTMLElement): void {
    const maxW = stage.clientWidth - 36;
    const maxH = window.innerHeight * 0.74;
    let w = maxW;
    let h = (w * this.imgH) / this.imgW;
    if (h > maxH) {
      h = maxH;
      w = (h * this.imgW) / this.imgH;
    }
    this.canvas.style.width = w + "px";
    this.canvas.style.height = h + "px";
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
  }

  /** ポインタ位置(uv, 0..1)を更新する。しばらく操作がないと自動で緩やかに周回する */
  setPointerTarget(u: number, v: number): void {
    this.cursorTarget = [u, v];
    this.lastMoveAt = performance.now();
  }

  private renderFrame = (t: number): void => {
    const gl = this.gl;
    const ts = t * 0.001;

    if (!this.reducedMotion.matches && t - this.lastMoveAt > 4000) {
      this.cursorTarget = [0.5 + 0.3 * Math.sin(ts * 0.45), 0.45 + 0.22 * Math.sin(ts * 0.33 + 1.7)];
    }
    this.cursorSmoothed[0] += (this.cursorTarget[0] - this.cursorSmoothed[0]) * 0.1;
    this.cursorSmoothed[1] += (this.cursorTarget[1] - this.cursorSmoothed[1]) * 0.1;

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texImg);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texDep);
    const u = this.uniforms;
    gl.uniform1i(u.uImg, 0);
    gl.uniform1i(u.uDep, 1);
    gl.uniform2f(u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform2f(u.uDRes, this.depW, this.depH);
    gl.uniform2f(u.uCur, this.cursorSmoothed[0], this.cursorSmoothed[1]);
    gl.uniform1f(u.uT, ts);
    gl.uniform1f(u.uTanF, Math.tan((this.state.fov * Math.PI) / 360));
    gl.uniform1f(u.uFar, this.state.far);
    gl.uniform1f(u.uRad, this.state.rad);
    gl.uniform1f(u.uSky, this.state.sky);
    gl.uniform1f(u.uEdge, this.state.edg);
    gl.uniform1i(u.uMode, this.state.mode);
    gl.uniform1i(u.uView, this.state.view);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.raf = requestAnimationFrame(this.renderFrame);
  };

  start(): void {
    this.stop();
    this.raf = requestAnimationFrame(this.renderFrame);
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
}
