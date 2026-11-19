//! The boundary between the web app and the core.
//!
//! Deliberately narrow: the app writes guide data into an inbox buffer and
//! calls one function; the core regenerates and reports which pixels changed.
//! The app then reads those pixels straight out of WebAssembly memory.
//!
//! Guide encoding (all f32):
//!   [world_seed, edge_smoothing_px, shape_count, shape...,
//!    mountain_count, mountain..., river_count, river..., region_count, region...]
//! a biome region is [id, rainfall_mm, humidity, forest, temperature (NaN to
//! keep the latitude's), feather_km, n, x0, y0, ...],
//! a mountain is [id, seed, height_m, width_km, ruggedness, curviness, n,
//! x0, y0, ..., bend_0 ... bend_(n-2)] and a river is
//! [id, width_km, depth_m, curviness, n, x0, y0, ..., bend_0 ... bend_(n-2)]
//! (bends in km: how far each segment bows sideways).
//! and each shape is
//!   [id, seed, frame_x, frame_y, frame_angle, frame_scale, kind, height, n,
//!    x0, y0, ..., x(n-1), y(n-1), then per segment r, c, s, g, i]
//! where x/y are kilometres, r = roughness, c = coves, s = shore distance (km),
//! g = reach outside the line (km), i = reach inside the line (km), kind is 0 for land, 1 for water and 2 for a highland raised by `height`
//! metres, and the
//! frame anchors the shape's coastline detail. Shapes combine in list order. Seeds and ids must be
//! below 2^24 so they survive the trip through f32 exactly.

use std::cell::RefCell;

use crate::coast::{Coastline, Frame, SegmentParams, Shape, ShapeKind};
use crate::engine::{Engine, Rect};
use crate::features::{Mountain, Region, River};
use crate::fine::{self, Structure};
use crate::hydro::{self, Climate, Rendered};
use crate::look::Style;

thread_local! {
    static ENGINE: RefCell<Option<Engine>> = const { RefCell::new(None) };
    static INBOX: RefCell<Vec<f32>> = const { RefCell::new(Vec::new()) };
    static DIRTY: RefCell<Rect> = const { RefCell::new(Rect::EMPTY) };
    static TERRAIN: RefCell<Option<Rendered>> = const { RefCell::new(None) };
    /// The structure from stage A, flattened for sending to other workers.
    static STRUCT_BUF: RefCell<Vec<f32>> = const { RefCell::new(Vec::new()) };
    /// The structure a strip worker was given, ready to render from.
    static STRUCT: RefCell<Option<Structure>> = const { RefCell::new(None) };
    static FINE: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static FINE_HEIGHT: RefCell<Vec<f32>> = const { RefCell::new(Vec::new()) };
    /// The vectors the last terrain render planned, flattened.
    static GENERATED: RefCell<Vec<f32>> = const { RefCell::new(Vec::new()) };
}

fn with_engine<T>(f: impl FnOnce(&mut Engine) -> T) -> T {
    ENGINE.with(|e| f(e.borrow_mut().as_mut().expect("wm_init must be called first")))
}

/// Create (or recreate) a window onto the world. `width_km` is the real
/// width of the window and (`origin_x_km`, `origin_y_km`) its top-left corner.
/// For the whole map, pass the map width and an origin of (0, 0).
/// Returns 1 on success.
#[no_mangle]
pub extern "C" fn wm_init(width: u32, height: u32, width_km: f32, origin_x_km: f32, origin_y_km: f32) -> u32 {
    if width == 0 || height == 0 || width_km <= 0.0 {
        return 0;
    }
    let engine = Engine::window(width, height, [origin_x_km, origin_y_km], width_km / width as f32);
    let all = engine.full_rect();
    ENGINE.with(|e| *e.borrow_mut() = Some(engine));
    DIRTY.with(|d| *d.borrow_mut() = all);
    1
}

/// Make room for `len` floats of input and return where to write them.
#[no_mangle]
pub extern "C" fn wm_inbox(len: u32) -> *mut f32 {
    INBOX.with(|b| {
        let mut b = b.borrow_mut();
        b.clear();
        b.resize(len as usize, 0.0);
        b.as_mut_ptr()
    })
}

/// Apply the guides in the inbox. Returns the number of changed pixels.
#[no_mangle]
pub extern "C" fn wm_set_shapes(len: u32) -> u32 {
    let (seed, smoothing, shapes, mountains, rivers, regions) = INBOX.with(|b| decode_shapes(&b.borrow()[..len as usize]));
    let dirty = with_engine(|e| {
        e.set_regions(regions);
        e.set_smoothing(smoothing).union(e.set_guides(seed, shapes, mountains, rivers))
    });
    DIRTY.with(|d| *d.borrow_mut() = dirty);
    dirty.cells() as u32
}

/// Changed pixel rectangle from the last update: 0 = x0, 1 = y0, 2 = x1, 3 = y1.
#[no_mangle]
pub extern "C" fn wm_dirty(which: u32) -> u32 {
    DIRTY.with(|d| {
        let r = *d.borrow();
        match which {
            0 => r.x0,
            1 => r.y0,
            2 => r.x1,
            _ => r.y1,
        }
    })
}

#[no_mangle]
pub extern "C" fn wm_rgba() -> *const u8 {
    with_engine(|e| e.rgba().as_ptr())
}

#[no_mangle]
pub extern "C" fn wm_elevation() -> *const f32 {
    with_engine(|e| e.elevation().as_ptr())
}

/// Run stage A of the terrain render (climate, drainage, erosion, lakes,
/// rivers, biomes) on the current map, in a look (0 true colour, 1 vivid,
/// 2 atlas). Returns 1 when the picture is ready.
#[no_mangle]
pub extern "C" fn wm_render_terrain(rainfall_mm: f32, evaporation_mm: f32, latitude: f32, erosion_rounds: u32, style: u32) -> u32 {
    let climate = Climate { rainfall_mm, evaporation_mm, latitude, erosion_rounds: erosion_rounds.min(40) };
    let rendered = with_engine(|e| hydro::render(e, &climate, Style::from_u32(style)));
    STRUCT_BUF.with(|b| *b.borrow_mut() = rendered.structure.to_f32());
    GENERATED.with(|g| *g.borrow_mut() = rendered.generated.to_f32());
    TERRAIN.with(|t| *t.borrow_mut() = Some(rendered));
    1
}

#[no_mangle]
pub extern "C" fn wm_terrain_rgba() -> *const u8 {
    TERRAIN.with(|t| t.borrow().as_ref().map_or(std::ptr::null(), |r| r.rgba.as_ptr()))
}

/// Facts about the last terrain render: 0 = lake cells, 1 = river cells,
/// 2 = the highest ground (m, rounded up).
#[no_mangle]
pub extern "C" fn wm_terrain_stat(which: u32) -> u32 {
    TERRAIN.with(|t| {
        t.borrow().as_ref().map_or(0, |r| match which {
            0 => r.lake_cells,
            1 => r.river_cells,
            _ => r.elevation.iter().fold(0.0f32, |a, b| a.max(*b)).ceil() as u32,
        })
    })
}

/// Lowest (0) or highest (1) ground in the last terrain render (m).
#[no_mangle]
pub extern "C" fn wm_terrain_range(which: u32) -> f32 {
    TERRAIN.with(|t| {
        t.borrow().as_ref().map_or(0.0, |r| {
            let ground = r.elevation.iter().copied().filter(|v| v.is_finite());
            if which == 0 {
                // The sea floor is in the live map, not the render (which keeps water at its surface).
                let floor = with_engine(|e| e.elevation().iter().copied().filter(|v| v.is_finite()).fold(f32::MAX, f32::min));
                ground.fold(floor, f32::min)
            } else {
                ground.fold(f32::MIN, f32::max)
            }
        })
    })
}

/// The rivers, hills and lakes the last terrain render planned (see
/// `plan::Generated::to_f32`).
#[no_mangle]
pub extern "C" fn wm_generated_ptr() -> *const f32 {
    GENERATED.with(|g| g.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn wm_generated_len() -> u32 {
    GENERATED.with(|g| g.borrow().len() as u32)
}

/// Heights (m, one f32 per pixel) from the last `wm_render_fine`.
#[no_mangle]
pub extern "C" fn wm_fine_height() -> *const f32 {
    FINE_HEIGHT.with(|f| f.borrow().as_ptr())
}

/// The last render's structure, as numbers, to hand to strip workers.
#[no_mangle]
pub extern "C" fn wm_structure_ptr() -> *const f32 {
    STRUCT_BUF.with(|b| b.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn wm_structure_len() -> u32 {
    STRUCT_BUF.with(|b| b.borrow().len() as u32)
}

/// Load a structure (written into the inbox) for rendering strips. Returns 1 on success.
#[no_mangle]
pub extern "C" fn wm_structure_load(len: u32) -> u32 {
    let loaded = INBOX.with(|b| Structure::from_f32(&b.borrow()[..len as usize]));
    let ok = loaded.is_some() as u32;
    STRUCT.with(|s| *s.borrow_mut() = loaded);
    ok
}

/// Render the middle `rows` rows of the current engine window in fine detail
/// (the window must be `rows + 2 * halo` tall). Returns RGBA, or null if no
/// structure is loaded.
#[no_mangle]
pub extern "C" fn wm_render_fine(style: u32, rows: u32, halo: u32) -> *const u8 {
    let out = STRUCT.with(|s| s.borrow().as_ref().map(|s| with_engine(|e| fine::render_fine_full(e, s, Style::from_u32(style), rows as usize, halo as usize))));
    match out {
        Some((pixels, heights)) => FINE.with(|f| {
            FINE_HEIGHT.with(|h| *h.borrow_mut() = heights);
            *f.borrow_mut() = pixels;
            f.borrow().as_ptr()
        }),
        None => std::ptr::null(),
    }
}

type Guides = (u32, f32, Vec<Shape>, Vec<Mountain>, Vec<River>, Vec<Region>);

fn points(data: &[f32]) -> Vec<[f32; 2]> {
    data.chunks_exact(2).map(|p| [p[0], p[1]]).collect()
}

fn decode_shapes(data: &[f32]) -> Guides {
    let mut shapes = Vec::new();
    if data.len() < 3 {
        return (0, 0.0, shapes, Vec::new(), Vec::new(), Vec::new());
    }
    let seed = data[0] as u32;
    let smoothing = data[1];
    let count = data[2] as usize;
    let mut at = 3;
    for _ in 0..count {
        if data.len() < at + 9 {
            break;
        }
        let head = &data[at..at + 9];
        let n = head[8] as usize;
        let body = at + 9;
        if data.len() < body + n * 7 {
            break;
        }
        let pts = &data[body..body + n * 2];
        let prm = &data[body + n * 2..body + n * 7];
        shapes.push(Shape {
            id: head[0] as u32,
            frame: Frame { x: head[2], y: head[3], angle: head[4], scale: head[5] },
            kind: if head[6] as u32 == 1 { ShapeKind::Water } else { ShapeKind::Land },
            height: head[7],
            coast: Coastline {
                points: pts.chunks_exact(2).map(|p| [p[0], p[1]]).collect(),
                params: prm
                    .chunks_exact(5)
                    .map(|p| SegmentParams { roughness: p[0], coves: p[1], shore_km: p[2], reach_km: p[3], inside_km: p[4] })
                    .collect(),
                seed: head[1] as u32,
            },
        });
        at = body + n * 7;
    }
    let mut mountains = Vec::new();
    let mut rivers = Vec::new();
    if at < data.len() {
        let count = data[at] as usize;
        at += 1;
        for _ in 0..count {
            if data.len() < at + 7 {
                break;
            }
            let n = data[at + 6] as usize;
            let len = 7 + n * 2 + n.saturating_sub(1);
            if data.len() < at + len {
                break;
            }
            mountains.push(Mountain {
                id: data[at] as u32,
                seed: data[at + 1] as u32,
                height: data[at + 2],
                width_km: data[at + 3],
                rugged: data[at + 4],
                curviness: data[at + 5],
                points: points(&data[at + 7..at + 7 + n * 2]),
                bends: data[at + 7 + n * 2..at + len].to_vec(),
                ..Default::default()
            });
            at += len;
        }
    }
    if at < data.len() {
        let count = data[at] as usize;
        at += 1;
        for _ in 0..count {
            if data.len() < at + 5 {
                break;
            }
            let n = data[at + 4] as usize;
            let len = 5 + n * 2 + n.saturating_sub(1);
            if data.len() < at + len {
                break;
            }
            rivers.push(River {
                id: data[at] as u32,
                width_km: data[at + 1],
                depth_m: data[at + 2],
                curviness: data[at + 3],
                points: points(&data[at + 5..at + 5 + n * 2]),
                bends: data[at + 5 + n * 2..at + len].to_vec(),
                ..Default::default()
            });
            at += len;
        }
    }
    let mut regions = Vec::new();
    if at < data.len() {
        let count = data[at] as usize;
        at += 1;
        for _ in 0..count {
            if data.len() < at + 7 {
                break;
            }
            let n = data[at + 6] as usize;
            if data.len() < at + 7 + n * 2 {
                break;
            }
            regions.push(Region {
                id: data[at] as u32,
                rainfall_mm: data[at + 1],
                humidity: data[at + 2],
                forest: data[at + 3],
                temp_c: data[at + 4],
                feather_km: data[at + 5],
                points: points(&data[at + 7..at + 7 + n * 2]),
            });
            at += 7 + n * 2;
        }
    }
    (seed, smoothing, shapes, mountains, rivers, regions)
}
