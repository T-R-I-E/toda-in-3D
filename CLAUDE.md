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
- tether and post go up-left, lead and meet go up-right
- a fast twist is a lead iff it has at least two fast twists after it
  on its line; the *last two* fast twists carry tether but no hoist

## Auto-pick
- tether: when toggling fast, picks the rightmost twist on the line
  directly above with `index < self.index`; falls back further up if
  the directly-above line is empty
- hoist: for a lead, picks a twist on the line above with index strictly
  between meet's and post's indices; falls back to the closest by distance

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
