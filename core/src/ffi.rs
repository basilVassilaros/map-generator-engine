//! The boundary between the web app and the core.
//!
//! Deliberately narrow: the app writes guide data into an inbox buffer and
//! calls one function; the core regenerates and reports which pixels changed.
//! The app then reads those pixels straight out of WebAssembly memory.
//!
//! Coastline encoding (all f32):
//!   [seed, n, x0, y0, ..., x(n-1), y(n-1), r0, c0, s0, ..., r(n-1), c(n-1), s(n-1)]
//! where x/y are kilometres, r = roughness, c = coves, s = shore distance (km).
//! n = 0 clears the coastline.

use std::cell::RefCell;

use crate::coast::{Coastline, SegmentParams};
use crate::engine::{Engine, Rect};

thread_local! {
    static ENGINE: RefCell<Option<Engine>> = const { RefCell::new(None) };
    static INBOX: RefCell<Vec<f32>> = const { RefCell::new(Vec::new()) };
    static DIRTY: RefCell<Rect> = const { RefCell::new(Rect::EMPTY) };
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

/// Apply the coastline in the inbox. Returns the number of changed pixels.
#[no_mangle]
pub extern "C" fn wm_set_coast(len: u32) -> u32 {
    let coast = INBOX.with(|b| decode_coast(&b.borrow()[..len as usize]));
    let dirty = with_engine(|e| e.set_coast(coast));
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

fn decode_coast(data: &[f32]) -> Option<Coastline> {
    if data.len() < 2 {
        return None;
    }
    let seed = data[0] as u32;
    let n = data[1] as usize;
    if n < 3 || data.len() < 2 + n * 5 {
        return None;
    }
    let pts = &data[2..2 + n * 2];
    let prm = &data[2 + n * 2..2 + n * 5];
    Some(Coastline {
        points: pts.chunks_exact(2).map(|p| [p[0], p[1]]).collect(),
        params: prm
            .chunks_exact(3)
            .map(|p| SegmentParams { roughness: p[0], coves: p[1], shore_km: p[2] })
            .collect(),
        seed,
    })
}
