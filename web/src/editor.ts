// The coastline pen and shape editing: drawing new shapes point by point,
// selecting shapes, segments and points, dragging points, inserting and
// deleting them, moving, resizing and rotating whole shapes, and drawing the
// guide overlay. Pan and zoom gestures are passed to the app.

import { DEFAULT_VALUES, NO_ADJUSTMENT, effective, toParams, type SliderValues } from "./params";
import type { Guides, Vec2 } from "./protocol";

export interface ShapeFrame {
  x: number;
  y: number;
  angle: number;
  /** 1 when drawn; resizing multiplies it, so the coastline detail scales too. */
  scale: number;
}

export type ShapeKindName = "land" | "water" | "highland";

const KIND_NAMES: Record<ShapeKindName, string> = { land: "Landmass", water: "Lake", highland: "Highland" };
export const DEFAULT_HIGHLAND_M = 800;

export interface ShapeModel {
  id: number;
  name: string;
  kind: ShapeKindName;
  /** For highlands: metres above (or, if negative, below) the land around. */
  height: number;
  points: Vec2[];
  /** Coastline slider values for the whole shape. */
  base: SliderValues;
  /** Each segment's own adjustment on top of `base`. adjust[i] belongs to the segment from points[i] to points[i + 1]. */
  adjust: SliderValues[];
  seed: number;
  /** Anchors the coastline detail, so it travels with the shape. */
  frame: ShapeFrame;
  hidden: boolean;
  locked: boolean;
}

/** A picture shown over the map to trace from. Never part of the terrain or exports. */
export interface ReferenceImage {
  image: HTMLImageElement;
  name: string;
  /** Centre (km), size (km) and rotation (radians). */
  x: number;
  y: number;
  w: number;
  h: number;
  angle: number;
  opacity: number;
  hidden: boolean;
  locked: boolean;
}

type ImageBox = Pick<ReferenceImage, "x" | "y" | "w" | "h" | "angle">;

export type Selection =
  | { kind: "shape"; shape: number }
  /** One or more segments of one shape; `index` is the most recently clicked. */
  | { kind: "segment"; shape: number; index: number; indices?: number[] }
  | { kind: "point"; shape: number; index: number }
  | null;

/** What changed: terrain ("shape"), only the selection, or only the shape list. */
export type EditKind = "shape" | "selection" | "list";

/** Every segment in a selection, in the order they were added. */
export function selectedSegments(sel: Selection): number[] {
  if (sel?.kind !== "segment") return [];
  return sel.indices?.length ? sel.indices : [sel.index];
}

type Corner = 0 | 1 | 2 | 3; // top-left, top-right, bottom-right, bottom-left

type Drag =
  | { kind: "point"; shape: number; index: number }
  | { kind: "image"; mode: "move" | "rotate" | { corner: Corner }; start: Vec2; from: ImageBox; moved: boolean }
  | { kind: "pan"; x: number; y: number; moved: boolean; onClick: "deselect" | "undo-point" | "none" }
  | {
      kind: "transform";
      mode: "move" | "rotate" | { corner: Corner };
      shape: number;
      start: Vec2;
      points: Vec2[];
      frame: ShapeFrame;
      box: Box;
      moved: boolean;
    };

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const POINT_HIT_PX = 10;
const SEGMENT_HIT_PX = 8;
const HANDLE_HIT_PX = 9;
const ROTATE_OFFSET_PX = 26;
const DRAG_THRESHOLD_PX = 4;

const GUIDE = "#ffffff";
const WATER_GUIDE = "#8fdcff";
const HIGHLAND_GUIDE = "#ffc978";
const HIGHLIGHT = "#f2b01e";
const HALO = "rgba(10, 20, 28, 0.45)";

export function newSeed(): number {
  // The core reads seeds as 32-bit floats, so keep them exactly representable.
  return Math.floor(Math.random() * 0xffffff);
}

function boundingBox(points: Vec2[]): Box {
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const p of points) {
    box.x0 = Math.min(box.x0, p.x);
    box.y0 = Math.min(box.y0, p.y);
    box.x1 = Math.max(box.x1, p.x);
    box.y1 = Math.max(box.y1, p.y);
  }
  return box;
}

function insidePolygon(p: Vec2, pts: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function boxCorners(b: Box): Vec2[] {
  return [
    { x: b.x0, y: b.y0 },
    { x: b.x1, y: b.y0 },
    { x: b.x1, y: b.y1 },
    { x: b.x0, y: b.y1 },
  ];
}

export class CoastEditor {
  shapes: ShapeModel[] = [];
  /** Points of the shape being drawn, or null when not drawing. */
  draft: Vec2[] | null = [];
  selection: Selection = null;
  /** The reference image, if one has been imported, and whether it is selected. */
  reference: ReferenceImage | null = null;
  referenceSelected = false;
  /** Grid spacing in km, or 0 to choose automatically from the zoom. */
  gridKm = 0;
  showGrid = true;
  readonly worldSeed = newSeed();
  onEdit: (kind: EditKind) => void = () => {};
  /** Drag to pan, in CSS pixels. */
  onPan: (dx: number, dy: number) => void = () => {};
  /** Zoom by `factor`, keeping the point under (x, y) in place (CSS pixels on the overlay). */
  onZoom: (factor: number, x: number, y: number) => void = () => {};

  private nextId = 1;
  private nextNumber = 1;
  private extentKm: number;
  private view = { left: 0, top: 0, size: 1 };
  private cursor: Vec2 | null = null;
  private hover: Selection = null;
  private drag: Drag | null = null;
  private spaceHeld = false;
  private shiftHeld = false;
  private ctx: CanvasRenderingContext2D;

  constructor(private overlay: HTMLCanvasElement, extentKm: number) {
    this.extentKm = extentKm;
    this.ctx = overlay.getContext("2d")!;
    overlay.addEventListener("pointerdown", (e) => this.pointerDown(e));
    overlay.addEventListener("pointermove", (e) => this.pointerMove(e));
    overlay.addEventListener("pointerup", (e) => this.pointerUp(e));
    overlay.addEventListener("pointercancel", (e) => this.pointerUp(e));
    overlay.addEventListener("pointerleave", () => {
      this.cursor = null;
      this.hover = null;
      this.draw();
    });
    overlay.addEventListener("dblclick", (e) => this.doubleClick(e));
    overlay.addEventListener("contextmenu", (e) => e.preventDefault());
    overlay.addEventListener("wheel", (e) => this.wheel(e), { passive: false });
    window.addEventListener("keydown", (e) => this.key(e));
    window.addEventListener("keyup", (e) => {
      if (e.key === " ") this.spaceHeld = false;
      if (e.key === "Shift") this.shiftHeld = false;
      this.overlay.style.cursor = this.cursorStyle();
    });
  }

  // --- the model, as seen by the app -----------------------------------------------

  get drawing(): boolean {
    return this.draft !== null;
  }

  shape(id: number): ShapeModel | undefined {
    return this.shapes.find((s) => s.id === id);
  }

  selectedShape(): ShapeModel | undefined {
    return this.selection ? this.shape(this.selection.shape) : undefined;
  }

  /** Edge smoothing (pixels), set by the app and passed through to the core. */
  smoothingPx = 1;

  /**
   * What the terrain engine needs: every visible shape, outermost first.
   * Shapes apply in order (land adds, water cuts out), so nesting decides the
   * result: a lake inside a continent comes after it and cuts into it, and an
   * island inside that lake comes after the lake and adds land back.
   */
  guides(): Guides {
    const visible = this.shapes.filter((s) => !s.hidden);
    const area = (s: ShapeModel) => {
      const b = boundingBox(s.points);
      return (b.x1 - b.x0) * (b.y1 - b.y0);
    };
    const depth = new Map<number, number>();
    for (const s of visible) {
      const b = boundingBox(s.points);
      const centre = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
      const inside = insidePolygon(centre, s.points) ? centre : s.points[0];
      depth.set(s.id, visible.filter((t) => t !== s && area(t) > area(s) && insidePolygon(inside, t.points)).length);
    }
    const ordered = visible
      .map((s, i) => ({ s, i }))
      .sort((a, b) => depth.get(a.s.id)! - depth.get(b.s.id)! || a.i - b.i)
      .map(({ s }) => s);
    return {
      worldSeed: this.worldSeed,
      smoothingPx: this.smoothingPx,
      shapes: ordered.map((s) => ({
        id: s.id,
        seed: s.seed,
        frame: s.frame,
        kind: s.kind,
        height: s.kind === "highland" ? s.height : 0,
        points: s.points,
        params: s.adjust.map((a) => toParams(effective(s.base, a))),
      })),
    };
  }

  // --- commands from the panel ------------------------------------------------------

  /** Start drawing a new shape. */
  newShape(): void {
    this.draft = [];
    this.selection = null;
    this.onEdit("selection");
    this.draw();
  }

  /** Stop drawing without keeping the unfinished shape. */
  cancelDraft(): void {
    if (!this.draft) return;
    this.draft = this.shapes.length ? null : [];
    this.onEdit("selection");
    this.draw();
  }

  select(selection: Selection): void {
    if (this.draft && this.shapes.length) this.draft = null;
    this.selection = selection;
    this.referenceSelected = false;
    this.onEdit("selection");
    this.draw();
  }

  // --- the reference image ---

  /** Show an image to trace from, fitted to the map and selected. */
  setReference(image: HTMLImageElement, name: string): void {
    const aspect = image.naturalHeight / (image.naturalWidth || 1);
    const w = aspect > 1 ? this.extentKm / aspect : this.extentKm;
    this.reference = { image, name, x: this.extentKm / 2, y: this.extentKm / 2, w, h: w * aspect, angle: 0, opacity: 0.6, hidden: false, locked: false };
    this.selectReference();
  }

  selectReference(): void {
    if (!this.reference) return;
    if (this.draft && this.shapes.length) this.draft = null;
    this.selection = null;
    this.referenceSelected = true;
    this.onEdit("selection");
    this.draw();
  }

  updateReference(change: Partial<Pick<ReferenceImage, "opacity" | "hidden" | "locked">>): void {
    if (!this.reference) return;
    Object.assign(this.reference, change);
    this.onEdit("list");
    this.onEdit("selection");
    this.draw();
  }

  removeReference(): void {
    this.reference = null;
    this.referenceSelected = false;
    this.onEdit("list");
    this.onEdit("selection");
    this.draw();
  }

  // --- map size ---

  get mapWidthKm(): number {
    return this.extentKm;
  }

  /**
   * Change the real width of the map. With `scaleContent`, every shape (and
   * the reference image) scales with the map, staying where it is on the
   * canvas; coastlines scale exactly with their shapes. Otherwise everything
   * keeps its real size and position from the map's top-left corner.
   */
  setMapWidth(km: number, scaleContent: boolean): void {
    const r = km / this.extentKm;
    this.extentKm = km;
    if (scaleContent && r !== 1) {
      for (const s of this.shapes) {
        s.points = s.points.map((p) => ({ x: p.x * r, y: p.y * r }));
        s.frame = { ...s.frame, x: s.frame.x * r, y: s.frame.y * r, scale: s.frame.scale * r };
      }
      if (this.draft) this.draft = this.draft.map((p) => ({ x: p.x * r, y: p.y * r }));
      if (this.reference) {
        const ref = this.reference;
        Object.assign(ref, { x: ref.x * r, y: ref.y * r, w: ref.w * r, h: ref.h * r });
      }
    }
    this.onEdit("shape");
    this.draw();
  }

  rename(id: number, name: string): void {
    const s = this.shape(id);
    if (!s) return;
    s.name = name.trim() || s.name;
    this.onEdit("list");
  }

  /** Make a shape land, water or highland. Default names follow the kind. */
  setKind(id: number, kind: ShapeKindName): void {
    const s = this.shape(id);
    if (!s || s.locked || s.kind === kind) return;
    s.kind = kind;
    const match = /^(Landmass|Lake|Highland) (\d+)$/.exec(s.name);
    if (match) s.name = `${KIND_NAMES[kind]} ${match[2]}`;
    this.onEdit("shape");
    this.onEdit("selection");
    this.draw();
  }

  /** A highland's height in metres; negative makes a basin. */
  setHeight(id: number, metres: number): void {
    const s = this.shape(id);
    if (!s || s.locked) return;
    s.height = metres;
    this.onEdit("shape");
  }

  toggleHidden(id: number): void {
    const s = this.shape(id);
    if (!s) return;
    s.hidden = !s.hidden;
    if (s.hidden && this.selection?.shape === id) this.selection = null;
    this.onEdit("shape");
    this.onEdit("selection");
    this.draw();
  }

  toggleLocked(id: number): void {
    const s = this.shape(id);
    if (!s) return;
    s.locked = !s.locked;
    if (s.locked && this.selection?.shape === id) this.selection = { kind: "shape", shape: id };
    this.onEdit("list");
    this.onEdit("selection");
    this.draw();
  }

  deleteShape(id: number): void {
    this.shapes = this.shapes.filter((s) => s.id !== id);
    if (this.selection?.shape === id) this.selection = null;
    if (!this.shapes.length) this.draft = [];
    this.onEdit("shape");
    this.onEdit("selection");
    this.draw();
  }

  clearAll(): void {
    this.shapes = [];
    this.draft = [];
    this.selection = null;
    this.onEdit("shape");
    this.onEdit("selection");
    this.draw();
  }

  /** The slider values a segment actually uses: its shape's plus its own adjustment. */
  segmentValues(shape: ShapeModel, index: number): SliderValues {
    return effective(shape.base, shape.adjust[index]);
  }

  /** Change the whole shape's values. Every segment keeps its own adjustment on top. */
  setShapeValues(values: SliderValues): void {
    const s = this.selectedShape();
    if (!s || s.locked) return;
    s.base = { ...values };
    this.onEdit("shape");
  }

  /** Set a segment's values; stored as its adjustment from the shape's values. */
  setSegmentValues(index: number, values: SliderValues): void {
    const s = this.selectedShape();
    if (!s || s.locked) return;
    const adjust = {} as SliderValues;
    for (const k of Object.keys(values) as (keyof SliderValues)[]) adjust[k] = values[k] - s.base[k];
    s.adjust[index] = adjust;
    this.onEdit("shape");
  }

  /** Set several segments' values at once (one update for the terrain). */
  setManySegmentValues(changes: [index: number, values: SliderValues][]): void {
    const s = this.selectedShape();
    if (!s || s.locked) return;
    for (const [index, values] of changes) {
      const adjust = {} as SliderValues;
      for (const k of Object.keys(values) as (keyof SliderValues)[]) adjust[k] = values[k] - s.base[k];
      s.adjust[index] = adjust;
    }
    this.onEdit("shape");
  }

  /** Remove segments' own adjustments, so they follow their shape exactly. */
  resetSegments(indices: number[]): void {
    const s = this.selectedShape();
    if (!s || s.locked) return;
    for (const i of indices) s.adjust[i] = { ...NO_ADJUSTMENT };
    this.onEdit("shape");
    this.onEdit("selection");
  }

  deletePoint(index: number): void {
    const s = this.selectedShape();
    if (!s || s.locked || s.points.length <= 3) return;
    s.points.splice(index, 1);
    // Removing a point merges the segments either side; keep the earlier one.
    s.adjust.splice(index, 1);
    this.selection = { kind: "shape", shape: s.id };
    this.onEdit("shape");
    this.onEdit("selection");
    this.draw();
  }

  // --- coordinates ------------------------------------------------------------------

  /** Where the map square sits on the overlay, in CSS pixels. */
  setView(left: number, top: number, size: number): void {
    this.view = { left, top, size };
    this.draw();
  }

  private toKm(e: { clientX: number; clientY: number }): Vec2 {
    const r = this.overlay.getBoundingClientRect();
    const s = this.extentKm / this.view.size;
    return { x: (e.clientX - r.left - this.view.left) * s, y: (e.clientY - r.top - this.view.top) * s };
  }

  private toPx(p: Vec2): Vec2 {
    const s = this.view.size / this.extentKm;
    return { x: this.view.left + p.x * s, y: this.view.top + p.y * s };
  }

  private kmPerPx(): number {
    return this.extentKm / this.view.size;
  }

  private onMap(p: Vec2): boolean {
    return p.x >= 0 && p.y >= 0 && p.x <= this.extentKm && p.y <= this.extentKm;
  }

  private clampToMap(p: Vec2): Vec2 {
    return { x: Math.max(0, Math.min(this.extentKm, p.x)), y: Math.max(0, Math.min(this.extentKm, p.y)) };
  }

  /** Shapes that can be clicked on the map: visible and not locked, topmost first. */
  private editable(): ShapeModel[] {
    return this.shapes.filter((s) => !s.hidden && !s.locked).reverse();
  }

  // --- the reference image's box ----------------------------------------------------

  /** Corners (km) of an image box: top-left, top-right, bottom-right, bottom-left in its own frame. */
  private imageCorners(b: ImageBox): Vec2[] {
    const cos = Math.cos(b.angle);
    const sin = Math.sin(b.angle);
    return [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([sx, sy]) => ({
      x: b.x + (sx * b.w * cos) / 2 - (sy * b.h * sin) / 2,
      y: b.y + (sx * b.w * sin) / 2 + (sy * b.h * cos) / 2,
    }));
  }

  /** Handles of the image box in screen pixels: four corners and the rotate knob. */
  private imageHandles(b: ImageBox): { corners: Vec2[]; rotate: Vec2; topMid: Vec2 } {
    const corners = this.imageCorners(b).map((c) => this.toPx(c));
    const topMid = { x: (corners[0].x + corners[1].x) / 2, y: (corners[0].y + corners[1].y) / 2 };
    // Out from the top edge, perpendicular to it.
    const up = { x: Math.sin(b.angle), y: -Math.cos(b.angle) };
    return { corners, topMid, rotate: { x: topMid.x + up.x * ROTATE_OFFSET_PX, y: topMid.y + up.y * ROTATE_OFFSET_PX } };
  }

  private hitImage(e: PointerEvent | MouseEvent, b: ImageBox): "rotate" | Corner | "inside" | null {
    const r = this.overlay.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const { corners, rotate } = this.imageHandles(b);
    if (Math.hypot(sx - rotate.x, sy - rotate.y) <= HANDLE_HIT_PX) return "rotate";
    for (let i = 0; i < 4; i++) {
      if (Math.hypot(sx - corners[i].x, sy - corners[i].y) <= HANDLE_HIT_PX) return i as Corner;
    }
    // Inside: the point in the image's own frame lies within half its size.
    const p = this.toKm(e);
    const dx = p.x - b.x;
    const dy = p.y - b.y;
    const u = dx * Math.cos(b.angle) + dy * Math.sin(b.angle);
    const v = -dx * Math.sin(b.angle) + dy * Math.cos(b.angle);
    return Math.abs(u) <= b.w / 2 && Math.abs(v) <= b.h / 2 ? "inside" : null;
  }

  /** The reference image, if it is selected and free to move. */
  private movableReference(): ReferenceImage | null {
    const ref = this.reference;
    return ref && this.referenceSelected && !ref.locked && !ref.hidden ? ref : null;
  }

  private transformImage(drag: Extract<Drag, { kind: "image" }>, p: Vec2): void {
    const ref = this.reference;
    if (!ref) return;
    const dx = p.x - drag.start.x;
    const dy = p.y - drag.start.y;
    if (!drag.moved && Math.hypot(dx, dy) / this.kmPerPx() < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    const b = drag.from;
    if (drag.mode === "move") {
      Object.assign(ref, { x: b.x + dx, y: b.y + dy });
    } else if (drag.mode === "rotate") {
      let angle = Math.atan2(p.y - b.y, p.x - b.x) - Math.atan2(drag.start.y - b.y, drag.start.x - b.x);
      if (this.shiftHeld) angle = Math.round(angle / (Math.PI / 12)) * (Math.PI / 12);
      ref.angle = b.angle + angle;
    } else {
      // Resize from the opposite corner, measured along the image's own axes.
      const k = drag.mode.corner;
      const signs: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      const [sx, sy] = signs[k];
      const anchor = this.imageCorners(b)[(k + 2) % 4];
      const cos = Math.cos(b.angle);
      const sin = Math.sin(b.angle);
      const ax = p.x - anchor.x;
      const ay = p.y - anchor.y;
      const minKm = 5;
      let w = Math.max(minKm, (ax * cos + ay * sin) * sx);
      let h = Math.max(minKm, (-ax * sin + ay * cos) * sy);
      if (!this.shiftHeld) {
        const f = Math.max(w / b.w, h / b.h);
        w = b.w * f;
        h = b.h * f;
      }
      Object.assign(ref, {
        w,
        h,
        x: anchor.x + (sx * w * cos) / 2 - (sy * h * sin) / 2,
        y: anchor.y + (sx * w * sin) / 2 + (sy * h * cos) / 2,
      });
    }
  }

  // --- hit testing ------------------------------------------------------------------

  private hitPoint(p: Vec2, pts: Vec2[]): number | null {
    let best: number | null = null;
    let bestDist = POINT_HIT_PX * this.kmPerPx();
    pts.forEach((q, i) => {
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d <= bestDist) {
        best = i;
        bestDist = d;
      }
    });
    return best;
  }

  private hitSegment(p: Vec2): { shape: ShapeModel; index: number; at: Vec2 } | null {
    let best: { shape: ShapeModel; index: number; at: Vec2 } | null = null;
    let bestDist = SEGMENT_HIT_PX * this.kmPerPx();
    for (const shape of this.editable()) {
      const pts = shape.points;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        const abx = b.x - a.x;
        const aby = b.y - a.y;
        const len2 = abx * abx + aby * aby || 1;
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2));
        const at = { x: a.x + abx * t, y: a.y + aby * t };
        const d = Math.hypot(p.x - at.x, p.y - at.y);
        if (d < bestDist) {
          best = { shape, index: i, at };
          bestDist = d;
        }
      }
    }
    return best;
  }

  private hitFill(p: Vec2): ShapeModel | null {
    return this.editable().find((s) => insidePolygon(p, s.points)) ?? null;
  }

  /** Handles of the whole-shape box, in screen pixels. */
  private handles(shape: ShapeModel): { box: Box; corners: Vec2[]; rotate: Vec2 } {
    const b = boundingBox(shape.points);
    const pad = 6 * this.kmPerPx();
    const box = { x0: b.x0 - pad, y0: b.y0 - pad, x1: b.x1 + pad, y1: b.y1 + pad };
    const corners = boxCorners(box).map((c) => this.toPx(c));
    const top = this.toPx({ x: (box.x0 + box.x1) / 2, y: box.y0 });
    return { box, corners, rotate: { x: top.x, y: top.y - ROTATE_OFFSET_PX } };
  }

  private hitHandle(e: PointerEvent | MouseEvent, shape: ShapeModel): "rotate" | Corner | "inside" | null {
    const r = this.overlay.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const { box, corners, rotate } = this.handles(shape);
    if (Math.hypot(sx - rotate.x, sy - rotate.y) <= HANDLE_HIT_PX) return "rotate";
    for (let i = 0; i < 4; i++) {
      if (Math.hypot(sx - corners[i].x, sy - corners[i].y) <= HANDLE_HIT_PX) return i as Corner;
    }
    const p = this.toKm(e);
    if (p.x >= box.x0 && p.x <= box.x1 && p.y >= box.y0 && p.y <= box.y1) return "inside";
    return null;
  }

  // --- input ------------------------------------------------------------------------

  private startPan(e: PointerEvent, onClick: "deselect" | "undo-point" | "none"): void {
    this.drag = { kind: "pan", x: e.clientX, y: e.clientY, moved: false, onClick };
    this.overlay.setPointerCapture(e.pointerId);
  }

  private startTransform(e: PointerEvent, shape: ShapeModel, mode: "move" | "rotate" | { corner: Corner }): void {
    this.drag = {
      kind: "transform",
      mode,
      shape: shape.id,
      start: this.toKm(e),
      points: shape.points.map((p) => ({ ...p })),
      frame: { ...shape.frame },
      box: boundingBox(shape.points),
      moved: false,
    };
    this.overlay.setPointerCapture(e.pointerId);
  }

  private pointerDown(e: PointerEvent): void {
    this.shiftHeld = e.shiftKey;
    // Middle button, or Space plus left button, always pans. Right button
    // pans when dragged; a plain right click while drawing removes the last point.
    if (e.button === 1 || (e.button === 0 && this.spaceHeld)) {
      e.preventDefault();
      this.startPan(e, "none");
      return;
    }
    if (e.button === 2) {
      e.preventDefault();
      this.startPan(e, this.draft?.length ? "undo-point" : "none");
      return;
    }
    if (e.button !== 0) return;
    const p = this.toKm(e);

    if (this.draft) {
      this.drawPoint(p);
      return;
    }

    // A selected, unlocked reference image: its handles, or drag it from inside.
    const ref = this.movableReference();
    if (ref) {
      const hit = this.hitImage(e, ref);
      if (hit !== null) {
        const mode = hit === "inside" ? "move" : hit === "rotate" ? "rotate" : { corner: hit };
        this.drag = { kind: "image", mode, start: p, from: { x: ref.x, y: ref.y, w: ref.w, h: ref.h, angle: ref.angle }, moved: false };
        this.overlay.setPointerCapture(e.pointerId);
        return;
      }
    }

    // Handles of a selected whole shape come first.
    const selected = this.selectedShape();
    if (selected && this.selection?.kind === "shape" && !selected.locked && !selected.hidden) {
      const handle = this.hitHandle(e, selected);
      if (handle === "rotate") return this.startTransform(e, selected, "rotate");
      if (handle !== null && handle !== "inside") return this.startTransform(e, selected, { corner: handle });
    }

    // Then points of the selected shape.
    if (selected && !selected.locked && !selected.hidden) {
      const index = this.hitPoint(p, selected.points);
      if (index !== null) {
        this.selection = { kind: "point", shape: selected.id, index };
        this.drag = { kind: "point", shape: selected.id, index };
        this.overlay.setPointerCapture(e.pointerId);
        this.onEdit("selection");
        this.draw();
        return;
      }
    }

    // Then segments of any shape.
    const seg = this.hitSegment(p);
    if (seg) {
      const sel = this.selection;
      if ((e.ctrlKey || e.metaKey) && sel?.kind === "segment" && sel.shape === seg.shape.id) {
        // Ctrl/Cmd+Click adds or removes a segment of the same shape.
        const indices = selectedSegments(sel).filter((i) => i !== seg.index);
        if (indices.length === selectedSegments(sel).length) indices.push(seg.index);
        this.selection = indices.length ? { kind: "segment", shape: seg.shape.id, index: indices[indices.length - 1], indices } : null;
      } else {
        this.selection = { kind: "segment", shape: seg.shape.id, index: seg.index, indices: [seg.index] };
      }
      this.onEdit("selection");
      this.draw();
      return;
    }

    // Ctrl/Cmd+Click elsewhere keeps a segment selection rather than clearing it.
    if ((e.ctrlKey || e.metaKey) && this.selection?.kind === "segment") return;

    // Inside the selected shape's box: drag to move it.
    if (selected && this.selection?.kind === "shape" && !selected.locked && this.hitHandle(e, selected) === "inside") {
      this.startTransform(e, selected, "move");
      return;
    }

    // A click on a shape's fill selects it as a whole. Dragging an
    // unselected shape pans instead, so panning never moves land by accident.
    const fill = this.hitFill(p);
    if (fill) {
      this.selection = { kind: "shape", shape: fill.id };
      this.onEdit("selection");
      this.draw();
      this.startPan(e, "none");
      return;
    }

    this.startPan(e, "deselect");
  }

  private drawPoint(p: Vec2): void {
    const draft = this.draft!;
    if (draft.length >= 3 && this.hitPoint(p, draft) === 0) {
      this.closeDraft();
    } else if (this.onMap(p)) {
      draft.push(p);
      this.onEdit("selection");
    }
    this.draw();
  }

  private closeDraft(): void {
    const points = this.draft!;
    const b = boundingBox(points);
    const shape: ShapeModel = {
      id: this.nextId++,
      name: `Landmass ${this.nextNumber++}`,
      kind: "land",
      height: DEFAULT_HIGHLAND_M,
      points,
      base: { ...DEFAULT_VALUES },
      adjust: points.map(() => ({ ...NO_ADJUSTMENT })),
      seed: newSeed(),
      frame: { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, angle: 0, scale: 1 },
      hidden: false,
      locked: false,
    };
    this.shapes.push(shape);
    this.draft = null;
    this.selection = { kind: "shape", shape: shape.id };
    this.onEdit("shape");
    this.onEdit("list");
    this.onEdit("selection");
  }

  private pointerMove(e: PointerEvent): void {
    this.shiftHeld = e.shiftKey;
    const drag = this.drag;
    if (drag?.kind === "pan") {
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
      drag.x = e.clientX;
      drag.y = e.clientY;
      this.onPan(dx, dy);
      return;
    }
    const p = this.toKm(e);
    this.cursor = p;
    if (drag?.kind === "point") {
      const shape = this.shape(drag.shape);
      if (shape) {
        shape.points[drag.index] = this.clampToMap(p);
        this.onEdit("shape");
      }
    } else if (drag?.kind === "transform") {
      this.transform(drag, p);
    } else if (drag?.kind === "image") {
      this.transformImage(drag, p);
    } else {
      this.hover = this.hoverAt(e, p);
    }
    this.overlay.style.cursor = this.cursorStyle(e);
    this.draw();
  }

  private hoverAt(e: PointerEvent, p: Vec2): Selection {
    if (this.draft) {
      return this.draft.length >= 3 && this.hitPoint(p, this.draft) === 0 ? { kind: "point", shape: -1, index: 0 } : null;
    }
    const selected = this.selectedShape();
    if (selected && !selected.locked && !selected.hidden) {
      const index = this.hitPoint(p, selected.points);
      if (index !== null) return { kind: "point", shape: selected.id, index };
    }
    const seg = this.hitSegment(p);
    if (seg) return { kind: "segment", shape: seg.shape.id, index: seg.index };
    const fill = this.hitFill(p);
    return fill ? { kind: "shape", shape: fill.id } : null;
  }

  /** Apply a move, resize or rotate drag to the shape, from its starting state. */
  private transform(drag: Extract<Drag, { kind: "transform" }>, p: Vec2): void {
    const shape = this.shape(drag.shape);
    if (!shape) return;
    const dx = p.x - drag.start.x;
    const dy = p.y - drag.start.y;
    if (!drag.moved && Math.hypot(dx, dy) / this.kmPerPx() < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    const b = drag.box;

    if (drag.mode === "move") {
      // Keep the whole shape on the map.
      const mx = Math.max(-b.x0, Math.min(this.extentKm - b.x1, dx));
      const my = Math.max(-b.y0, Math.min(this.extentKm - b.y1, dy));
      shape.points = drag.points.map((q) => ({ x: q.x + mx, y: q.y + my }));
      // The frame travels with the shape, so its coastline stays the same.
      shape.frame = { ...drag.frame, x: drag.frame.x + mx, y: drag.frame.y + my };
    } else if (drag.mode === "rotate") {
      const c = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
      let angle = Math.atan2(p.y - c.y, p.x - c.x) - Math.atan2(drag.start.y - c.y, drag.start.x - c.x);
      if (this.shiftHeld) angle = Math.round(angle / (Math.PI / 12)) * (Math.PI / 12); // 15 degree steps
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const turn = (q: Vec2) => ({ x: c.x + (q.x - c.x) * cos - (q.y - c.y) * sin, y: c.y + (q.x - c.x) * sin + (q.y - c.y) * cos });
      shape.points = drag.points.map((q) => this.clampToMap(turn(q)));
      // The frame turns too, so the coastline detail turns with the shape.
      shape.frame = { ...drag.frame, ...turn(drag.frame), angle: drag.frame.angle + angle };
    } else {
      // Resize from the opposite corner. Proportional by default, so the
      // coastline is an exact enlargement or reduction; Shift stretches freely.
      // The frame scales with the shape, so the coastline detail does too.
      const corners = boxCorners(b);
      const corner = drag.mode.corner;
      const anchor = corners[(corner + 2) % 4];
      const from = corners[corner];
      const minKm = 10;
      let sx = Math.max(minKm / (b.x1 - b.x0 || 1), (p.x - anchor.x) / (from.x - anchor.x || 1));
      let sy = Math.max(minKm / (b.y1 - b.y0 || 1), (p.y - anchor.y) / (from.y - anchor.y || 1));
      if (!this.shiftHeld) sx = sy = Math.max(sx, sy);
      const scale = (q: { x: number; y: number }) => ({ x: anchor.x + (q.x - anchor.x) * sx, y: anchor.y + (q.y - anchor.y) * sy });
      shape.points = drag.points.map((q) => this.clampToMap(scale(q)));
      shape.frame = { ...drag.frame, ...scale(drag.frame), scale: drag.frame.scale * Math.sqrt(sx * sy) };
    }
    this.onEdit("shape");
  }

  private pointerUp(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    if (this.overlay.hasPointerCapture(e.pointerId)) this.overlay.releasePointerCapture(e.pointerId);
    if (drag.kind === "pan" && !drag.moved) {
      if (drag.onClick === "undo-point" && this.draft?.length) {
        this.draft.pop();
        this.onEdit("selection");
      } else if (drag.onClick === "deselect" && (this.selection || this.referenceSelected)) {
        this.selection = null;
        this.referenceSelected = false;
        this.onEdit("selection");
      }
    }
    if (drag.kind === "transform" || drag.kind === "point" || drag.kind === "image") this.onEdit("selection");
    this.overlay.style.cursor = this.cursorStyle(e);
    this.draw();
  }

  private doubleClick(e: MouseEvent): void {
    if (this.draft) return;
    const p = this.toKm(e);
    const selected = this.selectedShape();
    if (selected && this.hitPoint(p, selected.points) !== null) return;
    const seg = this.hitSegment(p);
    if (!seg) return;
    const { points, adjust } = seg.shape;
    points.splice(seg.index + 1, 0, seg.at);
    // The split halves both keep the original segment's adjustment.
    adjust.splice(seg.index + 1, 0, { ...adjust[seg.index] });
    this.selection = { kind: "point", shape: seg.shape.id, index: seg.index + 1 };
    this.onEdit("shape");
    this.onEdit("selection");
    this.draw();
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    const r = this.overlay.getBoundingClientRect();
    // Trackpad pinch arrives as a wheel event with ctrlKey and small deltas.
    const sensitivity = e.ctrlKey ? 0.01 : 0.0015;
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    this.onZoom(Math.exp(-delta * sensitivity), e.clientX - r.left, e.clientY - r.top);
  }

  private key(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (target && ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(target.tagName)) return;
    if (e.key === "Shift") this.shiftHeld = true;
    if (e.key === " ") {
      this.spaceHeld = true;
      this.overlay.style.cursor = this.cursorStyle();
      e.preventDefault();
      return;
    }
    if (e.key === "Escape") {
      if (this.draft?.length) {
        this.draft = [];
        this.onEdit("selection");
      } else if (this.draft) {
        this.cancelDraft();
      } else {
        this.selection = null;
        this.referenceSelected = false;
        this.onEdit("selection");
      }
      this.draw();
    } else if (e.key === "Backspace" || e.key === "Delete") {
      if (this.draft?.length) {
        this.draft.pop();
        this.onEdit("selection");
        this.draw();
        e.preventDefault();
      } else if (this.selection?.kind === "point") {
        this.deletePoint(this.selection.index);
        e.preventDefault();
      }
    }
  }

  private cursorStyle(e?: PointerEvent): string {
    if (this.drag?.kind === "pan" && this.drag.moved) return "grabbing";
    if (this.drag?.kind === "point") return "grabbing";
    if (this.drag?.kind === "transform" || this.drag?.kind === "image") return this.drag.mode === "move" ? "grabbing" : "crosshair";
    if (this.spaceHeld) return "grab";
    if (this.draft) return this.hover?.kind === "point" ? "pointer" : "crosshair";
    const ref = this.movableReference();
    if (e && ref) {
      const hit = this.hitImage(e, ref);
      if (hit === "rotate") return "alias";
      if (hit === "inside") return "move";
      if (hit !== null) return "crosshair";
    }
    const selected = this.selectedShape();
    if (e && selected && this.selection?.kind === "shape" && !selected.locked && !selected.hidden) {
      const handle = this.hitHandle(e, selected);
      if (handle === "rotate") return "alias";
      if (handle === 0 || handle === 2) return "nwse-resize";
      if (handle === 1 || handle === 3) return "nesw-resize";
      if (handle === "inside" && this.hover?.kind !== "point" && this.hover?.kind !== "segment") return "move";
    }
    if (this.hover?.kind === "point") return "grab";
    if (this.hover?.kind === "segment" || this.hover?.kind === "shape") return "pointer";
    return "grab";
  }

  // --- drawing ----------------------------------------------------------------------

  draw(): void {
    const c = this.overlay;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (this.reference && !this.reference.hidden) this.drawReference(this.reference);
    if (this.showGrid) this.drawGrid();
    for (const shape of this.shapes) if (!shape.hidden) this.drawShape(shape);
    const selected = this.selectedShape();
    if (selected && !selected.hidden && this.selection?.kind === "shape" && !selected.locked) this.drawHandles(selected);
    const ref = this.movableReference();
    if (ref) this.drawImageHandles(ref);
    if (this.draft) this.drawDraft(this.draft);
    this.drawScale();
  }

  private drawReference(ref: ReferenceImage): void {
    const ctx = this.ctx;
    const c = this.toPx(ref);
    const s = this.view.size / this.extentKm;
    ctx.save();
    // Only the part over the map is useful for tracing.
    ctx.beginPath();
    ctx.rect(this.view.left, this.view.top, this.view.size, this.view.size);
    ctx.clip();
    ctx.globalAlpha = ref.opacity;
    ctx.translate(c.x, c.y);
    ctx.rotate(ref.angle);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(ref.image, (-ref.w * s) / 2, (-ref.h * s) / 2, ref.w * s, ref.h * s);
    ctx.restore();
  }

  private drawImageHandles(ref: ReferenceImage): void {
    const ctx = this.ctx;
    const { corners, rotate, topMid } = this.imageHandles(ref);
    ctx.strokeStyle = HIGHLIGHT;
    ctx.lineWidth = 1.25;
    ctx.setLineDash([5, 4]);
    this.path(corners, true);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(topMid.x, topMid.y);
    ctx.lineTo(rotate.x, rotate.y);
    ctx.stroke();
    for (const corner of corners) this.square(corner, 5, "#ffffff");
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "rgba(10, 20, 28, 0.8)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(rotate.x, rotate.y, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  /** A round distance (km) that spans at least `minPx` on screen. */
  private niceKm(minPx: number): number {
    const pxPerKm = this.view.size / this.extentKm;
    for (const km of [1, 2, 5, 10, 25, 50, 100, 250, 500]) {
      if (km * pxPerKm >= minPx) return km;
    }
    return 1000;
  }

  private drawGrid(): void {
    const ctx = this.ctx;
    const { left, top, size } = this.view;
    const w = this.overlay.clientWidth;
    const h = this.overlay.clientHeight;
    const pxPerKm = size / this.extentKm;
    const step = this.gridKm || this.niceKm(56);
    // A fixed grid too dense to see at this zoom is left out rather than drawn as a smear.
    if (step * pxPerKm < 6) return;
    const kmAt = (px: number, origin: number) => (px - origin) / pxPerKm;
    const fromX = Math.max(step, Math.ceil(kmAt(0, left) / step) * step);
    const toX = Math.min(this.extentKm - step / 2, kmAt(w, left));
    const fromY = Math.max(step, Math.ceil(kmAt(0, top) / step) * step);
    const toY = Math.min(this.extentKm - step / 2, kmAt(h, top));
    const y0 = Math.max(0, top);
    const y1 = Math.min(h, top + size);
    const x0 = Math.max(0, left);
    const x1 = Math.min(w, left + size);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.09)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let km = fromX; km <= toX; km += step) {
      const x = Math.round(left + km * pxPerKm) + 0.5;
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
    }
    for (let km = fromY; km <= toY; km += step) {
      const y = Math.round(top + km * pxPerKm) + 0.5;
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
    }
    ctx.stroke();
  }

  private drawScale(): void {
    const ctx = this.ctx;
    const km = this.niceKm(90);
    const len = (km / this.extentKm) * this.view.size;
    const x = 16;
    const y = this.overlay.clientHeight - 18;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y - 5);
    ctx.lineTo(x, y);
    ctx.lineTo(x + len, y);
    ctx.lineTo(x + len, y - 5);
    ctx.stroke();
    ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
    ctx.font = '500 12px "Barlow", system-ui, sans-serif';
    ctx.fillText(`${km.toLocaleString()} km`, x + len + 8, y + 1);
    if (this.showGrid && this.gridKm) {
      ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
      ctx.fillText(`Grid squares: ${this.gridKm.toLocaleString()} km`, x, y - 12);
    }
  }

  private path(pts: Vec2[], closed: boolean): void {
    const ctx = this.ctx;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    if (closed) ctx.closePath();
  }

  private drawShape(shape: ShapeModel): void {
    const ctx = this.ctx;
    const pts = shape.points.map((p) => this.toPx(p));
    const focused = this.selection?.shape === shape.id;
    const hovered = this.hover?.shape === shape.id && this.hover.kind === "shape";
    ctx.lineJoin = "round";

    this.path(pts, true);
    ctx.strokeStyle = HALO;
    ctx.lineWidth = focused ? 4 : 3;
    ctx.stroke();
    this.path(pts, true);
    const ink = shape.kind === "water" ? WATER_GUIDE : shape.kind === "highland" ? HIGHLAND_GUIDE : GUIDE;
    ctx.strokeStyle = ink;
    ctx.globalAlpha = shape.locked ? 0.55 : focused || hovered ? 1 : 0.75;
    ctx.lineWidth = focused ? 1.75 : 1.25;
    ctx.setLineDash(shape.locked ? [4, 4] : []);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    const segment = (index: number, color: string, width: number) => {
      const a = pts[index];
      const b = pts[(index + 1) % pts.length];
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    };
    const sel = this.selection;
    const chosen = sel?.kind === "segment" && sel.shape === shape.id ? selectedSegments(sel) : [];
    if (this.hover?.kind === "segment" && this.hover.shape === shape.id && !chosen.includes(this.hover.index)) {
      segment(this.hover.index, "rgba(242, 176, 30, 0.55)", 4);
    }
    for (const i of chosen) segment(i, HIGHLIGHT, i === (sel as { index: number }).index ? 4.5 : 3.5);

    // Points only for the shape being edited, to keep the map uncluttered.
    if (focused && !shape.locked) {
      pts.forEach((p, i) => {
        const selected = sel?.kind === "point" && sel.index === i;
        const hover = this.hover?.kind === "point" && this.hover.shape === shape.id && this.hover.index === i;
        this.square(p, hover || selected ? 5 : 3.5, selected ? HIGHLIGHT : ink);
      });
    }
  }

  private square(p: Vec2, r: number, fill: string): void {
    const ctx = this.ctx;
    ctx.fillStyle = fill;
    ctx.strokeStyle = "rgba(10, 20, 28, 0.8)";
    ctx.lineWidth = 1.5;
    ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
    ctx.strokeRect(p.x - r, p.y - r, r * 2, r * 2);
  }

  private drawHandles(shape: ShapeModel): void {
    const ctx = this.ctx;
    const { corners, rotate } = this.handles(shape);
    const topMid = { x: (corners[0].x + corners[1].x) / 2, y: corners[0].y };
    ctx.strokeStyle = HIGHLIGHT;
    ctx.lineWidth = 1.25;
    ctx.setLineDash([5, 4]);
    this.path(corners, true);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(topMid.x, topMid.y);
    ctx.lineTo(rotate.x, rotate.y);
    ctx.stroke();
    for (const c of corners) this.square(c, 5, "#ffffff");
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "rgba(10, 20, 28, 0.8)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(rotate.x, rotate.y, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  private drawDraft(draft: Vec2[]): void {
    const ctx = this.ctx;
    if (!draft.length) return;
    const pts = draft.map((p) => this.toPx(p));
    this.path(pts, false);
    ctx.strokeStyle = HALO;
    ctx.lineWidth = 4;
    ctx.stroke();
    this.path(pts, false);
    ctx.strokeStyle = GUIDE;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (this.cursor) {
      const last = pts[pts.length - 1];
      const to = this.toPx(this.cursor);
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const closable = draft.length >= 3;
    pts.forEach((p, i) => {
      if (closable && i === 0) {
        const hovered = this.hover?.kind === "point" && this.hover.shape === -1;
        ctx.strokeStyle = HIGHLIGHT;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, hovered ? 9 : 7, 0, Math.PI * 2);
        ctx.stroke();
      }
      this.square(p, 3.5, GUIDE);
    });
  }
}
