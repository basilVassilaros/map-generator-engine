// Wires the editor, the view (zoom and pan), the inspector panel and the
// generation core together.
//
// Two cores run side by side, each in its own background thread:
//   - the base core generates the whole map at the working resolution;
//   - the detail core generates only the visible area, at screen resolution,
//     whenever the view is zoomed in. Until it's ready, the base map is shown
//     enlarged, so zooming always responds instantly.

import { CoastEditor, toGuide, type EditKind } from "./editor";
import { EngineClient, type Frame } from "./engine-client";
import { exportPng } from "./export";
import { MAX_SHORE_KM, MIN_SHORE_KM, type SegmentParams } from "./protocol";

const EXTENT_KM = 1600;
const REAL_TIME_MS = 100;
const MAX_ZOOM = 32;
/** Below this zoom the base map already shows all the detail there is. */
const DETAIL_FROM_ZOOM = 1.6;
/** Pixel budget for the zoomed view, which keeps edits near real time. */
const MAX_DETAIL_PIXELS = 650_000;
const DETAIL_DELAY_MS = 220;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const stage = $<HTMLDivElement>("stage");
const display = $<HTMLCanvasElement>("map");
const overlay = $<HTMLCanvasElement>("overlay");
const displayCtx = display.getContext("2d")!;

const generateBtn = $<HTMLButtonElement>("generate");
const clearBtn = $<HTMLButtonElement>("clear");
const exportBtn = $<HTMLButtonElement>("export");
const exportStatus = $<HTMLParagraphElement>("export-status");
const guidance = $<HTMLParagraphElement>("guidance");
const segmentPanel = $<HTMLElement>("segment-panel");
const segmentTitle = $<HTMLElement>("segment-title");
const pointPanel = $<HTMLElement>("point-panel");
const pointTitle = $<HTMLElement>("point-title");
const deletePointBtn = $<HTMLButtonElement>("delete-point");
const applyAllBtn = $<HTMLButtonElement>("apply-all");
const resolutionSelect = $<HTMLSelectElement>("resolution");
const timing = $<HTMLParagraphElement>("timing");
const timingDetail = $<HTMLParagraphElement>("timing-detail");
const problem = $<HTMLDivElement>("problem");
const zoomIn = $<HTMLButtonElement>("zoom-in");
const zoomOut = $<HTMLButtonElement>("zoom-out");
const zoomFit = $<HTMLButtonElement>("zoom-fit");
const zoomLevel = $<HTMLOutputElement>("zoom-level");
const detailBadge = $<HTMLSpanElement>("detail-badge");

const sliders = {
  roughness: $<HTMLInputElement>("roughness"),
  coves: $<HTMLInputElement>("coves"),
  shore: $<HTMLInputElement>("shore"),
};
const readouts = {
  roughness: $<HTMLOutputElement>("roughness-value"),
  coves: $<HTMLOutputElement>("coves-value"),
  shore: $<HTMLOutputElement>("shore-value"),
};

// Shore distance spans 0.1 to 30 km, so the slider is logarithmic: equal
// slider travel gives an equal ratio, which keeps cliffs and beaches both usable.
const shoreFromSlider = (v: number) => MIN_SHORE_KM * Math.pow(MAX_SHORE_KM / MIN_SHORE_KM, v / 1000);
const sliderFromShore = (km: number) => Math.round((Math.log(km / MIN_SHORE_KM) / Math.log(MAX_SHORE_KM / MIN_SHORE_KM)) * 1000);

let resolution = Number(resolutionSelect.value);
let generated = false;

const editor = new CoastEditor(overlay, EXTENT_KM);
const base = new EngineClient();
const detail = new EngineClient();

// --- view --------------------------------------------------------------------

/** Zoom level and the world position (km) at the centre of the stage. */
const view = { zoom: 1, cx: EXTENT_KM / 2, cy: EXTENT_KM / 2 };

function fitSize(): number {
  return Math.max(200, Math.min(stage.clientWidth, stage.clientHeight) - 48);
}

/** Where the whole map sits on the stage, in CSS pixels. */
function mapRect() {
  const size = fitSize() * view.zoom;
  return {
    left: stage.clientWidth / 2 - (view.cx / EXTENT_KM) * size,
    top: stage.clientHeight / 2 - (view.cy / EXTENT_KM) * size,
    size,
  };
}

function setView(zoom: number, cx: number, cy: number): void {
  view.zoom = Math.min(MAX_ZOOM, Math.max(1, zoom));
  if (view.zoom === 1) {
    view.cx = EXTENT_KM / 2;
    view.cy = EXTENT_KM / 2;
  } else {
    view.cx = Math.min(EXTENT_KM, Math.max(0, cx));
    view.cy = Math.min(EXTENT_KM, Math.max(0, cy));
  }
  const r = mapRect();
  editor.setView(r.left, r.top, r.size);
  zoomLevel.textContent = view.zoom < 10 ? `${view.zoom.toFixed(1)}×` : `${Math.round(view.zoom)}×`;
  zoomOut.disabled = view.zoom <= 1;
  zoomFit.disabled = view.zoom <= 1;
  zoomIn.disabled = view.zoom >= MAX_ZOOM;
  render();
  scheduleDetail();
}

/** Zoom by `factor`, keeping the world point under stage pixel (x, y) still. */
function zoomAt(factor: number, x: number, y: number): void {
  const r = mapRect();
  const kmX = ((x - r.left) / r.size) * EXTENT_KM;
  const kmY = ((y - r.top) / r.size) * EXTENT_KM;
  const zoom = Math.min(MAX_ZOOM, Math.max(1, view.zoom * factor));
  const size = fitSize() * zoom;
  setView(zoom, kmX - ((x - stage.clientWidth / 2) / size) * EXTENT_KM, kmY - ((y - stage.clientHeight / 2) / size) * EXTENT_KM);
}

editor.onZoom = zoomAt;
editor.onPan = (dx, dy) => {
  if (view.zoom <= 1) return;
  const size = fitSize() * view.zoom;
  setView(view.zoom, view.cx - (dx / size) * EXTENT_KM, view.cy - (dy / size) * EXTENT_KM);
};
zoomIn.addEventListener("click", () => zoomAt(2, stage.clientWidth / 2, stage.clientHeight / 2));
zoomOut.addEventListener("click", () => zoomAt(0.5, stage.clientWidth / 2, stage.clientHeight / 2));
zoomFit.addEventListener("click", () => setView(1, 0, 0));
window.addEventListener("keydown", (e) => {
  const target = e.target as HTMLElement | null;
  if (target && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
  if (e.key === "+" || e.key === "=") zoomAt(1.5, stage.clientWidth / 2, stage.clientHeight / 2);
  else if (e.key === "-" || e.key === "_") zoomAt(1 / 1.5, stage.clientWidth / 2, stage.clientHeight / 2);
  else if (e.key === "0") setView(1, 0, 0);
});

// --- layers --------------------------------------------------------------------

/** The whole map at working resolution. Also the source for PNG export. */
const baseCanvas = document.createElement("canvas");
let baseInit = 0;

interface DetailLayer {
  canvas: HTMLCanvasElement;
  /** World area covered, in km. */
  x: number;
  y: number;
  w: number;
  h: number;
  initVersion: number;
  /** Ready to show: its terrain matches the current coastline. */
  ready: boolean;
}
let detailShown: DetailLayer | null = null;
let detailPending: DetailLayer | null = null;
let detailTimer = 0;

function render(): void {
  const dpr = window.devicePixelRatio || 1;
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  if (display.width !== Math.round(w * dpr) || display.height !== Math.round(h * dpr)) {
    display.width = Math.round(w * dpr);
    display.height = Math.round(h * dpr);
  }
  const ctx = displayCtx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const r = mapRect();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  if (baseCanvas.width) ctx.drawImage(baseCanvas, r.left, r.top, r.size, r.size);
  if (detailShown) {
    const s = r.size / EXTENT_KM;
    ctx.drawImage(detailShown.canvas, r.left + detailShown.x * s, r.top + detailShown.y * s, detailShown.w * s, detailShown.h * s);
  }
  // Outline the map edge when zoomed so its limits stay clear.
  ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
  ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(r.left) + 0.5, Math.round(r.top) + 0.5, Math.round(r.size) - 1, Math.round(r.size) - 1);
}

function detailActive(): boolean {
  return detailShown !== null || detailPending !== null;
}

function scheduleDetail(): void {
  clearTimeout(detailTimer);
  if (!generated || view.zoom < DETAIL_FROM_ZOOM) {
    detailShown = null;
    detailPending = null;
    detailBadge.hidden = true;
    render();
    return;
  }
  detailBadge.hidden = false;
  detailTimer = window.setTimeout(startDetail, DETAIL_DELAY_MS);
}

/** Generate the visible part of the map at screen resolution. */
function startDetail(): void {
  const r = mapRect();
  const left = Math.max(0, r.left);
  const top = Math.max(0, r.top);
  const right = Math.min(stage.clientWidth, r.left + r.size);
  const bottom = Math.min(stage.clientHeight, r.top + r.size);
  if (right - left < 8 || bottom - top < 8) return;

  const kmPerPx = EXTENT_KM / r.size;
  const area = { x: (left - r.left) * kmPerPx, y: (top - r.top) * kmPerPx, w: (right - left) * kmPerPx, h: (bottom - top) * kmPerPx };
  const dpr = window.devicePixelRatio || 1;
  const scale = Math.min(dpr, Math.sqrt(MAX_DETAIL_PIXELS / ((right - left) * (bottom - top))));
  const width = Math.max(8, Math.round((right - left) * scale));
  const height = Math.max(8, Math.round((bottom - top) * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const initVersion = detail.init(width, height, area.w, area.x, area.y);
  detailPending = { canvas, ...area, initVersion, ready: false };
  detail.setCoast(toGuide(editor.model));
}

function paint(canvas: HTMLCanvasElement, frame: Frame): void {
  const [x0, y0, x1, y1] = frame.rect;
  const w = x1 - x0;
  const h = y1 - y0;
  if (w > 0 && h > 0) canvas.getContext("2d")!.putImageData(new ImageData(frame.pixels, w, h), x0, y0);
}

// --- cores ---------------------------------------------------------------------

function startBase(): void {
  baseCanvas.width = resolution;
  baseCanvas.height = resolution;
  baseInit = base.init(resolution, resolution, EXTENT_KM);
  if (generated) base.setCoast(toGuide(editor.model));
}

base.onFrame = (frame) => {
  if (frame.initVersion !== baseInit) return; // From before a resolution change.
  paint(baseCanvas, frame);
  render();
  if (frame.kind === "coast" && !detailShown) showTiming(frame, "Whole map");
};

detail.onFrame = (frame) => {
  if (detailPending && frame.initVersion === detailPending.initVersion) {
    paint(detailPending.canvas, frame);
    if (frame.kind === "coast") {
      // The new view has its terrain: swap it in.
      detailShown = { ...detailPending, ready: true };
      detailPending = null;
      detailBadge.hidden = true;
      render();
    }
  } else if (detailShown && frame.initVersion === detailShown.initVersion && frame.kind === "coast") {
    paint(detailShown.canvas, frame);
    render();
    showTiming(frame, "Zoomed view");
  }
};

const stopped = (message: string) => {
  problem.hidden = false;
  problem.textContent = `The terrain engine stopped: ${message} Reload the page to start again.`;
};
base.onError = stopped;
detail.onError = stopped;

function showTiming(frame: Frame, what: string): void {
  const total = Math.round(frame.totalMs);
  const [x0, y0, x1, y1] = frame.rect;
  timing.textContent = `Last update took ${total} ms`;
  timing.classList.toggle("slow", total > REAL_TIME_MS);
  timingDetail.textContent =
    `${what}: ${Math.round(frame.computeMs)} ms generating, ${((x1 - x0) * (y1 - y0)).toLocaleString()} pixels redrawn. ` +
    `Target is ${REAL_TIME_MS} ms. Engine runs on the ${base.mode === "background" ? "background thread" : "main thread"}.`;
}

// --- panel -----------------------------------------------------------------------

function guidanceText(): string {
  const { points, closed } = editor.model;
  if (!points.length) return "Click on the map to place the first point of your coastline.";
  if (!closed) {
    return points.length < 3
      ? "Keep clicking to add points around the landmass."
      : "Click the first point to close the shape. Backspace removes the last point, Escape starts over.";
  }
  if (!generated) return "The shape is closed. Generate the landmass to see the terrain.";
  return "Click a segment of the coastline to adjust it. Drag points to reshape it, double-click a segment to add a point.";
}

function refreshPanel(): void {
  const { model, selection } = editor;
  guidance.textContent = guidanceText();
  generateBtn.disabled = !model.closed || generated;
  generateBtn.textContent = generated ? "Landmass generated" : "Generate landmass";
  clearBtn.disabled = model.points.length === 0;
  exportBtn.disabled = !generated;

  const seg = generated && selection?.kind === "segment" ? selection.index : null;
  segmentPanel.hidden = seg === null;
  if (seg !== null) {
    segmentTitle.textContent = `Segment ${seg + 1} of ${model.points.length}`;
    const p = model.params[seg];
    sliders.roughness.value = String(Math.round(p.roughness * 100));
    sliders.coves.value = String(Math.round(p.coves * 100));
    sliders.shore.value = String(sliderFromShore(p.shoreKm));
    showReadouts(p);
  }

  const point = model.closed && selection?.kind === "point" ? selection.index : null;
  pointPanel.hidden = point === null;
  if (point !== null) {
    pointTitle.textContent = `Point ${point + 1} of ${model.points.length}`;
    deletePointBtn.disabled = model.points.length <= 3;
  }
}

function showReadouts(p: SegmentParams): void {
  readouts.roughness.textContent = `${Math.round(p.roughness * 100)}%`;
  readouts.coves.textContent = `${Math.round(p.coves * 100)}%`;
  readouts.shore.textContent = p.shoreKm < 1 ? `${Math.round(p.shoreKm * 1000)} m` : `${p.shoreKm.toFixed(1)} km`;
}

function paramsFromSliders(): SegmentParams {
  return {
    roughness: Number(sliders.roughness.value) / 100,
    coves: Number(sliders.coves.value) / 100,
    shoreKm: shoreFromSlider(Number(sliders.shore.value)),
  };
}

for (const slider of Object.values(sliders)) {
  slider.addEventListener("input", () => {
    const sel = editor.selection;
    if (sel?.kind !== "segment") return;
    const p = paramsFromSliders();
    showReadouts(p);
    editor.setParams(sel.index, p);
  });
}

applyAllBtn.addEventListener("click", () => editor.applyToAll(paramsFromSliders()));
deletePointBtn.addEventListener("click", () => {
  if (editor.selection?.kind === "point") editor.deletePoint(editor.selection.index);
});

generateBtn.addEventListener("click", () => {
  generated = true;
  base.setCoast(toGuide(editor.model));
  scheduleDetail();
  refreshPanel();
});

clearBtn.addEventListener("click", () => {
  generated = false;
  editor.clear();
  base.setCoast(null);
  scheduleDetail();
  timing.textContent = "No updates yet";
  timing.classList.remove("slow");
  timingDetail.textContent = "";
  exportStatus.textContent = "";
  refreshPanel();
});

exportBtn.addEventListener("click", async () => {
  exportBtn.disabled = true;
  exportStatus.textContent = "Preparing image…";
  exportStatus.textContent = await exportPng(baseCanvas, `world-map-${resolution}px.png`);
  exportBtn.disabled = !generated;
});

resolutionSelect.addEventListener("change", () => {
  resolution = Number(resolutionSelect.value);
  startBase();
});

editor.onEdit = (kind: EditKind) => {
  if (kind === "shape" && generated) {
    const guide = toGuide(editor.model);
    base.setCoast(guide);
    if (detailActive()) detail.setCoast(guide);
  }
  refreshPanel();
};

// --- start -----------------------------------------------------------------------

new ResizeObserver(() => setView(view.zoom, view.cx, view.cy)).observe(stage);

if (typeof WebAssembly === "undefined") {
  problem.hidden = false;
  problem.textContent = "This browser can't run WebAssembly, which the terrain engine needs. Try a current version of Chrome, Edge, Firefox or Safari.";
} else {
  startBase();
}
setView(1, 0, 0);
refreshPanel();
