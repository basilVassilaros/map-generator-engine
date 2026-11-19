//! Partial updates must be exact: editing a guide and regenerating only the
//! affected rectangle has to give the same result as regenerating everything.

use terrain_core::{Coastline, Engine, SegmentParams};

const SIZE: u32 = 384;
const EXTENT_KM: f32 = 1600.0;

fn sample_coast() -> Coastline {
    let points = vec![
        [400.0, 300.0], [800.0, 220.0], [1150.0, 380.0], [1300.0, 750.0],
        [1180.0, 1150.0], [820.0, 1320.0], [450.0, 1200.0], [280.0, 820.0],
    ];
    let params = (0..points.len())
        .map(|i| SegmentParams {
            roughness: 0.1 * i as f32,
            coves: 0.9 - 0.1 * i as f32,
            shore_km: 1.0 + 3.0 * i as f32,
            reach_km: 8.0 * i as f32,
            inside_km: if i % 3 == 0 { 20.0 } else { 0.0 },
        })
        .collect();
    Coastline { points, params, seed: 4242 }
}

fn fresh(coast: &Coastline) -> Engine {
    let mut e = Engine::new(SIZE, SIZE, EXTENT_KM);
    e.set_coast(Some(coast.clone()));
    e
}

fn assert_same(a: &Engine, b: &Engine) {
    assert_eq!(a.elevation(), b.elevation(), "elevation differs");
    assert_eq!(a.rgba(), b.rgba(), "pixels differ");
}

#[test]
fn generation_is_deterministic() {
    assert_same(&fresh(&sample_coast()), &fresh(&sample_coast()));
}

#[test]
fn centre_is_land_and_corner_is_sea() {
    let e = fresh(&sample_coast());
    let at = |x: u32, y: u32| e.elevation()[(y * SIZE + x) as usize];
    assert!(at(SIZE / 2, SIZE / 2) > 0.0);
    assert!(at(2, 2) < 0.0);
}

#[test]
fn parameter_edit_matches_full_regeneration() {
    let mut coast = sample_coast();
    let mut live = fresh(&coast);
    for (seg, value) in [(2usize, 0.95f32), (5, 0.0), (0, 0.6)] {
        coast.params[seg].roughness = value;
        coast.params[seg].shore_km = 25.0 * value + 0.2;
        let dirty = live.set_coast(Some(coast.clone()));
        assert!(dirty.cells() < (SIZE * SIZE) as u64, "edit should be partial");
        assert_same(&live, &fresh(&coast));
    }
}

#[test]
fn point_drag_matches_full_regeneration() {
    let mut coast = sample_coast();
    let mut live = fresh(&coast);
    for step in 0..5 {
        coast.points[3][0] += 37.0;
        coast.points[3][1] -= 21.0 * step as f32;
        live.set_coast(Some(coast.clone()));
        assert_same(&live, &fresh(&coast));
    }
}

#[test]
fn clearing_restores_empty_ocean() {
    let mut live = fresh(&sample_coast());
    live.set_coast(None);
    assert_same(&live, &Engine::new(SIZE, SIZE, EXTENT_KM));
}

#[test]
fn zoomed_window_edits_match_full_regeneration() {
    // A window onto part of the map, with small cells, as a zoomed view uses.
    let window = || Engine::window(300, 200, [500.0, 600.0], 0.4);
    let mut coast = sample_coast();
    let mut live = window();
    live.set_coast(Some(coast.clone()));
    coast.params[7].coves = 1.0;
    coast.points[7][0] += 15.0;
    live.set_coast(Some(coast.clone()));
    let mut fresh_window = window();
    fresh_window.set_coast(Some(coast));
    assert_same(&live, &fresh_window);
}

#[test]
fn window_lines_up_with_the_whole_map() {
    // Same cell size, offset window: cells must hold identical values.
    let coast = sample_coast();
    let whole = fresh(&coast);
    let cell = EXTENT_KM / SIZE as f32;
    let mut part = Engine::window(64, 48, [100.0 * cell, 150.0 * cell], cell);
    part.set_coast(Some(coast));
    for y in 0..48u32 {
        for x in 0..64u32 {
            let a = whole.elevation()[((150 + y) * SIZE + 100 + x) as usize];
            let b = part.elevation()[(y * 64 + x) as usize];
            assert!((a - b).abs() < 0.01, "cell {x},{y}: {a} vs {b}");
        }
    }
}

// --- multiple shapes ----------------------------------------------------------

use terrain_core::engine::{FLOODED, LAND, RIVER};
use terrain_core::{Frame, Mountain, River, Shape, ShapeKind, AUTO_LEVEL};

fn island(id: u32, cx: f32, cy: f32, r: f32, seed: u32) -> Shape {
    let points: Vec<[f32; 2]> = (0..7)
        .map(|i| {
            let a = i as f32 / 7.0 * std::f32::consts::TAU;
            [cx + r * a.cos(), cy + r * 0.8 * a.sin()]
        })
        .collect();
    let params = points.iter().map(|_| SegmentParams::default()).collect();
    Shape { id, coast: Coastline { points, params, seed }, frame: Frame { x: cx, y: cy, angle: 0.0, scale: 1.0 }, kind: ShapeKind::Land, height: 300.0 }
}

fn world(shapes: &[Shape]) -> Engine {
    let mut e = Engine::new(SIZE, SIZE, EXTENT_KM);
    e.set_shapes(99, shapes.to_vec());
    e
}

fn archipelago() -> Vec<Shape> {
    vec![island(1, 450.0, 500.0, 260.0, 11), island(2, 1100.0, 600.0, 300.0, 22), island(3, 800.0, 1200.0, 180.0, 33)]
}

#[test]
fn overlapping_shapes_stay_land() {
    // Two overlapping islands: the overlap must be land, not cancelled out.
    let shapes = vec![island(1, 700.0, 800.0, 300.0, 1), island(2, 900.0, 800.0, 300.0, 2)];
    let e = world(&shapes);
    let cell = EXTENT_KM / SIZE as f32;
    let at = |x: f32, y: f32| e.elevation()[((y / cell) as u32 * SIZE + (x / cell) as u32) as usize];
    assert!(at(800.0, 800.0) > 0.0, "overlap should be land");
}

#[test]
fn shape_edits_match_full_regeneration() {
    let mut shapes = archipelago();
    let mut live = world(&shapes);

    shapes[1].coast.params[3].coves = 1.0; // slider
    live.set_shapes(99, shapes.clone());
    assert_same(&live, &world(&shapes));

    shapes[0].coast.points[2][0] += 25.0; // drag a point
    live.set_shapes(99, shapes.clone());
    assert_same(&live, &world(&shapes));

    shapes[0].coast.points[2][0] += 400.0; // drag it far, so the shape's reach grows
    live.set_shapes(99, shapes.clone());
    assert_same(&live, &world(&shapes));

    shapes.push(island(4, 300.0, 1300.0, 120.0, 44)); // add a shape
    live.set_shapes(99, shapes.clone());
    assert_same(&live, &world(&shapes));

    shapes.remove(2); // delete a shape
    live.set_shapes(99, shapes.clone());
    assert_same(&live, &world(&shapes));

    for p in shapes[1].coast.points.iter_mut() {
        p[0] -= 60.0; // move a whole shape
        p[1] += 35.0;
    }
    shapes[1].frame.x -= 60.0;
    shapes[1].frame.y += 35.0;
    live.set_shapes(99, shapes.clone());
    assert_same(&live, &world(&shapes));

    live.set_shapes(99, Vec::new()); // clear everything
    assert_same(&live, &Engine::new(SIZE, SIZE, EXTENT_KM));
}

#[test]
fn moving_a_shape_keeps_its_coastline() {
    // Move an island by a whole number of cells: its outline (where land
    // meets sea) must move with it unchanged.
    let cell = EXTENT_KM / SIZE as f32;
    let (dx, dy) = (40u32, 25u32);
    let a = island(1, 600.0, 600.0, 250.0, 5);
    let mut b = a.clone();
    for p in b.coast.points.iter_mut() {
        p[0] += dx as f32 * cell;
        p[1] += dy as f32 * cell;
    }
    b.frame.x += dx as f32 * cell;
    b.frame.y += dy as f32 * cell;
    let ea = world(&[a]);
    let eb = world(&[b]);
    let (mut same, mut total) = (0u32, 0u32);
    for y in 0..SIZE - dy {
        for x in 0..SIZE - dx {
            let la = ea.elevation()[(y * SIZE + x) as usize] > 0.0;
            let lb = eb.elevation()[((y + dy) * SIZE + x + dx) as usize] > 0.0;
            total += 1;
            same += (la == lb) as u32;
        }
    }
    let mismatch = total - same;
    assert!(mismatch < 20, "{mismatch} cells changed between land and sea");
}

// --- fill in, and water shapes ----------------------------------------------

fn lake(id: u32, cx: f32, cy: f32, r: f32, seed: u32) -> Shape {
    Shape { kind: ShapeKind::Water, height: AUTO_LEVEL, ..island(id, cx, cy, r, seed) }
}

/// Signed distance to the coast at a world position: negative means water.
fn shore_km(e: &Engine, x: f32, y: f32) -> f32 {
    let cell = EXTENT_KM / SIZE as f32;
    e.shore()[((y / cell) as u32 * SIZE + (x / cell) as u32) as usize]
}

/// Elevation at a world position (km) on a whole-map engine.
fn at_km(e: &Engine, x: f32, y: f32) -> f32 {
    let cell = EXTENT_KM / SIZE as f32;
    e.elevation()[((y / cell) as u32 * SIZE + (x / cell) as u32) as usize]
}

/// Cells just inside every edge of a shape's outline.
fn just_inside(shape: &Shape) -> Vec<[f32; 2]> {
    let pts = &shape.coast.points;
    let c = [shape.frame.x, shape.frame.y];
    let mut out = Vec::new();
    for i in 0..pts.len() {
        let (a, b) = (pts[i], pts[(i + 1) % pts.len()]);
        for k in 1..10 {
            let t = k as f32 / 10.0;
            let p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
            // Step 8 km towards the centre.
            let (dx, dy) = (c[0] - p[0], c[1] - p[1]);
            let len = (dx * dx + dy * dy).sqrt();
            out.push([p[0] + dx / len * 8.0, p[1] + dy / len * 8.0]);
        }
    }
    out
}

#[test]
fn everything_drawn_as_land_is_land() {
    for seed in [1, 2, 3, 4, 5] {
        let shape = island(1, 800.0, 800.0, 400.0, seed);
        let e = world(&[shape.clone()]);
        for p in just_inside(&shape) {
            assert!(shore_km(&e, p[0], p[1]) > 0.0, "seed {seed}: sea inside the drawn shape at {p:?}");
        }
    }
}

#[test]
fn everything_drawn_as_water_is_water() {
    let continent = island(1, 800.0, 800.0, 600.0, 7);
    let water = lake(2, 800.0, 800.0, 220.0, 8);
    let e = world(&[continent, water.clone()]);
    for p in just_inside(&water) {
        assert!(shore_km(&e, p[0], p[1]) < 0.0, "land inside the drawn lake at {p:?}");
    }
    // Inside the continent's drawn edge (about y = 1243 here) and beyond the
    // furthest the lake can grow (its edge is near y = 1022, plus at most 82 km).
    assert!(at_km(&e, 800.0, 1200.0) > 0.0, "the continent around the lake is still land");
}

#[test]
fn island_in_a_lake_in_a_continent() {
    let shapes = vec![island(1, 800.0, 800.0, 600.0, 1), lake(2, 800.0, 800.0, 300.0, 2), island(3, 800.0, 800.0, 90.0, 3)];
    let e = world(&shapes);
    assert!(at_km(&e, 800.0, 800.0) > 0.0, "island");
    // Inside the lake's drawn edge (y = 1022) but beyond the island's furthest growth.
    assert!(shore_km(&e, 800.0, 960.0) < 0.0, "lake");
    // Inside the continent's drawn edge (y = 1243) and beyond the lake's furthest growth.
    assert!(at_km(&e, 800.0, 1200.0) > 0.0, "continent");
}

#[test]
fn kind_and_order_changes_match_full_regeneration() {
    let mut shapes = vec![island(1, 800.0, 800.0, 600.0, 1), lake(2, 750.0, 750.0, 250.0, 2), island(3, 1300.0, 300.0, 150.0, 3)];
    let mut live = world(&shapes);

    shapes[1].kind = ShapeKind::Land; // lake becomes land
    live.set_shapes(99, shapes.clone());
    assert_same(&live, &world(&shapes));

    shapes[2].kind = ShapeKind::Water; // island becomes water
    live.set_shapes(99, shapes.clone());
    assert_same(&live, &world(&shapes));

    shapes[1].kind = ShapeKind::Water;
    shapes.swap(0, 1); // the lake now comes first, so the continent covers it
    live.set_shapes(99, shapes.clone());
    assert_same(&live, &world(&shapes));

    shapes[0].coast.params[2].reach_km = 60.0; // a reach slider on a water shape
    live.set_shapes(99, shapes.clone());
    assert_same(&live, &world(&shapes));
}

#[test]
fn smoothing_and_inward_reach_match_full_regeneration() {
    let mut shapes = archipelago();
    let mut live = world(&shapes);
    live.set_smoothing(1.5);
    let fresh_smooth = |shapes: &[Shape]| {
        let mut e = Engine::new(SIZE, SIZE, EXTENT_KM);
        e.set_smoothing(1.5);
        e.set_shapes(99, shapes.to_vec());
        e
    };
    assert_same(&live, &fresh_smooth(&shapes));

    shapes[1].coast.params[2].inside_km = 45.0; // let this stretch cut inside the line
    live.set_shapes(99, shapes.clone());
    assert_same(&live, &fresh_smooth(&shapes));

    shapes[0].coast.points[1][1] -= 30.0; // and a drag, with smoothing on
    live.set_shapes(99, shapes.clone());
    assert_same(&live, &fresh_smooth(&shapes));
}

#[test]
fn inward_reach_can_cut_into_the_shape() {
    // With "reach inside" raised, some cells just inside the drawn line become sea.
    let mut shape = island(1, 800.0, 800.0, 400.0, 3);
    for p in shape.coast.params.iter_mut() {
        p.inside_km = 60.0;
        p.coves = 1.0;
    }
    let e = world(&[shape.clone()]);
    let wet = just_inside(&shape).iter().filter(|p| shore_km(&e, p[0], p[1]) < 0.0).count();
    assert!(wet > 0, "expected some sea inside the drawn line");
}

#[test]
fn resizing_a_shape_keeps_its_coastline() {
    // Double an island's size about its frame: land and sea must match the
    // original, sampled at the corresponding (doubled) positions.
    let a = island(1, 600.0, 600.0, 180.0, 9);
    let mut b = a.clone();
    let (fx, fy) = (a.frame.x, a.frame.y);
    for p in b.coast.points.iter_mut() {
        p[0] = fx + (p[0] - fx) * 2.0;
        p[1] = fy + (p[1] - fy) * 2.0;
    }
    b.frame.scale = 2.0;
    let ea = world(&[a]);
    let eb = world(&[b]);
    let (mut same, mut total) = (0u32, 0u32);
    for i in 0..120 {
        for j in 0..120 {
            // A grid around the small island, and the matching point on the big one.
            let p = [fx - 300.0 + i as f32 * 5.0, fy - 300.0 + j as f32 * 5.0];
            let q = [fx + (p[0] - fx) * 2.0, fy + (p[1] - fy) * 2.0];
            if q[0] < 0.0 || q[1] < 0.0 || q[0] >= EXTENT_KM || q[1] >= EXTENT_KM {
                continue;
            }
            total += 1;
            same += ((at_km(&ea, p[0], p[1]) > 0.0) == (at_km(&eb, q[0], q[1]) > 0.0)) as u32;
        }
    }
    // Allow for pixel rounding along the coast.
    assert!(same as f32 / total as f32 > 0.97, "{same} of {total} matched");
}

#[test]
fn scaled_shape_edits_match_full_regeneration() {
    let mut shapes = archipelago();
    shapes[0].frame.scale = 2.5;
    shapes[2].frame.scale = 0.5;
    let mut live = world(&shapes);
    shapes[0].coast.params[1].reach_km = 60.0;
    live.set_shapes(99, shapes.clone());
    assert_same(&live, &world(&shapes));
    shapes[2].coast.points[0][0] += 20.0;
    live.set_shapes(99, shapes.clone());
    assert_same(&live, &world(&shapes));
    shapes[2].frame.scale = 1.5;
    live.set_shapes(99, shapes.clone());
    assert_same(&live, &world(&shapes));
}

// --- heights, escarpments, flooding, mountains and rivers -------------------------

fn kind_at(e: &Engine, x: f32, y: f32) -> u8 {
    let cell = EXTENT_KM / SIZE as f32;
    e.water()[((y / cell) as u32 * SIZE + (x / cell) as u32) as usize]
}

fn surface_at(e: &Engine, x: f32, y: f32) -> f32 {
    let cell = EXTENT_KM / SIZE as f32;
    e.surface()[((y / cell) as u32 * SIZE + (x / cell) as u32) as usize]
}

/// A land shape with a height and an edge slope.
fn land(id: u32, cx: f32, cy: f32, r: f32, seed: u32, height: f32, slope_km: f32) -> Shape {
    let mut s = Shape { height, ..island(id, cx, cy, r, seed) };
    for p in s.coast.params.iter_mut() {
        p.shore_km = slope_km;
        p.reach_km = 10.0;
    }
    s
}

#[test]
fn land_height_sets_the_surface() {
    let low = world(&[land(1, 800.0, 800.0, 600.0, 1, 200.0, 4.0)]);
    let high = world(&[land(1, 800.0, 800.0, 600.0, 1, 1500.0, 4.0)]);
    let (a, b) = (at_km(&low, 800.0, 800.0), at_km(&high, 800.0, 800.0));
    assert!((a - 200.0).abs() < 130.0, "low land at {a} m");
    assert!((b - 1500.0).abs() < 200.0, "high land at {b} m");
}

#[test]
fn land_on_land_makes_an_escarpment() {
    // The steepest step between neighbouring cells across the inner shape's edge.
    let steepest = |slope_km: f32| {
        let e = world(&[land(1, 800.0, 800.0, 650.0, 1, 300.0, 4.0), land(2, 800.0, 800.0, 300.0, 2, 1800.0, slope_km)]);
        assert!(at_km(&e, 800.0, 800.0) > 1500.0, "the upper land is high");
        assert!(at_km(&e, 800.0, 1220.0) < 700.0, "the lower land is not");
        let cell = EXTENT_KM / SIZE as f32;
        let (from, to) = (((800.0 - 450.0) / cell) as u32, ((800.0 + 450.0) / cell) as u32);
        let mut worst = 0.0f32;
        for x in from..to {
            let i = ((SIZE / 2) * SIZE + x) as usize;
            worst = worst.max((e.elevation()[i + 1] - e.elevation()[i]).abs());
        }
        worst
    };
    let (cliff, ramp) = (steepest(0.1), steepest(30.0));
    assert!(cliff > 900.0, "cliff steepest step {cliff} m");
    assert!(ramp < 150.0, "ramp steepest step {ramp} m");
}

#[test]
fn lower_land_on_land_steps_down() {
    let e = world(&[land(1, 800.0, 800.0, 650.0, 1, 1200.0, 4.0), land(2, 800.0, 800.0, 250.0, 2, 300.0, 5.0)]);
    assert!(at_km(&e, 800.0, 800.0) < 600.0 && at_km(&e, 800.0, 1200.0) > 900.0);
}

#[test]
fn lake_takes_the_level_of_the_land_or_its_own() {
    let shapes = vec![land(1, 800.0, 800.0, 650.0, 1, 900.0, 5.0), lake(2, 800.0, 800.0, 120.0, 3)];
    let auto = world(&shapes);
    assert_ne!(kind_at(&auto, 800.0, 800.0), LAND);
    // Following the ground, it sits in a hollow a little below the land's 900 m...
    let level = surface_at(&auto, 800.0, 800.0);
    assert!(level > 700.0 && level < 900.0, "auto level {level}");
    // ...and never floods the country around it.
    let flooded = auto.water().iter().filter(|k| **k == FLOODED).count();
    assert_eq!(flooded, 0, "a lake at ground level flooded {flooded} cells");
    let mut set = shapes.clone();
    set[1].height = 400.0;
    let fixed = world(&set);
    assert!((surface_at(&fixed, 800.0, 800.0) - 400.0).abs() < 1.0);
}

#[test]
fn land_below_water_it_touches_floods() {
    // A low patch reaching the coast floods; the same patch inland stays dry.
    let continent = land(1, 800.0, 800.0, 600.0, 1, 400.0, 4.0);
    let coastal = world(&[continent.clone(), land(2, 1250.0, 800.0, 160.0, 2, -300.0, 8.0)]);
    assert_eq!(kind_at(&coastal, 1250.0, 800.0), FLOODED, "low land open to the sea floods");
    assert_eq!(surface_at(&coastal, 1250.0, 800.0), 0.0, "to sea level");

    let inland = world(&[continent, land(2, 800.0, 800.0, 160.0, 2, -300.0, 8.0)]);
    assert_eq!(kind_at(&inland, 800.0, 800.0), LAND, "a basin no water reaches stays dry");
    assert!(at_km(&inland, 800.0, 800.0) < 0.0, "though it lies below sea level");
}

#[test]
fn land_below_a_lake_it_touches_floods_to_the_lake_level() {
    let mut water = lake(3, 800.0, 800.0, 100.0, 3);
    water.height = 500.0;
    let shapes = vec![land(1, 800.0, 800.0, 650.0, 1, 600.0, 4.0), land(2, 980.0, 800.0, 110.0, 2, 350.0, 6.0), water];
    let e = world(&shapes);
    assert_eq!(kind_at(&e, 1000.0, 800.0), FLOODED);
    assert!((surface_at(&e, 1000.0, 800.0) - 500.0).abs() < 1.0);
}

fn peak(id: u32, points: Vec<[f32; 2]>, height: f32, width_km: f32) -> Mountain {
    Mountain { id, seed: id * 7 + 1, points, height, width_km, rugged: 0.6, ..Default::default() }
}

fn with_features(shapes: &[Shape], mountains: &[Mountain], rivers: &[River]) -> Engine {
    let mut e = Engine::new(SIZE, SIZE, EXTENT_KM);
    e.set_guides(99, shapes.to_vec(), mountains.to_vec(), rivers.to_vec());
    e
}

#[test]
fn mountains_raise_the_ground_along_their_line() {
    let shapes = [land(1, 800.0, 800.0, 650.0, 1, 300.0, 4.0)];
    let flat = with_features(&shapes, &[], &[]);
    let range = peak(1, vec![[500.0, 800.0], [1100.0, 800.0]], 3000.0, 60.0);
    let e = with_features(&shapes, &[range], &[]);
    // Highest point along a line across the range, and a point well clear of it.
    let cell = EXTENT_KM / SIZE as f32;
    let crest = (0..80).map(|k| at_km(&e, 800.0, 760.0 + k as f32 * cell)).fold(0.0f32, f32::max);
    assert!(crest > 1700.0, "crest {crest} m");
    assert_eq!(at_km(&e, 800.0, 1100.0), at_km(&flat, 800.0, 1100.0), "ground beyond its slopes is untouched");
}

#[test]
fn a_mountain_in_the_sea_is_an_island() {
    let e = with_features(&[], &[peak(1, vec![[800.0, 800.0]], 2500.0, 40.0)], &[]);
    assert_eq!(kind_at(&e, 800.0, 800.0), LAND);
    assert!(at_km(&e, 800.0, 800.0) > 500.0);
    assert_ne!(kind_at(&e, 1000.0, 800.0), LAND, "open sea away from it");
}

#[test]
fn rivers_run_downhill_and_cut_through_rises() {
    // A river crossing a mountain range on its way to the coast.
    let shapes = [land(1, 800.0, 800.0, 650.0, 1, 500.0, 6.0)];
    let range = peak(1, vec![[800.0, 500.0], [800.0, 1100.0]], 2000.0, 50.0);
    let river = River { id: 1, points: vec![[600.0, 800.0], [1000.0, 820.0], [1500.0, 800.0]], width_km: 4.0, depth_m: 30.0, ..Default::default() };
    let e = with_features(&shapes, &[range], &[river.clone()]);
    let cell = EXTENT_KM / SIZE as f32;
    let mut last = f32::MAX;
    let mut wet = 0;
    for k in 0..200 {
        let x = 600.0 + k as f32 * cell;
        if x > 1350.0 {
            break;
        }
        let y = 800.0 + (x - 600.0) / 400.0 * 20.0_f32.min(20.0);
        if kind_at(&e, x, y.min(820.0)) == RIVER {
            let s = surface_at(&e, x, y.min(820.0));
            assert!(s <= last + 0.01, "river rises from {last} to {s} at x = {x}");
            last = s;
            wet += 1;
        }
    }
    assert!(wet > 30, "only {wet} river cells found");
}

#[test]
fn edits_with_mountains_and_rivers_match_full_regeneration() {
    let mut shapes = vec![land(1, 800.0, 800.0, 650.0, 1, 400.0, 4.0), land(2, 700.0, 700.0, 250.0, 2, 1400.0, 3.0), lake(3, 950.0, 950.0, 90.0, 3)];
    let mut mountains = vec![peak(1, vec![[500.0, 900.0], [900.0, 1100.0]], 2500.0, 55.0)];
    let mut rivers = vec![River { id: 1, points: vec![[700.0, 700.0], [1000.0, 1300.0]], width_km: 3.0, depth_m: 25.0, ..Default::default() }];
    let mut live = with_features(&shapes, &mountains, &rivers);

    shapes[1].height = 2200.0; // a shape's height
    live.set_guides(99, shapes.clone(), mountains.clone(), rivers.clone());
    assert_same(&live, &with_features(&shapes, &mountains, &rivers));

    mountains[0].points[1] = [950.0, 1000.0]; // drag a mountain point
    mountains[0].height = 3200.0;
    live.set_guides(99, shapes.clone(), mountains.clone(), rivers.clone());
    assert_same(&live, &with_features(&shapes, &mountains, &rivers));

    rivers[0].points[1] = [1200.0, 1250.0]; // move the river's mouth
    live.set_guides(99, shapes.clone(), mountains.clone(), rivers.clone());
    assert_same(&live, &with_features(&shapes, &mountains, &rivers));

    shapes.push(land(4, 1250.0, 800.0, 150.0, 4, -200.0, 8.0)); // low coast: floods
    live.set_guides(99, shapes.clone(), mountains.clone(), rivers.clone());
    assert_same(&live, &with_features(&shapes, &mountains, &rivers));

    mountains.clear(); // remove the mountains and the river
    rivers.clear();
    live.set_guides(99, shapes.clone(), mountains.clone(), rivers.clone());
    assert_same(&live, &with_features(&shapes, &mountains, &rivers));
}

#[test]
fn curved_rivers_still_run_downhill_and_edits_match_full_regeneration() {
    let shapes = [land(1, 800.0, 800.0, 650.0, 1, 500.0, 6.0)];
    let range = Mountain { curviness: 0.8, ..peak(1, vec![[800.0, 450.0], [700.0, 800.0], [820.0, 1150.0]], 2000.0, 50.0) };
    let mut river = River { id: 1, points: vec![[550.0, 700.0], [900.0, 950.0], [1250.0, 800.0], [1500.0, 900.0]], width_km: 4.0, depth_m: 30.0, curviness: 1.0, ..Default::default() };
    let e = with_features(&shapes, &[range.clone()], &[river.clone()]);
    // Walk every river cell in order along the curve: the surface never rises.
    let path = terrain_core::features::curve_path(&river.points, river.curviness, &river.bends);
    let cell = EXTENT_KM / SIZE as f32;
    let mut last = f32::MAX;
    let mut wet = 0;
    for w in path.windows(2) {
        let steps = (((w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1])) / cell).ceil() as usize;
        for k in 0..steps.max(1) {
            let t = k as f32 / steps.max(1) as f32;
            let (x, y) = (w[0][0] + (w[1][0] - w[0][0]) * t, w[0][1] + (w[1][1] - w[0][1]) * t);
            if x > 1350.0 { continue; }
            if kind_at(&e, x, y) == RIVER {
                let s = surface_at(&e, x, y);
                assert!(s <= last + 0.01, "curved river rises from {last} to {s}");
                last = s;
                wet += 1;
            }
        }
    }
    assert!(wet > 40, "only {wet} river cells on the curve");

    let mut live = with_features(&shapes, &[range.clone()], &[river.clone()]);
    river.curviness = 0.3; // the slider
    live.set_guides(99, shapes.to_vec(), vec![range.clone()], vec![river.clone()]);
    assert_same(&live, &with_features(&shapes, &[range.clone()], &[river.clone()]));
    river.bends = vec![0.0, 40.0, 0.0]; // bow the middle segment
    let bowed = Mountain { bends: vec![-30.0, 0.0], ..range };
    live.set_guides(99, shapes.to_vec(), vec![bowed.clone()], vec![river.clone()]);
    assert_same(&live, &with_features(&shapes, &[bowed], &[river]));
}

#[test]
fn overlapping_land_with_different_slopes_has_no_cliff_where_they_meet() {
    // Two overlapping land shapes of the same height but very different shore
    // slopes. Inland, the steepest step between neighbouring cells must be no
    // worse than the gentle ramp of the shallower coast alone: there must be no
    // cliff along the line where one shape's coast takes over from the other's.
    let steepest = |slope_a: f32| {
        let e = world(&[land(1, 700.0, 800.0, 450.0, 1, 600.0, slope_a), land(2, 1000.0, 800.0, 450.0, 2, 600.0, 25.0)]);
        let mut worst = 0.0f32;
        for y in (SIZE / 4)..(3 * SIZE / 4) {
            for x in (SIZE / 6)..(5 * SIZE / 6) {
                let i = (y * SIZE + x) as usize;
                if e.shore()[i] > 25.0 && e.shore()[i + 1] > 25.0 {
                    worst = worst.max((e.elevation()[i + 1] - e.elevation()[i]).abs());
                }
            }
        }
        worst
    };
    let (alike, mixed) = (steepest(25.0), steepest(2.0));
    assert!(mixed < alike * 1.6 + 10.0, "mixed slopes: a {mixed} m step, against {alike} m when alike");
}
