// Wires the editor, the view (zoom and pan), the inspector panel and the
// generation core together.
//
// Two cores run side by side, each in its own background thread:
//   - the base core generates the whole map at the working resolution;
//   - the detail core generates only the visible area, at screen resolution,
//     whenever the view is zoomed in. Until it's ready, the base map is shown
//     enlarged, so zooming always responds instantly.

import { CoastEditor, selectedSegments, type EditKind, type PathFeature, type ReferenceImage, type ShapeModel, type ToolName } from "./editor";
import { decodePlanned, type ClimateSettings, type Guides } from "./protocol";
import { exportTerrainPng, renderTerrainWindow, windowOver } from "./terrain-hq";
import { BIOMES, biome } from "./biomes";
import { EngineClient, type Frame } from "./engine-client";
import { exportPng, saveBlob } from "./export";
import { exportFullDetail } from "./export-full";
import { SLIDERS, isAdjusted, type SliderKey, type SliderValues } from "./params";

/** The real width of the map; set in the Map panel. */
const mapKm = () => editor.mapWidthKm;
const MIN_MAP_KM = 50;
const MAX_MAP_KM = 40_000;
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
const newShapeBtn = $<HTMLButtonElement>("new-shape");
const shapeList = $<HTMLUListElement>("shape-list");
const shapePanel = $<HTMLElement>("shape-panel");
const shapeName = $<HTMLInputElement>("shape-name");
const shapeFacts = $<HTMLParagraphElement>("shape-facts");
const shapeHelp = $<HTMLParagraphElement>("shape-help");
const deleteShapeBtn = $<HTMLButtonElement>("delete-shape");
const segmentShape = $<HTMLParagraphElement>("segment-shape");
const kindLand = $<HTMLButtonElement>("kind-land");
const kindWater = $<HTMLButtonElement>("kind-water");
const heightLabel = $<HTMLLabelElement>("height-label");
const heightHint = $<HTMLParagraphElement>("height-hint");
const autoLevel = $<HTMLInputElement>("auto-level");
const autoLevelRow = $<HTMLLabelElement>("auto-level-row");
const stackUp = $<HTMLButtonElement>("stack-up");
const stackDown = $<HTMLButtonElement>("stack-down");
const toolButtons: Record<ToolName, HTMLButtonElement> = { coast: $("tool-coast"), mountain: $("tool-mountain"), river: $("tool-river"), biome: $("tool-biome") };
const terrainBtn = $<HTMLButtonElement>("render-terrain");
const terrainDialog = $<HTMLDialogElement>("terrain-dialog");
const terrainSkip = $<HTMLInputElement>("terrain-skip");
const featurePanel = $<HTMLElement>("feature-panel");
const featureTitle = $<HTMLElement>("feature-title");
const featureName = $<HTMLInputElement>("feature-name");
const featureHelp = $<HTMLParagraphElement>("feature-help");
const deleteFeatureBtn = $<HTMLButtonElement>("delete-feature");
const fHeight = $<HTMLInputElement>("f-height");
const fWidth = $<HTMLInputElement>("f-width");
const fRugged = $<HTMLInputElement>("f-rugged");
const fDepth = $<HTMLInputElement>("f-depth");
const fCurve = $<HTMLInputElement>("f-curve");
const fResetBends = $<HTMLButtonElement>("f-reset-bends");
const latitudeInput = $<HTMLInputElement>("latitude");
const lookSelect = $<HTMLSelectElement>("terrain-look");
const detailSelect = $<HTMLSelectElement>("terrain-detail");
const saveTerrainBtn = $<HTMLButtonElement>("save-terrain");
const rainfallInput = $<HTMLInputElement>("rainfall");
const evaporationInput = $<HTMLInputElement>("evaporation");
const kindHint = $<HTMLParagraphElement>("kind-hint");
const heightSlider = $<HTMLInputElement>("height");
const heightValue = $<HTMLOutputElement>("height-value");
const importBtn = $<HTMLButtonElement>("import-image");
const importFile = $<HTMLInputElement>("import-file");
const referencePanel = $<HTMLElement>("reference-panel");
const referenceName = $<HTMLParagraphElement>("reference-name");
const referenceOpacity = $<HTMLInputElement>("reference-opacity");
const referenceOpacityValue = $<HTMLOutputElement>("reference-opacity-value");
const referenceHelp = $<HTMLParagraphElement>("reference-help");
const referenceReplace = $<HTMLButtonElement>("reference-replace");
const referenceRemove = $<HTMLButtonElement>("reference-remove");
const mapWidthInput = $<HTMLInputElement>("map-width");
const mapWidthApply = $<HTMLButtonElement>("map-width-apply");
const mapWidthChoice = $<HTMLDivElement>("map-width-choice");
const widthKeep = $<HTMLButtonElement>("width-keep");
const widthScale = $<HTMLButtonElement>("width-scale");
const gridSelect = $<HTMLSelectElement>("grid");
const showGrid = $<HTMLInputElement>("show-grid");
const mapFacts = $<HTMLParagraphElement>("map-facts");
const exportDialog = $<HTMLDialogElement>("export-dialog");
const quickHint = $<HTMLSpanElement>("quick-hint");
const fullOptions = $<HTMLDivElement>("full-options");
const fullSize = $<HTMLSelectElement>("full-size");
const fullEstimate = $<HTMLParagraphElement>("full-estimate");
const exportProgress = $<HTMLDivElement>("export-progress");
const exportBar = $<HTMLProgressElement>("export-bar");
const exportProgressText = $<HTMLParagraphElement>("export-progress-text");
const exportCancel = $<HTMLButtonElement>("export-cancel");
const exportGo = $<HTMLButtonElement>("export-go");
const exportBtn = $<HTMLButtonElement>("export");
const exportStatus = $<HTMLParagraphElement>("export-status");
const terrainOptions = $<HTMLDivElement>("terrain-options");
const terrainArea = $<HTMLSelectElement>("terrain-area");
const terrainSize = $<HTMLSelectElement>("terrain-size");
const terrainEstimate = $<HTMLParagraphElement>("terrain-estimate");
const plannedBox = $<HTMLDivElement>("planned-box");
const showPlanned = $<HTMLInputElement>("show-planned");
const keepPlanned = $<HTMLButtonElement>("keep-planned");
const plannedFacts = $<HTMLParagraphElement>("planned-facts");
const biomeFields = $<HTMLDivElement>("biome-fields");
const bPreset = $<HTMLSelectElement>("b-preset");
const bRain = $<HTMLInputElement>("b-rain");
const bHumid = $<HTMLInputElement>("b-humid");
const bForest = $<HTMLInputElement>("b-forest");
const bTemp = $<HTMLInputElement>("b-temp");
const bTempAuto = $<HTMLInputElement>("b-temp-auto");
const bFeather = $<HTMLInputElement>("b-feather");
const bRegen = $<HTMLButtonElement>("b-regen");
const guidance = $<HTMLParagraphElement>("guidance");
const segmentPanel = $<HTMLElement>("segment-panel");
const segmentTitle = $<HTMLElement>("segment-title");
const pointPanel = $<HTMLElement>("point-panel");
const pointTitle = $<HTMLElement>("point-title");
const deletePointBtn = $<HTMLButtonElement>("delete-point");
const resetSegmentBtn = $<HTMLButtonElement>("reset-segment");
const resolutionSelect = $<HTMLSelectElement>("resolution");
const timing = $<HTMLParagraphElement>("timing");
const timingDetail = $<HTMLParagraphElement>("timing-detail");
const problem = $<HTMLDivElement>("problem");
const zoomIn = $<HTMLButtonElement>("zoom-in");
const zoomOut = $<HTMLButtonElement>("zoom-out");
const zoomFit = $<HTMLButtonElement>("zoom-fit");
const zoomLevel = $<HTMLOutputElement>("zoom-level");
const detailBadge = $<HTMLSpanElement>("detail-badge");

const smoothingSlider = $<HTMLInputElement>("smoothing");
const smoothingValue = $<HTMLOutputElement>("smoothing-value");
/**
 * A set of the coastline sliders in `container`. `onChange` receives all
 * values whenever one moves. Built once and updated in place, so dragging a
 * slider never loses focus when the panel refreshes.
 */
function sliderSet(container: HTMLElement, prefix: string, onChange: (values: SliderValues) => void) {
  const inputs = {} as Record<SliderKey, HTMLInputElement>;
  const outputs = {} as Record<SliderKey, HTMLOutputElement>;
  for (const spec of SLIDERS) {
    const id = `${prefix}-${spec.key}`;
    const field = document.createElement("div");
    field.className = "field";
    field.innerHTML = `<div class="field-head"><label for="${id}"></label><output id="${id}-value"></output></div>
      <input id="${id}" type="range" min="${spec.min}" max="${spec.max}" step="${spec.step}">
      <p class="hint"></p>`;
    field.querySelector("label")!.textContent = spec.label;
    field.querySelector(".hint")!.textContent = spec.hint;
    inputs[spec.key] = field.querySelector("input")!;
    outputs[spec.key] = field.querySelector("output")!;
    container.append(field);
  }
  const read = () => {
    const v = {} as SliderValues;
    for (const spec of SLIDERS) v[spec.key] = Number(inputs[spec.key].value);
    return v;
  };
  for (const spec of SLIDERS) {
    inputs[spec.key].addEventListener("input", () => onChange(read()));
  }
  return {
    /** Show values; `adjust`, if given, marks how far each differs from the shape. */
    show(values: SliderValues, adjust?: SliderValues, disabled = false) {
      for (const spec of SLIDERS) {
        if (document.activeElement !== inputs[spec.key]) inputs[spec.key].value = String(values[spec.key]);
        inputs[spec.key].disabled = disabled;
        outputs[spec.key].textContent = spec.format(values[spec.key]);
        const a = adjust?.[spec.key] ?? 0;
        if (a !== 0) {
          const mark = document.createElement("span");
          mark.className = "adjusted";
          mark.textContent = spec.key === "shore" ? "adjusted" : `${a > 0 ? "+" : "−"}${Math.abs(Math.round(a))} from shape`;
          outputs[spec.key].append(mark);
        }
      }
    },
  };
}

const shapeSliders = sliderSet($("shape-sliders"), "shape", (values) => editor.setShapeValues(values));
// With several segments selected, a slider moves them all by the same amount,
// keeping their differences. Their values are captured when a drag starts, so
// one that hits the end of the range springs back if the slider returns.
let dragStart: Map<number, SliderValues> | null = null;
const segmentSliders = sliderSet($("segment-sliders"), "segment", (values) => {
  const sel = editor.selection;
  const shape = editor.selectedShape();
  if (sel?.kind !== "segment" || !shape) return;
  const indices = selectedSegments(sel);
  if (!dragStart) dragStart = new Map(indices.map((i) => [i, editor.segmentValues(shape, i)]));
  const from = dragStart.get(sel.index) ?? editor.segmentValues(shape, sel.index);
  editor.setManySegmentValues(
    indices.map((i) => {
      const start = dragStart!.get(i) ?? editor.segmentValues(shape, i);
      const next = {} as SliderValues;
      for (const spec of SLIDERS) next[spec.key] = Math.min(spec.max, Math.max(spec.min, start[spec.key] + values[spec.key] - from[spec.key]));
      return [i, next] as [number, SliderValues];
    }),
  );
});
$("segment-sliders").addEventListener("change", () => (dragStart = null));

let resolution = Number(resolutionSelect.value);
let generated = false;

const editor = new CoastEditor(overlay, 1600);
const base = new EngineClient();
const detail = new EngineClient();
/** A half-resolution copy of the map, for instant feedback on large edits. */
const preview = new EngineClient();

// --- view --------------------------------------------------------------------

/** Zoom level and the world position (km) at the centre of the stage. */
const view = { zoom: 1, cx: 800, cy: 800 };

function fitSize(): number {
  return Math.max(200, Math.min(stage.clientWidth, stage.clientHeight) - 48);
}

/** Where the whole map sits on the stage, in CSS pixels. */
function mapRect() {
  const size = fitSize() * view.zoom;
  return {
    left: stage.clientWidth / 2 - (view.cx / mapKm()) * size,
    top: stage.clientHeight / 2 - (view.cy / mapKm()) * size,
    size,
  };
}

function setView(zoom: number, cx: number, cy: number): void {
  view.zoom = Math.min(MAX_ZOOM, Math.max(1, zoom));
  if (view.zoom === 1) {
    view.cx = mapKm() / 2;
    view.cy = mapKm() / 2;
  } else {
    view.cx = Math.min(mapKm(), Math.max(0, cx));
    view.cy = Math.min(mapKm(), Math.max(0, cy));
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
  const kmX = ((x - r.left) / r.size) * mapKm();
  const kmY = ((y - r.top) / r.size) * mapKm();
  const zoom = Math.min(MAX_ZOOM, Math.max(1, view.zoom * factor));
  const size = fitSize() * zoom;
  setView(zoom, kmX - ((x - stage.clientWidth / 2) / size) * mapKm(), kmY - ((y - stage.clientHeight / 2) / size) * mapKm());
}

editor.onZoom = zoomAt;
editor.onPan = (dx, dy) => {
  if (view.zoom <= 1) return;
  const size = fitSize() * view.zoom;
  setView(view.zoom, view.cx - (dx / size) * mapKm(), view.cy - (dy / size) * mapKm());
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
/** A fine-detail terrain render, drawn over the base map; filled in strip by strip. */
let terrainLayer: DetailLayer | null = null;
let detailPending: DetailLayer | null = null;
/** The visible part of a terrain render, re-rendered in fine detail when zoomed in. */
let terrainZoom: DetailLayer | null = null;
let terrainZoomAbort: AbortController | null = null;
/** What the shown terrain render was made from: what exports and zoomed views need. */
let terrainData: { structure: ArrayBuffer; guides: Guides; style: number; range: [number, number] } | null = null;
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
  if (terrainLayer) {
    const k = r.size / mapKm();
    ctx.drawImage(terrainLayer.canvas, r.left + terrainLayer.x * k, r.top + terrainLayer.y * k, terrainLayer.w * k, terrainLayer.h * k);
  }
  if (terrainZoom && terrainShown) {
    const k = r.size / mapKm();
    ctx.drawImage(terrainZoom.canvas, r.left + terrainZoom.x * k, r.top + terrainZoom.y * k, terrainZoom.w * k, terrainZoom.h * k);
  }
  if (detailShown) {
    const s = r.size / mapKm();
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
  if (terrainShown) {
    detailShown = null;
    detailPending = null;
    terrainZoomAbort?.abort();
    if (!terrainData || view.zoom < DETAIL_FROM_ZOOM || hqAbort) {
      terrainZoom = null;
      detailBadge.hidden = true;
    } else {
      detailBadge.hidden = false;
      detailTimer = window.setTimeout(startTerrainZoom, DETAIL_DELAY_MS);
    }
    render();
    return;
  }
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

  const kmPerPx = mapKm() / r.size;
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
  detail.setGuides(editor.guides());
}

/** The part of the map on screen (km), clipped to the map, and its size on screen in CSS pixels. */
function visibleArea(): { x: number; y: number; w: number; h: number; px: number; py: number } | null {
  const r = mapRect();
  const left = Math.max(0, r.left);
  const top = Math.max(0, r.top);
  const right = Math.min(stage.clientWidth, r.left + r.size);
  const bottom = Math.min(stage.clientHeight, r.top + r.size);
  if (right - left < 8 || bottom - top < 8) return null;
  const k = mapKm() / r.size;
  return { x: (left - r.left) * k, y: (top - r.top) * k, w: (right - left) * k, h: (bottom - top) * k, px: right - left, py: bottom - top };
}

/** Zoomed in on a terrain render: render what's on screen in fine detail, at screen resolution. */
async function startTerrainZoom(): Promise<void> {
  const data = terrainData;
  const area = visibleArea();
  if (!data || !area || !terrainShown) return;
  const dpr = window.devicePixelRatio || 1;
  const scale = Math.min(dpr, Math.sqrt((2 * MAX_DETAIL_PIXELS) / (area.px * area.py)));
  const win = windowOver(area, Math.max(16, Math.round(Math.max(area.px, area.py) * scale)));
  const canvas = document.createElement("canvas");
  canvas.width = win.width;
  canvas.height = win.height;
  const ctx = canvas.getContext("2d")!;
  terrainZoomAbort?.abort();
  const abort = new AbortController();
  terrainZoomAbort = abort;
  try {
    await renderTerrainWindow(win, data.structure, data.guides, data.style, (strip) => ctx.putImageData(new ImageData(strip.pixels, win.width, strip.rows), 0, strip.row), abort.signal);
    if (abort.signal.aborted || terrainData !== data) return;
    terrainZoom = { canvas, x: win.x, y: win.y, w: win.widthKm, h: win.heightKm, initVersion: 0, ready: true };
    detailBadge.hidden = true;
    render();
  } catch {
    // Cancelled by a newer view, or the terrain changed: nothing to show.
  } finally {
    if (terrainZoomAbort === abort) terrainZoomAbort = null;
  }
}

/** The terrain render no longer matches the map: forget it and what came with it. */
function dropTerrain(): void {
  terrainShown = false;
  terrainLayer = null;
  terrainZoom = null;
  terrainData = null;
  terrainZoomAbort?.abort();
  editor.setPlanned(null);
  plannedBox.hidden = true;
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
  baseInit = base.init(resolution, resolution, mapKm());
  // The preview runs at half the resolution: a quarter of the work.
  previewInit = preview.init(resolution / 2, resolution / 2, mapKm());
  dropTerrain();
  if (generated) sendGuides();
}

/** Which edit each engine's requests belong to, so a stale preview never overwrites a newer full-resolution result. */
let editSeq = 0;
let basePaintedSeq = 0;
const baseSeq = new Map<number, number>();
const previewSeq = new Map<number, number>();
let previewInit = 0;
/** The map is showing a terrain render rather than the live picture. */
let terrainShown = false;

/** Send the current guides to every engine. */
function sendGuides(): void {
  const guides = editor.guides();
  const shown = generated ? guides : { ...guides, shapes: [], mountains: [], rivers: [] };
  editSeq++;
  baseSeq.set(base.setGuides(shown), editSeq);
  previewSeq.set(preview.setGuides(shown), editSeq);
  if (detailActive()) detail.setGuides(guides);
  if (terrainShown) {
    dropTerrain();
    hqAbort?.abort();
    saveTerrainBtn.hidden = true;
    scheduleDetail();
  }
  scheduleAutosave();
}

base.onFrame = (frame) => {
  if (frame.initVersion !== baseInit) return; // From before a resolution change.
  if (frame.kind === "terrain") {
    terrainShown = true;
    detailShown = null;
    detailPending = null;
    detailBadge.hidden = true;
    paint(baseCanvas, frame);
    render();
    const lakes = frame.lakes ?? 0;
    const rivers = frame.rivers ?? 0;
    exportStatus.textContent = `Terrain rendered in ${(frame.computeMs / 1000).toFixed(1)} s: rivers through ${rivers.toLocaleString()} cells${lakes ? `, lakes over ${lakes.toLocaleString()}` : ""}. Any change returns to the live map.`;
    terrainBtn.disabled = false;
    saveTerrainBtn.hidden = false;
    const guidesUsed = pendingGuides ?? editor.guides();
    if (frame.structure) terrainData = { structure: frame.structure, guides: guidesUsed, style: climateSettings().style, range: frame.range ?? [0, 3000] };
    const plan = decodePlanned(frame.planned);
    editor.setPlanned(plan);
    plannedBox.hidden = !(plan.rivers.length || plan.hills.length || plan.lakes.length);
    plannedFacts.textContent = `The render planned ${plan.rivers.length} rivers, ${plan.hills.length} lines of hills and ${plan.lakes.length} lake${plan.lakes.length === 1 ? "" : "s"} from your guides, and shaped the terrain from them.`;
    refreshPanel();
    if (frame.structure && detailSelect.value !== "quick") void renderDetail(frame.structure, guidesUsed);
    else scheduleDetail();
    return;
  }
  basePaintedSeq = Math.max(basePaintedSeq, baseSeq.get(frame.version) ?? 0);
  baseSeq.delete(frame.version);
  paint(baseCanvas, frame);
  render();
  if (frame.kind === "guides" && !detailShown) showTiming(frame, "Whole map");
};

// While the full-resolution engine works on a large edit, the half-resolution
// preview usually finishes first. Show it, enlarged, until the real one lands.
const previewScratch = document.createElement("canvas");
preview.onFrame = (frame) => {
  const seq = previewSeq.get(frame.version) ?? 0;
  previewSeq.delete(frame.version);
  if (frame.initVersion !== previewInit || frame.kind !== "guides" || seq <= basePaintedSeq || terrainShown) return;
  const [x0, y0, x1, y1] = frame.rect;
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 2 || h <= 2) return;
  previewScratch.width = w;
  previewScratch.height = h;
  previewScratch.getContext("2d")!.putImageData(new ImageData(frame.pixels, w, h), 0, 0);
  const ctx = baseCanvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  // Leave a one-pixel margin, so nothing blurry survives outside the area
  // the full-resolution result will repaint.
  ctx.drawImage(previewScratch, 1, 1, w - 2, h - 2, (x0 + 1) * 2, (y0 + 1) * 2, (w - 2) * 2, (h - 2) * 2);
  render();
  if (!detailShown) showTiming(frame, "Preview (half resolution)");
};

detail.onFrame = (frame) => {
  if (detailPending && frame.initVersion === detailPending.initVersion) {
    paint(detailPending.canvas, frame);
    if (frame.kind === "guides") {
      // The new view has its terrain: swap it in.
      detailShown = { ...detailPending, ready: true };
      detailPending = null;
      detailBadge.hidden = true;
      render();
    }
  } else if (detailShown && frame.initVersion === detailShown.initVersion && frame.kind === "guides") {
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
preview.onError = () => {}; // The preview is a convenience: the map works without it.

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

const ICON_EYE = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M1.5 10S5 4 10 4s8.5 6 8.5 6-3.5 6-8.5 6-8.5-6-8.5-6Z" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="10" cy="10" r="2.6" fill="currentColor"/></svg>';
const ICON_EYE_OFF = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M1.5 10S5 4 10 4s8.5 6 8.5 6-3.5 6-8.5 6-8.5-6-8.5-6Z" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".45"/><path d="M3 17 17 3" stroke="currentColor" stroke-width="1.6"/></svg>';
const ICON_LOCK = '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4" y="9" width="12" height="8" rx="1.5" fill="currentColor"/><path d="M6.5 9V6.5a3.5 3.5 0 0 1 7 0V9" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
const ICON_UNLOCK = '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4" y="9" width="12" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".6"/><path d="M6.5 9V6.5a3.5 3.5 0 0 1 6.8-1.2" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".6"/></svg>';

function toolGuidance(): string | null {
  if (editor.tool === "coast") return null;
  const mountain = editor.tool === "mountain";
  const n = editor.featureDraft?.length ?? 0;
  if (editor.featureSelected !== null && !n) return "";
  if (editor.tool === "biome") {
    if (!n) return "Click around an area to paint a biome region over it, then click the first point (or press Enter) to close it. Click inside a region to select it.";
    return n < 3
      ? `${n} point${n > 1 ? "s" : ""} placed. Keep clicking around the area; right-click or Backspace removes the last point.`
      : "Click the first point or press Enter to close the region. Escape cancels.";
  }
  if (!n) {
    return mountain
      ? "Click on the map to place a mountain. One point makes a single peak; keep clicking for a range, then press Enter or double-click to finish."
      : "Click where the river begins and keep clicking downstream; press Enter or double-click to finish. One point makes a pool.";
  }
  return `${n} point${n > 1 ? "s" : ""} placed. Press Enter or double-click to finish, right-click or Backspace to remove the last point, Escape to cancel.`;
}

function guidanceText(): string {
  const forTool = toolGuidance();
  if (forTool !== null) return forTool;
  if (editor.featureSelected !== null) return "";
  const draft = editor.draft;
  const count = editor.shapes.length;
  if (draft) {
    if (!draft.length) {
      return count
        ? "Click on the map to start the new shape. Escape cancels."
        : "Click on the map to place the first point of your coastline.";
    }
    return draft.length < 3
      ? "Keep clicking to add points around the shape. Right-click or Backspace removes the last point."
      : "Click the first point to close the shape. Right-click or Backspace removes the last point, Escape starts over.";
  }
  if (!generated) return "Generate the landmass to see the terrain, or add another shape first.";
  const sel = editor.selection;
  if (editor.referenceSelected) return "";
  if (sel?.kind === "segment") return "";
  if (sel === null && generated && editor.shapes.length && !editor.drawing) return "Click a shape to select it, or a stretch of its coast to adjust it. Ctrl+Click (Cmd+Click on a Mac) to pick several stretches.";
  if (sel?.kind === "point") return "Drag the point to reshape the coast. Delete or Backspace removes it.";
  // A selected shape's instructions live in its own panel.
  if (sel?.kind === "shape") return "";
  return "Click a shape to select it, or a stretch of its coast to adjust it.";
}

/** Clicking once arms a destructive button; a second click within a few seconds confirms. */
function confirmable(button: HTMLButtonElement, label: string, confirm: string, action: () => void): void {
  let armed = 0;
  button.addEventListener("click", () => {
    if (armed) {
      clearTimeout(armed);
      armed = 0;
      button.textContent = label;
      button.classList.remove("armed");
      action();
      return;
    }
    button.textContent = confirm;
    button.classList.add("armed");
    armed = window.setTimeout(() => {
      armed = 0;
      button.textContent = label;
      button.classList.remove("armed");
    }, 4000);
  });
}

function featureRow(f: PathFeature): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "shape-row feature";
  const selected = editor.featureSelected === f.id;
  li.classList.toggle("selected", selected);
  li.classList.toggle("hidden-shape", f.hidden);
  const pick = document.createElement("button");
  pick.className = "shape-pick";
  pick.setAttribute("aria-pressed", String(selected));
  const note =
    f.kind === "biome"
      ? `${biome(f.biome ?? "").name} · ${Math.round(f.rainfall ?? 0)} mm`
      : f.kind === "mountain"
        ? `${f.height.toLocaleString()} m · ${f.points.length === 1 ? "peak" : "range"}`
        : f.points.length === 1
          ? "pool"
          : `${f.width} km wide`;
  pick.innerHTML = `<span class="shape-name"></span><span class="shape-kind">${note}</span>`;
  pick.querySelector(".shape-name")!.textContent = f.name;
  pick.addEventListener("click", () => editor.selectFeature(f.id));
  const hide = document.createElement("button");
  hide.className = "icon-btn";
  hide.innerHTML = f.hidden ? ICON_EYE_OFF : ICON_EYE;
  hide.setAttribute("aria-label", f.hidden ? `Show ${f.name}` : `Hide ${f.name}`);
  hide.addEventListener("click", () => editor.updateFeature(f.id, { hidden: !f.hidden }));
  const lock = document.createElement("button");
  lock.className = "icon-btn";
  lock.innerHTML = f.locked ? ICON_LOCK : ICON_UNLOCK;
  lock.setAttribute("aria-label", f.locked ? `Unlock ${f.name}` : `Lock ${f.name}`);
  lock.addEventListener("click", () => editor.updateFeature(f.id, { locked: !f.locked }));
  li.append(pick, hide, lock);
  return li;
}

function renderShapeList(): void {
  shapeList.replaceChildren(
    ...editor.shapes.map((shape) => {
      const li = document.createElement("li");
      li.className = "shape-row";
      const selected = editor.selection?.shape === shape.id;
      li.classList.toggle("selected", selected);
      li.classList.toggle("hidden-shape", shape.hidden);

      const pick = document.createElement("button");
      pick.className = "shape-pick";
      pick.setAttribute("aria-pressed", String(selected));
      const kindLabel = shape.kind === "water" ? `Water · ${shape.autoLevel ? "ground level" : `${shape.height} m`}` : `Land · ${shape.height} m`;
      pick.innerHTML = `<span class="shape-name"></span><span class="shape-kind">${kindLabel} · ${shape.points.length} points</span>`;
      pick.querySelector(".shape-name")!.textContent = shape.name;
      pick.addEventListener("click", () => editor.select({ kind: "shape", shape: shape.id }));

      const hide = document.createElement("button");
      hide.className = "icon-btn";
      hide.innerHTML = shape.hidden ? ICON_EYE_OFF : ICON_EYE;
      hide.setAttribute("aria-label", shape.hidden ? `Show ${shape.name}` : `Hide ${shape.name}`);
      hide.title = shape.hidden ? "Show" : "Hide";
      hide.addEventListener("click", () => editor.toggleHidden(shape.id));

      const lock = document.createElement("button");
      lock.className = "icon-btn";
      lock.innerHTML = shape.locked ? ICON_LOCK : ICON_UNLOCK;
      lock.setAttribute("aria-label", shape.locked ? `Unlock ${shape.name}` : `Lock ${shape.name}`);
      lock.title = shape.locked ? "Unlock" : "Lock";
      lock.addEventListener("click", () => editor.toggleLocked(shape.id));

      li.append(pick, hide, lock);
      return li;
    }),
  );
  for (const kind of ["mountain", "river", "biome"] as const) {
    const items = editor.features.filter((f) => f.kind === kind);
    if (!items.length) continue;
    const head = document.createElement("li");
    head.className = "list-head";
    head.textContent = kind === "mountain" ? "Mountains" : kind === "river" ? "Rivers" : "Biomes";
    shapeList.append(head);
    for (const f of items) shapeList.append(featureRow(f));
  }
  const ref = editor.reference;
  if (ref) {
    const li = document.createElement("li");
    li.className = "shape-row reference";
    li.classList.toggle("selected", editor.referenceSelected);
    li.classList.toggle("hidden-shape", ref.hidden);
    const pick = document.createElement("button");
    pick.className = "shape-pick";
    pick.setAttribute("aria-pressed", String(editor.referenceSelected));
    pick.innerHTML = `<span class="shape-name">Reference image</span><span class="shape-kind">For tracing · ${Math.round(ref.opacity * 100)}% opacity</span>`;
    pick.addEventListener("click", () => editor.selectReference());
    const hide = document.createElement("button");
    hide.className = "icon-btn";
    hide.innerHTML = ref.hidden ? ICON_EYE_OFF : ICON_EYE;
    hide.setAttribute("aria-label", ref.hidden ? "Show reference image" : "Hide reference image");
    hide.title = ref.hidden ? "Show" : "Hide";
    hide.addEventListener("click", () => editor.updateReference({ hidden: !ref.hidden }));
    const lock = document.createElement("button");
    lock.className = "icon-btn";
    lock.innerHTML = ref.locked ? ICON_LOCK : ICON_UNLOCK;
    lock.setAttribute("aria-label", ref.locked ? "Unlock reference image" : "Lock reference image");
    lock.title = ref.locked ? "Unlock" : "Lock";
    lock.addEventListener("click", () => editor.updateReference({ locked: !ref.locked }));
    li.append(pick, hide, lock);
    shapeList.append(li);
  }
  importBtn.hidden = !!ref;
  if (editor.draft && editor.shapes.length) {
    const li = document.createElement("li");
    li.className = "shape-row drafting";
    li.textContent = "New shape: drawing…";
    shapeList.append(li);
  }
}

function refreshPanel(): void {
  const sel = editor.selection;
  const shape: ShapeModel | undefined = editor.selectedShape();
  guidance.textContent = guidanceText();
  const anything = editor.shapes.length > 0 || editor.features.length > 0;
  generateBtn.disabled = !anything;
  generateBtn.textContent = generated ? "New variation" : "Generate";
  generateBtn.title = generated ? "Change the noise for a fresh version of the same design. Locked items keep theirs." : "";
  terrainBtn.disabled = !generated || !anything;
  for (const [tool, button] of Object.entries(toolButtons)) {
    button.classList.toggle("active", editor.tool === tool);
    button.setAttribute("aria-pressed", String(editor.tool === tool));
  }
  refreshFeaturePanel();
  clearBtn.disabled = !editor.shapes.length && !editor.draft?.length;
  exportBtn.disabled = !generated;
  newShapeBtn.disabled = editor.drawing;
  renderShapeList();

  shapePanel.hidden = !shape || sel?.kind !== "shape";
  if (shape && sel?.kind === "shape") {
    if (document.activeElement !== shapeName) shapeName.value = shape.name;
    shapeName.disabled = false;
    shapeFacts.textContent = `${shape.points.length} points${shape.hidden ? " · hidden" : ""}${shape.locked ? " · locked" : ""}`;
    kindLand.setAttribute("aria-pressed", String(shape.kind === "land"));
    kindWater.setAttribute("aria-pressed", String(shape.kind === "water"));
    kindLand.disabled = kindWater.disabled = shape.locked;
    kindHint.textContent =
      shape.kind === "land"
        ? "Adds land at this height. Drawn over other land, it steps up or down to it with an escarpment."
        : "Becomes a lake, sea or bay. Land drawn inside water becomes an island.";
    const water = shape.kind === "water";
    heightLabel.textContent = water ? "Water level" : "Height";
    autoLevelRow.hidden = !water;
    autoLevel.checked = shape.autoLevel;
    autoLevel.disabled = shape.locked;
    if (document.activeElement !== heightSlider) heightSlider.value = String(shape.height);
    heightSlider.disabled = shape.locked || (water && shape.autoLevel);
    heightValue.textContent = water && shape.autoLevel ? "Ground level" : `${shape.height.toLocaleString()} m`;
    heightHint.textContent = water
      ? "Land lower than the water it touches floods."
      : "Height above sea level. Land below the level of water it touches floods; below sea level but cut off from water, it stays a dry basin.";
    const at = editor.shapes.indexOf(shape);
    stackUp.disabled = at <= 0;
    stackDown.disabled = at < 0 || at >= editor.shapes.length - 1;
    shapeSliders.show(shape.base, undefined, shape.locked);
    shapeHelp.textContent = shape.locked
      ? "This shape is locked, so it can't be selected or changed on the map. Unlock it in the list above to edit it."
      : "Drag inside the box to move, a corner to resize (the coastline scales with it; Shift stretches freely), or the round handle to rotate (Shift snaps to 15°).";
    deleteShapeBtn.disabled = shape.locked;
  }

  const ref = editor.reference;
  referencePanel.hidden = !ref || !editor.referenceSelected;
  if (ref && editor.referenceSelected) {
    referenceName.textContent = ref.name;
    if (document.activeElement !== referenceOpacity) referenceOpacity.value = String(Math.round(ref.opacity * 100));
    referenceOpacityValue.textContent = `${Math.round(ref.opacity * 100)}%`;
    referenceHelp.textContent = ref.locked
      ? "Locked: it stays put, and clicks pass through it to the map. Unlock it in the list above to move it."
      : ref.hidden
        ? "Hidden. Show it again from the list above."
        : "Drag inside its box to move it, a corner to resize (Shift stretches), or the round handle to rotate. Lock it when it's in place.";
  }

  const seg = generated && sel?.kind === "segment" && shape ? sel.index : null;
  segmentPanel.hidden = seg === null;
  if (seg !== null && shape) {
    const count = selectedSegments(sel).length;
    segmentTitle.textContent = count > 1 ? `${count} segments selected` : `Segment ${seg + 1} of ${shape.points.length}`;
    segmentShape.textContent =
      count > 1
        ? `Part of ${shape.name}. Sliders show the last one you picked and move all ${count} by the same amount. Ctrl+Click (Cmd+Click on a Mac) a segment to add or remove it.`
        : `Part of ${shape.name}. Values here add to the shape's own. Ctrl+Click (Cmd+Click on a Mac) more segments to adjust them together; double-click the line to add a point.`;
    const adjust = shape.adjust[seg];
    segmentSliders.show(editor.segmentValues(shape, seg), adjust, shape.locked);
    resetSegmentBtn.disabled = shape.locked || !selectedSegments(sel).some((i) => isAdjusted(shape.adjust[i]));
    resetSegmentBtn.textContent = count > 1 ? "Reset these to shape values" : "Reset to shape values";
  }

  const point = sel?.kind === "point" && shape ? sel.index : null;
  pointPanel.hidden = point === null;
  if (point !== null && shape) {
    pointTitle.textContent = `Point ${point + 1} of ${shape.points.length}`;
    deletePointBtn.disabled = shape.points.length <= 3;
  }
}

resetSegmentBtn.addEventListener("click", () => {
  if (editor.selection?.kind === "segment") editor.resetSegments(selectedSegments(editor.selection));
});
deletePointBtn.addEventListener("click", () => {
  if (editor.selection?.kind === "point") editor.deletePoint(editor.selection.index);
});
newShapeBtn.addEventListener("click", () => {
  if (editor.tool !== "coast") editor.setTool("coast");
  editor.newShape();
});
kindLand.addEventListener("click", () => {
  const shape = editor.selectedShape();
  if (shape) editor.setKind(shape.id, "land");
});
heightSlider.addEventListener("input", () => {
  const shape = editor.selectedShape();
  if (shape) editor.setHeight(shape.id, Number(heightSlider.value));
});
autoLevel.addEventListener("change", () => {
  const shape = editor.selectedShape();
  if (shape) editor.setAutoLevel(shape.id, autoLevel.checked);
});
stackUp.addEventListener("click", () => {
  const shape = editor.selectedShape();
  if (shape) editor.restack(shape.id, -1);
});
stackDown.addEventListener("click", () => {
  const shape = editor.selectedShape();
  if (shape) editor.restack(shape.id, 1);
});
kindWater.addEventListener("click", () => {
  const shape = editor.selectedShape();
  if (shape) editor.setKind(shape.id, "water");
});
shapeName.addEventListener("change", () => {
  const shape = editor.selectedShape();
  if (shape) editor.rename(shape.id, shapeName.value);
});
shapeName.addEventListener("keydown", (e) => {
  if (e.key === "Enter") shapeName.blur();
});
confirmable(deleteShapeBtn, "Delete shape", "Click again to delete", () => {
  const shape = editor.selectedShape();
  if (shape) editor.deleteShape(shape.id);
});

generateBtn.addEventListener("click", () => {
  if (generated) {
    // Same design, new noise.
    editor.reseed();
    return;
  }
  generated = true;
  sendGuides();
  scheduleDetail();
  refreshPanel();
});

confirmable(clearBtn, "Clear all shapes", "Click again to clear", () => {
  generated = false;
  editor.clearAll();
  sendGuides();
  scheduleDetail();
  timing.textContent = "No updates yet";
  timing.classList.remove("slow");
  timingDetail.textContent = "";
  exportStatus.textContent = "";
  refreshPanel();
});

// --- export ------------------------------------------------------------------------

let exporting: AbortController | null = null;

const exportMode = () => (document.querySelector<HTMLInputElement>('input[name="export-mode"]:checked')?.value ?? "quick") as "quick" | "full" | "terrain" | "heightmap" | "project";

/** Pixels per km when the canvas is fully zoomed in. */
function fullZoomPxPerKm(): number {
  return ((mapRect().size / view.zoom) * MAX_ZOOM * (window.devicePixelRatio || 1)) / mapKm();
}

/** The area a terrain export covers (km). */
function terrainExportArea(): { x: number; y: number; w: number; h: number } {
  const km = mapKm();
  const v = terrainArea.value === "view" ? visibleArea() : null;
  return v ? { x: v.x, y: v.y, w: v.w, h: v.h } : { x: 0, y: 0, w: km, h: km };
}

/** Fill the size choices for a terrain or heightmap export. */
function fillTerrainSizes(): void {
  const heightmap = exportMode() === "heightmap";
  const area = terrainExportArea();
  const zoomed = Math.min(16384, Math.round(Math.max(area.w, area.h) * fullZoomPxPerKm()));
  const previous = terrainSize.value;
  // Unreal Engine landscapes import best at these sizes (a whole number of components).
  const sizes = heightmap ? [1009, 2017, 4033, 8129, 16321] : [2048, 4096, 8192, 16384];
  const options = sizes.map((px) => [String(px), `${px.toLocaleString()} px${heightmap ? " (Unreal size)" : ""}`]);
  if (!heightmap) options.push(["zoom", `Full zoom detail: ${zoomed.toLocaleString()} px`]);
  terrainSize.replaceChildren(
    ...options.map(([value, label]) => {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = label;
      return o;
    }),
  );
  terrainSize.value = options.some(([v]) => v === previous) ? previous : heightmap ? "4033" : "zoom";
}

function terrainExportSize(): number {
  const area = terrainExportArea();
  if (terrainSize.value === "zoom") return Math.max(64, Math.min(16384, Math.round(Math.max(area.w, area.h) * fullZoomPxPerKm())));
  return Number(terrainSize.value);
}

/** Heights written as black and white in a heightmap: the terrain's range, with room for the finest relief. */
function heightRange(): [number, number] {
  const [lo, hi] = terrainData?.range ?? [0, 3000];
  const low = Math.floor((lo - 50) / 10) * 10;
  const high = Math.ceil((hi + Math.max(100, 0.08 * (hi - lo))) / 10) * 10;
  return [low, high];
}

function describeExport(): void {
  const kmPerPx = (mapKm() / resolution).toFixed(1);
  quickHint.textContent = `The map as shown: ${resolution} × ${resolution} pixels (${kmPerPx} km per pixel). Instant.`;
  const mode = exportMode();
  fullOptions.hidden = mode !== "full";
  const terrainMode = mode === "terrain" || mode === "heightmap";
  terrainOptions.hidden = !terrainMode;
  for (const value of ["terrain", "heightmap"]) {
    const input = exportDialog.querySelector<HTMLInputElement>(`input[name="export-mode"][value="${value}"]`)!;
    input.disabled = !terrainData || !!exporting;
    input.closest(".choice")!.classList.toggle("unavailable", !terrainData);
  }
  $("terrain-export-hint").textContent = terrainData
    ? "The rendered terrain at the detail you see fully zoomed in: relief shaped by its drainage, true-width rivers and satellite texture down to the pixel."
    : "Render the terrain first (Render terrain… in the left panel); then it can be saved here at full detail.";
  const workers = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 2) - 1));
  const estimate = (pixels: number, perSecond: number) => {
    const seconds = pixels / (perSecond * workers);
    const time = seconds < 60 ? `about ${Math.max(5, Math.round(seconds / 5) * 5)} seconds` : `about ${Math.round(seconds / 60)} minute${seconds >= 90 ? "s" : ""}`;
    return `Takes ${time} here, using ${workers} background thread${workers > 1 ? "s" : ""}. You can keep working while it runs.`;
  };
  const size = Number(fullSize.value);
  // Roughly 0.8 million pixels per second per worker on a typical laptop for the map, 1 million for terrain.
  fullEstimate.textContent = estimate(size * size, 800_000);
  if (terrainMode) {
    if (!terrainSize.options.length || terrainSize.dataset.mode !== mode || terrainSize.dataset.area !== terrainArea.value) {
      fillTerrainSizes();
      terrainSize.dataset.mode = mode;
      terrainSize.dataset.area = terrainArea.value;
    }
    const area = terrainExportArea();
    const win = windowOver(area, terrainExportSize());
    const perPixel = (area.w / win.width) * 1000;
    const res = perPixel < 1000 ? `${Math.round(perPixel)} m` : `${(perPixel / 1000).toFixed(1)} km`;
    let text = `${win.width.toLocaleString()} × ${win.height.toLocaleString()} px, ${res} per pixel. ${estimate(win.width * win.height, 1_000_000)}`;
    if (mode === "heightmap") {
      const [lo, hi] = heightRange();
      // An Unreal landscape at Z scale 100 spans 512 m from black to white.
      text += ` Black is ${lo.toLocaleString()} m and white ${hi.toLocaleString()} m; in Unreal Engine set the landscape's Z scale to ${(((hi - lo) / 512) * 100).toFixed(1)} and X/Y scale to ${(perPixel * 100).toFixed(0)} to match.`;
    }
    terrainEstimate.textContent = text;
  }
}

function setExporting(active: boolean): void {
  exportDialog.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select").forEach((el) => (el.disabled = active));
  exportGo.disabled = active;
  exportProgress.hidden = !active;
  exportCancel.textContent = active ? "Cancel export" : "Cancel";
  // Terrain choices stay unavailable until there's a terrain render to save.
  if (!active) describeExport();
}

exportBtn.addEventListener("click", () => {
  terrainSize.dataset.mode = "";
  describeExport();
  setExporting(false);
  exportDialog.showModal();
});
exportDialog.addEventListener("change", describeExport);
exportCancel.addEventListener("click", () => {
  if (exporting) exporting.abort();
  else exportDialog.close();
});
exportDialog.addEventListener("cancel", (e) => {
  // Escape closes the dialog only when nothing is running.
  if (exporting) e.preventDefault();
});

exportGo.addEventListener("click", async () => {
  if (exportMode() === "project") {
    exportDialog.close();
    const blob = new Blob([JSON.stringify(await projectData(true))], { type: "application/json" });
    exportStatus.textContent = await saveBlob(blob, "world-map.wmap.json");
    return;
  }
  if (exportMode() === "quick") {
    exportDialog.close();
    exportStatus.textContent = "Preparing image…";
    exportStatus.textContent = await exportPng(baseCanvas, `world-map-${resolution}px.png`);
    return;
  }
  if (exportMode() === "terrain" || exportMode() === "heightmap") {
    const data = terrainData;
    if (!data) return;
    const heightmap = exportMode() === "heightmap";
    const win = windowOver(terrainExportArea(), terrainExportSize());
    const [low, high] = heightRange();
    exporting = new AbortController();
    setExporting(true);
    exportBar.value = 0;
    exportProgressText.textContent = "Starting…";
    try {
      const blob = await exportTerrainPng(
        win,
        data.structure,
        data.guides,
        data.style,
        heightmap ? { kind: "height", low, high } : { kind: "colour" },
        (done, total, remainingMs) => {
          exportBar.value = done / total;
          const left = remainingMs === null ? "" : remainingMs < 60_000 ? `, about ${Math.ceil(remainingMs / 1000)} s left` : `, about ${Math.ceil(remainingMs / 60_000)} min left`;
          exportProgressText.textContent = `${Math.round((done / total) * 100)}% rendered${left}`;
        },
        exporting.signal,
      );
      exportProgressText.textContent = "Saving…";
      const mb = (blob.size / 1024 / 1024).toFixed(blob.size > 100 * 1024 * 1024 ? 0 : 1);
      exportDialog.close();
      const name = heightmap ? `heightmap-${win.width}x${win.height}-16bit-${low}m-to-${high}m.png` : `terrain-${win.width}x${win.height}.png`;
      const status = await saveBlob(blob, name);
      exportStatus.textContent = `${status.replace(/\.$/, "")} (${mb} MB).`;
    } catch (err) {
      const cancelled = err instanceof DOMException && err.name === "AbortError";
      exportStatus.textContent = cancelled ? "Export cancelled." : `Export failed: ${err instanceof Error ? err.message : String(err)}`;
      exportDialog.close();
    } finally {
      exporting = null;
      setExporting(false);
    }
    return;
  }
  const size = Number(fullSize.value);
  exporting = new AbortController();
  setExporting(true);
  exportBar.value = 0;
  exportProgressText.textContent = "Starting…";
  try {
    const blob = await exportFullDetail(size, mapKm(), editor.guides(), (p) => {
      exportBar.value = p.done / p.total;
      const left = p.remainingMs === null ? "" : p.remainingMs < 60_000 ? `, about ${Math.ceil(p.remainingMs / 1000)} s left` : `, about ${Math.ceil(p.remainingMs / 60_000)} min left`;
      exportProgressText.textContent = `${Math.round((p.done / p.total) * 100)}% generated${left}`;
    }, exporting.signal);
    exportProgressText.textContent = "Saving…";
    const mb = (blob.size / 1024 / 1024).toFixed(blob.size > 100 * 1024 * 1024 ? 0 : 1);
    exportDialog.close();
    const status = await saveBlob(blob, `world-map-${size}px.png`);
    exportStatus.textContent = `${status.replace(/\.$/, "")} (${mb} MB).`;
  } catch (err) {
    const cancelled = err instanceof DOMException && err.name === "AbortError";
    exportStatus.textContent = cancelled ? "Export cancelled." : `Export failed: ${err instanceof Error ? err.message : String(err)}`;
    exportDialog.close();
  } finally {
    exporting = null;
    setExporting(false);
  }
});

function showSmoothing(): void {
  const px = Number(smoothingSlider.value);
  smoothingValue.textContent = px === 0 ? "Off" : `${px} px`;
}
smoothingSlider.addEventListener("input", () => {
  editor.smoothingPx = Number(smoothingSlider.value);
  showSmoothing();
  // Only recolours, so it's cheap enough to apply live, even before generating.
  sendGuides();
});
showSmoothing();

// --- reference image ---------------------------------------------------------------

function chooseImage(): void {
  importFile.value = "";
  importFile.click();
}
importBtn.addEventListener("click", chooseImage);
referenceReplace.addEventListener("click", chooseImage);
importFile.addEventListener("change", async () => {
  const file = importFile.files?.[0];
  if (!file) return;
  if (/\.(json|wmap)$/i.test(file.name) || file.type === "application/json") {
    try {
      await openProject(JSON.parse(await file.text()));
      exportStatus.textContent = `Opened ${file.name}.`;
    } catch (err) {
      exportStatus.textContent = `“${file.name}” isn't a project file this version can open (${err instanceof Error ? err.message : err}).`;
    }
    return;
  }
  const image = new Image();
  const url = URL.createObjectURL(file);
  image.onload = () => {
    // The picture stays on this computer: it's only ever drawn on screen.
    const old = editor.reference;
    editor.setReference(image, file.name);
    if (old) editor.updateReference({ opacity: old.opacity });
  };
  image.onerror = () => {
    URL.revokeObjectURL(url);
    exportStatus.textContent = `“${file.name}” couldn't be opened as an image.`;
  };
  image.src = url;
});
referenceOpacity.addEventListener("input", () => editor.updateReference({ opacity: Number(referenceOpacity.value) / 100 }));
confirmable(referenceRemove, "Remove", "Click again to remove", () => editor.removeReference());

// --- map size and grid -----------------------------------------------------------------

function describeMap(): void {
  const km = mapKm();
  for (const option of Array.from(resolutionSelect.options)) {
    const px = Number(option.value);
    option.textContent = `${px} × ${px} (${formatKm(km / px)} per pixel)`;
  }
  for (const option of Array.from(fullSize.options)) {
    const px = Number(option.value);
    option.textContent = `${px} × ${px} (${formatKm(km / px)} per pixel)`;
  }
  mapFacts.textContent = `The map is ${km.toLocaleString()} km across.`;
}

function formatKm(km: number): string {
  return km >= 1 ? `${km.toFixed(km >= 10 ? 0 : 1)} km` : `${Math.round(km * 1000)} m`;
}

function requestedWidth(): number | null {
  const km = Math.round(Number(mapWidthInput.value));
  return Number.isFinite(km) && km >= MIN_MAP_KM && km <= MAX_MAP_KM ? km : null;
}

mapWidthInput.addEventListener("input", () => {
  const km = requestedWidth();
  mapWidthApply.hidden = km === null || km === mapKm();
  mapWidthChoice.hidden = true;
});
mapWidthInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !mapWidthApply.hidden) mapWidthApply.click();
});
mapWidthApply.addEventListener("click", () => {
  if (requestedWidth() === null) return;
  if (editor.shapes.length || editor.draft?.length || editor.reference) {
    mapWidthChoice.hidden = false;
  } else {
    applyMapWidth(false);
  }
});
widthKeep.addEventListener("click", () => applyMapWidth(false));
widthScale.addEventListener("click", () => applyMapWidth(true));

function applyMapWidth(scaleContent: boolean): void {
  const km = requestedWidth();
  if (km === null) return;
  editor.setMapWidth(km, scaleContent);
  mapWidthInput.value = String(km);
  mapWidthApply.hidden = true;
  mapWidthChoice.hidden = true;
  startBase();
  setView(1, 0, 0);
  describeMap();
}

gridSelect.addEventListener("change", () => {
  editor.gridKm = Number(gridSelect.value);
  editor.draw();
});
showGrid.addEventListener("change", () => {
  editor.showGrid = showGrid.checked;
  editor.draw();
});

resolutionSelect.addEventListener("change", () => {
  resolution = Number(resolutionSelect.value);
  startBase();
});

editor.onEdit = (kind: EditKind) => {
  if (kind === "selection") dragStart = null;
  if (kind === "shape" && generated) sendGuides();
  else if (kind !== "selection") scheduleAutosave();
  refreshPanel();
};

// --- tools, mountains and rivers ---------------------------------------------------

for (const [tool, button] of Object.entries(toolButtons)) {
  button.addEventListener("click", () => editor.setTool(tool as ToolName));
}

function refreshFeaturePanel(): void {
  const f = editor.feature(editor.featureSelected);
  featurePanel.hidden = !f;
  if (!f) return;
  const mountain = f.kind === "mountain";
  const single = f.points.length === 1;
  const region = f.kind === "biome";
  if (document.activeElement !== featureName) featureName.value = f.name;
  biomeFields.hidden = !region;
  fWidth.closest(".field")!.toggleAttribute("hidden", region);
  fResetBends.hidden = region;
  if (region) {
    featureTitle.textContent = "Biome region";
    $("f-height-field").hidden = true;
    $("f-rugged-field").hidden = true;
    $("f-depth-field").hidden = true;
    $("f-curve-field").hidden = false;
    $("f-curve-value").textContent = `${Math.round(f.curviness * 100)}%`;
    if (document.activeElement !== fCurve) fCurve.value = String(Math.round(f.curviness * 100));
    fCurve.disabled = f.locked;
    const preset = biome(f.biome ?? "");
    bPreset.value = preset.key;
    $("b-note").textContent = preset.note;
    const temp = f.temp === undefined ? preset.temp : f.temp;
    for (const [input, value] of [[bRain, f.rainfall ?? preset.rainfall], [bHumid, Math.round((f.humidity ?? preset.humidity) * 100)], [bForest, Math.round((f.forest ?? preset.forest) * 100)], [bTemp, temp ?? 12], [bFeather, f.feather ?? 40]] as const) {
      if (document.activeElement !== input) input.value = String(value);
      input.disabled = f.locked;
    }
    bTemp.disabled = f.locked || temp === null;
    bTempAuto.checked = temp === null;
    bTempAuto.disabled = bPreset.disabled = f.locked;
    $("b-rain-value").textContent = `${Number(bRain.value).toLocaleString()} mm a year`;
    $("b-humid-value").textContent = `${bHumid.value}%`;
    $("b-forest-value").textContent = `${bForest.value}%`;
    $("b-temp-value").textContent = temp === null ? "from latitude" : `${temp} °C`;
    $("b-feather-value").textContent = `${bFeather.value} km`;
    bRegen.disabled = !generated || !!hqAbort;
    bRegen.textContent = terrainShown ? "Regenerate terrain" : "Render terrain with this";
    featureHelp.textContent = f.locked
      ? "Locked. Unlock it in the list above to change it."
      : "Drag its corners to reshape it. It changes the terrain render only, not the live map. Smaller regions drawn inside larger ones take over there.";
    deleteFeatureBtn.disabled = f.locked;
    return;
  }
  featureTitle.textContent = mountain ? (single ? "Mountain peak" : "Mountain range") : single ? "Pool" : "River";
  $("f-height-field").hidden = !mountain;
  $("f-rugged-field").hidden = !mountain;
  $("f-depth-field").hidden = mountain;
  $("f-width-label").textContent = mountain ? "Width of the slopes" : single ? "Diameter" : "Width";
  $("f-width-hint").textContent = mountain ? "How far the slopes spread to either side of the crest." : "On a map this size, rivers narrower than a pixel are drawn one pixel wide.";
  fWidth.max = mountain ? "200" : "60";
  $("f-curve-field").hidden = single;
  $("f-curve-value").textContent = `${Math.round(f.curviness * 100)}%`;
  fResetBends.disabled = f.locked || f.bends.every((b) => !b);
  for (const [input, value] of [[fHeight, f.height], [fWidth, f.width], [fRugged, Math.round(f.rugged * 100)], [fDepth, f.depth], [fCurve, Math.round(f.curviness * 100)]] as const) {
    if (document.activeElement !== input) input.value = String(value);
    input.disabled = f.locked;
  }
  $("f-height-value").textContent = `${f.height.toLocaleString()} m`;
  $("f-width-value").textContent = `${f.width} km`;
  $("f-rugged-value").textContent = `${Math.round(f.rugged * 100)}%`;
  $("f-depth-value").textContent = `${f.depth} m`;
  featureHelp.textContent = f.locked
    ? "Locked. Unlock it in the list above to change it."
    : mountain
      ? "Drag its points on the map to reshape it. A mountain drawn in the sea becomes an island."
      : "Drag its points to reroute it. It always runs downhill from its first point, cutting through any rise in its way.";
  deleteFeatureBtn.disabled = f.locked;
}

const editFeature = (change: Parameters<CoastEditor["updateFeature"]>[1]) => {
  if (editor.featureSelected !== null) editor.updateFeature(editor.featureSelected, change);
};
fHeight.addEventListener("input", () => editFeature({ height: Number(fHeight.value) }));
fWidth.addEventListener("input", () => editFeature({ width: Number(fWidth.value) }));
fRugged.addEventListener("input", () => editFeature({ rugged: Number(fRugged.value) / 100 }));
fDepth.addEventListener("input", () => editFeature({ depth: Number(fDepth.value) }));
fCurve.addEventListener("input", () => editFeature({ curviness: Number(fCurve.value) / 100 }));
bPreset.replaceChildren(
  ...BIOMES.map((b) => {
    const o = document.createElement("option");
    o.value = b.key;
    o.textContent = b.name;
    return o;
  }),
);
bPreset.addEventListener("change", () => {
  if (editor.featureSelected !== null) editor.applyBiomePreset(editor.featureSelected, bPreset.value);
});
bRain.addEventListener("input", () => editFeature({ rainfall: Number(bRain.value) }));
bHumid.addEventListener("input", () => editFeature({ humidity: Number(bHumid.value) / 100 }));
bForest.addEventListener("input", () => editFeature({ forest: Number(bForest.value) / 100 }));
bTemp.addEventListener("input", () => editFeature({ temp: Number(bTemp.value) }));
bTempAuto.addEventListener("change", () => {
  const f = editor.feature(editor.featureSelected);
  editFeature({ temp: bTempAuto.checked ? null : (biome(f?.biome ?? "").temp ?? 12) });
});
bFeather.addEventListener("input", () => editFeature({ feather: Number(bFeather.value) }));
bRegen.addEventListener("click", () => {
  if (generated && !hqAbort) renderTerrain();
});
showPlanned.addEventListener("change", () => {
  editor.showPlanned = showPlanned.checked;
  editor.draw();
});
keepPlanned.addEventListener("click", () => {
  const n = editor.adoptPlanned(20);
  plannedBox.hidden = true;
  exportStatus.textContent = `Added ${n.rivers} rivers, ${n.hills} lines of hills and ${n.lakes} lake${n.lakes === 1 ? "" : "s"} as guides. Edit them like your own, then render the terrain again.`;
});
fResetBends.addEventListener("click", () => {
  const f = editor.feature(editor.featureSelected);
  if (f) editFeature({ bends: f.bends.map(() => 0) });
});
featureName.addEventListener("change", () => editFeature({ name: featureName.value.trim() || "Unnamed" }));
confirmable(deleteFeatureBtn, "Delete", "Click again to delete", () => {
  if (editor.featureSelected !== null) editor.deleteFeature(editor.featureSelected);
});

// --- terrain render ----------------------------------------------------------------

function climateSettings(): ClimateSettings {
  const read = (input: HTMLInputElement, fallback: number, min: number, max: number) => {
    const v = Number(input.value);
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  };
  return {
    rainfall: read(rainfallInput, 800, 50, 4000),
    evaporation: read(evaporationInput, 900, 0, 4000),
    latitude: read(latitudeInput, 35, -85, 85),
    rounds: 10,
    style: Number(lookSelect.value) || 0,
  };
}

function remembered(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable or full; the app works without it.
  }
}

/** The guides the terrain render in progress was made from. */
let pendingGuides: Guides | null = null;
let hqAbort: AbortController | null = null;

function renderTerrain(): void {
  terrainBtn.disabled = true;
  saveTerrainBtn.hidden = true;
  terrainLayer = null;
  pendingGuides = structuredClone(editor.guides());
  exportStatus.textContent = "Rendering terrain…";
  base.renderTerrain(climateSettings());
}

/** Stage B: render the chosen window in fine detail, strip by strip. */
async function renderDetail(structure: ArrayBuffer, guides: Guides): Promise<void> {
  const [mode, sizeText] = detailSelect.value.split("-");
  const size = Number(sizeText);
  const km = mapKm();
  let area = { x: 0, y: 0, w: km, h: km };
  if (mode === "view") {
    // Just what's on screen, clipped to the map.
    const r = mapRect();
    const k = km / r.size;
    const x0 = Math.max(0, -r.left * k);
    const y0 = Math.max(0, -r.top * k);
    const x1 = Math.min(km, (stage.clientWidth - r.left) * k);
    const y1 = Math.min(km, (stage.clientHeight - r.top) * k);
    if (x1 - x0 < 1 || y1 - y0 < 1) return;
    area = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  const win = windowOver(area, size);
  const canvas = document.createElement("canvas");
  canvas.width = win.width;
  canvas.height = win.height;
  const ctx = canvas.getContext("2d")!;
  terrainLayer = { canvas, x: win.x, y: win.y, w: win.widthKm, h: win.heightKm, initVersion: 0, ready: false };
  hqAbort = new AbortController();
  const abort = hqAbort;
  const started = performance.now();
  terrainBtn.disabled = false;
  terrainBtn.textContent = "Cancel detail render";
  const perPixel = (win.widthKm / win.width) * 1000;
  const label = `${win.width} × ${win.height} px, ${perPixel < 1000 ? `${Math.round(perPixel)} m` : `${(perPixel / 1000).toFixed(1)} km`} per pixel`;
  let repaint = 0;
  try {
    await renderTerrainWindow(
      win,
      structure,
      guides,
      climateSettings().style,
      (strip, done, total) => {
        ctx.putImageData(new ImageData(strip.pixels, win.width, strip.rows), 0, strip.row);
        if (!repaint) repaint = requestAnimationFrame(() => ((repaint = 0), render()));
        const left = ((performance.now() - started) / done) * (total - done);
        exportStatus.textContent = `Adding detail (${label}): ${Math.round((done / total) * 100)}%${done >= 2 ? `, about ${Math.ceil(left / 1000)} s left` : ""}`;
      },
      abort.signal,
    );
    exportStatus.textContent = `Terrain rendered in detail (${label}) in ${((performance.now() - started) / 1000).toFixed(1)} s. Zoom in to explore it, or save the image. Any change returns to the live map.`;
    if (terrainLayer) terrainLayer.ready = true;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      exportStatus.textContent = "Detail render cancelled; showing the quick terrain render.";
    } else {
      exportStatus.textContent = `The detail render failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (terrainLayer?.canvas === canvas) terrainLayer = null;
  } finally {
    if (hqAbort === abort) hqAbort = null;
    terrainBtn.textContent = "Render terrain…";
    render();
    scheduleDetail();
  }
}

saveTerrainBtn.addEventListener("click", async () => {
  // Save the finest picture on screen: the detail render if there is one.
  const canvas = terrainLayer?.ready ? terrainLayer.canvas : baseCanvas;
  saveTerrainBtn.disabled = true;
  exportStatus.textContent = "Preparing image…";
  exportStatus.textContent = await exportPng(canvas, `terrain-${canvas.width}x${canvas.height}.png`);
  saveTerrainBtn.disabled = false;
});
terrainBtn.addEventListener("click", () => {
  if (hqAbort) {
    hqAbort.abort();
    return;
  }
  if (remembered("wmg-terrain-notice") === "hide") renderTerrain();
  else terrainDialog.showModal();
});
$("terrain-cancel").addEventListener("click", () => terrainDialog.close());
$("terrain-go").addEventListener("click", () => {
  if (terrainSkip.checked) remember("wmg-terrain-notice", "hide");
  terrainDialog.close();
  renderTerrain();
});

// --- project files and autosave -----------------------------------------------------

const PROJECT_VERSION = 1;

interface SavedReference extends Omit<ReferenceImage, "image"> {
  dataUrl: string;
}

async function projectData(withImage: boolean) {
  let reference: SavedReference | null = null;
  const ref = editor.reference;
  if (ref && withImage) {
    // Store the picture inside the file, so the project is self-contained.
    const c = document.createElement("canvas");
    c.width = ref.image.naturalWidth;
    c.height = ref.image.naturalHeight;
    c.getContext("2d")!.drawImage(ref.image, 0, 0);
    const { image: _image, ...rest } = ref;
    reference = { ...rest, dataUrl: c.toDataURL("image/png") };
  }
  return {
    app: "world-map-generator",
    version: PROJECT_VERSION,
    map: editor.serialize(),
    settings: {
      generated,
      resolution,
      gridKm: editor.gridKm,
      showGrid: editor.showGrid,
      smoothingPx: editor.smoothingPx,
      climate: climateSettings(),
      terrainDetail: detailSelect.value,
    },
    reference,
  };
}

async function openProject(data: Awaited<ReturnType<typeof projectData>>): Promise<void> {
  if (data?.app !== "world-map-generator" || !data.map) throw new Error("not a World Map Generator project");
  if (data.version > PROJECT_VERSION) throw new Error("it was saved by a newer version");
  const s = data.settings;
  generated = s.generated;
  resolution = [512, 1024, 2048].includes(s.resolution) ? s.resolution : 1024;
  resolutionSelect.value = String(resolution);
  editor.gridKm = s.gridKm;
  editor.showGrid = s.showGrid;
  editor.smoothingPx = s.smoothingPx;
  gridSelect.value = String(s.gridKm);
  showGrid.checked = s.showGrid;
  smoothingSlider.value = String(s.smoothingPx);
  showSmoothing();
  rainfallInput.value = String(s.climate.rainfall);
  evaporationInput.value = String(s.climate.evaporation);
  latitudeInput.value = String(s.climate.latitude);
  lookSelect.value = String(s.climate.style ?? 0);
  detailSelect.value = (s as { terrainDetail?: string }).terrainDetail ?? "quick";
  editor.reference = null;
  editor.restore(data.map);
  mapWidthInput.value = String(mapKm());
  if (data.reference) {
    const { dataUrl, ...rest } = data.reference;
    const image = new Image();
    await new Promise<void>((resolve) => {
      image.onload = image.onerror = () => resolve();
      image.src = dataUrl;
    });
    editor.reference = { ...rest, image };
  }
  startBase();
  setView(1, 0, 0);
  describeMap();
  refreshPanel();
}

// Autosave keeps the map (without the reference picture, which can be large)
// in this browser, so closing the tab doesn't lose work.
let autosaveTimer = 0;
function scheduleAutosave(): void {
  clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(async () => remember("wmg-autosave", JSON.stringify(await projectData(false))), 800);
}

async function restoreAutosave(): Promise<void> {
  const saved = remembered("wmg-autosave");
  if (!saved) return;
  try {
    const data = JSON.parse(saved);
    if (data.map?.shapes?.length || data.map?.features?.length) {
      await openProject(data);
      exportStatus.textContent = "Restored your last map from this browser.";
    }
  } catch {
    // A damaged autosave is ignored rather than blocking the app.
  }
}

// --- start -----------------------------------------------------------------------

new ResizeObserver(() => setView(view.zoom, view.cx, view.cy)).observe(stage);

if (typeof WebAssembly === "undefined") {
  problem.hidden = false;
  problem.textContent = "This browser can't run WebAssembly, which the terrain engine needs. Try a current version of Chrome, Edge, Firefox or Safari.";
} else {
  startBase();
}
setView(1, 0, 0);
describeMap();
refreshPanel();
void restoreAutosave();
