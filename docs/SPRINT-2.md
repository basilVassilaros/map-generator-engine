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

Tests: 16 core tests (every edit type matches a full regeneration exactly; a
moved island keeps its coastline) and a 25-check browser test in headless
Firefox (`web/tests/ui-test.py`).

## Behaviour to know

- Dragging an unselected shape pans the map; a shape must be selected
  (click it once) before dragging moves it. This stops accidental moves.
- Moving or rotating a large shape at 2048 resolution takes about 0.4 s per
  update, so the terrain trails the outline slightly.

## Still to do this sprint

- Coastline rework: the drawn line becomes the inner edge, with a "Coast reach" slider
- Merge rules (minimum water gap per segment)
- Water shapes: lakes, seas, islands in lakes
- Maximum-resolution export (current view or area, and whole map at high resolution)
- Browser autosave
- Coordinate system decision and export format specification

## Later

- Box select several points
- Shapes menus for later tools
