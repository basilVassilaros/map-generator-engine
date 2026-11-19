//! The engine owns the world rasters and keeps them in sync with the guides.
//!
//! The guides (a list of shapes) are the source of truth. When new guides
//! arrive, the engine compares them with what it had, works out which cells
//! the change can affect, and regenerates only those. Results are identical
//! to regenerating the whole map; `tests/incremental.rs` holds it to that.
//!
//! The map is built in two tiers.
//!
//! **Tier 1, the ground**, is local: each cell depends only on nearby shapes
//! and mountains, so an edit recomputes just the cells it can reach. Shapes
//! combine in list order, starting from open ocean. A land shape adds land
//! at its own height (stepping up or down from any land beneath, with an
//! escarpment at its edge); a water shape cuts a lake, sea or bay out of
//! whatever came before. Mountains then add their height on top.
//!
//! **Tier 2, water that depends on connections**, covers the whole map:
//! drawn rivers carve their channels downhill, and land lying below the
//! surface of water it touches floods. A basin below sea level that no
//! water reaches stays dry land. This tier is cheap, so it reruns in full
//! after every edit, and only the cells it changed are redrawn.
//!
//! Water is tracked separately from elevation: each cell knows whether it is
//! water and the height of its surface.

use crate::coast::{
    coast_bands, coast_rise, coastal_displacement, distance_to_segment, highland_rise, inland_base,
    lake_depth, ocean_depth, CoastBands, Coastline, Frame, SegmentParams, Shape, ShapeKind,
    AUTO_LEVEL, CLAMP_KM, MAX_HEIGHT_M, MIN_HEIGHT_M,
};
use crate::features::{curve_path, nearest_on_path, Mountain, Region, River};
use crate::render;

/// Cell kinds in `Engine::water`.
pub const LAND: u8 = 0;
pub const OCEAN: u8 = 1;
pub const LAKE: u8 = 2;
/// Land that flooded because it lies below water it touches.
pub const FLOODED: u8 = 3;
pub const RIVER: u8 = 4;
/// A drawn pool (a river feature with a single point): standing water.
pub const POOL: u8 = 5;

/// Elevation of an empty map (open ocean), in metres.
pub const EMPTY_ELEVATION: f32 = -3680.0;

/// Half-open rectangle of cells: x0 <= x < x1, y0 <= y < y1.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Rect {
    pub x0: u32,
    pub y0: u32,
    pub x1: u32,
    pub y1: u32,
}

impl Rect {
    pub const EMPTY: Rect = Rect { x0: 0, y0: 0, x1: 0, y1: 0 };

    pub fn width(&self) -> u32 {
        self.x1.saturating_sub(self.x0)
    }

    pub fn height(&self) -> u32 {
        self.y1.saturating_sub(self.y0)
    }

    pub fn is_empty(&self) -> bool {
        self.width() == 0 || self.height() == 0
    }

    pub fn cells(&self) -> u64 {
        self.width() as u64 * self.height() as u64
    }

    #[inline]
    pub fn contains(&self, x: u32, y: u32) -> bool {
        x >= self.x0 && x < self.x1 && y >= self.y0 && y < self.y1
    }

    pub fn union(self, other: Rect) -> Rect {
        if self.is_empty() {
            return other;
        }
        if other.is_empty() {
            return self;
        }
        Rect {
            x0: self.x0.min(other.x0),
            y0: self.y0.min(other.y0),
            x1: self.x1.max(other.x1),
            y1: self.y1.max(other.y1),
        }
    }

    pub fn intersect(self, other: Rect) -> Rect {
        let r = Rect {
            x0: self.x0.max(other.x0),
            y0: self.y0.max(other.y0),
            x1: self.x1.min(other.x1),
            y1: self.y1.min(other.y1),
        };
        if r.is_empty() {
            Rect::EMPTY
        } else {
            r
        }
    }

    pub fn grow(self, by: u32, width: u32, height: u32) -> Rect {
        if self.is_empty() {
            return self;
        }
        Rect {
            x0: self.x0.saturating_sub(by),
            y0: self.y0.saturating_sub(by),
            x1: (self.x1 + by).min(width),
            y1: (self.y1 + by).min(height),
        }
    }
}

/// Per-shape caches, covering only the cells the shape can reach.
struct ShapeCache {
    rect: Rect,
    /// Distance to the nearest segment (clamped), which segment, where along it.
    dist: Vec<f32>,
    nearest: Vec<u32>,
    along: Vec<f32>,
    inside: Vec<bool>,
    /// Coastline noise in the shape's own frame. Depends on seed and frame.
    /// Only filled near the coast (where `nearest` is set); see `MISSING`.
    bands: Vec<CoastBands>,
}

/// Marks noise not yet computed for a cell. Cells far from the coast never
/// use noise, so it's computed lazily, only where a segment is in reach.
const MISSING: CoastBands = CoastBands { big: f32::NAN, mid: 0.0, small: 0.0, rough: 0.0 };

impl ShapeCache {
    fn new(rect: Rect, clamp: f32) -> Self {
        let n = rect.cells() as usize;
        Self {
            rect,
            dist: vec![clamp; n],
            nearest: vec![u32::MAX; n],
            along: vec![0.0; n],
            inside: vec![false; n],
            bands: vec![MISSING; n],
        }
    }

    #[inline]
    fn index(&self, x: u32, y: u32) -> usize {
        ((y - self.rect.y0) * self.rect.width() + (x - self.rect.x0)) as usize
    }
}

/// Work queued while comparing old and new guides.
enum Task {
    /// Recompute every cell in the rectangle.
    All(Rect),
    /// Recompute only cells whose nearest segment of shape `shape` is flagged.
    Retuned { rect: Rect, shape: usize, segments: Vec<bool> },
}

pub struct Engine {
    width: u32,
    height: u32,
    /// World position (km) of the top-left corner of cell (0, 0).
    origin: [f32; 2],
    cell_km: f32,
    /// Tier 1: the ground from shapes and mountains.
    g_elev: Vec<f32>,
    g_shore: Vec<f32>,
    g_surface: Vec<f32>,
    g_water: Vec<u8>,
    /// How many land cells lie below the water nearest them. While this is
    /// zero nothing can flood, so the whole-map flood pass is skipped.
    low_land: i64,
    /// The finished map, after rivers and flooding.
    elevation: Vec<f32>,
    /// Signed distance (km) to the coastline: positive on land, negative in
    /// water. Lets the renderer blend land and water across the edge.
    shore: Vec<f32>,
    /// Height (metres) of the water surface, for water cells.
    surface: Vec<f32>,
    /// What each cell is: see the `LAND`, `OCEAN`... constants.
    water: Vec<u8>,
    /// Cells tier 2 changed last time, so they can be put back before it reruns.
    touched: Vec<u32>,
    mountains: Vec<Mountain>,
    rivers: Vec<River>,
    /// Biome regions: they shape the terrain render, not the live map.
    regions: Vec<Region>,
    rgba: Vec<u8>,
    /// Width (pixels) of the land/water blend along coastlines. 0 = off.
    smoothing: f32,
    world_seed: u32,
    /// Lowland height, anchored to the world. Depends only on the world seed.
    base: Vec<f32>,
    base_seed: Option<u32>,
    shapes: Vec<Shape>,
    caches: Vec<ShapeCache>,
}

impl Engine {
    /// A whole map whose top-left corner is at the world origin.
    /// `extent_km` is the real width of the map. Cells are square.
    pub fn new(width: u32, height: u32, extent_km: f32) -> Self {
        Self::window(width, height, [0.0, 0.0], extent_km / width as f32)
    }

    /// Any window onto the world: `origin` is the world position (km) of the
    /// top-left corner, `cell_km` the size of one cell. A zoomed-in view uses
    /// a small window with small cells; noise is placed by world position (or
    /// by shape frame), so the window lines up exactly with the whole map.
    pub fn window(width: u32, height: u32, origin: [f32; 2], cell_km: f32) -> Self {
        let cells = width as usize * height as usize;
        let mut engine = Self {
            width,
            height,
            origin,
            cell_km,
            g_elev: vec![EMPTY_ELEVATION; cells],
            g_shore: vec![-CLAMP_KM; cells],
            g_surface: vec![0.0; cells],
            g_water: vec![OCEAN; cells],
            low_land: 0,
            elevation: vec![EMPTY_ELEVATION; cells],
            shore: vec![-CLAMP_KM; cells],
            surface: vec![0.0; cells],
            water: vec![OCEAN; cells],
            touched: Vec::new(),
            mountains: Vec::new(),
            rivers: Vec::new(),
            regions: Vec::new(),
            rgba: vec![0; cells * 4],
            smoothing: 0.0,
            world_seed: 0,
            base: Vec::new(),
            base_seed: None,
            shapes: Vec::new(),
            caches: Vec::new(),
        };
        engine.shade(engine.full_rect());
        engine
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    pub fn elevation(&self) -> &[f32] {
        &self.elevation
    }

    /// Signed distance (km) to the coastline: negative means water.
    pub fn shore(&self) -> &[f32] {
        &self.shore
    }

    /// Water surface height (metres) for water cells.
    pub fn surface(&self) -> &[f32] {
        &self.surface
    }

    /// The ground before rivers were cut into it and before any flooding.
    pub fn ground(&self) -> &[f32] {
        &self.g_elev
    }

    pub fn mountains(&self) -> &[Mountain] {
        &self.mountains
    }

    /// The drawn rivers, with their curves.
    pub fn rivers(&self) -> &[River] {
        &self.rivers
    }

    pub fn regions(&self) -> &[Region] {
        &self.regions
    }

    /// Replace the biome regions. They only affect the terrain render.
    pub fn set_regions(&mut self, regions: Vec<Region>) {
        self.regions = regions.into_iter().filter(|r| r.points.len() >= 3).collect();
    }

    /// The cell containing a world position, if it is on the map.
    pub fn cell_at(&self, p: [f32; 2]) -> Option<usize> {
        self.cell_of(p)
    }

    /// What each cell is: `LAND`, `OCEAN`, `LAKE`, `FLOODED`, `RIVER` or `POOL`.
    pub fn water(&self) -> &[u8] {
        &self.water
    }

    pub fn cell_km(&self) -> f32 {
        self.cell_km
    }

    pub fn origin(&self) -> [f32; 2] {
        self.origin
    }

    pub fn rgba(&self) -> &[u8] {
        &self.rgba
    }

    pub fn shapes(&self) -> &[Shape] {
        &self.shapes
    }

    /// Set the edge smoothing width in pixels. Only recolours: the terrain is
    /// unchanged. Returns the pixels that changed.
    pub fn set_smoothing(&mut self, pixels: f32) -> Rect {
        let pixels = if pixels.is_finite() { pixels.clamp(0.0, 4.0) } else { 0.0 };
        if pixels == self.smoothing {
            return Rect::EMPTY;
        }
        self.smoothing = pixels;
        let all = self.full_rect();
        self.shade(all);
        all
    }

    pub fn full_rect(&self) -> Rect {
        Rect { x0: 0, y0: 0, x1: self.width, y1: self.height }
    }

    /// Convenience for a single coastline (id 0, frame at the origin).
    pub fn set_coast(&mut self, coast: Option<Coastline>) -> Rect {
        let seed = coast.as_ref().map_or(0, |c| c.seed);
        let shapes = coast.into_iter().map(|c| Shape { id: 0, coast: c, frame: Default::default(), kind: ShapeKind::Land, height: 300.0 }).collect();
        self.set_shapes(seed, shapes)
    }

    /// Replace the shapes, keeping the current mountains and rivers.
    pub fn set_shapes(&mut self, world_seed: u32, shapes: Vec<Shape>) -> Rect {
        let (mountains, rivers) = (self.mountains.clone(), self.rivers.clone());
        self.set_guides(world_seed, shapes, mountains, rivers)
    }

    /// Replace the guides. Returns the rectangle of pixels that changed
    /// (empty if nothing did).
    pub fn set_guides(&mut self, world_seed: u32, shapes: Vec<Shape>, mountains: Vec<Mountain>, rivers: Vec<River>) -> Rect {
        let mut dirty = self.update_ground(world_seed, shapes);

        // Mountains: any that changed, appeared or went redo their footprint.
        let mut mountains: Vec<Mountain> = mountains
            .into_iter()
            .filter(|m| !m.points.is_empty() && m.height.is_finite() && m.width_km.is_finite())
            .map(|mut m| {
                m.height = m.height.clamp(0.0, 9000.0);
                m.width_km = m.width_km.clamp(1.0, 400.0);
                m.rugged = m.rugged.clamp(0.0, 1.0);
                m.path = curve_path(&m.points, m.curviness, &m.bends);
                m.rect = self.path_rect(&m.path, m.reach_km());
                m
            })
            .collect();
        std::mem::swap(&mut self.mountains, &mut mountains);
        let old = mountains;
        let mut redo = Rect::EMPTY;
        for m in &self.mountains {
            if !old.contains(m) {
                redo = redo.union(m.rect);
            }
        }
        for m in &old {
            if !self.mountains.contains(m) {
                redo = redo.union(m.rect);
            }
        }
        if !redo.is_empty() && self.base_seed.is_none() {
            self.compute_base();
        }
        if !redo.is_empty() {
            dirty = dirty.union(self.compute_terrain(redo.intersect(self.full_rect()), None));
        }

        self.rivers = rivers
            .into_iter()
            .filter(|r| !r.points.is_empty())
            .map(|mut r| {
                r.path = curve_path(&r.points, r.curviness, &r.bends);
                r
            })
            .collect();
        self.finish(dirty)
    }

    /// Tier 1 for shapes: returns the cells whose ground changed.
    fn update_ground(&mut self, world_seed: u32, shapes: Vec<Shape>) -> Rect {
        let shapes: Vec<Shape> = shapes
            .into_iter()
            .filter(|s| s.coast.is_valid())
            .map(|mut s| {
                for p in s.coast.params.iter_mut() {
                    *p = p.sanitized();
                }
                if s.height != AUTO_LEVEL || s.kind == ShapeKind::Land {
                    let h = if s.height.is_finite() { s.height } else { 0.0 };
                    s.height = h.clamp(MIN_HEIGHT_M, MAX_HEIGHT_M);
                }
                s
            })
            .collect();

        if world_seed != self.world_seed || (self.base_seed.is_none() && !shapes.is_empty()) {
            // The relief under every shape changes: start over.
            self.world_seed = world_seed;
            self.compute_base();
            self.shapes = shapes;
            self.caches = (0..self.shapes.len()).map(|k| self.build_cache(k, None)).collect();
            let all = self.full_rect();
            self.compute_terrain(all, None);
            return all;
        }

        let old_shapes = std::mem::take(&mut self.shapes);
        let mut old_caches: Vec<Option<ShapeCache>> = std::mem::take(&mut self.caches).into_iter().map(Some).collect();
        self.shapes = shapes;
        let mut tasks: Vec<Task> = Vec::new();
        let mut caches: Vec<ShapeCache> = Vec::with_capacity(self.shapes.len());

        for k in 0..self.shapes.len() {
            let id = self.shapes[k].id;
            let previous = old_shapes.iter().position(|s| s.id == id);
            let Some(j) = previous else {
                // A new shape.
                let cache = self.build_cache(k, None);
                tasks.push(Task::All(cache.rect));
                caches.push(cache);
                continue;
            };
            let old = &old_shapes[j];
            let old_cache = old_caches[j].take().expect("each old shape is matched once");
            let new = &self.shapes[k];

            if old.kind != new.kind || old.height != new.height {
                // Kind or height changed: everything it reaches changes.
                tasks.push(Task::All(old_cache.rect));
                if old.coast == new.coast && old.frame == new.frame {
                    caches.push(old_cache);
                } else {
                    let cache = self.build_cache(k, None);
                    tasks.push(Task::All(cache.rect));
                    caches.push(cache);
                }
                continue;
            }

            if old.coast.seed != new.coast.seed || old.frame != new.frame || old.coast.len() != new.coast.len() {
                // Moved, rotated, scaled, reseeded, or points added/removed:
                // rebuild this shape. Its old and new areas both change.
                let keep_bands = old.coast.seed == new.coast.seed && old.frame == new.frame;
                let old_rect = old_cache.rect;
                let cache = self.build_cache(k, keep_bands.then_some(old_cache));
                tasks.push(Task::All(old_rect.union(cache.rect)));
                caches.push(cache);
                continue;
            }

            let n = new.coast.len();
            let mut moved = vec![false; n];
            let mut retuned = vec![false; n];
            for i in 0..n {
                if old.coast.points[i] != new.coast.points[i] {
                    // A point belongs to the segment ending and the one starting there.
                    moved[(i + n - 1) % n] = true;
                    moved[i] = true;
                }
                if old.coast.params[i] != new.coast.params[i] {
                    // Parameters blend into both neighbouring segments.
                    retuned[(i + n - 1) % n] = true;
                    retuned[i] = true;
                    retuned[(i + 1) % n] = true;
                }
            }

            if moved.iter().any(|m| *m) {
                let either: Vec<bool> = moved.iter().zip(&retuned).map(|(m, r)| *m || *r).collect();
                let touched = self.reach_of(&old.coast, &old.frame, &either).union(self.reach_of(&new.coast, &new.frame, &either));
                if self.shape_rect(new) != old_cache.rect {
                    // The shape's reach grew or shrank: rebuild its caches,
                    // keeping the noise where the areas overlap.
                    let cache = self.build_cache(k, Some(old_cache));
                    caches.push(cache);
                } else {
                    let mut cache = old_cache;
                    let r = touched.intersect(cache.rect);
                    self.compute_geometry(k, &mut cache, r);
                    caches.push(cache);
                }
                tasks.push(Task::All(touched));
            } else if retuned.iter().any(|r| *r) {
                // Only sliders changed: geometry is still valid, and only
                // cells whose nearest segment was retuned can change.
                let rect = self.reach_of(&new.coast, &new.frame, &retuned);
                tasks.push(Task::Retuned { rect, shape: k, segments: retuned });
                caches.push(old_cache);
            } else {
                caches.push(old_cache);
            }
        }
        // Removed shapes leave their area to be recomputed.
        for cache in old_caches.into_iter().flatten() {
            tasks.push(Task::All(cache.rect));
        }
        self.caches = caches;

        // Order decides how shapes combine. If the relative order of shapes
        // that exist before and after changed, redo every shape that moved.
        let kept_old: Vec<u32> = old_shapes.iter().map(|s| s.id).filter(|id| self.shapes.iter().any(|n| n.id == *id)).collect();
        let kept_new: Vec<u32> = self.shapes.iter().map(|s| s.id).filter(|id| kept_old.contains(id)).collect();
        if kept_old != kept_new {
            for (i, id) in kept_new.iter().enumerate() {
                if kept_old[i] != *id {
                    let k = self.shapes.iter().position(|s| s.id == *id).expect("kept shape exists");
                    tasks.push(Task::All(self.caches[k].rect));
                }
            }
        }

        let mut changed = Rect::EMPTY;
        for task in tasks {
            let written = match task {
                Task::All(rect) => self.compute_terrain(rect.intersect(self.full_rect()), None),
                Task::Retuned { rect, shape, segments } => {
                    self.compute_terrain(rect.intersect(self.full_rect()), Some((shape, &segments)))
                }
            };
            changed = changed.union(written);
        }
        changed
    }

    /// Cells within `reach_km` of a path.
    fn path_rect(&self, pts: &[[f32; 2]], reach_km: f32) -> Rect {
        let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
        for p in pts {
            x0 = x0.min(p[0]);
            y0 = y0.min(p[1]);
            x1 = x1.max(p[0]);
            y1 = y1.max(p[1]);
        }
        self.km_box_to_cells(x0 - reach_km, y0 - reach_km, x1 + reach_km, y1 + reach_km)
    }

    #[inline]
    fn cell_of(&self, p: [f32; 2]) -> Option<usize> {
        let x = ((p[0] - self.origin[0]) / self.cell_km).floor();
        let y = ((p[1] - self.origin[1]) / self.cell_km).floor();
        if x < 0.0 || y < 0.0 || x >= self.width as f32 || y >= self.height as f32 {
            return None;
        }
        Some(y as usize * self.width as usize + x as usize)
    }

    #[inline]
    fn restore(&mut self, i: usize) {
        self.elevation[i] = self.g_elev[i];
        self.shore[i] = self.g_shore[i];
        self.surface[i] = self.g_surface[i];
        self.water[i] = self.g_water[i];
    }

    fn bounds_of(&self, cells: &[u32]) -> Rect {
        let mut r = Rect::EMPTY;
        let (mut x0, mut y0, mut x1, mut y1) = (u32::MAX, u32::MAX, 0, 0);
        for &i in cells {
            let (x, y) = (i % self.width, i / self.width);
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x + 1);
            y1 = y1.max(y + 1);
        }
        if !cells.is_empty() {
            r = Rect { x0, y0, x1, y1 };
        }
        r
    }

    /// Tier 2: rivers and flooding over the whole map, from the tier 1
    /// ground. `dirty` is the ground that changed. Returns the pixels to redraw.
    fn finish(&mut self, dirty: Rect) -> Rect {
        let before = std::mem::take(&mut self.touched);
        let mut changed = dirty.union(self.bounds_of(&before));
        for &i in &before {
            self.restore(i as usize);
        }
        for cy in dirty.y0..dirty.y1 {
            let a = (cy * self.width + dirty.x0) as usize;
            let b = (cy * self.width + dirty.x1) as usize;
            self.elevation[a..b].copy_from_slice(&self.g_elev[a..b]);
            self.shore[a..b].copy_from_slice(&self.g_shore[a..b]);
            self.surface[a..b].copy_from_slice(&self.g_surface[a..b]);
            self.water[a..b].copy_from_slice(&self.g_water[a..b]);
        }
        let rivers = std::mem::take(&mut self.rivers);
        for river in &rivers {
            self.carve(river);
        }
        self.rivers = rivers;
        self.flood();
        changed = changed.union(self.bounds_of(&self.touched));
        if changed.is_empty() {
            return Rect::EMPTY;
        }
        let pixels = changed.grow(1, self.width, self.height);
        self.shade(pixels);
        pixels
    }

    /// Land below the surface of water it touches becomes part of that
    /// water. Spreads cell to cell, so it follows the ground: a basin that no
    /// water can reach stays dry however low it lies.
    fn flood(&mut self) {
        if self.low_land == 0 {
            return;
        }
        let (w, h) = (self.width as usize, self.height as usize);
        let mut queue: Vec<u32> = Vec::new();
        let wet = -0.5 * self.cell_km;
        let spread = |e: &mut Self, i: usize, queue: &mut Vec<u32>| {
            let level = e.surface[i];
            let (x, y) = (i % w, i / w);
            let mut visit = |j: usize| {
                if e.water[j] == LAND && e.elevation[j] < level {
                    e.water[j] = FLOODED;
                    e.surface[j] = level;
                    e.shore[j] = wet;
                    e.touched.push(j as u32);
                    queue.push(j as u32);
                }
            };
            if x > 0 { visit(i - 1); }
            if x + 1 < w { visit(i + 1); }
            if y > 0 { visit(i - w); }
            if y + 1 < h { visit(i + w); }
        };
        for i in 0..w * h {
            // Rivers don't flood their banks; seas and lakes do.
            if self.water[i] == OCEAN || self.water[i] == LAKE {
                spread(self, i, &mut queue);
            }
        }
        while let Some(i) = queue.pop() {
            spread(self, i as usize, &mut queue);
        }
    }

    /// Carve a drawn river from its first point to its last. The water
    /// surface only ever descends, so the river always runs downhill, cutting
    /// through any rise in its way; its banks slope up to the ground beside it.
    fn carve(&mut self, river: &River) {
        let cell = self.cell_km;
        let half = (river.width_km * 0.5).max(cell * 0.6);
        let bank = half + (river.depth_m / 120.0).max(cell * 1.5); // banks rise ~120 m per km
        let pts = &river.path;
        // Walk the path in equal steps of half a cell.
        let step = cell * 0.5;
        let mut samples: Vec<[f32; 2]> = vec![pts[0]];
        let mut carried = 0.0; // distance already covered towards the next sample
        for s in pts.windows(2) {
            let (a, b) = (s[0], s[1]);
            let len = ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt();
            let mut at = step - carried;
            while at <= len {
                let t = at / len;
                samples.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
                at += step;
            }
            carried = len - (at - step);
        }
        // Water surface along the path: never rising, and ending where the
        // river meets a sea or lake.
        let mut level = f32::MAX;
        let mut levels: Vec<f32> = Vec::with_capacity(samples.len());
        for p in &samples {
            let Some(i) = self.cell_of(*p) else { levels.push(level); continue };
            if self.g_water[i] != LAND {
                level = level.min(self.g_surface[i]);
            } else {
                level = level.min(self.g_elev[i] - river.depth_m * 0.25).max(self.sea_floor_guard(i));
            }
            levels.push(level);
        }
        if level == f32::MAX {
            return;
        }
        let r = self.path_rect(pts, bank).intersect(self.full_rect());
        for cy in r.y0..r.y1 {
            for cx in r.x0..r.x1 {
                let i = (cy * self.width + cx) as usize;
                if self.g_water[i] != LAND {
                    continue;
                }
                let p = self.cell_center(cx, cy);
                // Nearest sample (paths are short, so a direct search is fine
                // within the river's own rectangle).
                let (d, along) = nearest_on_path(p, pts);
                if d > bank {
                    continue;
                }
                let k = ((along / step).round() as usize).min(levels.len() - 1);
                let surface = levels[k];
                if d <= half {
                    self.elevation[i] = self.elevation[i].min(surface - river.depth_m);
                    self.surface[i] = surface;
                    self.water[i] = if pts.len() == 1 { POOL } else { RIVER };
                    self.shore[i] = -0.3 * cell;
                    self.touched.push(i as u32);
                } else {
                    let rise = (d - half) / (bank - half);
                    let limit = surface + rise * rise * (self.g_elev[i] - surface).max(0.0);
                    if limit < self.elevation[i] {
                        self.elevation[i] = limit;
                        self.touched.push(i as u32);
                    }
                }
            }
        }
    }

    /// A river never cuts below sea level on its way down.
    #[inline]
    fn sea_floor_guard(&self, _i: usize) -> f32 {
        0.5
    }

    fn shade(&mut self, pixels: Rect) {
        let blend_km = self.smoothing * self.cell_km;
        render::shade(&self.elevation, &self.shore, &self.surface, &mut self.rgba, self.width, self.height, self.cell_km, blend_km, pixels);
    }

    fn compute_base(&mut self) {
        let cells = self.width as usize * self.height as usize;
        self.base.resize(cells, 0.0);
        for cy in 0..self.height {
            for cx in 0..self.width {
                let p = self.cell_center(cx, cy);
                self.base[(cy * self.width + cx) as usize] = inland_base(p[0], p[1], self.world_seed, self.cell_km);
            }
        }
        self.base_seed = Some(self.world_seed);
    }

    /// Fresh caches for shape `k`. With `reuse`, noise is copied from the old
    /// caches where the areas overlap (only valid if seed and frame are unchanged).
    fn build_cache(&self, k: usize, reuse: Option<ShapeCache>) -> ShapeCache {
        let shape = &self.shapes[k];
        let rect = self.shape_rect(shape);
        let mut cache = ShapeCache::new(rect, shape.frame.clamp_km());
        if let Some(old) = &reuse {
            let overlap = old.rect.intersect(rect);
            for cy in overlap.y0..overlap.y1 {
                for cx in overlap.x0..overlap.x1 {
                    let idx = cache.index(cx, cy);
                    cache.bands[idx] = old.bands[old.index(cx, cy)];
                }
            }
        }
        self.compute_geometry(k, &mut cache, rect);
        cache
    }

    /// Fill in noise for cells in `r` that are near the coast and lack it.
    fn fill_bands(&self, k: usize, cache: &mut ShapeCache, r: Rect) {
        let shape = &self.shapes[k];
        for cy in r.y0..r.y1 {
            for cx in r.x0..r.x1 {
                let idx = cache.index(cx, cy);
                if cache.nearest[idx] != u32::MAX && cache.bands[idx].big.is_nan() {
                    let local = shape.frame.to_local(self.cell_center(cx, cy));
                    // Detail scales with the shape, so pick octaves for the
                    // cell size as seen in the shape's own coordinates.
                    let local_cell = self.cell_km / shape.frame.detail_scale();
                    cache.bands[idx] = coast_bands(local[0], local[1], shape.coast.seed, local_cell);
                }
            }
        }
    }

    /// Cells a shape can influence: within its clamp distance of its outline.
    fn shape_rect(&self, shape: &Shape) -> Rect {
        let c = shape.frame.clamp_km();
        let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
        for p in &shape.coast.points {
            x0 = x0.min(p[0]);
            y0 = y0.min(p[1]);
            x1 = x1.max(p[0]);
            y1 = y1.max(p[1]);
        }
        self.km_box_to_cells(x0 - c, y0 - c, x1 + c, y1 + c)
    }

    /// Union of the reach of the flagged segments.
    fn reach_of(&self, coast: &Coastline, frame: &Frame, flags: &[bool]) -> Rect {
        flags
            .iter()
            .enumerate()
            .filter(|(_, f)| **f)
            .fold(Rect::EMPTY, |r, (i, _)| r.union(self.segment_reach(coast, frame, i)))
    }

    fn segment_reach(&self, coast: &Coastline, frame: &Frame, i: usize) -> Rect {
        let c = frame.clamp_km();
        let (a, b) = coast.segment(i);
        self.km_box_to_cells(a[0].min(b[0]) - c, a[1].min(b[1]) - c, a[0].max(b[0]) + c, a[1].max(b[1]) + c)
    }

    fn km_box_to_cells(&self, min_x: f32, min_y: f32, max_x: f32, max_y: f32) -> Rect {
        let [ox, oy] = self.origin;
        let to_cell = |km: f32, limit: u32| ((km / self.cell_km).floor().max(0.0) as u32).min(limit);
        let to_cell_end = |km: f32, limit: u32| ((km / self.cell_km).ceil().max(0.0) as u32 + 1).min(limit);
        let r = Rect {
            x0: to_cell(min_x - ox, self.width),
            y0: to_cell(min_y - oy, self.height),
            x1: to_cell_end(max_x - ox, self.width),
            y1: to_cell_end(max_y - oy, self.height),
        };
        if r.is_empty() {
            Rect::EMPTY
        } else {
            r
        }
    }

    #[inline]
    fn cell_center(&self, cx: u32, cy: u32) -> [f32; 2] {
        [
            self.origin[0] + (cx as f32 + 0.5) * self.cell_km,
            self.origin[1] + (cy as f32 + 0.5) * self.cell_km,
        ]
    }

    /// Distance and inside/outside for shape `k`, for cells in `r` (which
    /// must lie within the cache's rectangle).
    fn compute_geometry(&self, k: usize, cache: &mut ShapeCache, r: Rect) {
        if r.is_empty() {
            return;
        }
        let coast = &self.shapes[k].coast;
        let frame = &self.shapes[k].frame;
        let clamp = frame.clamp_km();
        for cy in r.y0..r.y1 {
            for cx in r.x0..r.x1 {
                let idx = cache.index(cx, cy);
                cache.dist[idx] = clamp;
                cache.nearest[idx] = u32::MAX;
            }
        }

        // Each segment visits only the cells it can reach.
        for i in 0..coast.len() {
            let reach = self.segment_reach(coast, frame, i).intersect(r);
            let (a, b) = coast.segment(i);
            for cy in reach.y0..reach.y1 {
                for cx in reach.x0..reach.x1 {
                    let (d, t) = distance_to_segment(self.cell_center(cx, cy), a, b);
                    let idx = cache.index(cx, cy);
                    if d < cache.dist[idx] {
                        cache.dist[idx] = d;
                        cache.nearest[idx] = i as u32;
                        cache.along[idx] = t;
                    }
                }
            }
        }

        // Inside/outside by scanline crossings.
        let mut crossings: Vec<f32> = Vec::with_capacity(coast.len());
        for cy in r.y0..r.y1 {
            let py = self.cell_center(0, cy)[1];
            crossings.clear();
            for i in 0..coast.len() {
                let (a, b) = coast.segment(i);
                if (a[1] > py) != (b[1] > py) {
                    crossings.push(a[0] + (py - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
                }
            }
            crossings.sort_by(|p, q| p.total_cmp(q));
            let first_x = self.cell_center(r.x0, cy)[0];
            let mut next = crossings.iter().take_while(|&&x| x < first_x).count();
            let mut inside = next % 2 == 1;
            for cx in r.x0..r.x1 {
                let px = self.cell_center(cx, cy)[0];
                while next < crossings.len() && crossings[next] < px {
                    inside = !inside;
                    next += 1;
                }
                let idx = cache.index(cx, cy);
                cache.inside[idx] = inside;
            }
        }
        self.fill_bands(k, cache, r);
    }

    /// Elevation for cells in `r`, combining every shape that reaches each
    /// cell. With `only`, skip cells whose nearest segment of that shape is
    /// not flagged. Returns the cells written.
    fn compute_terrain(&mut self, r: Rect, only: Option<(usize, &[bool])>) -> Rect {
        let far = SegmentParams::default();
        let mut written = Rect::EMPTY;
        for cy in r.y0..r.y1 {
            let mut row_min = u32::MAX;
            let mut row_max = 0;
            for cx in r.x0..r.x1 {
                if let Some((k, flags)) = only {
                    let cache = &self.caches[k];
                    if !cache.rect.contains(cx, cy) {
                        continue;
                    }
                    let seg = cache.nearest[cache.index(cx, cy)];
                    if seg == u32::MAX || !flags[seg as usize] {
                        continue;
                    }
                }
                let idx = (cy * self.width + cx) as usize;
                // Start from open ocean, then apply each shape in order.
                let mut level = -CLAMP_KM; // signed distance to the nearest water's edge
                let mut level_params = far;
                let mut lake: Option<f32> = None; // that water's height, if it is a water shape
                let mut ground = 0.0f32; // height of the land surface here
                // The runner-up land shape: where two overlap, the winner switches
                // along a line, so their slope settings are blended across it
                // rather than changing abruptly into a cliff.
                let mut second: Option<(f32, SegmentParams)> = None;
                for (shape, cache) in self.shapes.iter().zip(&self.caches) {
                    if !cache.rect.contains(cx, cy) {
                        continue;
                    }
                    let c = cache.index(cx, cy);
                    let d = cache.dist[c];
                    let signed = if cache.inside[c] { d } else { -d };
                    let seg = cache.nearest[c];
                    let (shifted, params) = if seg != u32::MAX {
                        let params = shape.coast.params_at(seg as usize, cache.along[c]);
                        // The coast's detail scales with its shape.
                        let push = coastal_displacement(&cache.bands[c], &params) * shape.frame.detail_scale();
                        (signed + push, params)
                    } else {
                        // Too far from any segment for its parameters to matter.
                        (signed, far)
                    };
                    match shape.kind {
                        ShapeKind::Land => {
                            // Over open sea (no land beneath) a shape simply sits at its
                            // height inside its outline; the coast's own ramp, applied
                            // below, shapes the shore once. Over land it steps up or
                            // down with an escarpment, by this segment's slope.
                            let under = crate::coast::smoothstep(0.0, 8.0, level.max(0.0));
                            let edge = crate::coast::smoothstep(0.0, 2.0, shifted);
                            let step = edge * (1.0 - under) + highland_rise(shifted, &params) * under;
                            ground += (shape.height - ground) * step;
                            if shifted > level {
                                if lake.is_none() && level > 0.0 {
                                    second = Some((level, level_params));
                                }
                                level = shifted;
                                level_params = params;
                                lake = None;
                            } else if lake.is_none() && shifted > 0.0 && second.map_or(true, |(l, _)| shifted > l) {
                                second = Some((shifted, params));
                            }
                        }
                        ShapeKind::Water => {
                            if -shifted < level {
                                level = -shifted;
                                level_params = params;
                                lake = Some(shape.height);
                                second = None;
                            }
                        }
                    }
                }
                if let (Some((other, other_params)), true) = (second, lake.is_none()) {
                    let gap = level - other;
                    if level > 0.0 && gap < 40.0 {
                        let t = 0.5 + 0.5 * crate::coast::smoothstep(0.0, 40.0, gap);
                        level_params = SegmentParams::lerp(other_params, level_params, t);
                    }
                }
                let mut peaks = 0.0f32;
                if !self.mountains.is_empty() {
                    let p = self.cell_center(cx, cy);
                    for m in &self.mountains {
                        if m.rect.contains(cx, cy) {
                            peaks += m.height_at(p, self.cell_km);
                        }
                    }
                }
                // The surface of the water nearest this cell: sea level, or a
                // lake's own level (by default, the height of the ground it sits in).
                let nearest_water = match lake {
                    Some(h) if h != AUTO_LEVEL => h,
                    // A lake following the ground sits in a slight hollow:
                    // just below the lowest the land's relief can dip, so it
                    // never spills over the country around it.
                    Some(_) => ground - 0.36 * ground.clamp(0.0, 300.0) - 5.0,
                    None => 0.0,
                };
                let (elevation, kind, surface, shore) = if level >= 0.0 {
                    // Land rises from the water's edge to its full height,
                    // with gentle relief that fades out at the shore.
                    let rise = coast_rise(level, &level_params);
                    // Relief is in proportion to the land's own height, so it
                    // can never dip the ground below the water it rises from.
                    let relief = (self.base[idx] - 200.0) * 0.6 * rise * (ground.max(0.0) / 300.0).min(1.0);
                    (nearest_water + (ground - nearest_water) * rise + relief + peaks, LAND, 0.0, level)
                } else if peaks > 20.0 {
                    // A mountain standing in water breaks the surface: an island.
                    // Its distance from the water grows with its height, so only the low
                    // fringe of such an island is beach.
                    (nearest_water + peaks - 20.0, LAND, 0.0, ((peaks - 20.0) * 0.01).max(0.4 * self.cell_km))
                } else if lake.is_some() {
                    (nearest_water + lake_depth(level, &level_params) + peaks, LAKE, nearest_water, level)
                } else {
                    (ocean_depth(level, &level_params) + peaks, OCEAN, 0.0, level)
                };
                // Keep count of land lying below its nearest water (see `low_land`).
                let was_low = self.g_water[idx] == LAND && self.g_elev[idx] < self.g_surface[idx];
                let low_surface = if kind == LAND { nearest_water } else { surface };
                let is_low = kind == LAND && elevation < low_surface;
                self.low_land += is_low as i64 - was_low as i64;
                self.g_elev[idx] = elevation;
                self.g_water[idx] = kind;
                // For land, remember the level of the nearest water: what it
                // would flood to.
                self.g_surface[idx] = low_surface;
                self.g_shore[idx] = shore;
                row_min = row_min.min(cx);
                row_max = row_max.max(cx);
            }
            if row_min != u32::MAX {
                written = written.union(Rect { x0: row_min, y0: cy, x1: row_max + 1, y1: cy + 1 });
            }
        }
        written
    }
}
