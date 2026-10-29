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
