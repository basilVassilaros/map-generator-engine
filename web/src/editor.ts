// The coastline pen and shape editing: drawing new shapes point by point,
// selecting shapes, segments and points, dragging points, inserting and
// deleting them, moving, resizing and rotating whole shapes, and drawing the
// guide overlay. Pan and zoom gestures are passed to the app.

import { DEFAULT_PARAMS, type Guides, type SegmentParams, type Vec2 } from "./protocol";

export interface ShapeFrame {
  x: number;
  y: number;
  angle: number;
}

export interface ShapeModel {
  id: number;
  name: string;
  kind: "land";
  points: Vec2[];
  params: SegmentParams[]; // params[i] belongs to the segment from points[i] to points[i + 1]
  seed: number;
  /** Anchors the coastline detail, so it travels with the shape. */
  frame: ShapeFrame;
  hidden: boolean;
  locked: boolean;
}

export type Selection =
  | { kind: "shape"; shape: number }
  | { kind: "segment"; shape: number; index: number }
  | { kind: "point"; shape: number; index: number }
  | null;

/** What changed: terrain ("shape"), only the selection, or only the shape list. */
export type EditKind = "shape" | "selection" | "list";

type Corner = 0 | 1 | 2 | 3; // top-left, top-right, bottom-right, bottom-left

type Drag =
  | { kind: "point"; shape: number; index: number }
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

  /** What the terrain engine needs: every visible shape. */
  guides(): Guides {
    return {
      worldSeed: this.worldSeed,
      shapes: this.shapes
        .filter((s) => !s.hidden)
        .map((s) => ({ id: s.id, seed: s.seed, frame: s.frame, points: s.points, params: s.params })),
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
    this.onEdit("selection");
    this.draw();
  }

  rename(id: number, name: string): void {
    const s = this.shape(id);
    if (!s) return;
    s.name = name.trim() || s.name;
    this.onEdit("list");
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

  setParams(index: number, params: SegmentParams): void {
    const s = this.selectedShape();
    if (!s || s.locked) return;
    s.params[index] = { ...params };
    this.onEdit("shape");
  }

  /** Apply settings to every segment of the selected shape. */
  applyToAll(params: SegmentParams): void {
    const s = this.selectedShape();
    if (!s || s.locked) return;
    s.params = s.points.map(() => ({ ...params }));
    this.onEdit("shape");
  }

  deletePoint(index: number): void {
    const s = this.selectedShape();
    if (!s || s.locked || s.points.length <= 3) return;
    s.points.splice(index, 1);
    // Removing a point merges the segments either side; keep the earlier one.
    s.params.splice(index, 1);
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
      this.selection = { kind: "segment", shape: seg.shape.id, index: seg.index };
      this.onEdit("selection");
      this.draw();
      return;
    }

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
      points,
      params: points.map(() => ({ ...DEFAULT_PARAMS })),
      seed: newSeed(),
      frame: { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, angle: 0 },
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
      shape.frame = { ...turn(drag.frame), angle: drag.frame.angle + angle };
    } else {
      // Resize from the opposite corner. The frame stays put, so the outline
      // scales but fine detail is regenerated at real-world scale.
      const corners = boxCorners(b);
      const corner = drag.mode.corner;
      const anchor = corners[(corner + 2) % 4];
      const from = corners[corner];
      const minKm = 10;
      let sx = Math.max(minKm / (b.x1 - b.x0 || 1), (p.x - anchor.x) / (from.x - anchor.x || 1));
      let sy = Math.max(minKm / (b.y1 - b.y0 || 1), (p.y - anchor.y) / (from.y - anchor.y || 1));
      if (this.shiftHeld) sx = sy = Math.max(sx, sy);
      shape.points = drag.points.map((q) => this.clampToMap({ x: anchor.x + (q.x - anchor.x) * sx, y: anchor.y + (q.y - anchor.y) * sy }));
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
      } else if (drag.onClick === "deselect" && this.selection) {
        this.selection = null;
        this.onEdit("selection");
      }
    }
    if (drag.kind === "transform" || drag.kind === "point") this.onEdit("selection");
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
    const { points, params } = seg.shape;
    points.splice(seg.index + 1, 0, seg.at);
    // The split halves both keep the original segment's settings.
    params.splice(seg.index + 1, 0, { ...params[seg.index] });
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
    if (this.drag?.kind === "transform") return this.drag.mode === "move" ? "grabbing" : "crosshair";
    if (this.spaceHeld) return "grab";
    if (this.draft) return this.hover?.kind === "point" ? "pointer" : "crosshair";
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
    this.drawGrid();
    for (const shape of this.shapes) if (!shape.hidden) this.drawShape(shape);
    const selected = this.selectedShape();
    if (selected && !selected.hidden && this.selection?.kind === "shape" && !selected.locked) this.drawHandles(selected);
    if (this.draft) this.drawDraft(this.draft);
    this.drawScale();
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
    const step = this.niceKm(56);
    const pxPerKm = size / this.extentKm;
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
    ctx.strokeStyle = shape.locked ? "rgba(255, 255, 255, 0.55)" : focused || hovered ? GUIDE : "rgba(255, 255, 255, 0.75)";
    ctx.lineWidth = focused ? 1.75 : 1.25;
    ctx.setLineDash(shape.locked ? [4, 4] : []);
    ctx.stroke();
    ctx.setLineDash([]);

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
    if (this.hover?.kind === "segment" && this.hover.shape === shape.id && !(sel?.kind === "segment" && sel.shape === shape.id && sel.index === this.hover.index)) {
      segment(this.hover.index, "rgba(242, 176, 30, 0.55)", 4);
    }
    if (sel?.kind === "segment" && sel.shape === shape.id) segment(sel.index, HIGHLIGHT, 4);

    // Points only for the shape being edited, to keep the map uncluttered.
    if (focused && !shape.locked) {
      pts.forEach((p, i) => {
        const selected = sel?.kind === "point" && sel.index === i;
        const hover = this.hover?.kind === "point" && this.hover.shape === shape.id && this.hover.index === i;
        this.square(p, hover || selected ? 5 : 3.5, selected ? HIGHLIGHT : GUIDE);
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
