//! The engine owns the world rasters and keeps them in sync with the guides.
//!
//! The guides are the source of truth. When new guide data arrives, the engine
//! compares it with what it had, works out which cells the change can affect,
//! and regenerates only those. Results are identical to regenerating the whole
//! map; the tests in `tests/incremental.rs` hold it to that.

use crate::coast::{
    coast_bands, coastal_displacement, distance_to_segment, elevation_from_coast, inland_base,
    CoastBands, Coastline, SegmentParams, CLAMP_KM,
};
use crate::render;

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

pub struct Engine {
    width: u32,
    height: u32,
    /// World position (km) of the top-left corner of cell (0, 0).
    origin: [f32; 2],
    cell_km: f32,
    elevation: Vec<f32>,
    rgba: Vec<u8>,
    coast: Option<Coastline>,
    // Caches, so an edit only redoes the work it can affect.
    /// Lowland height and shoreline noise. Depend only on the seed.
    base: Vec<f32>,
    bands: Vec<CoastBands>,
    base_seed: Option<u32>,
    /// Distance to the nearest segment (clamped), which segment, and where along it.
    dist: Vec<f32>,
    nearest: Vec<u32>,
    along: Vec<f32>,
    inside: Vec<bool>,
}

impl Engine {
    /// A whole map whose top-left corner is at the world origin.
    /// `extent_km` is the real width of the map. Cells are square.
    pub fn new(width: u32, height: u32, extent_km: f32) -> Self {
        Self::window(width, height, [0.0, 0.0], extent_km / width as f32)
    }

    /// Any window onto the world: `origin` is the world position (km) of the
    /// top-left corner, `cell_km` the size of one cell. A zoomed-in view uses
    /// a small window with small cells; noise is placed by world position, so
    /// the window lines up exactly with the whole map.
    pub fn window(width: u32, height: u32, origin: [f32; 2], cell_km: f32) -> Self {
        let cells = width as usize * height as usize;
        let mut engine = Self {
            width,
            height,
            origin,
            cell_km,
            elevation: vec![EMPTY_ELEVATION; cells],
            rgba: vec![0; cells * 4],
            coast: None,
            base: vec![0.0; cells],
            bands: vec![CoastBands::default(); cells],
            base_seed: None,
            dist: vec![CLAMP_KM; cells],
            nearest: vec![u32::MAX; cells],
            along: vec![0.0; cells],
            inside: vec![false; cells],
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

    pub fn rgba(&self) -> &[u8] {
        &self.rgba
    }

    pub fn coast(&self) -> Option<&Coastline> {
        self.coast.as_ref()
    }

    pub fn full_rect(&self) -> Rect {
        Rect { x0: 0, y0: 0, x1: self.width, y1: self.height }
    }

    /// Replace the coastline guide. Returns the rectangle of pixels that
    /// changed (empty if nothing did).
    pub fn set_coast(&mut self, coast: Option<Coastline>) -> Rect {
        let coast = coast.filter(Coastline::is_valid).map(|mut c| {
            for p in c.params.iter_mut() {
                *p = p.sanitized();
            }
            c
        });
        let old = std::mem::replace(&mut self.coast, coast);
        let changed = match (&old, &self.coast) {
            (None, None) => Rect::EMPTY,
            (Some(a), Some(b)) if a.len() == b.len() && a.seed == b.seed => {
                let (a, b) = (a.clone(), b.clone());
                self.apply_edit(&a, &b)
            }
            _ => self.regenerate_all(),
        };
        // Shading reads neighbouring cells, so one extra pixel of border changes too.
        changed.grow(1, self.width, self.height)
    }

    /// Regenerate everything from the guides. Returns the cells that changed.
    pub fn regenerate_all(&mut self) -> Rect {
        let all = self.full_rect();
        match self.coast.as_ref().map(|c| c.seed) {
            None => self.elevation.fill(EMPTY_ELEVATION),
            Some(seed) => {
                if self.base_seed != Some(seed) {
                    self.compute_base(seed);
                }
                self.compute_geometry(all);
                self.compute_terrain(all, None);
            }
        }
        self.shade(all);
        all
    }

    /// Same number of points and same seed: make the smallest exact update.
    fn apply_edit(&mut self, old: &Coastline, new: &Coastline) -> Rect {
        let n = old.len();
        let mut moved = vec![false; n];
        let mut retuned = vec![false; n];
        for k in 0..n {
            if old.points[k] != new.points[k] {
                // A point belongs to the segment ending and the one starting there.
                moved[(k + n - 1) % n] = true;
                moved[k] = true;
            }
            if old.params[k] != new.params[k] {
                // Parameters blend into both neighbouring segments.
                retuned[(k + n - 1) % n] = true;
                retuned[k] = true;
                retuned[(k + 1) % n] = true;
            }
        }
        let reach = |flags: &[bool], coast: &Coastline| {
            flags
                .iter()
                .enumerate()
                .filter(|(_, f)| **f)
                .fold(Rect::EMPTY, |r, (i, _)| r.union(self.segment_reach(coast, i)))
        };

        let changed = if moved.iter().any(|m| *m) {
            // Geometry changed: distances must be recomputed wherever the old
            // or new segments reach.
            let either: Vec<bool> = moved.iter().zip(&retuned).map(|(m, r)| *m || *r).collect();
            let rect = reach(&either, old).union(reach(&either, new));
            self.compute_geometry(rect);
            self.compute_terrain(rect, None)
        } else if retuned.iter().any(|r| *r) {
            // Only parameters changed: distances are still valid, and only
            // cells whose nearest segment was retuned can change.
            let rect = reach(&retuned, new);
            self.compute_terrain(rect, Some(&retuned))
        } else {
            Rect::EMPTY
        };
        if !changed.is_empty() {
            self.shade(changed.grow(1, self.width, self.height));
        }
        changed
    }

    fn shade(&mut self, pixels: Rect) {
        render::shade(&self.elevation, &mut self.rgba, self.width, self.height, self.cell_km * 1000.0, pixels);
    }

    fn compute_base(&mut self, seed: u32) {
        for cy in 0..self.height {
            for cx in 0..self.width {
                let p = self.cell_center(cx, cy);
                let idx = (cy * self.width + cx) as usize;
                self.base[idx] = inland_base(p[0], p[1], seed, self.cell_km);
                self.bands[idx] = coast_bands(p[0], p[1], seed, self.cell_km);
            }
        }
        self.base_seed = Some(seed);
    }

    /// Cells within CLAMP_KM of segment `i`: everything the segment can influence.
    fn segment_reach(&self, coast: &Coastline, i: usize) -> Rect {
        let (a, b) = coast.segment(i);
        self.km_box_to_cells(
            a[0].min(b[0]) - CLAMP_KM,
            a[1].min(b[1]) - CLAMP_KM,
            a[0].max(b[0]) + CLAMP_KM,
            a[1].max(b[1]) + CLAMP_KM,
        )
    }

    fn km_box_to_cells(&self, min_x: f32, min_y: f32, max_x: f32, max_y: f32) -> Rect {
        let [ox, oy] = self.origin;
        let to_cell = |km: f32, limit: u32| ((km / self.cell_km).floor().max(0.0) as u32).min(limit);
        let to_cell_end = |km: f32, limit: u32| ((km / self.cell_km).ceil().max(0.0) as u32 + 1).min(limit);
        Rect {
            x0: to_cell(min_x - ox, self.width),
            y0: to_cell(min_y - oy, self.height),
            x1: to_cell_end(max_x - ox, self.width),
            y1: to_cell_end(max_y - oy, self.height),
        }
    }

    #[inline]
    fn cell_center(&self, cx: u32, cy: u32) -> [f32; 2] {
        [
            self.origin[0] + (cx as f32 + 0.5) * self.cell_km,
            self.origin[1] + (cy as f32 + 0.5) * self.cell_km,
        ]
    }

    /// Distance to the coastline and inside/outside, for cells in `r`.
    fn compute_geometry(&mut self, r: Rect) {
        let Some(coast) = self.coast.as_ref() else { return };
        let width = self.width;
        for cy in r.y0..r.y1 {
            let row = (cy * width) as usize;
            self.dist[row + r.x0 as usize..row + r.x1 as usize].fill(CLAMP_KM);
            self.nearest[row + r.x0 as usize..row + r.x1 as usize].fill(u32::MAX);
        }

        // Each segment visits only the cells it can reach, rather than every
        // cell testing every segment.
        for i in 0..coast.len() {
            let reach = self.segment_reach(coast, i);
            let (x0, x1) = (reach.x0.max(r.x0), reach.x1.min(r.x1));
            let (y0, y1) = (reach.y0.max(r.y0), reach.y1.min(r.y1));
            let (a, b) = coast.segment(i);
            for cy in y0..y1 {
                for cx in x0..x1 {
                    let (d, t) = distance_to_segment(self.cell_center(cx, cy), a, b);
                    let idx = (cy * width + cx) as usize;
                    if d < self.dist[idx] {
                        self.dist[idx] = d;
                        self.nearest[idx] = i as u32;
                        self.along[idx] = t;
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
                self.inside[(cy * width + cx) as usize] = inside;
            }
        }
    }

    /// Elevation for cells in `r` from the cached geometry. With `only`, skip
    /// cells whose nearest segment is not flagged. Returns the cells written.
    fn compute_terrain(&mut self, r: Rect, only: Option<&[bool]>) -> Rect {
        let Some(coast) = self.coast.as_ref() else { return Rect::EMPTY };
        let far = SegmentParams::default();
        let mut written = Rect::EMPTY;
        for cy in r.y0..r.y1 {
            let mut row_min = u32::MAX;
            let mut row_max = 0;
            for cx in r.x0..r.x1 {
                let idx = (cy * self.width + cx) as usize;
                let seg = self.nearest[idx];
                if let Some(flags) = only {
                    if seg == u32::MAX || !flags[seg as usize] {
                        continue;
                    }
                }
                let d = self.dist[idx];
                let signed = if self.inside[idx] { d } else { -d };
                let base = self.base[idx];
                self.elevation[idx] = if seg != u32::MAX {
                    let params = coast.params_at(seg as usize, self.along[idx]);
                    let shifted = signed + coastal_displacement(&self.bands[idx], &params);
                    elevation_from_coast(base, shifted, &params)
                } else {
                    // Too far from any segment for its parameters to matter.
                    elevation_from_coast(base, signed, &far)
                };
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
