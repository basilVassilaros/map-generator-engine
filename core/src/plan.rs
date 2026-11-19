//! Features the terrain render works out for itself, as vectors.
//!
//! Before any ground is shaped, the render plans the land the way a
//! cartographer would sketch it: where the rivers run, where the hills between
//! them stand, where water gathers into lakes. Each is a line or outline in
//! world kilometres, the same kind of thing the user draws by hand:
//!
//! * **Rivers** follow the drainage from source to mouth, main stems first,
//!   with tributaries ending on the river they join.
//! * **Hills** run along the divides: the ground furthest from any river,
//!   which is where real interfluves stand highest.
//! * **Lakes** are the outlines of the hollows that fill with water.
//!
//! The terrain is then built from these (see `hydro::render`), and the app can
//! show them or turn them into ordinary, editable guides.

use crate::hydro::Routing;
use crate::noise::gradient;

#[derive(Clone, Debug, PartialEq)]
pub struct GenRiver {
    /// Source to mouth (km).
    pub points: Vec<[f32; 2]>,
    /// Flow at the mouth (m³/s).
    pub flow: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GenHill {
    pub points: Vec<[f32; 2]>,
    /// Height of the crest above the ground around (m).
    pub height: f32,
    /// How far the slopes spread to either side (km).
    pub width_km: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GenLake {
    /// A closed outline (km).
    pub points: Vec<[f32; 2]>,
    /// Height of the water's surface (m).
    pub level: f32,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Generated {
    pub rivers: Vec<GenRiver>,
    pub hills: Vec<GenHill>,
    pub lakes: Vec<GenLake>,
}

impl Generated {
    /// Flatten to numbers for the app:
    /// `[rivers, (n, flow, x0, y0, ...)..., hills, (n, height, width, x0, y0, ...)...,
    ///   lakes, (n, level, x0, y0, ...)...]`.
    pub fn to_f32(&self) -> Vec<f32> {
        let mut out = vec![self.rivers.len() as f32];
        let push = |out: &mut Vec<f32>, pts: &[[f32; 2]]| pts.iter().for_each(|p| out.extend_from_slice(p));
        for r in &self.rivers {
            out.extend_from_slice(&[r.points.len() as f32, r.flow]);
            push(&mut out, &r.points);
        }
        out.push(self.hills.len() as f32);
        for h in &self.hills {
            out.extend_from_slice(&[h.points.len() as f32, h.height, h.width_km]);
            push(&mut out, &h.points);
        }
        out.push(self.lakes.len() as f32);
        for l in &self.lakes {
            out.extend_from_slice(&[l.points.len() as f32, l.level]);
            push(&mut out, &l.points);
        }
        out
    }
}

/// The working grid the plan is made on.
#[derive(Clone, Copy)]
pub struct Grid {
    pub w: usize,
    pub h: usize,
    pub cell_km: f32,
    pub origin: [f32; 2],
}

impl Grid {
    pub fn centre(&self, i: usize) -> [f32; 2] {
        [self.origin[0] + ((i % self.w) as f32 + 0.5) * self.cell_km, self.origin[1] + ((i / self.w) as f32 + 0.5) * self.cell_km]
    }
}

/// How far (km) rivers are pushed off the grid's lines so they wander: two
/// scales of gentle displacement that depend only on position, so every river
/// and tributary moves together and stays joined. `cell_km` is the working
/// grid's cell size.
pub fn wander(p: [f32; 2], cell_km: f32) -> [f32; 2] {
    let (a, b) = (5.0 * cell_km, 1.7 * cell_km);
    [
        0.45 * cell_km * gradient(p[0] / a, p[1] / a, 901) + 0.16 * cell_km * gradient(p[0] / b, p[1] / b, 903),
        0.45 * cell_km * gradient(p[0] / a + 31.7, p[1] / a, 902) + 0.16 * cell_km * gradient(p[0] / b + 17.3, p[1] / b, 904),
    ]
}

/// One round of corner cutting (Chaikin): each corner is replaced by two
/// points a quarter of the way along its sides. An open line keeps its ends.
pub fn chaikin(pts: &[[f32; 2]], closed: bool) -> Vec<[f32; 2]> {
    let n = pts.len();
    if n < 3 {
        return pts.to_vec();
    }
    let mix = |a: [f32; 2], b: [f32; 2], t: f32| [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    let mut out = Vec::with_capacity(n * 2);
    if closed {
        for i in 0..n {
            let (a, b) = (pts[i], pts[(i + 1) % n]);
            out.push(mix(a, b, 0.25));
            out.push(mix(a, b, 0.75));
        }
    } else {
        out.push(pts[0]);
        for i in 0..n - 1 {
            let (a, b) = (pts[i], pts[i + 1]);
            if i > 0 {
                out.push(mix(a, b, 0.25));
            }
            if i < n - 2 {
                out.push(mix(a, b, 0.75));
            }
        }
        out.push(pts[n - 1]);
    }
    out
}

/// Drop points that lie within `tolerance` km of the line between the points
/// kept (Douglas-Peucker). The ends always stay.
pub fn simplify(pts: &[[f32; 2]], tolerance: f32) -> Vec<[f32; 2]> {
    let n = pts.len();
    if n < 3 {
        return pts.to_vec();
    }
    let mut keep = vec![false; n];
    keep[0] = true;
    keep[n - 1] = true;
    let mut stack = vec![(0usize, n - 1)];
    while let Some((a, b)) = stack.pop() {
        let (pa, pb) = (pts[a], pts[b]);
        let (abx, aby) = (pb[0] - pa[0], pb[1] - pa[1]);
        let len2 = abx * abx + aby * aby;
        let (mut worst, mut at) = (0.0f32, a);
        for (k, p) in pts.iter().enumerate().take(b).skip(a + 1) {
            let t = if len2 > 1e-9 { (((p[0] - pa[0]) * abx + (p[1] - pa[1]) * aby) / len2).clamp(0.0, 1.0) } else { 0.0 };
            let d = (p[0] - (pa[0] + abx * t)).hypot(p[1] - (pa[1] + aby * t));
            if d > worst {
                worst = d;
                at = k;
            }
        }
        if worst > tolerance {
            keep[at] = true;
            stack.push((a, at));
            stack.push((at, b));
        }
    }
    pts.iter().zip(&keep).filter(|(_, k)| **k).map(|(p, _)| *p).collect()
}

/// Simplify until the line has at most `max` points.
fn simplify_to(pts: &[[f32; 2]], mut tolerance: f32, max: usize) -> Vec<[f32; 2]> {
    loop {
        let out = simplify(pts, tolerance);
        if out.len() <= max {
            return out;
        }
        tolerance *= 1.5;
    }
}

/// The larger rivers as lines from source to mouth. `is_river(i)` says which
/// cells carry one. A tributary's last point is on the river it joins.
pub fn trace_rivers(g: &Grid, r: &Routing, q: &[f32], is_river: &dyn Fn(usize) -> bool, max: usize) -> Vec<GenRiver> {
    let n = g.w * g.h;
    // For each cell, the river cell that brings it the most water.
    let mut main = vec![u32::MAX; n];
    let mut most = vec![0.0f32; n];
    for d in 0..n {
        let to = r.receiver[d] as usize;
        if to != d && is_river(d) && q[d] > most[to] {
            most[to] = q[d];
            main[to] = d as u32;
        }
    }
    let mut found: Vec<(f32, Vec<usize>, Option<usize>)> = Vec::new();
    for d in 0..n {
        if !is_river(d) {
            continue;
        }
        let to = r.receiver[d] as usize;
        // A river ends where it reaches water or the map's edge, or joins a bigger one.
        if to != d && is_river(to) && main[to] == d as u32 {
            continue;
        }
        let mut chain = vec![d];
        let mut cur = d;
        while main[cur] != u32::MAX {
            cur = main[cur] as usize;
            chain.push(cur);
        }
        if chain.len() < 4 {
            continue;
        }
        chain.reverse();
        found.push((q[d], chain, (to != d).then_some(to)));
    }
    found.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1[0].cmp(&b.1[0])));
    found.truncate(max);
    found
        .into_iter()
        .map(|(flow, chain, end)| {
            let mut pts: Vec<[f32; 2]> = chain.iter().map(|i| g.centre(*i)).collect();
            if let Some(to) = end {
                pts.push(g.centre(to));
            }
            let smooth = chaikin(&chaikin(&pts, false), false);
            // Where the fine render will show the river: it looks rivers up
            // through `wander`, so the line it draws sits the other way.
            let moved: Vec<[f32; 2]> = smooth
                .iter()
                .map(|p| {
                    let d = wander(*p, g.cell_km);
                    [p[0] - d[0], p[1] - d[1]]
                })
                .collect();
            GenRiver { points: simplify_to(&moved, 0.3 * g.cell_km, 40), flow }
        })
        .collect()
}

/// Outlines of the lakes: `level[i]` is the water surface, NaN where dry.
pub fn trace_lakes(g: &Grid, level: &[f32], max: usize) -> Vec<GenLake> {
    let (w, h) = (g.w, g.h);
    let n = w * h;
    let mut label = vec![0u32; n];
    let mut found: Vec<(usize, u32, f32, usize)> = Vec::new(); // size, label, level, first cell
    let mut stack = Vec::new();
    for start in 0..n {
        if level[start].is_nan() || label[start] != 0 {
            continue;
        }
        let id = found.len() as u32 + 1;
        let (mut size, mut top) = (0usize, f32::MIN);
        label[start] = id;
        stack.push(start);
        while let Some(i) = stack.pop() {
            size += 1;
            top = top.max(level[i]);
            let (x, y) = (i % w, i / w);
            let mut visit = |j: usize| {
                if !level[j].is_nan() && label[j] == 0 {
                    label[j] = id;
                    stack.push(j);
                }
            };
            if x > 0 { visit(i - 1); }
            if x + 1 < w { visit(i + 1); }
            if y > 0 { visit(i - w); }
            if y + 1 < h { visit(i + w); }
        }
        found.push((size, id, top, start));
    }
    found.retain(|f| f.0 >= 4);
    found.sort_by(|a, b| b.0.cmp(&a.0).then(a.3.cmp(&b.3)));
    found.truncate(max);
    let inside = |x: i64, y: i64, id: u32| x >= 0 && y >= 0 && x < w as i64 && y < h as i64 && label[y as usize * w + x as usize] == id;
    found
        .into_iter()
        .map(|(_, id, top, start)| {
            // Walk the outer edge with the lake on the right, from the top-left
            // corner of its first cell (the topmost, then leftmost), heading east.
            let (sx, sy) = ((start % w) as i64, (start / w) as i64);
            let (mut cx, mut cy, mut dx, mut dy) = (sx, sy, 1i64, 0i64);
            let mut corners: Vec<[f32; 2]> = Vec::new();
            loop {
                corners.push([g.origin[0] + cx as f32 * g.cell_km, g.origin[1] + cy as f32 * g.cell_km]);
                cx += dx;
                cy += dy;
                // The two cells ahead of the new corner: to the right and left of the heading.
                let (rx, ry) = (-dy, dx);
                let cell = |fx: i64, fy: i64| ((2 * cx + fx - 1) / 2, (2 * cy + fy - 1) / 2);
                let (ax, ay) = cell(dx + rx, dy + ry);
                let (bx, by) = cell(dx - rx, dy - ry);
                if !inside(ax, ay, id) {
                    (dx, dy) = (rx, ry); // turn right
                } else if inside(bx, by, id) {
                    (dx, dy) = (-rx, -ry); // turn left
                }
                if (cx == sx && cy == sy) || corners.len() > 4 * n {
                    break;
                }
            }
            let smooth = chaikin(&chaikin(&simplify(&corners, 0.01 * g.cell_km), true), true);
            let mut pts = simplify_to(&smooth, 0.25 * g.cell_km, 48);
            if pts.len() > 3 && pts[0] == pts[pts.len() - 1] {
                pts.pop();
            }
            GenLake { points: pts, level: top }
        })
        .collect()
}

/// Lines along the divides between rivers. `mask[i]` marks rivers and water;
/// `land[i]` the cells hills may stand on. Returns each line with the typical
/// distance (km) from it to the nearest river.
pub fn find_divides(g: &Grid, mask: &[bool], land: &[bool], max: usize) -> Vec<(Vec<[f32; 2]>, f32)> {
    let (w, h) = (g.w, g.h);
    let n = w * h;
    // Distance to the nearest river or water, in cells (two-pass chamfer).
    let mut d = vec![0.0f32; n];
    for i in 0..n {
        d[i] = if mask[i] { 0.0 } else { 1e6 };
    }
    const S: f32 = std::f32::consts::SQRT_2;
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let mut v = d[i];
            if x > 0 { v = v.min(d[i - 1] + 1.0); }
            if y > 0 {
                v = v.min(d[i - w] + 1.0);
                if x > 0 { v = v.min(d[i - w - 1] + S); }
                if x + 1 < w { v = v.min(d[i - w + 1] + S); }
            }
            d[i] = v;
        }
    }
    for y in (0..h).rev() {
        for x in (0..w).rev() {
            let i = y * w + x;
            let mut v = d[i];
            if x + 1 < w { v = v.min(d[i + 1] + 1.0); }
            if y + 1 < h {
                v = v.min(d[i + w] + 1.0);
                if x + 1 < w { v = v.min(d[i + w + 1] + S); }
                if x > 0 { v = v.min(d[i + w - 1] + S); }
            }
            d[i] = v;
        }
    }
    // A divide cell is at least as far from water as its neighbours on both
    // sides, along some direction.
    let min_d = 3.0f32;
    let mut ridge = vec![false; n];
    for y in 2..h.saturating_sub(2) {
        for x in 2..w.saturating_sub(2) {
            let i = y * w + x;
            if !land[i] || d[i] < min_d || d[i] > 1e5 {
                continue;
            }
            let pair = |a: usize, b: usize| d[i] >= d[a] && d[i] > d[b] - 0.01 && (d[i] > d[a] + 0.05 || d[i] > d[b] + 0.05);
            ridge[i] = pair(i - 1, i + 1) || pair(i - w, i + w) || pair(i - w - 1, i + w + 1) || pair(i - w + 1, i + w - 1);
        }
    }
    // Chain divide cells into lines, starting from the most remote.
    let mut order: Vec<usize> = (0..n).filter(|i| ridge[*i]).collect();
    order.sort_by(|a, b| d[*b].total_cmp(&d[*a]).then(a.cmp(b)));
    let mut used = vec![false; n];
    let mut lines: Vec<(f32, Vec<usize>)> = Vec::new();
    for &start in &order {
        if used[start] {
            continue;
        }
        let mut chain = vec![start];
        used[start] = true;
        for pass in 0..2 {
            let mut cur = start;
            let mut heading = (0i64, 0i64);
            loop {
                let (x, y) = ((cur % w) as i64, (cur / w) as i64);
                let mut best: Option<(f32, usize, (i64, i64))> = None;
                for dy in -1i64..=1 {
                    for dx in -1i64..=1 {
                        if (dx == 0 && dy == 0) || dx * heading.0 + dy * heading.1 < 0 {
                            continue;
                        }
                        let j = ((y + dy) as usize) * w + (x + dx) as usize;
                        if !ridge[j] || used[j] {
                            continue;
                        }
                        // Prefer carrying straight on, then the more remote cell.
                        let score = d[j] + 0.6 * (dx * heading.0 + dy * heading.1) as f32;
                        if best.is_none_or(|b| score > b.0) {
                            best = Some((score, j, (dx, dy)));
                        }
                    }
                }
                let Some((_, j, step)) = best else { break };
                // Thin the divide: nothing else may start beside this line.
                for dy in -1i64..=1 {
                    for dx in -1i64..=1 {
                        used[((y + dy) as usize) * w + (x + dx) as usize] = true;
                    }
                }
                used[j] = true;
                heading = step;
                cur = j;
                if pass == 0 { chain.push(j) } else { chain.insert(0, j) }
            }
        }
        if chain.len() >= 5 {
            let total: f32 = chain.iter().map(|i| d[*i]).sum();
            lines.push((total, chain));
        }
    }
    lines.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1[0].cmp(&b.1[0])));
    lines.truncate(max);
    lines
        .into_iter()
        .map(|(total, chain)| {
            let pts: Vec<[f32; 2]> = chain.iter().map(|i| g.centre(*i)).collect();
            let smooth = chaikin(&chaikin(&pts, false), false);
            (simplify_to(&smooth, 0.4 * g.cell_km, 24), total / chain.len() as f32 * g.cell_km)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_lake_outline_goes_once_round_its_cells() {
        // A 3 x 2 block of lake in a 6 x 5 grid.
        let g = Grid { w: 6, h: 5, cell_km: 2.0, origin: [10.0, 20.0] };
        let mut level = vec![f32::NAN; 30];
        for (x, y) in [(1, 1), (2, 1), (3, 1), (1, 2), (2, 2), (3, 2)] {
            level[y * 6 + x] = 120.0;
        }
        let lakes = trace_lakes(&g, &level, 8);
        assert_eq!(lakes.len(), 1);
        let l = &lakes[0];
        assert_eq!(l.level, 120.0);
        // Every point lies within the block's bounds, and the outline encloses most of it.
        let mut area = 0.0;
        for i in 0..l.points.len() {
            let (a, b) = (l.points[i], l.points[(i + 1) % l.points.len()]);
            assert!(a[0] >= 12.0 - 1e-3 && a[0] <= 18.0 + 1e-3 && a[1] >= 22.0 - 1e-3 && a[1] <= 26.0 + 1e-3, "{a:?}");
            area += a[0] * b[1] - b[0] * a[1];
        }
        let area = area.abs() / 2.0;
        assert!(area > 18.0 && area <= 24.0, "area {area}");
    }

    #[test]
    fn simplifying_keeps_the_ends_and_the_corners() {
        let pts = [[0.0, 0.0], [1.0, 0.01], [2.0, 0.0], [2.0, 2.0]];
        assert_eq!(simplify(&pts, 0.1), vec![[0.0, 0.0], [2.0, 0.0], [2.0, 2.0]]);
        let cut = chaikin(&pts, false);
        assert_eq!((cut[0], cut[cut.len() - 1]), ([0.0, 0.0], [2.0, 2.0]));
    }
}
