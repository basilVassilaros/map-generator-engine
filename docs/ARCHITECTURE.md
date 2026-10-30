# Architecture

## Principles

- **Guides are the source of truth.** The terrain is always derived from what
  the user drew plus parameters and a seed. Nothing generated is ever edited
  directly, so any part of the map can be regenerated at any time.
- **Generation is deterministic.** The same guides and seed give bit-identical
  terrain on every machine. Saving a project will only need the guides.
- **Edits are partial but exact.** An edit recomputes only the cells it can
  affect, and the result is identical to regenerating the whole map. The
  tests in `core/tests/incremental.rs` enforce this.
- **The interface never waits on generation.** The core runs on a background
  thread, and only the latest edit is processed.
- **Real units.** Positions are kilometres, elevation is metres, stored as
  32-bit floats. Pixels and colours exist only in the preview.

## The two halves

The interface (TypeScript) handles drawing, panels and input. The core (Rust,
compiled to WebAssembly) owns all generation. They meet at a deliberately
narrow boundary (`core/src/ffi.rs`): the interface writes the full coastline
guide into a buffer and calls one function; the core works out what changed,
regenerates, and reports the rectangle of pixels that changed. Guide data is
tiny, so sending all of it each time is simpler and safer than sending edits.

The core has no imports, so the same code runs natively for tests and
benchmarks, and could run on a server for large exports later.

## Shapes

The guides are a list of shapes, each a closed outline with per-segment
parameters, a seed, and a **frame** (a position and rotation). The frame
anchors the shape's coastline noise, so moving or rotating a shape carries
its coves and headlands with it. Resizing leaves the frame in place, so the
outline scales while fine detail is regenerated at real-world scale rather
than stretched. The lowland height under the coast is anchored to the world.

Shapes combine as a union: a cell is land if any shape makes it land, and
where shapes overlap, the one reaching furthest inland decides the terrain.
Each shape keeps its own caches (distance to its coast, inside/outside, and
its coastline noise) covering only the area it can reach. Noise is computed
lazily, only near the coast, since cells far inland or out at sea never use it.

Hidden shapes are simply left out of the guides. Locking is purely an
editor feature.

## Zoom: two cores, one world

The browser runs two copies of the core, each in its own background thread.
The **base core** generates the whole map at the working resolution. When the
view is zoomed in past 1.6×, the **detail core** generates just the visible
area at screen resolution (capped at about 650,000 pixels so edits stay
quick). Until the detail is ready, the base map is shown enlarged, so zooming
and panning always respond instantly.

This works because the engine can generate any window onto the world
(`Engine::window`), and all noise is placed by world position in kilometres.
A window lines up exactly with the whole map. Finer cells also get more noise
octaves (`octaves_for`), so zooming in reveals detail rather than blur.

Edits go to both cores. The display draws the base map first and the detail
layer over the area it covers. Frames from a window that has since been
replaced are discarded by version number.

## How partial updates stay exact

Every coastal effect fades out completely within `INFLUENCE_KM` of the shore,
and noise moves the shore by at most `MAX_COAST_NOISE_KM`. Distances are
clamped at the sum of the two, `CLAMP_KM`. So a cell further than `CLAMP_KM`
from an edited segment cannot change, and only cells within reach of the
edited segments (old and new positions) are recomputed.

The engine caches what doesn't depend on the edit:

| Cache | Depends on | Recomputed when |
| --- | --- | --- |
| Lowland height (per world) | World seed | The project starts |
| Shoreline noise (per shape) | Shape seed and frame | The shape is moved or rotated |
| Distance, nearest segment, inside/outside (per shape) | Shape outline | Points move, near those points |
| Elevation and preview pixels | Everything | Any edit, only where it can reach |

A slider edit changes no geometry, so it recomputes only cells whose nearest
segment was retuned, re-weighting cached noise. That is why it's the fastest
edit.

## Measured performance

Core only, measured in Node.js on the build machine with three shapes.
Browser times vary with hardware; the app shows live timings.

| Edit | 1024 × 1024 | 2048 × 2048 |
| --- | --- | --- |
| Generate landmass | about 0.65 s | about 2.7 s |
| Slider on one segment | about 11 ms | about 43 ms |
| Dragging one point | about 22 ms | about 86 ms |
| Resizing a whole shape | about 24 ms | about 105 ms |
| Moving or rotating a whole shape | about 95 ms | about 390 ms |

Moving and rotating are slowest because they shift the shape's noise frame,
so its coastline noise is recomputed. The outline on screen always follows
the mouse immediately; at 2048 the terrain trails slightly behind.

A zoomed view takes about 1 to 1.5 s to sharpen after the view stops moving.
