// Wires the editor, the view (zoom and pan), the inspector panel and the
// generation core together.
//
// Two cores run side by side, each in its own background thread:
//   - the base core generates the whole map at the working resolution;
//   - the detail core generates only the visible area, at screen resolution,
//     whenever the view is zoomed in. Until it's ready, the base map is shown
//     enlarged, so zooming always responds instantly.

import { CoastEditor, selectedSegments, type EditKind, type ShapeKindName, type ShapeModel } from "./editor";
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
const kindHighland = $<HTMLButtonElement>("kind-highland");
const kindHint = $<HTMLParagraphElement>("kind-hint");
const heightField = $<HTMLDivElement>("height-field");
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
  const labels = {} as Record<SliderKey, HTMLLabelElement>;
  const hints = {} as Record<SliderKey, HTMLParagraphElement>;
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
    labels[spec.key] = field.querySelector("label")!;
    hints[spec.key] = field.querySelector(".hint")!;
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
    /** A highland's edge is an escarpment, so its slope slider says so. */
    labelFor(kind: ShapeKindName) {
      const highland = kind === "highland";
      labels.shore.textContent = highland ? "Edge slope" : "Shore slope";
      hints.shore.textContent = highland
        ? "How far the escarpment takes to rise. Short makes a cliff, long a gentle ramp."
        : SLIDERS.find((x) => x.key === "shore")!.hint;
    },
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
  if (generated) base.setGuides(editor.guides());
}

base.onFrame = (frame) => {
  if (frame.initVersion !== baseInit) return; // From before a resolution change.
  paint(baseCanvas, frame);
  render();
  if (frame.kind === "guides" && !detailShown) showTiming(frame, "Whole map");
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

function guidanceText(): string {
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
      const kindLabel = shape.kind === "water" ? "Water" : shape.kind === "highland" ? `Highland · ${shape.height > 0 ? "+" : ""}${shape.height} m` : "Land";
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
  generateBtn.disabled = !editor.shapes.length || generated;
  generateBtn.textContent = generated ? "Landmass generated" : "Generate landmass";
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
    kindHighland.setAttribute("aria-pressed", String(shape.kind === "highland"));
    kindLand.disabled = kindWater.disabled = kindHighland.disabled = shape.locked;
    kindHint.textContent = {
      land: "Adds land. Overlapping land shapes join into one landmass.",
      water: "Becomes a lake, sea or bay. A lake on high ground stays at that height. Land drawn inside water becomes an island.",
      highland: "Raises the land inside it, with an escarpment at the edge. Draw it over land; it never raises the sea.",
    }[shape.kind];
    heightField.hidden = shape.kind !== "highland";
    if (document.activeElement !== heightSlider) heightSlider.value = String(shape.height);
    heightSlider.disabled = shape.locked;
    heightValue.textContent = `${shape.height > 0 ? "+" : ""}${shape.height.toLocaleString()} m`;
    shapeSliders.labelFor(shape.kind);
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
    segmentSliders.labelFor(shape.kind);
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
newShapeBtn.addEventListener("click", () => editor.newShape());
kindLand.addEventListener("click", () => {
  const shape = editor.selectedShape();
  if (shape) editor.setKind(shape.id, "land");
});
kindHighland.addEventListener("click", () => {
  const shape = editor.selectedShape();
  if (shape) editor.setKind(shape.id, "highland");
});
heightSlider.addEventListener("input", () => {
  const shape = editor.selectedShape();
  if (shape) editor.setHeight(shape.id, Number(heightSlider.value));
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
  generated = true;
  base.setGuides(editor.guides());
  scheduleDetail();
  refreshPanel();
});

confirmable(clearBtn, "Clear all shapes", "Click again to clear", () => {
  generated = false;
  editor.clearAll();
  base.setGuides(editor.guides());
  scheduleDetail();
  timing.textContent = "No updates yet";
  timing.classList.remove("slow");
  timingDetail.textContent = "";
  exportStatus.textContent = "";
  refreshPanel();
});

// --- export ------------------------------------------------------------------------

let exporting: AbortController | null = null;

const exportMode = () => (document.querySelector<HTMLInputElement>('input[name="export-mode"]:checked')?.value ?? "quick") as "quick" | "full";

function describeExport(): void {
  const kmPerPx = (mapKm() / resolution).toFixed(1);
  quickHint.textContent = `The map as shown: ${resolution} × ${resolution} pixels (${kmPerPx} km per pixel). Instant.`;
  fullOptions.hidden = exportMode() !== "full";
  const size = Number(fullSize.value);
  const workers = Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 2) - 1));
  // Roughly 0.8 million pixels per second per worker on a typical laptop.
  const seconds = (size * size) / (800_000 * workers);
  const time = seconds < 60 ? `about ${Math.max(5, Math.round(seconds / 5) * 5)} seconds` : `about ${Math.round(seconds / 60)} minute${seconds >= 90 ? "s" : ""}`;
  fullEstimate.textContent = `Takes ${time} here, using ${workers} background thread${workers > 1 ? "s" : ""}. You can keep working while it runs.`;
}

function setExporting(active: boolean): void {
  exportDialog.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select").forEach((el) => (el.disabled = active));
  exportGo.disabled = active;
  exportProgress.hidden = !active;
  exportCancel.textContent = active ? "Cancel export" : "Cancel";
}

exportBtn.addEventListener("click", () => {
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
  if (exportMode() === "quick") {
    exportDialog.close();
    exportStatus.textContent = "Preparing image…";
    exportStatus.textContent = await exportPng(baseCanvas, `world-map-${resolution}px.png`);
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
  const guides = editor.guides();
  base.setGuides(generated ? guides : { ...guides, shapes: [] });
  if (detailActive()) detail.setGuides(guides);
});
showSmoothing();

// --- reference image ---------------------------------------------------------------

function chooseImage(): void {
  importFile.value = "";
  importFile.click();
}
importBtn.addEventListener("click", chooseImage);
referenceReplace.addEventListener("click", chooseImage);
importFile.addEventListener("change", () => {
  const file = importFile.files?.[0];
  if (!file) return;
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
  if (kind === "shape" && generated) {
    const guides = editor.guides();
    base.setGuides(guides);
    if (detailActive()) detail.setGuides(guides);
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
describeMap();
refreshPanel();
