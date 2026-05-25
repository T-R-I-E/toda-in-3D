# TODA Rig → 3D

A single-page static web app for designing a TODA rig topologically and
exporting a 3D-printable `.3mf` file. No backend, no build step. Open
`index.html` (served by the `~/Dev` static server, e.g.
`http://localhost:8080/toda/toda-in-3D/`).

## Layout
- `index.html` — markup + CSS only. Loads Three.js + OrbitControls from
  jsdelivr via importmap.
- `app.js` — all logic. Sections (see banner comments):
  state · edges · auto-pick · mutations · 2D editor (SVG) · 3D scene
  (Three.js) · 3MF export (stored-mode ZIP + CRC32 + 3MF XML) · JSON I/O ·
  params · toolbar · init.

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
- Lines are visually staggered by half a `twistSpacing` on alternating
  parities, so a same-index twist on the line directly above is never at
  the same X — every inter-line edge is diagonal by construction.

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
