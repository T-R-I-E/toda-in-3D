# TODA Rig → 3D

A single-page static web app for designing a TODA rig topologically and
exporting a 3D-printable `.3mf` file. No backend, no build step. Open
`index.html` (served by the `~/Dev` static server, e.g.
`http://localhost:8080/toda/toda-in-3D/`).

## Layout
- `index.html` — markup + CSS only. Loads Three.js + OrbitControls from
  jsdelivr via importmap. Dark/light theme via `html.theme-dark` /
  `html.theme-light` classes; an inline script at the top of `<head>`
  sets the class from `localStorage['toda3d.theme']` before the
  stylesheet applies to avoid FOUC.
- `app.js` — all logic. Sections (see banner comments):
  state · edges · auto-pick · mutations · 2D editor (SVG) · 3D scene
  (Three.js, transparent so the panel-body lens vignette shows
  through) · 3MF export (stored-mode ZIP + CRC32 + 3MF XML) · JSON I/O ·
  params · toolbar · init · theme toggle · controls fade.

## UI conventions
- Two equal panels (red lens = 2D editor, blue lens = 3D preview),
  horizontal slider bar below them, status chips + legend at the
  bottom.
- Edge colors stay on the rigging-workshop palette
  (`--rig-prev/teth/lead/meet/post`) — they're tied to data semantics
  and to the print output, so they don't change with theme.
- The Fast/Loose pill reflects the selected twist's state (green dot
  when fast, idle when loose or no selection). Clicking it toggles
  fast on that twist.

## Data model
A rig is just `{ lines: [{ id, twists: [{ id, tether?, hoist? }] }] }`.
`tether` and `hoist` point to twist ids on *some* line above; a twist with
a tether is "fast", otherwise "loose". Edges (prev / teth / lead / meet /
post) are *derived* from this, not stored — once a lead has a hoist, the
meet and post are the next two fast twists on the same line, all pointing
at that same hoist.

## Constraints (auto-enforced at edit time)
- topmost line (`L1 (cork)`) holds only loose twists
- tether and post go up-left, lead and meet go up-right (strict — no
  vertical edges; `setTether`/`setHoist` reject equal-X targets)
- a fast twist is a lead iff it has at least one more fast twist after it
  on its line. The hitch carries lead + meet always, and post once a third
  fast twist appears. Only the *last* fast on a line never hoists.
- Each line carries its own `xShift` (mm). New lines default to an
  alternating half-`twistSpacing` stagger so a same-index twist on the
  line directly above is never at the same X — every inter-line edge is
  diagonal by construction.
- When `setFast`/`setTether` can't satisfy the up-left rule at the
  current `xShift`, the engine searches for the minimum rightward shift
  (in `twistSpacing` increments) that puts the source past the leftmost
  upper-line twist, applies it, then revalidates every other tether and
  hoist and re-auto-picks anything broken. If revalidation can't fix
  everything, the whole change is rolled back (snapshot/restore over
  `xShift` + all tether/hoist refs) and the operation is refused.

## Auto-pick
- tether: walks up from the line directly above and picks the rightmost
  twist whose X < source X (strict — guarantees up-left)
- hoist: picks a twist on the line above with X strictly > meet X and (if
  a post exists) < post X. If no twist on the line above satisfies the
  bracket, the auto-pick returns null and no hoist edge is drawn until
  the user adds a candidate or alt-clicks one manually.

## Persistence
The current rig (lines + params + id counters) is saved to
`localStorage['toda-rig-designer:v1']` on every rerender and restored on
page load. Selection and camera are not persisted. `applySnapshot` is the
shared loader for both this and `Import JSON`. To start fresh, clear the
key in DevTools (no UI button yet).

## Camera
`initCamera()` runs once on page load and sizes the view for a typical
~10-twist × ~4-line rig. After that, the camera is owned by the user
(OrbitControls) — no auto re-fit on graph changes or JSON import. If a
rig is much larger or smaller than the default, the user orbits/zooms.

## Coordinate convention
- Three.js scene: Y up, X = horizontal along a line, Z = across lines
  (top line at Z=0)
- 3MF export: Y↔Z swap (3MF/print is Z-up), triangle winding reversed
  to keep outward normals after the handedness flip

## SCAD export
`exportScad()` emits an OpenSCAD `.scad` using primitives (cube plate,
hemispheres as `sphere ∩ slab`, edges as `hull()` of two spheres) — not
extracted Three.js geometry. Parameters (`twistRadius`, `edgeRadius`,
`plateThick`, optional `borderH/W`) are emitted as SCAD variables at the
top so the user can tweak them without re-exporting. Each color group is
its own `color(...) union {}` block.

## Print orientation
Three.js uses Y-up; printers / 3MF / OpenSCAD are Z-up. We use a true
rotation (X +90°: `(x,y,z) → (x, yOffset-z, y)`), not the Y↔Z swap that
earlier code used. Y↔Z swap is a *reflection* — it produces a mirror-
imaged print, which is why the first export came out flipped. With the
true rotation, winding is preserved (no triangle reversal needed) and the
corkline (line 0) lands at the back of the bed, matching the editor's
"top of screen" convention.

## Bambu filament map
The 3MF zip includes `Metadata/model_settings.config` mapping each object
to a 1-based extruder index (plate=1, twist=2, prev=3, teth=4, lead=5,
meet=6, post=7) so Bambu Studio assigns filaments automatically on load.
The file is a Bambu extension — other slicers ignore unknown files in
the zip, so the standard 3MF still loads cleanly elsewhere. User can
remap extruders in the slicer UI.

## 3MF mesh hygiene
Three.js primitives generate per-face split vertices (so each face can have
its own normal/UV for sharp shading). That makes individual meshes look
right in the viewport but reports as non-manifold to slicers (Bambu Studio
flagged "2910 non-manifold edges" on an early export). `extractMesh`
rebuilds a position-only copy of each mesh and runs `mergeVertices`
before extracting — the scene keeps its sharp shading, the 3MF is
watertight. The plate is its own clean closed box; cylinder edges are
lifted so they rest on the plate's top surface, never dip below it.

## Git policy (overrides global)
You manage git directly in this project. The global "manual git" rule does
NOT apply here. `git push` remains denied at the permission layer; the user
handles pushing.

Workflow:
- Commit after each meaningful change passes its tests. One logical change
  per commit.
- Stage only the files relevant to the change. Use `git add <paths>`, not
  `git add .` or `git add -A`. Do not sweep up unrelated edits.
- Before committing, run `git diff --staged` and verify the diff is exactly
  what you intend. If something unintended is staged, `git restore --staged
  <path>` to unstage.
- Conventional commit messages: feat:, fix:, refactor:, docs:, test:, chore:.
  First line under 72 chars. Body if useful, omitted if not.
- Never commit on red. If a test was passing and now isn't, fix the test or
  the code before committing — do not commit broken state.
- Do not include AI attribution in commit messages.
