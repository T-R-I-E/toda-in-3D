# TODA in 3-D

> A presentation of T.R.I.E. — now in eye-popping anaglyph.

A single-page web app for designing a TODA rig topologically and
exporting it as a 3D-printable `.3mf`. No backend, no build step, no
dependencies beyond Three.js loaded from a CDN.

## Showtime

Static — open `index.html` through any web server. The repo's local
convention is the `~/Dev` static server on port 8080:

    http://localhost:8080/toda/toda-in-3D/

A theme toggle in the top-right flips between dark and light.

## Two panels, two lenses

The stage is split into two equal viewports, each clipped by a coloured
lens frame.

**Rig editor** (red). A 2-D graph of lines and twists.

- Click a twist to select it.
- `shift`-click a twist on a line above to set the **tether** (up-left).
- `alt`-click to set the **hoist** (up-right).
- The panel header carries the rig toolbar: `+ Line`, `+ Twist`,
  `Remove`, and a centred Fast/Loose pill.
- `+` ghosts inside the canvas add twists at end-of-line and a new
  line below the last one.

**3D preview** (blue). Live Three.js render of the rig as it will print.
Drag to orbit · wheel zoom · right-drag pan.

## Print modes

A segmented control in the 3D preview header. All three exports follow
whichever mode is active.

| Mode  | Twists                | Edges               | Plate            |
|-------|-----------------------|---------------------|------------------|
| Solid | hemispheres on top    | cylinders above     | opaque           |
| Embed | spheres inside        | cylinders inside    | semi-transparent |
| Flat  | discs sunk by *depth* | bars sunk by *depth* | semi-transparent |

In **Flat** mode the bars stop at the disc circumference, so each disc
visually owns its area — biz-card aesthetic. The *depth* slider only
appears when Flat is selected; it's an absolute mm value, clamped to
plate thickness.

**Embed** and **Flat** are designed for prints where the plate filament
is transparent: the colored inclusions read through the plate like a
paperweight.

## Exports

- **JSON** — round-trippable. Saves lines, twists, tethers, hoists,
  every slider value, and the camera.
- **`.scad`** — OpenSCAD primitives with named variables
  (`twistRadius`, `edgeRadius`, `plateThick`, `borderH/W`, and
  `flatDepth` in Flat mode) at the top, so you can tweak in OpenSCAD
  without coming back to the editor.
- **`.3mf`** — watertight per-color objects (each pipeline-stage gets
  its own mesh and color), plus a Bambu Studio filament map
  (plate=1, twist=2, prev=3, teth=4, lead=5, meet=6, post=7). Other
  slicers ignore the Bambu extension and load the standard 3MF as-is.

## Keyboard

| Key   | Action                                              |
|:-----:|-----------------------------------------------------|
| `N`   | Add a line (auto-includes one twist)                |
| `T`   | Add a twist after the selected one                  |
| `F`   | Toggle Fast on the selected twist                   |
| `Del` | Remove the selected twist (refused if it's the last)|

Exactly one twist is always selected — the editor enforces it. Lines
auto-remove when their last twist is deleted; they aren't independently
selectable.

## Persistence

Every render saves the rig to `localStorage['toda-rig-designer:v1']`.
To start fresh, clear that key from DevTools.

## Files

- `index.html` — markup, CSS, Three.js importmap.
- `app.js` — all logic, sectioned with banner comments
  (state · edges · auto-pick · mutations · 2-D editor · 3-D scene ·
  3MF export · SCAD export · JSON I/O · params · toolbar · init).
- `CLAUDE.md` — design notes and invariants for future iteration.

## Coordinate convention

Three.js is Y-up; the printer / 3MF / OpenSCAD are Z-up. The exporter
applies a true X+90° rotation (not a Y↔Z swap, which would mirror) and
translates so all coordinates stay positive. The corkline lands at the
back of the bed, matching "top of screen" in the editor.

---

*The lights dim. Roll print.*
