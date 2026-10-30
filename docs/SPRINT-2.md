# Sprint 2: Shapes and editing

## Done

| Item | Notes |
| --- | --- |
| Multiple complete shapes | Shapes combine as a union; overlapping land stays land |
| Shapes menu (coastline tool) | Select, rename, hide, lock; "New shape" starts drawing |
| Select a whole shape | Click inside it; shows a box with corner and rotate handles |
| Move a whole shape | Drag inside its box; the coastline travels with it |
| Resize a whole shape | Drag a corner, Shift keeps proportions; detail regenerates at real scale |
| Rotate a whole shape | Round handle above the box, Shift snaps to 15° |
| Shape-anchored coastline detail | Each shape has a frame anchoring its noise |
| Lock shapes | Locked shapes can't be selected or changed on the map |
| Right-click removes the last point while drawing | Right drag still pans |
| Make point insertion discoverable | Mentioned in the segment panel |
| Delete a shape | Two-step confirmation, since there's no undo yet |
| Land or water shapes | Lakes, seas and bays; islands inside water; nesting worked out automatically |
| Coastline "fill in" | The drawn line is the inner edge; new Coast reach slider per segment |
| Shape-wide coastline sliders | Segments keep their own adjustment on top; changes add up |
| Resizing keeps the coastline | Detail scales with the shape; proportional by default, Shift stretches |
| Reach inside (per segment) | Lets the coast cut into a shape; at 0 the inside guarantee holds |
| Edge smoothing (anti-aliasing) | Map panel slider, 0 to 3 px; applies to the map and exports |
| Export: quick or full detail | Full detail at 4096, 8192 or 16384 px, in strips across worker threads, with progress and cancel |

Tests: 24 core tests (every edit type matches a full regeneration exactly; a
moved island keeps its coastline; drawn land is always land and drawn water
always water) and a 37-check browser test in headless Firefox
(`web/tests/ui-test.py`), which also opens and checks a real full-detail
export.

## Behaviour to know

- Dragging an unselected shape pans the map; a shape must be selected
  (click it once) before dragging moves it. This stops accidental moves.
- Moving or rotating a large shape at 2048 resolution takes about 0.4 s per
  update, so the terrain trails the outline slightly. At 1024 it's about
  110 ms, just over the target.
- Lakes sit at sea level and use the ocean's depth profile, so large ones get
  deep centres. Lake surface levels and a depth setting are still to come.
- Shapes can merge where their coasts grow into each other; merge rules are
  still to come.

## Still to do this sprint

- Merge rules (minimum water gap per segment)
- Lake surface levels and depth
- Export of the current view or a chosen area at maximum detail
- Browser autosave
- Coordinate system decision and export format specification

## Later

- Box select several points
- Shapes menus for later tools
