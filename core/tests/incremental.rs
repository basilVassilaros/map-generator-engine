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
    Shape { id, coast: Coastline { points, params, seed }, frame: Frame { x: cx, y: cy, angle: 0.0 } }
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
