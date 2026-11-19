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
parameters, a seed, and a **frame** (position, rotation and scale). The frame
anchors the shape's coastline noise, so moving, rotating or resizing a shape
moves, turns or scales its coves and headlands with it: the coastline only
changes when points move relative to each other. Detail scaling is limited
to 1/8× to 8×, and each shape's area of influence grows with its scale so
partial updates stay exact. The lowland height under the coast is anchored
to the world.

In the editor, each shape has slider values for all its segments, and each
segment stores an adjustment on top. The effective value is the sum, kept
within the slider's range, so shape and segment changes always add up.

Each shape is land or water, and shapes combine in order, starting from
open ocean: land shapes add land (where land shapes overlap, the one reaching
furthest inland decides the terrain), water shapes cut water out of whatever
came before them. The app sorts shapes by nesting, so a lake inside a
continent cuts into it and an island inside that lake adds land back.

**Highland** shapes don't take part in that land/water ordering. Each adds a
rise (its height, which may be negative) to the land inside it, with an
escarpment whose steepness comes from the segment's slope setting. They only
ever affect land, so a highland crossing the coast makes sea cliffs rather
than new land. Nested highlands add up, making terraces.

**Water is tracked separately from elevation.** Each cell records whether it
is water (from its signed distance to the final coastline) and, if so, the
height of its surface: sea level for the ocean, the surrounding ground for a
lake, which therefore sits on top of any highland it's drawn on. Lakes use a
shallower depth profile than the ocean (at most 300 m). Land below sea level
in a basin stays land. The renderer colours water by depth below its own
surface and only uses beach colours next to actual water.

By default the drawn line is the **inner edge** of every coast. Each segment
has a Reach outside and a Reach inside; the coast stays between the two
(roughness only ever adds outward). With Reach inside at zero, the default,
everything inside a land shape is land and everything inside a water shape is
water. Tests check this for land, water, and an island in a lake in a
continent.
Each shape keeps its own caches (distance to its coast, inside/outside, and
its coastline noise) covering only the area it can reach. Noise is computed
lazily, only near the coast, since cells far inland or out at sea never use it.

Hidden shapes are simply left out of the guides. Locking is purely an
editor feature.

## Two tiers, and the terrain render

**Tier 1, the ground,** is local: every cell depends only on nearby shapes
and mountains, so edits recompute just what they reach, exactly. Land shapes
set the ground's height in stacking order, each stepping from whatever was
there to its own height across its edge. Mountains add their height on top.

**Tier 2** covers the whole map after every edit, because it depends on what
connects to what: drawn rivers carve their channels (the water surface along
a river never rises), and land below the surface of water it touches floods,
spreading cell to cell. The engine counts land lying below its nearest water;
while that count is zero the flood pass is skipped entirely. Tier 2 remembers
which cells it changed, puts them back, and reruns from the tier 1 ground,
so the result is always a pure function of the guides.

**The terrain render** (`core/src/hydro.rs`) is a slower pass run on request:

1. *Climate.* Temperature from latitude, less 6.5 °C per km of height.
   Winds by circulation cell: trade winds within 30° of the equator,
   westerlies from 30° to 60°, polar easterlies beyond, with dry belts near
   30°. Air gains moisture over water, loses it over land, fastest when
   forced up a slope, and descends dry: a rain shadow.
2. *Drainage.* Priority flood fills every hollow to its spill point and
   gives each cell a downhill route; rain is accumulated along the routes.
3. *Erosion.* The stream power law: incision grows with discharge and slope.
   Downstream cells are settled first, which keeps it stable.
4. *Lakes and rivers.* Hollows that still hold water after evaporation are
   lakes; cells carrying enough water are rivers.
5. *Biomes.* Colour from temperature and rainfall, after Whittaker.

It runs on the CPU with fixed arithmetic, so it's repeatable everywhere.

## Curves

Mountain ranges and rivers follow a *curve* through their points: a
centripetal Catmull-Rom spline blended with the straight line by
**curviness**, plus an optional sideways **bend** per segment
(`features::curve_path`). It is sampled every ~6 km regardless of resolution,
so the same line results at every zoom and in strips. The browser has a
mirror of the function (`curve.ts`) so the drawn line matches the core's.

## The terrain render in two stages

**Stage A** (`hydro::render`) is the render described above, on the working
grid. It also leaves a **structure** (`fine::Structure`): the height changes
(plains undulation and valley cutting), rain, where hollow lakes and floods
stand, and the drainage network as smooth curves (each river cell's channel
runs from the midpoint with the cell upstream, through its centre, to the
midpoint downstream, so tributaries merge into continuous curves).

Before shaping anything, stage A **plans** the land as vectors (`plan.rs`),
the same kind of lines and outlines the user draws:

1. **Drawn rivers** are resampled every few hundred metres and swung from
   side to side: meanders about twelve channel widths long with an uneven
   rhythm, on broader swings, fading to nothing at source and mouth so the
   river still starts and ends where it was drawn. The channel is set into
   the ground and only ever descends; the river carries its own flow (from its
   width) besides everything that drains into it. In the live map a drawn
   river is fixed water; in the render it is part of the drainage.
2. **Biome regions** replace the climate inside them, blending across a soft
   edge: rainfall, a temperature offset (so height still cools the air),
   humidity and tree cover, all passed to stage B.
3. **Hills** stand on the divides between rivers: the cells furthest from any
   river (a chamfer distance transform) chained into lines, skipping ground a
   drawn range already covers. Their height and width grow with how far they
   are from water. They are added to the ground before erosion.
4. Steep ground is **roughened** in proportion to its slope, so water
   gathers into branching valleys instead of running down parallel gullies.
5. After erosion, the larger **rivers are traced** source to mouth (each
   tributary ending on the river it joins) and **lake outlines** are traced
   round the hollows that hold water; both are simplified to editable guides.

**Stage B** (`fine::render_fine`) renders any window onto the world at any
resolution from that structure. It builds the ground from the guides at the
window's own resolution (shapes, mountains, drawn rivers, with detail down to
the pixel), adds the structure's height changes, fractal relief, lake and
flood contours that follow the real fine ground, and rivers at their true
width through a gentle warp so they wander. Colour comes from `look.rs`:
land-cover texture (with woods in clumps where a biome region sets the tree
cover, and humidity changing how far the rain goes), slope and rock, a ragged snow line, wetlands and green
banks, beaches, water depth, sediment plumes, hillshade and ambient occlusion.

Mountainsides follow their drainage: every stream down to a few cells'
worth of rain is in the structure, and the ground rises from each stream in a
V that rounds off towards the crest, so ridges and spurs stand between the
gullies. A stream's handicap shrinks with its size, so big rivers cut deeper
valleys than rills, and taking the lowest score over nearby streams keeps the
ground continuous where the nearest stream changes. The structure's height
changes are sampled with a cubic B-spline, so no grid lines show however far
the view is zoomed.

Stage B also returns the **ground height** of each pixel (under water too),
which the browser writes into **16-bit heightmaps**, and the same strips feed
the **full-detail terrain export**: strips finish in any order on several
workers and are written into the PNG in order, so images far larger than a
canvas (up to 16384 px) stream to the file with modest memory.

Stage B never moves what stage A decided, and depends only on world position
and the structure, so a window cut into strips renders identically to one cut
whole (tested). The browser therefore renders strips in parallel workers,
each sent the structure once, and paints them as they arrive.

**Three engines run side by side:** the full-resolution map, a
half-resolution preview (a quarter of the work, shown enlarged until the
full result lands), and the zoomed detail view.

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

## Edge smoothing

The engine keeps each cell's signed distance to the final coastline. When
edge smoothing is on, the renderer blends land and water colours across a
band of the chosen width in pixels, so coastlines are anti-aliased with
sub-pixel precision and no supersampling. Changing it only recolours, so it
applies live, and it carries through to zoomed views and both export modes.

## Full-detail export

A full-detail export regenerates the whole map at the chosen size, not by
enlarging the preview. Several background workers each generate horizontal
strips of about a million pixels, using the same windowed engine as the
zoomed view, so finer cells get more noise octaves and real detail. Each
strip includes one extra row above and below so hillshading matches across
strip edges. A streaming PNG encoder compresses rows as strips arrive, in
order, so memory stays small even for a 16384-pixel image. The browser's own
canvas size limits never apply.

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
| Slider on one segment | about 10 ms | about 43 ms |
| Dragging one point | about 22 ms | about 86 ms |
| Moving, rotating or resizing a whole shape | about 95 to 115 ms | about 400 ms |

Moving, rotating and resizing are slowest because they change the shape's
noise frame, so its coastline noise is recomputed. The outline on screen always follows
the mouse immediately; at 2048 the terrain trails slightly behind.

A zoomed view takes about 1 to 1.5 s to sharpen after the view stops moving.

Terrain render (core only, one thread, 1024 working resolution): stage A
about 3 s; stage B about 7 s for the whole map at 2048 px, 3 s for a
1024 px section. In headless Firefox with workers, a 2048 px whole-map detail
render took about 4 s and a view-only 2048 px render about 5 s.
A full-detail export at 4096 pixels took about 11 s in headless Firefox here;
time grows with the square of the size.
