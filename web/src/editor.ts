// The coastline pen: placing, closing, dragging, inserting and deleting
// points, selecting segments, and drawing the guide overlay.

import { DEFAULT_PARAMS, type CoastGuide, type SegmentParams, type Vec2 } from "./protocol";

export type Selection = { kind: "segment"; index: number } | { kind: "point"; index: number } | null;

export interface CoastModel {
  points: Vec2[];
  params: SegmentParams[];
  seed: number;
  closed: boolean;
}

/** What changed, so the app knows whether to regenerate. */
export type EditKind = "shape" | "selection" | "view";

const POINT_HIT_PX = 10;
const SEGMENT_HIT_PX = 8;

export function newSeed(): number {
  // The core reads the seed as a 32-bit float, so keep it exactly representable.
  return Math.floor(Math.random() * 0xffffff);
}

export function toGuide(model: CoastModel): CoastGuide | null {
  if (!model.closed) return null;
  return { points: model.points, params: model.params, seed: model.seed };
}

export class CoastEditor {
  model: CoastModel = { points: [], params: [], seed: newSeed(), closed: false };
  selection: Selection = null;
  onEdit: (kind: EditKind) => void = () => {};
  /** Drag to pan, in CSS pixels. */
  onPan: (dx: number, dy: number) => void = () => {};
  /** Zoom by `factor`, keeping the point under (x, y) in place (CSS pixels on the overlay). */
  onZoom: (factor: number, x: number, y: number) => void = () => {};

  private extentKm: number;
  private view = { left: 0, top: 0, size: 1 };
  private cursor: Vec2 | null = null;
  private hover: Selection = null;
  private dragging: number | null = null;
  private panning: { x: number; y: number; moved: boolean; clickDeselects: boolean } | null = null;
  private spaceHeld = false;
  private ctx: CanvasRenderingContext2D;

  constructor(private overlay: HTMLCanvasElement, extentKm: number) {
    this.extentKm = extentKm;
    this.ctx = overlay.getContext("2d")!;
    overlay.addEventListener("pointerdown", (e) => this.pointerDown(e));
    overlay.addEventListener("pointermove", (e) => this.pointerMove(e));
    overlay.addEventListener("pointerup", (e) => this.pointerUp(e));
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
      if (e.key === " ") {
        this.spaceHeld = false;
        this.overlay.style.cursor = this.cursorStyle();
      }
    });
  }

  /** Where the map square sits on the overlay, in CSS pixels. */
  setView(left: number, top: number, size: number): void {
    this.view = { left, top, size };
    this.draw();
  }

  clear(): void {
    this.model = { points: [], params: [], seed: newSeed(), closed: false };
    this.selection = null;
    this.onEdit("shape");
    this.draw();
  }

  setParams(index: number, params: SegmentParams): void {
    this.model.params[index] = { ...params };
    this.onEdit("shape");
  }

  applyToAll(params: SegmentParams): void {
    this.model.params = this.model.points.map(() => ({ ...params }));
    this.onEdit("shape");
  }

  deletePoint(index: number): void {
    const { points, params } = this.model;
    if (!this.model.closed || points.length <= 3) return;
    points.splice(index, 1);
    // Removing a point merges the segments either side; keep the earlier one.
    params.splice(index, 1);
    this.selection = null;
    this.onEdit("shape");
    this.draw();
  }

  // --- coordinates ----------------------------------------------------------

  private toKm(e: PointerEvent | MouseEvent): Vec2 {
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

  // --- hit testing ----------------------------------------------------------

  private hitPoint(p: Vec2): number | null {
    const limit = POINT_HIT_PX * this.kmPerPx();
    let best: number | null = null;
    let bestDist = limit;
    this.model.points.forEach((q, i) => {
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d <= bestDist) {
        best = i;
        bestDist = d;
      }
    });
    return best;
  }

  private hitSegment(p: Vec2): { index: number; at: Vec2 } | null {
    if (!this.model.closed) return null;
    const pts = this.model.points;
    const limit = SEGMENT_HIT_PX * this.kmPerPx();
    let best: { index: number; at: Vec2 } | null = null;
    let bestDist = limit;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const len2 = abx * abx + aby * aby || 1;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2));
      const at = { x: a.x + abx * t, y: a.y + aby * t };
      const d = Math.hypot(p.x - at.x, p.y - at.y);
      if (d <= bestDist) {
        best = { index: i, at };
        bestDist = d;
      }
    }
    return best;
  }

  // --- input ----------------------------------------------------------------

  private startPan(e: PointerEvent, clickDeselects: boolean): void {
    this.panning = { x: e.clientX, y: e.clientY, moved: false, clickDeselects };
    this.overlay.setPointerCapture(e.pointerId);
    this.overlay.style.cursor = "grabbing";
  }

  private pointerDown(e: PointerEvent): void {
    // Middle or right button, or Space plus left button, always pans.
    if (e.button === 1 || e.button === 2 || (e.button === 0 && this.spaceHeld)) {
      e.preventDefault();
      this.startPan(e, false);
      return;
    }
    if (e.button !== 0) return;
    const p = this.toKm(e);
    const { model } = this;

    if (!model.closed) {
      if (model.points.length >= 3 && this.hitPoint(p) === 0) {
        model.closed = true;
        model.params = model.points.map(() => ({ ...DEFAULT_PARAMS }));
        this.onEdit("shape");
      } else if (this.onMap(p)) {
        model.points.push(p);
        this.onEdit("shape");
      }
      this.draw();
      return;
    }

    const point = this.hitPoint(p);
    if (point !== null) {
      this.dragging = point;
      this.selection = { kind: "point", index: point };
      this.overlay.setPointerCapture(e.pointerId);
    } else {
      const seg = this.hitSegment(p);
      if (!seg) {
        // Dragging empty map pans; a plain click there clears the selection.
        this.startPan(e, true);
        return;
      }
      this.selection = { kind: "segment", index: seg.index };
    }
    this.onEdit("selection");
    this.draw();
  }

  private pointerMove(e: PointerEvent): void {
    if (this.panning) {
      const dx = e.clientX - this.panning.x;
      const dy = e.clientY - this.panning.y;
      if (!this.panning.moved && Math.hypot(dx, dy) < 4) return;
      this.panning.moved = true;
      this.panning.x = e.clientX;
      this.panning.y = e.clientY;
      this.onPan(dx, dy);
      return;
    }
    const p = this.toKm(e);
    this.cursor = p;
    if (this.dragging !== null) {
      this.model.points[this.dragging] = {
        x: Math.max(0, Math.min(this.extentKm, p.x)),
        y: Math.max(0, Math.min(this.extentKm, p.y)),
      };
      this.onEdit("shape");
    } else {
      const point = this.hitPoint(p);
      const seg = point === null ? this.hitSegment(p) : null;
      this.hover = point !== null ? { kind: "point", index: point } : seg ? { kind: "segment", index: seg.index } : null;
    }
    this.overlay.style.cursor = this.cursorStyle();
    this.draw();
  }

  private pointerUp(e: PointerEvent): void {
    if (this.panning) {
      const { moved, clickDeselects } = this.panning;
      this.panning = null;
      this.overlay.releasePointerCapture(e.pointerId);
      if (!moved && clickDeselects && this.selection) {
        this.selection = null;
        this.onEdit("selection");
        this.draw();
      }
      this.overlay.style.cursor = this.cursorStyle();
      return;
    }
    if (this.dragging !== null) {
      this.dragging = null;
      this.overlay.releasePointerCapture(e.pointerId);
    }
  }

  private doubleClick(e: MouseEvent): void {
    const p = this.toKm(e);
    if (this.hitPoint(p) !== null) return;
    const seg = this.hitSegment(p);
    if (!seg) return;
    const { points, params } = this.model;
    points.splice(seg.index + 1, 0, seg.at);
    // The split halves both keep the original segment's settings.
    params.splice(seg.index + 1, 0, { ...params[seg.index] });
    this.selection = { kind: "point", index: seg.index + 1 };
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
    const { model } = this;
    if (e.key === " ") {
      this.spaceHeld = true;
      this.overlay.style.cursor = this.cursorStyle();
      e.preventDefault();
      return;
    }
    if (e.key === "Escape") {
      if (!model.closed && model.points.length) {
        model.points = [];
        this.onEdit("shape");
      } else {
        this.selection = null;
        this.onEdit("selection");
      }
      this.draw();
    } else if (e.key === "Backspace" || e.key === "Delete") {
      if (!model.closed && model.points.length) {
        model.points.pop();
        this.onEdit("shape");
        this.draw();
        e.preventDefault();
      } else if (this.selection?.kind === "point") {
        this.deletePoint(this.selection.index);
        e.preventDefault();
      }
    }
  }

  private cursorStyle(): string {
    if (this.dragging !== null || this.panning) return "grabbing";
    if (this.spaceHeld) return "grab";
    if (!this.model.closed) return this.model.points.length >= 3 && this.hover?.kind === "point" && this.hover.index === 0 ? "pointer" : "crosshair";
    if (this.hover?.kind === "point") return "grab";
    if (this.hover?.kind === "segment") return "pointer";
    return "grab";
  }

  // --- drawing --------------------------------------------------------------

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
    this.drawGuide();
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
    // Only the lines that are on screen.
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

  private drawGuide(): void {
    const ctx = this.ctx;
    const pts = this.model.points.map((p) => this.toPx(p));
    if (!pts.length) return;
    const closed = this.model.closed;

    const path = () => {
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      if (closed) ctx.closePath();
    };

    // Halo first so the line reads over both sea and land.
    path();
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(10, 20, 28, 0.45)";
    ctx.lineWidth = 4;
    ctx.stroke();
    path();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Rubber band to the cursor while drawing.
    if (!closed && this.cursor) {
      const last = pts[pts.length - 1];
      const to = this.toPx(this.cursor);
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Hovered and selected segments.
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
    if (closed && this.hover?.kind === "segment" && !(this.selection?.kind === "segment" && this.selection.index === this.hover.index)) {
      segment(this.hover.index, "rgba(242, 176, 30, 0.55)", 4);
    }
    if (this.selection?.kind === "segment") segment(this.selection.index, "#f2b01e", 4);

    // Points.
    const closable = !closed && pts.length >= 3;
    pts.forEach((p, i) => {
      const selected = this.selection?.kind === "point" && this.selection.index === i;
      const hovered = this.hover?.kind === "point" && this.hover.index === i;
      if (closable && i === 0) {
        ctx.strokeStyle = "#f2b01e";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, hovered ? 9 : 7, 0, Math.PI * 2);
        ctx.stroke();
      }
      const r = hovered || selected ? 5 : 3.5;
      ctx.fillStyle = selected ? "#f2b01e" : "#ffffff";
      ctx.strokeStyle = "rgba(10, 20, 28, 0.8)";
      ctx.lineWidth = 1.5;
      ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
      ctx.strokeRect(p.x - r, p.y - r, r * 2, r * 2);
    });
  }
}
