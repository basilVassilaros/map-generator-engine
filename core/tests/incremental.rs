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

use terrain_core::{Frame, Shape};

fn island(id: u32, cx: f32, cy: f32, r: f32, seed: u32) -> Shape {
    let points: Vec<[f32; 2]> = (0..7)
        .map(|i| {
            let a = i as f32 / 7.0 * std::f32::consts::TAU;
            [cx + r * a.cos(), cy + r * 0.8 * a.sin()]
        })
        .collect();
    let params = points.iter().map(|_| SegmentParams::default()).collect();
    Shape { id, coast: Coastline { points, params, seed }, frame: Frame { x: cx, y: cy, angle: 0.0, scale: 1.0 }, water: false }
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
    Shape { water: true, ..island(id, cx, cy, r, seed) }
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
            assert!(at_km(&e, p[0], p[1]) > 0.0, "seed {seed}: sea inside the drawn shape at {p:?}");
        }
    }
}

#[test]
fn everything_drawn_as_water_is_water() {
    let continent = island(1, 800.0, 800.0, 600.0, 7);
    let water = lake(2, 800.0, 800.0, 220.0, 8);
    let e = world(&[continent, water.clone()]);
    for p in just_inside(&water) {
        assert!(at_km(&e, p[0], p[1]) < 0.0, "land inside the drawn lake at {p:?}");
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
    assert!(at_km(&e, 800.0, 960.0) < 0.0, "lake");
    // Inside the continent's drawn edge (y = 1243) and beyond the lake's furthest growth.
    assert!(at_km(&e, 800.0, 1200.0) > 0.0, "continent");
}

#[test]
fn kind_and_order_changes_match_full_regeneration() {
    let mut shapes = vec![island(1, 800.0, 800.0, 600.0, 1), lake(2, 750.0, 750.0, 250.0, 2), island(3, 1300.0, 300.0, 150.0, 3)];
    let mut live = world(&shapes);

    shapes[1].water = false; // lake becomes land
    live.set_shapes(99, shapes.clone());
    assert_same(&live, &world(&shapes));

    shapes[2].water = true; // island becomes water
    live.set_shapes(99, shapes.clone());
    assert_same(&live, &world(&shapes));

    shapes[1].water = true;
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
    let wet = just_inside(&shape).iter().filter(|p| at_km(&e, p[0], p[1]) < 0.0).count();
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
