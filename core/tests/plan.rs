//! Drawn rivers, biome regions and the vectors the terrain render plans.

use terrain_core::engine::{LAND, POOL, RIVER};
use terrain_core::features::Region;
use terrain_core::fine::render_fine_full;
use terrain_core::hydro::{render, Climate, Rendered};
use terrain_core::look::Style;
use terrain_core::{Coastline, Engine, Frame, Mountain, River, SegmentParams, Shape, ShapeKind};

const SIZE: u32 = 200;
const EXTENT_KM: f32 = 1600.0;

fn continent() -> Shape {
    let points: Vec<[f32; 2]> = (0..9)
        .map(|i| {
            let a = i as f32 / 9.0 * std::f32::consts::TAU;
            [800.0 + 620.0 * a.cos(), 800.0 + 520.0 * a.sin()]
        })
        .collect();
    let params = points.iter().map(|_| SegmentParams::default()).collect();
    Shape { id: 1, coast: Coastline { points, params, seed: 5 }, frame: Frame { x: 800.0, y: 800.0, angle: 0.0, scale: 1.0 }, kind: ShapeKind::Land, height: 300.0 }
}

fn range() -> Mountain {
    Mountain { id: 1, seed: 3, points: vec![[800.0, 380.0], [800.0, 1220.0]], height: 3000.0, width_km: 90.0, rugged: 0.6, curviness: 0.5, ..Default::default() }
}

/// From the foot of the range to the east coast.
fn river() -> River {
    River { id: 1, points: vec![[930.0, 760.0], [1150.0, 700.0], [1300.0, 820.0], [1480.0, 800.0]], width_km: 0.6, depth_m: 25.0, curviness: 0.6, ..Default::default() }
}

fn world(rivers: Vec<River>, regions: Vec<Region>) -> Engine {
    let mut e = Engine::new(SIZE, SIZE, EXTENT_KM);
    e.set_guides(42, vec![continent()], vec![range()], rivers);
    e.set_regions(regions);
    e
}

fn go(e: &Engine) -> Rendered {
    render(e, &Climate::default(), Style::TrueColour)
}

fn cell(e: &Engine, p: [f32; 2]) -> usize {
    e.cell_at(p).expect("on the map")
}

#[test]
fn a_drawn_river_becomes_a_channel_that_gathers_water_on_its_way_down() {
    let e = world(vec![river()], vec![]);
    assert!(e.water().iter().any(|k| *k == RIVER), "the live map shows the river");
    let out = go(&e);
    let path = &e.rivers()[0].path;
    // Sample the drawn line: flow grows from source to mouth and the bed descends.
    let land: Vec<usize> = path.iter().map(|p| cell(&e, *p)).filter(|i| e.water()[*i] == RIVER).collect();
    assert!(land.len() > 10);
    let (head, foot) = (land[1], land[land.len() - 2]);
    let near = |i: usize, f: &dyn Fn(usize) -> f32| -> f32 {
        // The channel meanders up to a couple of cells from the drawn line.
        let (x, y) = ((i % SIZE as usize) as i64, (i / SIZE as usize) as i64);
        let mut best = f32::MIN;
        for dy in -2..=2 {
            for dx in -2..=2 {
                best = best.max(f(((y + dy) * SIZE as i64 + x + dx) as usize));
            }
        }
        best
    };
    let (q_head, q_foot) = (near(head, &|i| out.discharge[i]), near(foot, &|i| out.discharge[i]));
    assert!(q_foot > 2000.0, "a 0.6 km river carries thousands of m³/s at its mouth, got {q_foot}");
    assert!(q_foot > q_head * 3.0, "flow grows downstream: {q_head} then {q_foot}");
    let low = |i: usize| -near(i, &|j| -out.elevation[j]);
    assert!(low(foot) < low(head), "the bed descends: {} then {}", low(head), low(foot));
    // The river is drawn in stage B from its own line: curves run close to the guide.
    let s = &out.structure;
    let mid = path[path.len() / 2];
    let close = s.curves.iter().filter(|c| (c[0] - mid[0]).hypot(c[1] - mid[1]) < 12.0 && c[6] > 500.0).count();
    assert!(close > 0, "no big river curve near the middle of the drawn line");
}

#[test]
fn the_same_river_gives_the_same_channel_every_time_and_pools_are_standing_water() {
    let pool = River { id: 2, points: vec![[600.0, 800.0]], width_km: 30.0, depth_m: 20.0, ..Default::default() };
    let e = world(vec![river(), pool], vec![]);
    assert!(e.water().iter().any(|k| *k == POOL));
    let (a, b) = (go(&e), go(&e));
    assert_eq!(a.rgba, b.rgba);
    assert_eq!(a.generated, b.generated);
    assert_eq!(a.structure.curves, b.structure.curves);
    // A pool's cells keep their water: flat at its surface.
    let i = cell(&e, [600.0, 800.0]);
    assert_eq!(a.elevation[i], e.surface()[i]);
}

#[test]
fn a_biome_region_sets_the_climate_inside_it_and_nowhere_else() {
    let square = |x: f32, y: f32, r: f32| vec![[x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r]];
    let desert = Region { id: 1, points: square(1100.0, 800.0, 120.0), rainfall_mm: 60.0, humidity: 0.1, forest: 0.0, temp_c: 28.0, feather_km: 40.0 };
    let plain = go(&world(vec![], vec![]));
    let e = world(vec![], vec![desert]);
    let out = go(&e);
    let inside = cell(&e, [1100.0, 800.0]);
    assert!((out.rainfall[inside] - 60.0).abs() < 1.0, "rain inside {}", out.rainfall[inside]);
    assert!(plain.rainfall[inside] > 200.0);
    assert!((out.temperature[inside] - (28.0 - 6.5 * out.elevation[inside].max(0.0) / 1000.0)).abs() < 1.5, "temperature {}", out.temperature[inside]);
    // Redder and less green than the same place without the region.
    let (a, b) = (&out.rgba[inside * 4..inside * 4 + 3], &plain.rgba[inside * 4..inside * 4 + 3]);
    assert!(a[0] as i32 > b[0] as i32 + 25, "desert {a:?} was {b:?}");
    // Well outside, on the far side of the range, nothing changed.
    let outside = cell(&e, [450.0, 800.0]);
    assert_eq!(out.rainfall[outside], plain.rainfall[outside]);
    assert_eq!(out.temperature[outside], plain.temperature[outside]);
    // The soft edge blends: halfway across it the rain is in between.
    let edge = cell(&e, [1220.0, 800.0]);
    assert!(out.rainfall[edge] > 70.0 && out.rainfall[edge] < plain.rainfall[edge] - 10.0, "edge {} vs {}", out.rainfall[edge], plain.rainfall[edge]);
}

#[test]
fn the_render_plans_rivers_hills_and_lakes_as_vectors() {
    let e = world(vec![river()], vec![]);
    let out = go(&e);
    let g = &out.generated;
    assert!(g.rivers.len() >= 5, "{} rivers", g.rivers.len());
    for r in &g.rivers {
        assert!(r.points.len() >= 2 && r.points.len() <= 40 && r.flow >= 6.0);
        // Rivers run downhill: the source is higher than the mouth.
        let (a, b) = (r.points[0], r.points[r.points.len() - 1]);
        if let (Some(i), Some(j)) = (e.cell_at(a), e.cell_at(b)) {
            assert!(out.elevation[i] >= out.elevation[j] - 30.0, "river climbs from {} to {}", out.elevation[i], out.elevation[j]);
        }
    }
    assert!(g.rivers.windows(2).all(|w| w[0].flow >= w[1].flow), "biggest first");
    assert!(g.hills.len() >= 3, "{} hills", g.hills.len());
    for h in &g.hills {
        assert!(h.points.len() >= 2 && (25.0..=450.0).contains(&h.height) && h.width_km > 0.0);
        // Hills stand on land, away from the drawn mountain range.
        let mid = h.points[h.points.len() / 2];
        assert_eq!(e.water()[cell(&e, mid)] == LAND || e.water()[cell(&e, mid)] == RIVER, true);
        assert!((mid[0] - 800.0).abs() > 60.0 || mid[1] < 380.0 || mid[1] > 1220.0, "hill on the drawn range at {mid:?}");
    }
    // The hills are in the ground: their crests stand above the plain the guides gave.
    let lifted = g.hills.iter().filter(|h| {
        let i = cell(&e, h.points[h.points.len() / 2]);
        out.elevation[i] > e.ground()[i]
    }).count();
    assert!(lifted * 2 > g.hills.len(), "{lifted} of {} hill crests stand proud", g.hills.len());
    // The flattened form the app reads accounts for every number.
    let flat = g.to_f32();
    let expect = 3 + g.rivers.iter().map(|r| 2 + r.points.len() * 2).sum::<usize>() + g.hills.iter().map(|h| 3 + h.points.len() * 2).sum::<usize>() + g.lakes.iter().map(|l| 2 + l.points.len() * 2).sum::<usize>();
    assert_eq!(flat.len(), expect);
}

#[test]
fn a_basin_fills_into_a_lake_with_an_outline() {
    // A ring of mountains encloses a basin in rainy country.
    let ring: Vec<[f32; 2]> = (0..=12).map(|i| {
        let a = i as f32 / 12.0 * std::f32::consts::TAU;
        [800.0 + 170.0 * a.cos(), 800.0 + 170.0 * a.sin()]
    }).collect();
    let wall = Mountain { id: 2, seed: 9, points: ring, height: 1500.0, width_km: 60.0, rugged: 0.2, curviness: 1.0, ..Default::default() };
    let mut e = Engine::new(SIZE, SIZE, EXTENT_KM);
    e.set_guides(42, vec![continent()], vec![wall], vec![]);
    let out = render(&e, &Climate { rainfall_mm: 1500.0, evaporation_mm: 300.0, ..Climate::default() }, Style::TrueColour);
    assert!(out.lake_cells > 20, "{} lake cells", out.lake_cells);
    let lake = out.generated.lakes.first().expect("a lake outline");
    assert!(lake.points.len() >= 4);
    let (cx, cy) = lake.points.iter().fold((0.0, 0.0), |a, p| (a.0 + p[0] / lake.points.len() as f32, a.1 + p[1] / lake.points.len() as f32));
    assert!((cx - 800.0).abs() < 150.0 && (cy - 800.0).abs() < 150.0, "lake centred at {cx}, {cy}");
    assert!(lake.level > 300.0, "level {}", lake.level);
}

#[test]
fn fine_heights_match_whether_rendered_whole_or_in_strips_and_slopes_follow_the_streams() {
    let e = world(vec![river()], vec![]);
    let s = go(&e).structure;
    let window = |y: f32, rows: u32| {
        let mut w = Engine::window(160, rows + 6, [700.0, y - 3.0 * 0.5], 0.5);
        w.set_guides(42, vec![continent()], vec![range()], vec![river()]);
        w
    };
    let (rgba, height) = render_fine_full(&window(700.0, 80), &s, Style::TrueColour, 80, 3);
    assert_eq!((rgba.len(), height.len()), (160 * 80 * 4, 160 * 80));
    let (_, top) = render_fine_full(&window(700.0, 40), &s, Style::TrueColour, 40, 3);
    let (_, bottom) = render_fine_full(&window(720.0, 40), &s, Style::TrueColour, 40, 3);
    assert_eq!(height, [top, bottom].concat());
    // On the mountainside the ground is cut into ridges and gullies: relief
    // within a few km is large.
    let (lo, hi) = height.iter().fold((f32::MAX, f32::MIN), |a, v| (a.0.min(*v), a.1.max(*v)));
    assert!(hi - lo > 400.0, "relief {} m", hi - lo);
}
