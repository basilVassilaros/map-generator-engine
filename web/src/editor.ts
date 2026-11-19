// The coastline pen and shape editing: drawing new shapes point by point,
// selecting shapes, segments and points, dragging points, inserting and
// deleting them, moving, resizing and rotating whole shapes, and drawing the
// guide overlay. Pan and zoom gestures are passed to the app.

import { DEFAULT_VALUES, NO_ADJUSTMENT, effective, toParams, type SliderValues } from "./params";
import { closedCurve, curvePath, segmentMiddle } from "./curve";
import { biome, DEFAULT_BIOME } from "./biomes";
import type { Guides, PlannedFeatures, Vec2 } from "./protocol";

export interface ShapeFrame {
  x: number;
  y: number;
  angle: number;
  /** 1 when drawn; resizing multiplies it, so the coastline detail scales too. */
  scale: number;
}

export type ShapeKindName = "land" | "water";

const KIND_NAMES: Record<ShapeKindName, string> = { land: "Landmass", water: "Lake" };
export const DEFAULT_LAND_M = 300;

/** A mountain (peak or range) or a river (pool or stream) drawn as points. */
export interface PathFeature {
  id: number;
  kind: FeatureKind;
  name: string;
  /** One point is a single peak or a pool; more make a range or a river (first point upstream). */
  points: Vec2[];
  seed: number;
  /** Mountain: summit height (m). */
  height: number;
  /** Mountain: how far the slopes spread (km). River: width of the water (km). */
  width: number;
  /** Mountain: 0..1 ruggedness. */
  rugged: number;
  /** 0 straight segments .. 1 a smooth curve through the points. */
  curviness: number;
  /** How far (km) each segment is bowed sideways; one per segment. */
  bends: number[];
  /** River: channel depth (m). */
  depth: number;
  hidden: boolean;
  locked: boolean;
  /** Biome regions only: the preset it started from and its climate. */
  biome?: string;
  rainfall?: number;
  humidity?: number;
  forest?: number;
  /** Mean temperature at sea level (°C), or null to follow the latitude. */
  temp?: number | null;
  /** Width of the soft edge (km). */
  feather?: number;
}

export type FeatureKind = "mountain" | "river" | "biome";
export type ToolName = "coast" | FeatureKind;

/** New mountains and rivers start moderately curved. */
export const DEFAULT_CURVINESS = 0.5;

export interface ShapeModel {
  id: number;
  name: string;
  kind: ShapeKindName;
  /** Land: height of its surface (m). Water: height of the water surface (m), unless `autoLevel`. */
  height: number;
  /** Water: take the surface level from the ground around it. */
  autoLevel: boolean;
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
  | { kind: "fpoint"; feature: number; index: number }
  | { kind: "fbend"; feature: number; index: number; from: number; start: Vec2; normal: Vec2 }
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
const MOUNTAIN_GUIDE = "#ffc978";
const RIVER_GUIDE = "#7fe3ff";
const PLANNED_RIVER = "rgba(150, 230, 255, 0.85)";
const PLANNED_HILL = "rgba(255, 214, 150, 0.8)";
const PLANNED_LAKE = "rgba(150, 230, 255, 0.9)";
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
  worldSeed = newSeed();
  /** Mountains and rivers. */
  features: PathFeature[] = [];
  /** Which pen is active. */
  tool: ToolName = "coast";
  /** Points of the mountain or river being drawn, or null. */
  featureDraft: Vec2[] | null = null;
  /** The selected mountain, river or biome region, if any. */
  featureSelected: number | null = null;
  /** What the last terrain render planned, shown faintly over the map. */
  planned: PlannedFeatures | null = null;
  showPlanned = true;
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
        height: s.kind === "water" && s.autoLevel ? -Infinity : s.height,
        points: s.points,
        params: s.adjust.map((a) => toParams(effective(s.base, a))),
      })),
      mountains: this.features
        .filter((f) => f.kind === "mountain" && !f.hidden)
        .map((f) => ({ id: f.id, seed: f.seed, height: f.height, width: f.width, rugged: f.rugged, curviness: f.curviness, bends: f.bends, points: f.points })),
      rivers: this.features
        .filter((f) => f.kind === "river" && !f.hidden)
        .map((f) => ({ id: f.id, width: f.width, depth: f.depth, curviness: f.curviness, bends: f.bends, points: f.points })),
      regions: this.features
        .filter((f) => f.kind === "biome" && !f.hidden && f.points.length >= 3)
        .map((f) => {
          const preset = biome(f.biome ?? DEFAULT_BIOME);
          return {
            id: f.id,
            rainfall: f.rainfall ?? preset.rainfall,
            humidity: f.humidity ?? preset.humidity,
            forest: f.forest ?? preset.forest,
            temp: f.temp === undefined ? preset.temp : f.temp,
            feather: f.feather ?? 40,
            points: closedCurve(f.points, f.curviness),
          };
        }),
    };
  }

  // --- mountains and rivers ---

  feature(id: number | null): PathFeature | undefined {
    return this.features.find((f) => f.id === id);
  }

  /** Pick a pen. Mountains and rivers start drawing straight away. */
  setTool(tool: ToolName): void {
    this.tool = tool;
    this.featureDraft = tool === "coast" ? null : [];
    if (tool !== "coast") {
      if (this.draft && this.shapes.length) this.draft = null;
      this.selection = null;
      this.referenceSelected = false;
      this.featureSelected = null;
    }
    this.onEdit("selection");
    this.draw();
  }

  /** Finish the mountain or river being drawn (one point is enough), or the biome region (three or more). */
  finishFeature(): void {
    const points = this.featureDraft;
    if (!points || this.tool === "coast") return;
    if (this.tool === "biome") {
      if (points.length >= 3) this.addBiome(points, DEFAULT_BIOME);
    } else if (points.length) {
      const mountain = this.tool === "mountain";
      const count = this.features.filter((f) => f.kind === this.tool).length + 1;
      const single = points.length === 1;
      this.addFeature({
        kind: mountain ? "mountain" : "river",
        name: `${mountain ? (single ? "Peak" : "Range") : single ? "Pool" : "River"} ${count}`,
        points,
        height: 2500,
        width: mountain ? 60 : single ? 20 : 4,
        rugged: 0.6,
        curviness: DEFAULT_CURVINESS,
        depth: 30,
      });
    }
    // Stay in the tool, ready to draw the next one.
    this.featureDraft = [];
    this.onEdit("selection");
    this.draw();
  }

  private addFeature(f: Omit<PathFeature, "id" | "seed" | "bends" | "hidden" | "locked"> & Partial<PathFeature>, select = true): PathFeature {
    const feature: PathFeature = { id: this.nextId++, seed: newSeed(), bends: f.points.slice(1).map(() => 0), hidden: false, locked: false, ...f };
    this.features.push(feature);
    if (select) this.featureSelected = feature.id;
    this.onEdit("shape");
    this.onEdit("list");
    return feature;
  }

  private addBiome(points: Vec2[], key: string): PathFeature {
    const preset = biome(key);
    const count = this.features.filter((f) => f.kind === "biome" && f.biome === key).length + 1;
    return this.addFeature({
      kind: "biome",
      name: `${preset.name} ${count}`,
      points,
      height: 0,
      width: 0,
      rugged: 0,
      curviness: 0.35,
      depth: 0,
      bends: [],
      biome: key,
      rainfall: preset.rainfall,
      humidity: preset.humidity,
      forest: preset.forest,
      temp: preset.temp,
      feather: 40,
    });
  }

  /** Start a region from a preset: its climate values are replaced by the preset's. */
  applyBiomePreset(id: number, key: string): void {
    const f = this.feature(id);
    if (!f || f.kind !== "biome") return;
    const preset = biome(key);
    const renamed = /^.+ \d+$/.test(f.name) && this.features.some((g) => g === f) ? `${preset.name} ${f.name.match(/(\d+)$/)?.[1] ?? ""}`.trim() : f.name;
    this.updateFeature(id, { biome: key, rainfall: preset.rainfall, humidity: preset.humidity, forest: preset.forest, temp: preset.temp, name: renamed });
  }

  /**
   * Turn what the terrain render planned into ordinary guides the user can
   * edit: rivers become rivers, hills become low ranges, lakes become water
   * shapes. The biggest of each come first; `limit` caps how many of each.
   */
  adoptPlanned(limit: number): { rivers: number; hills: number; lakes: number } {
    const plan = this.planned;
    if (!plan) return { rivers: 0, hills: 0, lakes: 0 };
    const rivers = plan.rivers.slice(0, limit);
    const hills = plan.hills.slice(0, limit);
    const lakes = plan.lakes.slice(0, Math.ceil(limit / 2));
    let n = this.features.filter((f) => f.kind === "river").length;
    for (const r of rivers) {
      this.addFeature({ kind: "river", name: `River ${++n} (planned)`, points: r.points, height: 0, width: Math.min(60, Math.max(0.2, Math.round(0.01 * Math.sqrt(r.flow) * 10) / 10)), rugged: 0, curviness: 0.5, depth: 15 }, false);
    }
    n = this.features.filter((f) => f.kind === "mountain").length;
    for (const h of hills) {
      this.addFeature({ kind: "mountain", name: `Hills ${++n} (planned)`, points: h.points, height: Math.round(h.height / 10) * 10, width: Math.max(1, Math.round(h.width)), rugged: 0.35, curviness: 0.6, depth: 0 }, false);
    }
    for (const l of lakes) {
      const b = boundingBox(l.points);
      this.shapes.push({
        id: this.nextId++,
        name: `Lake ${this.nextNumber++} (planned)`,
        kind: "water",
        // The render's spill level stands on its own hills and cut valleys, so
        // on the live map it could flood far beyond the outline: the lake
        // follows the ground instead, sitting in its hollow.
        height: Math.round(l.level),
        autoLevel: true,
        points: l.points,
        base: { ...DEFAULT_VALUES },
        adjust: l.points.map(() => ({ ...NO_ADJUSTMENT })),
        seed: newSeed(),
        frame: { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, angle: 0, scale: 1 },
        hidden: false,
        locked: false,
      });
    }
    this.planned = null;
    this.onEdit("shape");
    this.onEdit("list");
    this.draw();
    return { rivers: rivers.length, hills: hills.length, lakes: lakes.length };
  }

  setPlanned(plan: PlannedFeatures | null): void {
    this.planned = plan;
    this.draw();
  }

  selectFeature(id: number | null): void {
    this.featureDraft = this.tool === "coast" ? null : this.featureDraft && !this.featureDraft.length ? [] : null;
    if (id !== null) this.featureDraft = null;
    this.selection = null;
    this.referenceSelected = false;
    this.featureSelected = id;
    this.onEdit("selection");
    this.draw();
  }

  updateFeature(
    id: number,
    change: Partial<Pick<PathFeature, "name" | "height" | "width" | "rugged" | "depth" | "curviness" | "bends" | "hidden" | "locked" | "biome" | "rainfall" | "humidity" | "forest" | "temp" | "feather">>,
  ): void {
    const f = this.feature(id);
    if (!f) return;
    Object.assign(f, change);
    this.onEdit("shape");
    this.onEdit("list");
    this.draw();
  }

  deleteFeature(id: number): void {
    this.features = this.features.filter((f) => f.id !== id);
    if (this.featureSelected === id) this.featureSelected = null;
    this.onEdit("shape");
    this.onEdit("list");
    this.onEdit("selection");
    this.draw();
  }

  private hitFeature(p: Vec2): PathFeature | null {
    const limit = SEGMENT_HIT_PX * this.kmPerPx();
    let best: PathFeature | null = null;
    let bestDist = limit;
    for (const f of this.features) {
      if (f.hidden || f.locked) continue;
      const pts = f.kind === "biome" ? [...closedCurve(f.points, f.curviness), f.points[0]] : curvePath(f.points, f.curviness, f.bends);
      for (let i = 0; i < Math.max(1, pts.length - 1); i++) {
        const a = pts[i];
        const b = pts[Math.min(i + 1, pts.length - 1)];
        const abx = b.x - a.x;
        const aby = b.y - a.y;
        const len2 = abx * abx + aby * aby || 1;
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2));
        const d = Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
        if (d < bestDist) {
          best = f;
          bestDist = d;
        }
      }
    }
    return best;
  }

  /** The smallest biome region containing `p` (only with the biome pen, so regions never get in the way of other edits). */
  private hitRegion(p: Vec2): PathFeature | null {
    if (this.tool !== "biome") return null;
    const inside = this.features.filter((f) => f.kind === "biome" && !f.hidden && !f.locked && f.points.length >= 3 && insidePolygon(p, f.points));
    const area = (f: PathFeature) => {
      const b = boundingBox(f.points);
      return (b.x1 - b.x0) * (b.y1 - b.y0);
    };
    return inside.sort((a, b) => area(a) - area(b))[0] ?? null;
  }

  // --- variations and project files ---

  /** New noise for everything that isn't locked: a fresh variation of the same design. */
  reseed(): void {
    this.worldSeed = newSeed();
    for (const s of this.shapes) if (!s.locked) s.seed = newSeed();
    for (const f of this.features) if (!f.locked) f.seed = newSeed();
    this.onEdit("shape");
  }

  /** Everything needed to rebuild the map (the reference image is added by the app). */
  serialize(): { worldSeed: number; mapWidthKm: number; shapes: ShapeModel[]; features: PathFeature[] } {
    return structuredClone({ worldSeed: this.worldSeed, mapWidthKm: this.extentKm, shapes: this.shapes, features: this.features });
  }

  /** Replace the whole map with a saved one. */
  restore(data: { worldSeed: number; mapWidthKm: number; shapes: ShapeModel[]; features?: PathFeature[] }): void {
    this.worldSeed = data.worldSeed;
    this.extentKm = data.mapWidthKm;
    this.shapes = structuredClone(data.shapes);
    this.features = structuredClone(data.features ?? []).map((f) => ({
      ...f,
      // Files from before curves open straight, exactly as they were drawn.
      curviness: f.curviness ?? 0,
      bends: f.bends ?? f.points.slice(1).map(() => 0),
    }));
    this.nextId = Math.max(0, ...this.shapes.map((s) => s.id), ...this.features.map((f) => f.id)) + 1;
    this.nextNumber = this.shapes.length + 1;
    this.draft = this.shapes.length ? null : [];
    this.featureDraft = null;
    this.tool = "coast";
    this.selection = null;
    this.featureSelected = null;
    this.referenceSelected = false;
    this.onEdit("shape");
    this.onEdit("list");
    this.onEdit("selection");
    this.draw();
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
    this.featureSelected = null;
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
    this.featureSelected = null;
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

  /** Make a shape land or water. Default names follow the kind. */
  setKind(id: number, kind: ShapeKindName): void {
    const s = this.shape(id);
    if (!s || s.locked || s.kind === kind) return;
    s.kind = kind;
    const match = /^(Landmass|Lake) (\d+)$/.exec(s.name);
    if (match) s.name = `${KIND_NAMES[kind]} ${match[2]}`;
    this.onEdit("shape");
    this.onEdit("selection");
    this.draw();
  }

  /** Whether a water shape takes its level from the ground around it. */
  setAutoLevel(id: number, auto: boolean): void {
    const s = this.shape(id);
    if (!s || s.locked) return;
    s.autoLevel = auto;
    this.onEdit("shape");
    this.onEdit("selection");
  }

  /** Move a shape up or down the stack: where land shapes cross, the later one is on top. */
  restack(id: number, by: -1 | 1): void {
    const i = this.shapes.findIndex((s) => s.id === id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= this.shapes.length) return;
    [this.shapes[i], this.shapes[j]] = [this.shapes[j], this.shapes[i]];
    this.onEdit("shape");
    this.onEdit("list");
  }

  /** A shape's height in metres: land surface, or water level. */
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
    this.features = [];
    this.featureDraft = null;
    this.featureSelected = null;
    this.tool = "coast";
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
      this.startPan(e, this.draft?.length || this.featureDraft?.length ? "undo-point" : "none");
      return;
    }
    if (e.button !== 0) return;
    const p = this.toKm(e);

    // Mountains and rivers: drag a point of the selected one, select one by
    // clicking its line, or (with that pen active) add points to a new one.
    const chosen = this.feature(this.featureSelected);
    if (chosen && !chosen.locked && !chosen.hidden) {
      for (let i = 0; i < (chosen.kind === "biome" ? 0 : chosen.points.length - 1); i++) {
        const mid = segmentMiddle(chosen.points, chosen.curviness, chosen.bends, i);
        if (Math.hypot(mid.at.x - p.x, mid.at.y - p.y) <= HANDLE_HIT_PX * this.kmPerPx()) {
          this.drag = { kind: "fbend", feature: chosen.id, index: i, from: chosen.bends[i] ?? 0, start: mid.at, normal: mid.normal };
          this.overlay.setPointerCapture(e.pointerId);
          return;
        }
      }
      const index = this.hitPoint(p, chosen.points);
      if (index !== null) {
        this.drag = { kind: "fpoint", feature: chosen.id, index };
        this.overlay.setPointerCapture(e.pointerId);
        return;
      }
    }
    if (!this.featureDraft?.length && !this.draft?.length) {
      const hit = this.hitFeature(p);
      if (hit) {
        this.selectFeature(hit.id);
        return;
      }
      // With the biome pen, a click inside a region selects it; a second click
      // inside the selected region starts a new one there (regions can nest).
      const region = this.hitRegion(p);
      if (region && region.id !== this.featureSelected) {
        this.selectFeature(region.id);
        this.featureDraft = [];
        return;
      }
    }
    if (this.tool !== "coast" && this.featureDraft) {
      // A biome region closes by clicking its first point.
      if (this.tool === "biome" && this.featureDraft.length >= 3 && this.hitPoint(p, [this.featureDraft[0]]) === 0) {
        this.finishFeature();
        return;
      }
      if (this.onMap(p)) {
        this.featureDraft.push(p);
        this.featureSelected = null;
        this.onEdit("selection");
        this.draw();
      }
      return;
    }

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
      height: DEFAULT_LAND_M,
      autoLevel: true,
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
    if (drag?.kind === "fbend") {
      const f = this.feature(drag.feature);
      if (f) {
        // Moving the handle sideways bows the segment by the same amount.
        f.bends[drag.index] = drag.from + (p.x - drag.start.x) * drag.normal.x + (p.y - drag.start.y) * drag.normal.y;
        this.onEdit("shape");
      }
    } else if (drag?.kind === "fpoint") {
      const f = this.feature(drag.feature);
      if (f) {
        f.points[drag.index] = this.clampToMap(p);
        this.onEdit("shape");
      }
    } else if (drag?.kind === "point") {
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
      if (drag.onClick === "undo-point" && this.featureDraft?.length) {
        this.featureDraft.pop();
        this.onEdit("selection");
      } else if (drag.onClick === "undo-point" && this.draft?.length) {
        this.draft.pop();
        this.onEdit("selection");
      } else if (drag.onClick === "deselect" && (this.selection || this.referenceSelected || this.featureSelected !== null)) {
        this.selection = null;
        this.referenceSelected = false;
        this.featureSelected = null;
        this.onEdit("selection");
      }
    }
    if (drag.kind !== "pan") this.onEdit("selection");
    this.overlay.style.cursor = this.cursorStyle(e);
    this.draw();
  }

  private doubleClick(e: MouseEvent): void {
    if (this.tool !== "coast" && this.featureDraft?.length) {
      // The double-click's two clicks each added a point: drop the repeat.
      if (this.featureDraft.length > 1) this.featureDraft.pop();
      this.finishFeature();
      return;
    }
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
    if (e.key === "Enter" && this.featureDraft?.length) {
      this.finishFeature();
      return;
    }
    if (e.key === "Escape" && this.tool !== "coast") {
      if (this.featureDraft?.length) this.featureDraft = [];
      else this.setTool("coast");
      this.onEdit("selection");
      this.draw();
      return;
    }
    if ((e.key === "Backspace" || e.key === "Delete") && this.featureDraft?.length) {
      this.featureDraft.pop();
      this.onEdit("selection");
      this.draw();
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
        this.featureSelected = null;
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
    if (this.drag?.kind === "point" || this.drag?.kind === "fpoint" || this.drag?.kind === "fbend") return "grabbing";
    if (this.tool !== "coast" && this.featureDraft) return "crosshair";
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
    for (const f of this.features) if (!f.hidden && f.kind === "biome") this.drawRegion(f.points, f.biome ?? DEFAULT_BIOME, f.id === this.featureSelected, f.locked, f.curviness, false);
    if (this.planned && this.showPlanned) this.drawPlanned(this.planned);
    for (const f of this.features) if (!f.hidden && f.kind !== "biome") this.drawFeature(f.points, f.kind as "mountain" | "river", f.id === this.featureSelected, f.locked, f.curviness, f.bends);
    if (this.featureDraft?.length && this.tool !== "coast") {
      const pts = this.cursor ? [...this.featureDraft, this.cursor] : this.featureDraft;
      if (this.tool === "biome") this.drawRegion(pts, DEFAULT_BIOME, true, false, 0, true);
      else this.drawFeature(pts, this.tool, true, false, DEFAULT_CURVINESS, []);
    }
    const selected = this.selectedShape();
    if (selected && !selected.hidden && this.selection?.kind === "shape" && !selected.locked) this.drawHandles(selected);
    const ref = this.movableReference();
    if (ref) this.drawImageHandles(ref);
    if (this.draft) this.drawDraft(this.draft);
    this.drawScale();
  }

  /** A biome region: a tinted, dashed outline. While drawing (`open`), the closing edge isn't filled in yet. */
  private drawRegion(points: Vec2[], key: string, selected: boolean, locked: boolean, curviness: number, open: boolean): void {
    const ctx = this.ctx;
    const preset = biome(key);
    const outline = (open ? points : closedCurve(points, curviness)).map((p) => this.toPx(p));
    ctx.lineJoin = "round";
    if (outline.length >= 3 && !open) {
      this.path(outline, true);
      ctx.fillStyle = preset.colour;
      ctx.globalAlpha = selected ? 0.32 : 0.2;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (outline.length > 1) {
      this.path(outline, !open);
      ctx.strokeStyle = HALO;
      ctx.lineWidth = selected ? 5 : 4;
      ctx.stroke();
      this.path(outline, !open);
      ctx.strokeStyle = selected ? HIGHLIGHT : "#f1f5e8";
      ctx.globalAlpha = locked ? 0.55 : selected ? 1 : 0.85;
      ctx.lineWidth = selected ? 2 : 1.4;
      ctx.setLineDash([3, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
    if (!selected) return;
    points.forEach((v, i) => {
      const p = this.toPx(v);
      ctx.beginPath();
      ctx.rect(p.x - (i === 0 && open ? 5 : 4), p.y - (i === 0 && open ? 5 : 4), i === 0 && open ? 10 : 8, i === 0 && open ? 10 : 8);
      ctx.fillStyle = i === 0 && open && points.length >= 4 ? HIGHLIGHT : "#ffffff";
      ctx.strokeStyle = "rgba(10, 20, 28, 0.8)";
      ctx.lineWidth = 1.5;
      ctx.fill();
      ctx.stroke();
    });
  }

  /** What the terrain render planned: thin lines, so the user's own guides stay clear. */
  private drawPlanned(plan: PlannedFeatures): void {
    const ctx = this.ctx;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const l of plan.lakes) {
      this.path(l.points.map((p) => this.toPx(p)), true);
      ctx.strokeStyle = PLANNED_LAKE;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([2, 3]);
      ctx.stroke();
    }
    for (const h of plan.hills) {
      this.path(h.points.map((p) => this.toPx(p)), false);
      ctx.strokeStyle = PLANNED_HILL;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([5, 4]);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const r of plan.rivers) {
      this.path(r.points.map((p) => this.toPx(p)), false);
      ctx.strokeStyle = PLANNED_RIVER;
      ctx.lineWidth = Math.min(2.5, 0.6 + 0.25 * Math.log10(r.flow + 1));
      ctx.stroke();
    }
    ctx.lineCap = "butt";
  }

  /** A mountain or river: its line, or a marker for a single point. */
  private drawFeature(points: Vec2[], kind: "mountain" | "river", selected: boolean, locked: boolean, curviness: number, bends: number[]): void {
    const ctx = this.ctx;
    const pts = curvePath(points, curviness, bends).map((p) => this.toPx(p));
    const marks = points.map((p) => this.toPx(p));
    const ink = kind === "mountain" ? MOUNTAIN_GUIDE : RIVER_GUIDE;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    if (pts.length > 1) {
      this.path(pts, false);
      ctx.strokeStyle = HALO;
      ctx.lineWidth = selected ? 5 : 4;
      ctx.stroke();
      this.path(pts, false);
      ctx.strokeStyle = ink;
      ctx.globalAlpha = locked ? 0.55 : selected ? 1 : 0.8;
      ctx.lineWidth = selected ? 2.25 : 1.5;
      ctx.setLineDash(kind === "mountain" ? [7, 4] : []);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
    ctx.lineCap = "butt";
    // Bend handles: grab one to bow its segment sideways.
    if (selected && !locked && points.length > 1 && points.length === bends.length + 1) {
      for (let i = 0; i < points.length - 1; i++) {
        const m = this.toPx(segmentMiddle(points, curviness, bends, i).at);
        ctx.beginPath();
        ctx.moveTo(m.x, m.y - 5.5);
        ctx.lineTo(m.x + 5.5, m.y);
        ctx.lineTo(m.x, m.y + 5.5);
        ctx.lineTo(m.x - 5.5, m.y);
        ctx.closePath();
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = ink;
        ctx.lineWidth = 1.75;
        ctx.fill();
        ctx.stroke();
      }
    }
    marks.forEach((p, i) => {
      if (marks.length > 1 && !selected) return;
      if (kind === "mountain") {
        // A small summit triangle.
        const r = marks.length === 1 ? 7 : 5;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y - r);
        ctx.lineTo(p.x + r, p.y + r * 0.8);
        ctx.lineTo(p.x - r, p.y + r * 0.8);
        ctx.closePath();
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, marks.length === 1 ? 6 : i === 0 ? 5 : 4, 0, Math.PI * 2);
      }
      ctx.fillStyle = selected ? ink : "#ffffff";
      ctx.strokeStyle = "rgba(10, 20, 28, 0.8)";
      ctx.lineWidth = 1.5;
      ctx.fill();
      ctx.stroke();
    });
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
    const ink = shape.kind === "water" ? WATER_GUIDE : GUIDE;
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
