// TODA Rig Designer — single-file logic
// Sections: state | edges | auto-pick | mutations | 2D editor | 3D scene
//           | 3MF export | JSON I/O | params | toolbar | init.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as BGU from 'three/addons/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------- state ----

const ids = { L: 1, t: 1 };
const nid = (p) => `${p}${ids[p]++}`;

function defaultXShift(lineIdx) {
  return (lineIdx % 2) * (state.params.twistSpacing / 2);
}

const state = {
  lines: [{ id: nid('L'), twists: [], xShift: 0 }],
  selection: null,
  params: {
    plateThickness: 2,
    borderHeight:   0,
    borderWidth:    2,
    twistRadius:    4,
    edgeRadius:     0.6,
    twistSpacing:   16,
    lineSpacing:    28,
  },
};

const isFast = (t) => !!t.tether;

function indexTwists(s) {
  const m = {};
  s.lines.forEach((line, li) => {
    line.twists.forEach((t, ti) => {
      m[t.id] = { line, lineIdx: li, twistIdx: ti, twist: t };
    });
  });
  return m;
}

// Each line has an xShift (mm) that places its column zero on the X axis.
// New lines default to an alternating ts/2 stagger so adjacent lines never
// share an X position, but the rules engine is free to shift any line
// further right when the user makes a constraint that wouldn't otherwise
// fit (e.g. a fast twist on a line that's currently left of every twist
// on the line above).
function twistX(lineIdx, twistIdx) {
  const line = state.lines[lineIdx];
  return (line?.xShift ?? 0) + twistIdx * state.params.twistSpacing;
}

// --------------------------------------------------------------- edges -----

function deriveEdges(s) {
  const out = [];
  s.lines.forEach((line) => {
    for (let i = 1; i < line.twists.length; i++) {
      out.push({ type: 'prev', from: line.twists[i].id, to: line.twists[i - 1].id });
    }
    const fasts = line.twists.filter(isFast);
    line.twists.forEach((t) => {
      if (t.tether) out.push({ type: 'teth', from: t.id, to: t.tether });
      if (t.hoist) {
        const fi = fasts.indexOf(t);
        out.push({ type: 'lead', from: t.id, to: t.hoist });
        if (fasts[fi + 1]) out.push({ type: 'meet', from: fasts[fi + 1].id, to: t.hoist });
        if (fasts[fi + 2]) out.push({ type: 'post', from: fasts[fi + 2].id, to: t.hoist });
      }
    });
  });
  return out;
}

// ------------------------------------------------------------ auto-pick ----

// Tether goes up-left (strictly smaller X). Walk up from the line directly
// above; pick the rightmost twist whose X < source X. If none satisfies it
// on that line, fall through to the next line up.
function autoPickTether(s, lineIdx, twistIdx) {
  const xS = twistX(lineIdx, twistIdx);
  for (let li = lineIdx - 1; li >= 0; li--) {
    const above = s.lines[li];
    if (!above.twists.length) continue;
    let bestIdx = -1, bestX = -Infinity;
    above.twists.forEach((t, i) => {
      const x = twistX(li, i);
      if (x < xS && x > bestX) { bestX = x; bestIdx = i; }
    });
    if (bestIdx >= 0) return above.twists[bestIdx].id;
  }
  return null;
}

// Hoist for a fast lead: needs to land on a line above, with X strictly
// between meet's X and post's X if a post exists, or just past meet otherwise
// (so lead/meet up-right and post up-left all hold).
function autoPickHoist(s, lineIdx, twistIdx) {
  const line = s.lines[lineIdx];
  const fasts = line.twists.map((t, i) => ({ t, i })).filter((o) => isFast(o.t));
  const pos = fasts.findIndex((o) => o.i === twistIdx);
  if (pos < 0 || pos > fasts.length - 2) return null;   // need at least a meet
  const selfX = twistX(lineIdx, twistIdx);
  const meetX = twistX(lineIdx, fasts[pos + 1].i);
  const hasPost = pos + 2 < fasts.length;
  const postX = hasPost ? twistX(lineIdx, fasts[pos + 2].i) : null;
  const target = hasPost ? (meetX + postX) / 2 : meetX + state.params.twistSpacing / 2;
  for (let li = lineIdx - 1; li >= 0; li--) {
    const above = s.lines[li];
    if (!above.twists.length) continue;
    let best = null, bestDist = Infinity;
    above.twists.forEach((t, i) => {
      const x = twistX(li, i);
      const ok = x > selfX && x > meetX && (!hasPost || x < postX);
      if (!ok) return;
      const d = Math.abs(x - target);
      if (d < bestDist) { bestDist = d; best = t.id; }
    });
    if (best) return best;
  }
  return null;
}

function isHoistValid(s, lineIdx, twistIdx, hoistId) {
  const idx = indexTwists(s);
  const h = idx[hoistId];
  if (!h) return false;
  if (h.lineIdx >= lineIdx) return false;
  const line = s.lines[lineIdx];
  const fasts = line.twists.map((t, i) => ({ t, i })).filter((o) => isFast(o.t));
  const pos = fasts.findIndex((o) => o.i === twistIdx);
  if (pos < 0 || pos > fasts.length - 2) return false;
  const selfX = twistX(lineIdx, twistIdx);
  const meetX = twistX(lineIdx, fasts[pos + 1].i);
  const hoistX = twistX(h.lineIdx, h.twistIdx);
  if (hoistX <= selfX || hoistX <= meetX) return false;
  if (pos + 2 < fasts.length) {
    const postX = twistX(lineIdx, fasts[pos + 2].i);
    if (hoistX >= postX) return false;
  }
  return true;
}

// After any structural change, re-evaluate which fast twists on `lineIdx`
// are leads, validate their existing hoists, and auto-pick a new one when
// needed. A lead requires only one more fast after it (the meet); post is
// added automatically when a third fast appears (via deriveEdges).
function recomputeHoists(s, lineIdx) {
  const line = s.lines[lineIdx];
  const fasts = line.twists.map((t, i) => ({ t, i })).filter((o) => isFast(o.t));
  fasts.forEach((o, fi) => {
    const shouldHaveHoist = fi <= fasts.length - 2;
    if (!shouldHaveHoist) { o.t.hoist = null; return; }
    if (o.t.hoist && !isHoistValid(s, lineIdx, o.i, o.t.hoist)) o.t.hoist = null;
    if (!o.t.hoist) o.t.hoist = autoPickHoist(s, lineIdx, o.i);
  });
}

// ---- shift helpers ----

function snapshotEdges() {
  return state.lines.map((l) => ({
    xShift: l.xShift,
    twists: l.twists.map((t) => ({ tether: t.tether, hoist: t.hoist })),
  }));
}

function restoreEdges(snap) {
  state.lines.forEach((l, li) => {
    l.xShift = snap[li].xShift;
    l.twists.forEach((t, ti) => {
      t.tether = snap[li].twists[ti].tether;
      t.hoist = snap[li].twists[ti].hoist;
    });
  });
}

function isTetherValid(srcLineIdx, srcTwistIdx, tetherId) {
  const tgt = indexTwists(state)[tetherId];
  if (!tgt) return false;
  if (tgt.lineIdx >= srcLineIdx) return false;
  return twistX(tgt.lineIdx, tgt.twistIdx) < twistX(srcLineIdx, srcTwistIdx);
}

// Walk every twist; re-auto-pick any tether/hoist that's no longer valid
// (e.g. because we just shifted a line). `protectedKeys` is a set of
// "lineIdx:twistIdx" strings whose tether we must keep as-is (it's the
// one we're trying to install). Returns true if everything could be
// validated or repaired, false if any tether/hoist is broken and there's
// no candidate to swap it for.
function validateAndFix(protectedKeys = new Set()) {
  for (let li = 0; li < state.lines.length; li++) {
    const line = state.lines[li];
    for (let ti = 0; ti < line.twists.length; ti++) {
      const t = line.twists[ti];
      if (!t.tether) continue;
      if (isTetherValid(li, ti, t.tether)) continue;
      if (protectedKeys.has(`${li}:${ti}`)) return false;
      const repl = autoPickTether(state, li, ti);
      if (!repl) return false;
      t.tether = repl;
    }
  }
  state.lines.forEach((_, li) => recomputeHoists(state, li));
  return true;
}

// Make `twistId` fast, shifting its line right if no up-left tether
// target exists at the current position. Returns true on success.
function trySetFastWithShift(twistId) {
  const info = indexTwists(state)[twistId];
  if (!info || info.lineIdx === 0) return false;

  // Try without shifting first.
  let target = autoPickTether(state, info.lineIdx, info.twistIdx);
  if (target) {
    info.twist.tether = target;
    recomputeHoists(state, info.lineIdx);
    return true;
  }

  // No valid target at current X — find the leftmost upper-line X and
  // shift this line in twistSpacing units until source.X exceeds it.
  let minUpperX = Infinity;
  for (let li = info.lineIdx - 1; li >= 0; li--) {
    state.lines[li].twists.forEach((_, i) => {
      minUpperX = Math.min(minUpperX, twistX(li, i));
    });
  }
  if (minUpperX === Infinity) return false;

  const ts = state.params.twistSpacing;
  const line = info.line;
  const oldShift = line.xShift ?? 0;
  const baseSrcX = info.twistIdx * ts;
  const required = minUpperX - baseSrcX + 1e-4;
  const newShift = Math.max(oldShift + ts, Math.ceil(required / ts) * ts);

  const snap = snapshotEdges();
  line.xShift = newShift;
  target = autoPickTether(state, info.lineIdx, info.twistIdx);
  if (!target) { restoreEdges(snap); return false; }
  info.twist.tether = target;
  if (!validateAndFix(new Set([`${info.lineIdx}:${info.twistIdx}`]))) {
    restoreEdges(snap);
    return false;
  }
  return true;
}

// Set `twistId`'s tether to `targetId`, shifting the source line if
// needed so the target ends up strictly up-left.
function trySetTetherWithShift(twistId, targetId) {
  const idx = indexTwists(state);
  const src = idx[twistId], tgt = idx[targetId];
  if (!src || !tgt) return false;
  if (tgt.lineIdx >= src.lineIdx) return false;

  const xS = twistX(src.lineIdx, src.twistIdx);
  const xT = twistX(tgt.lineIdx, tgt.twistIdx);
  if (xT < xS) {
    src.twist.tether = targetId;
    recomputeHoists(state, src.lineIdx);
    return true;
  }

  const ts = state.params.twistSpacing;
  const line = src.line;
  const oldShift = line.xShift ?? 0;
  const baseSrcX = src.twistIdx * ts;
  const required = xT - baseSrcX + 1e-4;
  const newShift = Math.max(oldShift + ts, Math.ceil(required / ts) * ts);

  const snap = snapshotEdges();
  line.xShift = newShift;
  src.twist.tether = targetId;
  if (!validateAndFix(new Set([`${src.lineIdx}:${src.twistIdx}`]))) {
    restoreEdges(snap);
    return false;
  }
  return true;
}

// ----------------------------------------------------------- mutations ----

function addLine() {
  const li = state.lines.length;
  state.lines.push({ id: nid('L'), twists: [], xShift: defaultXShift(li) });
}

function addTwistAtLine(lineIdx, atIdx = null) {
  if (lineIdx < 0 || lineIdx >= state.lines.length) return null;
  const id = nid('t');
  const twists = state.lines[lineIdx].twists;
  if (atIdx == null || atIdx >= twists.length) twists.push({ id });
  else twists.splice(atIdx, 0, { id });
  return id;
}

function setFast(twistId, fast) {
  const info = indexTwists(state)[twistId];
  if (!info) return;
  if (info.lineIdx === 0) { flash('Top line is always loose'); return; }
  if (!fast) {
    info.twist.tether = null;
    info.twist.hoist = null;
    recomputeHoists(state, info.lineIdx);
    return;
  }
  if (info.twist.tether) return;          // already fast
  const oldShift = info.line.xShift;
  if (!trySetFastWithShift(twistId)) {
    flash('No twist above can serve as tether (even after shifting)');
    return;
  }
  if (info.line.xShift !== oldShift) {
    flash(`Shifted ${info.line.id} to fit`);
  }
}

function setTether(twistId, targetId) {
  const idx = indexTwists(state);
  const src = idx[twistId], tgt = idx[targetId];
  if (!src || !tgt) return;
  if (tgt.lineIdx >= src.lineIdx) { flash('Tether must point to a line above'); return; }
  const oldShift = src.line.xShift;
  if (!trySetTetherWithShift(twistId, targetId)) {
    flash('Cannot set tether — would break other constraints');
    return;
  }
  if (src.line.xShift !== oldShift) {
    flash(`Shifted ${src.line.id} to fit`);
  }
}

function setHoist(twistId, targetId) {
  const idx = indexTwists(state);
  const src = idx[twistId], tgt = idx[targetId];
  if (!src || !tgt) return;
  if (tgt.lineIdx >= src.lineIdx) { flash('Hoist must point to a line above'); return; }
  if (!isFast(src.twist)) { flash('Only fast twists can have a hoist'); return; }
  const fasts = src.line.twists.filter(isFast);
  const fi = fasts.indexOf(src.twist);
  if (fi > fasts.length - 2) {
    flash('Need one more fast twist after this one to act as lead'); return;
  }
  const xS = twistX(src.lineIdx, src.twistIdx);
  const xT = twistX(tgt.lineIdx, tgt.twistIdx);
  const meetTwistIdx = src.line.twists.indexOf(fasts[fi + 1]);
  const xM = twistX(src.lineIdx, meetTwistIdx);
  if (xT <= xS) { flash('Hoist must be right of the lead'); return; }
  if (xT <= xM) { flash('Hoist must be right of the meet'); return; }
  if (fasts[fi + 2]) {
    const postTwistIdx = src.line.twists.indexOf(fasts[fi + 2]);
    const xP = twistX(src.lineIdx, postTwistIdx);
    if (xT >= xP) { flash('Hoist must be left of the post'); return; }
  }
  src.twist.hoist = targetId;
}

function removeTwist(twistId) {
  const info = indexTwists(state)[twistId];
  if (!info) return;
  state.lines.forEach((line) => {
    line.twists.forEach((t) => {
      if (t.tether === twistId) { t.tether = null; t.hoist = null; }
      if (t.hoist === twistId) t.hoist = null;
    });
  });
  info.line.twists.splice(info.twistIdx, 1);
  state.lines.forEach((_, li) => recomputeHoists(state, li));
}

function removeLine(lineId) {
  const li = state.lines.findIndex((l) => l.id === lineId);
  if (li < 0) return;
  if (state.lines.length === 1) { flash('Cannot remove the only line'); return; }
  const ids = new Set(state.lines[li].twists.map((t) => t.id));
  state.lines.forEach((line) => {
    line.twists.forEach((t) => {
      if (ids.has(t.tether)) { t.tether = null; t.hoist = null; }
      if (ids.has(t.hoist)) t.hoist = null;
    });
  });
  state.lines.splice(li, 1);
  state.lines.forEach((_, i) => recomputeHoists(state, i));
}

// ------------------------------------------------------------ 2D editor ----

const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = document.getElementById('editorSvg');

const SVG_SCALE = 3; // pixels per mm in the SVG viewBox

function svg(tag, attrs, parent) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (v != null) el.setAttribute(k, v);
  }
  if (parent) parent.appendChild(el);
  return el;
}

const SVG_OFFSET_X = 100;
const SVG_OFFSET_Y = 50;

function svgCoord(lineIdx, twistIdx) {
  const p = state.params;
  return {
    x: SVG_OFFSET_X + twistX(lineIdx, twistIdx) * SVG_SCALE,
    y: SVG_OFFSET_Y + lineIdx * p.lineSpacing * SVG_SCALE,
  };
}

function renderEditor() {
  while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);
  const p = state.params;

  let maxTwists = 0;
  state.lines.forEach((line) => { maxTwists = Math.max(maxTwists, line.twists.length); });
  const lastCol = Math.max(maxTwists, 1);
  const w = SVG_OFFSET_X + ((lastCol + 1) * p.twistSpacing + p.twistSpacing / 2) * SVG_SCALE + 20;
  const h = SVG_OFFSET_Y + Math.max(state.lines.length, 1) * p.lineSpacing * SVG_SCALE + 20;
  svgEl.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  const labelsG = svg('g', {}, svgEl);
  const railsG = svg('g', {}, svgEl);
  const edgesG = svg('g', {}, svgEl);
  const twistsG = svg('g', {}, svgEl);

  state.lines.forEach((line, li) => {
    const y = SVG_OFFSET_Y + li * p.lineSpacing * SVG_SCALE;
    const selLine = state.selection?.kind === 'line' && state.selection.id === line.id;
    const label = svg('text', {
      x: 10, y: y + 4,
      class: 'line-label' + (selLine ? ' selected' : ''),
    }, labelsG);
    label.textContent = `${line.id}${li === 0 ? ' (cork)' : ''}`;
    label.addEventListener('click', () => {
      state.selection = { kind: 'line', id: line.id };
      rerender();
    });

    if (line.twists.length > 1) {
      const a = svgCoord(li, 0);
      const b = svgCoord(li, line.twists.length - 1);
      svg('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'line-rail' }, railsG);
    }
  });

  const idx = indexTwists(state);
  const ePos = (id) => {
    const info = idx[id];
    return info ? svgCoord(info.lineIdx, info.twistIdx) : null;
  };

  deriveEdges(state).forEach((e) => {
    const a = ePos(e.from), b = ePos(e.to);
    if (!a || !b) return;
    svg('line', {
      x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: `edge ${e.type}`,
    }, edgesG);
  });

  const r = p.twistRadius * SVG_SCALE;
  state.lines.forEach((line, li) => {
    line.twists.forEach((t, ti) => {
      const c = svgCoord(li, ti);
      const sel = state.selection?.kind === 'twist' && state.selection.id === t.id;
      const cls = ['twist', isFast(t) ? 'fast' : 'loose'];
      if (sel) cls.push('selected');
      else if (state.selection?.kind === 'twist') cls.push('linkable');
      const c1 = svg('circle', {
        cx: c.x, cy: c.y, r,
        class: cls.join(' '),
        'data-twist': t.id,
      }, twistsG);
      c1.addEventListener('click', (ev) => {
        ev.stopPropagation();
        onTwistClick(ev, t.id);
      });
    });

    // ghost "add twist" at end of line
    const g = svgCoord(li, line.twists.length);
    const gr = r * 0.75;
    const ghost = svg('circle', {
      cx: g.x, cy: g.y, r: gr, class: 'ghost-add',
    }, twistsG);
    ghost.addEventListener('click', (ev) => {
      ev.stopPropagation();
      addTwistAtLine(li);
      rerender();
    });
    svg('text', {
      x: g.x, y: g.y, class: 'ghost-plus',
    }, twistsG).textContent = '+';
  });

  svgEl.addEventListener('click', clearSelectionIfBackground, { once: true });
}

function clearSelectionIfBackground(ev) {
  if (ev.target === svgEl) {
    state.selection = null;
    rerender();
  }
}

function onTwistClick(ev, twistId) {
  if (ev.shiftKey && state.selection?.kind === 'twist' && state.selection.id !== twistId) {
    setTether(state.selection.id, twistId);
  } else if (ev.altKey && state.selection?.kind === 'twist' && state.selection.id !== twistId) {
    setHoist(state.selection.id, twistId);
  } else {
    state.selection = { kind: 'twist', id: twistId };
  }
  rerender();
}

// ------------------------------------------------------------- 3D scene ----

const cv = document.getElementById('previewCanvas');
const scene = new THREE.Scene();
scene.background = null;  // transparent so the panel-body gradient shows through

const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 2000);
const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.setClearColor(0x000000, 0);

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.dampingFactor = 0.1;

scene.add(new THREE.AmbientLight(0xffffff, 0.55));
{
  const d = new THREE.DirectionalLight(0xffffff, 0.85);
  d.position.set(60, 90, 40);
  scene.add(d);
}
{
  const d = new THREE.DirectionalLight(0xaaccff, 0.25);
  d.position.set(-40, 40, -60);
  scene.add(d);
}

const sceneRoot = new THREE.Group();
scene.add(sceneRoot);

const EDGE_COLOR = {
  prev: 0x999999,
  teth: 0xff99ff,
  lead: 0x3dff33,
  meet: 0x8866ff,
  post: 0xffae3c,
};
const PLATE_COLOR = 0xdddddd;
const TWIST_COLOR = 0xffffff;

function disposeGroup(g) {
  while (g.children.length) {
    const c = g.children[0];
    g.remove(c);
    c.geometry && c.geometry.dispose();
    c.material && c.material.dispose && c.material.dispose();
  }
}

// Closed (capped) hemisphere: dome + disk at base.
// SphereGeometry's top hemisphere has its flat at Y=0, dome above. The cap
// is a CircleGeometry rotated so its normal points -Y (away from the dome).
function hemisphereGeom(radius, segs = 24) {
  const dome = new THREE.SphereGeometry(radius, segs, Math.max(8, segs / 2), 0, Math.PI * 2, 0, Math.PI / 2);
  const cap = new THREE.CircleGeometry(radius, segs);
  cap.rotateX(Math.PI / 2);
  return BGU.mergeGeometries([dome, cap], false) || dome;
}

function cylinderBetween(a, b, radius) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  if (len < 1e-5) return null;
  const geom = new THREE.CylinderGeometry(radius, radius, len, 14, 1, false);
  const m = new THREE.Mesh(geom);
  m.position.copy(a).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  return m;
}

// World-space position of a twist in Three.js (Y is up; Z is "down" across lines).
function worldPos(twistId, idx) {
  const info = idx[twistId];
  if (!info) return null;
  const p = state.params;
  return new THREE.Vector3(
    twistX(info.lineIdx, info.twistIdx),
    p.plateThickness,
    info.lineIdx * p.lineSpacing,
  );
}

function buildScene() {
  disposeGroup(sceneRoot);
  const p = state.params;
  const idx = indexTwists(state);

  let minX = 0, maxX = 0, maxZ = 0;
  state.lines.forEach((line, li) => {
    if (line.twists.length) {
      maxX = Math.max(maxX, twistX(li, line.twists.length - 1));
      minX = Math.min(minX, twistX(li, 0));
    }
    maxZ = Math.max(maxZ, li * p.lineSpacing);
  });
  const margin = Math.max(p.twistRadius * 2.2, 6);
  const plateW = (maxX - minX) + margin * 2;
  const plateD = maxZ + margin * 2;
  const plateCx = (maxX + minX) / 2;
  const plateCz = maxZ / 2;

  // plate
  {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(plateW, p.plateThickness, plateD),
      new THREE.MeshLambertMaterial({ color: PLATE_COLOR }),
    );
    m.position.set(plateCx, p.plateThickness / 2, plateCz);
    m.userData.exportColor = 'plate';
    sceneRoot.add(m);
  }

  // optional border frame on top of plate
  if (p.borderHeight > 0 && p.borderWidth > 0) {
    const bh = p.borderHeight, bw = p.borderWidth;
    const y = p.plateThickness + bh / 2;
    const mat = new THREE.MeshLambertMaterial({ color: PLATE_COLOR });
    const innerD = plateD - 2 * bw;
    const left = minX - margin;
    const right = maxX + margin;
    const strips = [
      { dx: plateW, dz: bw,     x: plateCx,            z: -margin + bw / 2 },
      { dx: plateW, dz: bw,     x: plateCx,            z: maxZ + margin - bw / 2 },
      { dx: bw,     dz: innerD, x: left + bw / 2,      z: plateCz },
      { dx: bw,     dz: innerD, x: right - bw / 2,     z: plateCz },
    ];
    strips.forEach((s) => {
      if (s.dx <= 0 || s.dz <= 0) return;
      const m = new THREE.Mesh(new THREE.BoxGeometry(s.dx, bh, s.dz), mat);
      m.position.set(s.x, y, s.z);
      m.userData.exportColor = 'plate';
      sceneRoot.add(m);
    });
  }

  // twists (hemispheres)
  const twistGeom = hemisphereGeom(p.twistRadius);
  const twistMat = new THREE.MeshLambertMaterial({ color: TWIST_COLOR });
  state.lines.forEach((line) => {
    line.twists.forEach((t) => {
      const pos = worldPos(t.id, idx);
      const m = new THREE.Mesh(twistGeom, twistMat);
      m.position.copy(pos);
      m.userData.exportColor = 'twist';
      sceneRoot.add(m);
    });
  });

  // edges (capped cylinders)
  const edgeMats = {};
  Object.entries(EDGE_COLOR).forEach(([k, c]) => {
    edgeMats[k] = new THREE.MeshLambertMaterial({ color: c });
  });
  // Lift cylinder centers by edgeRadius so the cylinder bottom rests on
  // the plate top instead of dipping below it. This keeps the plate free
  // of internal geometry (so it can be printed as a clean solid).
  const edgeLift = p.edgeRadius;
  deriveEdges(state).forEach((e) => {
    const a = worldPos(e.from, idx); const b = worldPos(e.to, idx);
    if (!a || !b) return;
    a.y = p.plateThickness + edgeLift;
    b.y = p.plateThickness + edgeLift;
    const m = cylinderBetween(a, b, p.edgeRadius);
    if (!m) return;
    m.material = edgeMats[e.type];
    m.userData.exportColor = e.type;
    sceneRoot.add(m);
  });

}

function initCamera() {
  // Set a sensible default view sized for a moderate rig (~10 twists by
  // ~4 lines). After this, the user owns the camera — graph changes never
  // touch it.
  const p = state.params;
  const target = new THREE.Vector3(10 * p.twistSpacing / 2, p.plateThickness, 4 * p.lineSpacing / 2);
  const fov = camera.fov * Math.PI / 180;
  const span = Math.max(10 * p.twistSpacing, 4 * p.lineSpacing);
  const dist = span * 1.2 / (2 * Math.tan(fov / 2));
  camera.position.set(target.x, target.y + dist * 0.7, target.z + dist * 0.9);
  orbit.target.copy(target);
  orbit.update();
}

function snapshotCamera() {
  return {
    pos: [camera.position.x, camera.position.y, camera.position.z],
    target: [orbit.target.x, orbit.target.y, orbit.target.z],
  };
}

function applyCamera(c) {
  if (!c || !Array.isArray(c.pos) || c.pos.length !== 3) return false;
  if (!Array.isArray(c.target) || c.target.length !== 3) return false;
  camera.position.set(c.pos[0], c.pos[1], c.pos[2]);
  orbit.target.set(c.target[0], c.target[1], c.target[2]);
  orbit.update();
  return true;
}

function resize3D() {
  const r = cv.getBoundingClientRect();
  if (!r.width || !r.height) return;
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / r.height;
  camera.updateProjectionMatrix();
}

function tick() {
  requestAnimationFrame(tick);
  orbit.update();
  renderer.render(scene, camera);
}

new ResizeObserver(resize3D).observe(cv);

// ----------------------------------------------------------- 3MF export ----

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const ENCODER = new TextEncoder();
const strToBytes = (s) => ENCODER.encode(s);

// Stored-mode (uncompressed) ZIP writer. Entries: [{name, data:Uint8Array}].
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const name = strToBytes(e.name);
    const crc = crc32(e.data);
    const size = e.data.length;
    const local = new Uint8Array(30 + name.length + size);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);  dv.setUint16(6, 0, true);
    dv.setUint16(8, 0, true);   dv.setUint16(10, 0, true);
    dv.setUint16(12, 0, true);  dv.setUint32(14, crc, true);
    dv.setUint32(18, size, true); dv.setUint32(22, size, true);
    dv.setUint16(26, name.length, true); dv.setUint16(28, 0, true);
    local.set(name, 30);
    local.set(e.data, 30 + name.length);
    locals.push(local);
    centrals.push({ name, crc, size, offset });
    offset += local.length;
  }

  const cdParts = [];
  let cdSize = 0;
  for (const c of centrals) {
    const buf = new Uint8Array(46 + c.name.length);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);   dv.setUint16(6, 20, true);
    dv.setUint16(8, 0, true);    dv.setUint16(10, 0, true);
    dv.setUint16(12, 0, true);   dv.setUint16(14, 0, true);
    dv.setUint32(16, c.crc, true);
    dv.setUint32(20, c.size, true); dv.setUint32(24, c.size, true);
    dv.setUint16(28, c.name.length, true); dv.setUint16(30, 0, true);
    dv.setUint16(32, 0, true);   dv.setUint16(34, 0, true);
    dv.setUint16(36, 0, true);   dv.setUint32(38, 0, true);
    dv.setUint32(42, c.offset, true);
    buf.set(c.name, 46);
    cdParts.push(buf);
    cdSize += buf.length;
  }

  const eocd = new Uint8Array(22);
  const dv = new DataView(eocd.buffer);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(4, 0, true);  dv.setUint16(6, 0, true);
  dv.setUint16(8, centrals.length, true); dv.setUint16(10, centrals.length, true);
  dv.setUint32(12, cdSize, true); dv.setUint32(16, offset, true);
  dv.setUint16(20, 0, true);

  const total = offset + cdSize + 22;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const l of locals) { out.set(l, pos); pos += l.length; }
  for (const c of cdParts) { out.set(c, pos); pos += c.length; }
  out.set(eocd, pos);
  return out;
}

// Three.js mesh -> {verts, tris} for 3MF export.
// Three.js primitives split vertices at face seams (so each face can have
// its own normal/UV for sharp rendering); the rendered scene wants that,
// but a 3MF needs a watertight manifold. We rebuild a position-only copy
// of the geometry and weld vertices by position before extracting.
//
// Three is Y-up. 3MF/printers are Z-up. We rotate +90° about X (i.e.,
// Three +Y becomes 3MF +Z, Three +Z becomes 3MF -Y) and then translate Y
// so all coordinates stay positive. Winding is preserved because this is
// a true rotation, not a reflection — earlier code did a Y↔Z swap, which
// IS a reflection and produced a mirror-imaged print.
function extractMesh(threeMesh, yOffset) {
  const original = threeMesh.geometry;
  const stripped = new THREE.BufferGeometry();
  stripped.setAttribute('position', original.getAttribute('position').clone());
  if (original.index) stripped.setIndex(original.index.clone());
  const welded = BGU.mergeVertices(stripped, 1e-4);

  threeMesh.updateMatrixWorld(true);
  const M = threeMesh.matrixWorld;
  const pos = welded.attributes.position;
  const idxAttr = welded.index;
  const verts = [];
  const tmp = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    tmp.fromBufferAttribute(pos, i).applyMatrix4(M);
    verts.push([tmp.x, yOffset - tmp.z, tmp.y]);
  }
  const tris = [];
  if (idxAttr) {
    for (let i = 0; i < idxAttr.count; i += 3) {
      tris.push([idxAttr.getX(i), idxAttr.getX(i + 1), idxAttr.getX(i + 2)]);
    }
  } else {
    for (let i = 0; i < pos.count; i += 3) tris.push([i, i + 1, i + 2]);
  }
  welded.dispose();
  stripped.dispose();
  return { verts, tris };
}

const EXPORT_MATERIALS = [
  { key: 'twist',  name: 'twist',  color: '#FFFFFF' },
  { key: 'plate',  name: 'plate',  color: '#DDDDDD' },
  { key: 'prev',   name: 'prev',   color: '#999999' },
  { key: 'teth',   name: 'tether', color: '#FF99FF' },
  { key: 'lead',   name: 'lead',   color: '#3DFF33' },
  { key: 'meet',   name: 'meet',   color: '#8866FF' },
  { key: 'post',   name: 'post',   color: '#FFAE3C' },
];

function buildModelXml(byKey) {
  const live = EXPORT_MATERIALS.filter((m) => byKey[m.key]?.verts.length);
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n';
  xml += '  <resources>\n';
  xml += '    <basematerials id="1">\n';
  live.forEach((m) => {
    xml += `      <base name="${m.name}" displaycolor="${m.color}" />\n`;
  });
  xml += '    </basematerials>\n';

  const objectIds = [];
  live.forEach((m, i) => {
    const data = byKey[m.key];
    const objId = 2 + i;
    objectIds.push(objId);
    xml += `    <object id="${objId}" type="model" pid="1" pindex="${i}">\n`;
    xml += '      <mesh>\n';
    xml += '        <vertices>\n';
    for (const v of data.verts) {
      xml += `          <vertex x="${v[0].toFixed(4)}" y="${v[1].toFixed(4)}" z="${v[2].toFixed(4)}"/>\n`;
    }
    xml += '        </vertices>\n';
    xml += '        <triangles>\n';
    for (const t of data.tris) {
      xml += `          <triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"/>\n`;
    }
    xml += '        </triangles>\n';
    xml += '      </mesh>\n';
    xml += '    </object>\n';
  });

  xml += '  </resources>\n';
  xml += '  <build>\n';
  objectIds.forEach((id) => { xml += `    <item objectid="${id}"/>\n`; });
  xml += '  </build>\n';
  xml += '</model>\n';
  return xml;
}

// Map each material key to a Bambu Studio extruder index (1-based). Plate
// is 1 so the baseplate stays a single solid color; each other part is on
// its own filament so the rig is easy to recolor in the slicer. User can
// remap in Bambu's UI after loading.
const BAMBU_EXTRUDER = {
  plate: 1, twist: 2, prev: 3, teth: 4, lead: 5, meet: 6, post: 7,
};

function export3mf() {
  // Y offset used by extractMesh to keep all 3MF Y coords positive after
  // the Z-up rotation (and to put the corkline at the back of the bed,
  // matching the editor's top-of-screen orientation).
  const p = state.params;
  const margin = Math.max(p.twistRadius * 2.2, 6);
  const yOffset = (state.lines.length - 1) * p.lineSpacing + margin;

  const byKey = {};
  EXPORT_MATERIALS.forEach((m) => { byKey[m.key] = { verts: [], tris: [] }; });

  sceneRoot.traverse((o) => {
    if (!o.isMesh) return;
    const key = o.userData.exportColor;
    if (!byKey[key]) return;
    const m = extractMesh(o, yOffset);
    const dst = byKey[key];
    const base = dst.verts.length;
    for (const v of m.verts) dst.verts.push(v);
    for (const t of m.tris) dst.tris.push([t[0] + base, t[1] + base, t[2] + base]);
  });

  const totalTris = Object.values(byKey).reduce((a, b) => a + b.tris.length, 0);
  if (totalTris === 0) { flash('Nothing to export'); return; }

  const modelXml = buildModelXml(byKey);
  const contentTypes =
`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
  <Default Extension="config" ContentType="application/vnd.bambulab-package.config+xml"/>
</Types>
`;
  const rels =
`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/3dmodel.model" Id="rel0"/>
</Relationships>
`;

  // Bambu Studio's per-object filament assignment. References the same
  // object ids we wrote into 3D/3dmodel.model. Other slicers ignore the
  // file (it's outside the standard 3MF schema).
  const liveMaterials = EXPORT_MATERIALS.filter((m) => byKey[m.key].verts.length);
  let bambuCfg = '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n';
  liveMaterials.forEach((m, i) => {
    const objId = 2 + i;  // mirror the numbering buildModelXml uses
    const ext = BAMBU_EXTRUDER[m.key] ?? 1;
    bambuCfg += `  <object id="${objId}">\n`;
    bambuCfg += `    <metadata key="name" value="${m.name}"/>\n`;
    bambuCfg += `    <metadata key="extruder" value="${ext}"/>\n`;
    bambuCfg += `  </object>\n`;
  });
  bambuCfg += '</config>\n';

  const zip = buildZip([
    { name: '[Content_Types].xml',          data: strToBytes(contentTypes) },
    { name: '_rels/.rels',                  data: strToBytes(rels) },
    { name: '3D/3dmodel.model',             data: strToBytes(modelXml) },
    { name: 'Metadata/model_settings.config', data: strToBytes(bambuCfg) },
  ]);
  download(new Blob([zip], { type: 'model/3mf' }), 'rig.3mf');
  flash(`Exported ${totalTris} triangles to rig.3mf`);
}

// ----------------------------------------------------------- SCAD export ----

// Three is Y-up; OpenSCAD is Z-up. Map: scad.x = three.x, scad.y = three.z,
// scad.z = three.y. We compute geometry directly in SCAD space here (no
// per-vertex swap needed — we just use the right axes when emitting).
const SCAD_EDGE_COLOR = {
  prev: [0.60, 0.60, 0.60],
  teth: [1.00, 0.60, 1.00],
  lead: [0.24, 1.00, 0.20],
  meet: [0.53, 0.40, 1.00],
  post: [1.00, 0.68, 0.24],
};

function exportScad() {
  const p = state.params;
  const idx = indexTwists(state);
  const f = (n) => (Math.round(n * 1000) / 1000).toString();

  // Plate bounds. Note: in the editor "down the screen" is increasing line
  // index, but on a print bed "back of the bed" is increasing Y. To make
  // the printed plate match the editor orientation, we flip the line
  // direction here so the corkline (line 0) sits at the back of the bed.
  let minX = 0, maxX = 0;
  state.lines.forEach((line, li) => {
    if (line.twists.length) {
      maxX = Math.max(maxX, twistX(li, line.twists.length - 1));
      minX = Math.min(minX, twistX(li, 0));
    }
  });
  const margin = Math.max(p.twistRadius * 2.2, 6);
  const lastLineY = (state.lines.length - 1) * p.lineSpacing;
  const plateW = (maxX - minX) + margin * 2;
  const plateD = lastLineY + margin * 2;
  const plateX0 = (minX + maxX) / 2 - plateW / 2;
  const plateY0 = 0;
  // Convert a line index to its SCAD-Y position (cork at the back).
  const lineY = (li) => margin + (state.lines.length - 1 - li) * p.lineSpacing;

  const lines = [];
  lines.push(`// TODA rig — exported ${new Date().toISOString()}`);
  lines.push(`// Open in OpenSCAD. Render with F6 to export STL/3MF.`);
  lines.push(``);
  lines.push(`$fn = 32;`);
  lines.push(``);
  lines.push(`twistRadius = ${f(p.twistRadius)};`);
  lines.push(`edgeRadius  = ${f(p.edgeRadius)};`);
  lines.push(`plateThick  = ${f(p.plateThickness)};`);
  if (p.borderHeight > 0 && p.borderWidth > 0) {
    lines.push(`borderH     = ${f(p.borderHeight)};`);
    lines.push(`borderW     = ${f(p.borderWidth)};`);
  }
  lines.push(``);
  lines.push(`// Hemisphere sitting flat on Z=z, dome up.`);
  lines.push(`module hemi(x, y, z, r) {`);
  lines.push(`  translate([x, y, z]) intersection() {`);
  lines.push(`    sphere(r=r);`);
  lines.push(`    translate([-r, -r, 0]) cube([2*r, 2*r, r]);`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`// Capsule edge between two 3D points (hull of two spheres).`);
  lines.push(`module edge(x1, y1, x2, y2, z, r) {`);
  lines.push(`  hull() {`);
  lines.push(`    translate([x1, y1, z]) sphere(r=r);`);
  lines.push(`    translate([x2, y2, z]) sphere(r=r);`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push(``);

  // Plate
  lines.push(`// ---- baseplate ----`);
  lines.push(`color([0.87, 0.87, 0.87])`);
  lines.push(`  translate([${f(plateX0)}, ${f(plateY0)}, 0])`);
  lines.push(`    cube([${f(plateW)}, ${f(plateD)}, plateThick]);`);
  lines.push(``);

  // Optional border frame
  if (p.borderHeight > 0 && p.borderWidth > 0) {
    const bw = p.borderWidth, bh = p.borderHeight;
    lines.push(`// ---- border ----`);
    lines.push(`color([0.87, 0.87, 0.87])`);
    lines.push(`  translate([0, 0, plateThick]) union() {`);
    // North
    lines.push(`    translate([${f(plateX0)}, ${f(plateY0)}, 0]) cube([${f(plateW)}, ${f(bw)}, ${f(bh)}]);`);
    // South
    lines.push(`    translate([${f(plateX0)}, ${f(plateY0 + plateD - bw)}, 0]) cube([${f(plateW)}, ${f(bw)}, ${f(bh)}]);`);
    // West
    lines.push(`    translate([${f(plateX0)}, ${f(plateY0 + bw)}, 0]) cube([${f(bw)}, ${f(plateD - 2 * bw)}, ${f(bh)}]);`);
    // East
    lines.push(`    translate([${f(plateX0 + plateW - bw)}, ${f(plateY0 + bw)}, 0]) cube([${f(bw)}, ${f(plateD - 2 * bw)}, ${f(bh)}]);`);
    lines.push(`  }`);
    lines.push(``);
  }

  // Twists (hemispheres)
  lines.push(`// ---- twists ----`);
  lines.push(`color([1, 1, 1]) union() {`);
  state.lines.forEach((line, li) => {
    line.twists.forEach((t, ti) => {
      const x = twistX(li, ti);
      const y = lineY(li);
      lines.push(`  hemi(${f(x)}, ${f(y)}, plateThick, twistRadius);`);
    });
  });
  lines.push(`}`);
  lines.push(``);

  // Edges, grouped by type so each color is one union.
  const byType = { prev: [], teth: [], lead: [], meet: [], post: [] };
  deriveEdges(state).forEach((e) => { byType[e.type]?.push(e); });
  const edgeZ = p.plateThickness + p.edgeRadius;
  ['prev', 'teth', 'lead', 'meet', 'post'].forEach((type) => {
    const es = byType[type];
    if (!es || es.length === 0) return;
    const [r, g, b] = SCAD_EDGE_COLOR[type];
    lines.push(`// ---- ${type} ----`);
    lines.push(`color([${f(r)}, ${f(g)}, ${f(b)}]) union() {`);
    es.forEach((e) => {
      const a = idx[e.from], bb = idx[e.to];
      if (!a || !bb) return;
      const x1 = twistX(a.lineIdx, a.twistIdx);
      const y1 = lineY(a.lineIdx);
      const x2 = twistX(bb.lineIdx, bb.twistIdx);
      const y2 = lineY(bb.lineIdx);
      lines.push(`  edge(${f(x1)}, ${f(y1)}, ${f(x2)}, ${f(y2)}, ${f(edgeZ)}, edgeRadius);`);
    });
    lines.push(`}`);
    lines.push(``);
  });

  const scad = lines.join('\n');
  download(new Blob([scad], { type: 'application/x-openscad' }), 'rig.scad');
  flash(`Exported rig.scad (${scad.length} bytes)`);
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ------------------------------------------------------------ JSON I/O ----

function snapshot() {
  return {
    version: 1,
    ids,
    lines: state.lines,
    params: state.params,
    camera: snapshotCamera(),
  };
}

function exportJson() {
  download(new Blob([JSON.stringify(snapshot(), null, 2)],
    { type: 'application/json' }), 'rig.json');
}

function applySnapshot(obj) {
  if (!obj || !Array.isArray(obj.lines) || obj.lines.length === 0) {
    throw new Error('missing or empty lines[]');
  }
  state.lines = obj.lines.map((l, li) => ({
    id: l.id,
    xShift: typeof l.xShift === 'number' ? l.xShift : defaultXShift(li),
    twists: (l.twists || []).map((t) => ({
      id: t.id, tether: t.tether || null, hoist: t.hoist || null,
    })),
  }));
  if (obj.params) Object.assign(state.params, obj.params);
  if (obj.ids) Object.assign(ids, obj.ids);
  state.selection = null;
  return applyCamera(obj.camera);
}

function importJson(file) {
  const r = new FileReader();
  r.onload = (ev) => {
    try {
      applySnapshot(JSON.parse(ev.target.result));
      syncParamInputs();
      rerender();
      flash('Loaded ' + file.name);
    } catch (err) {
      flash('Failed to load: ' + err.message);
    }
  };
  r.readAsText(file);
}

// ----------------------------------------------------------- localStorage ----

const STORAGE_KEY = 'toda-rig-designer:v1';

function saveSession() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot()));
  } catch (_) { /* quota/disabled — fall through silently */ }
}

function restoreSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { restored: false, cameraRestored: false };
    const cameraRestored = applySnapshot(JSON.parse(raw));
    return { restored: true, cameraRestored };
  } catch (_) {
    return { restored: false, cameraRestored: false };
  }
}

// ---------------------------------------------------------- params UI ----

function syncParamInputs() {
  document.querySelectorAll('[data-p]').forEach((el) => {
    el.value = state.params[el.dataset.p];
    const min = +el.min, max = +el.max;
    const pct = max > min ? ((+el.value - min) / (max - min)) * 100 : 0;
    el.style.setProperty('--pct', pct + '%');
  });
  document.querySelectorAll('[data-v]').forEach((el) => {
    const v = state.params[el.dataset.v];
    el.textContent = Math.round(v * 10) / 10;
  });
}

function bindParams() {
  document.querySelectorAll('[data-p]').forEach((el) => {
    el.addEventListener('input', () => {
      state.params[el.dataset.p] = parseFloat(el.value);
      syncParamInputs();
      rerender();
    });
  });
  syncParamInputs();
}

// ------------------------------------------------------------ toolbar ----

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function flash(msg) {
  const el = document.getElementById('status-left');
  if (!el) return;
  el.dataset.flashing = '1';
  el.innerHTML = `<span class="status-chip">${esc(msg)}</span>`;
  clearTimeout(flash._t);
  flash._t = setTimeout(() => { delete el.dataset.flashing; updateStatus(); }, 2200);
}

function updateStatus() {
  const left = document.getElementById('status-left');
  const meta = document.getElementById('panel-meta-editor');
  if (meta) {
    meta.textContent = state.lines.length
      ? state.lines.map((l, i) => `L${i}:${l.twists.length}`).join(' · ')
      : '—';
  }
  if (left && !left.dataset.flashing) {
    const n = state.lines.length;
    const chip = `<span class="status-chip">${n} line${n === 1 ? '' : 's'}</span>`;
    const sel = state.selection
      ? `<span class="status-dot">·</span><span class="status-piece">sel=<span class="status-sel">${esc(state.selection.kind)}:${esc(state.selection.id)}</span></span>`
      : '';
    left.innerHTML = chip + sel;
  }
  updateFastPill();
}

function updateFastPill() {
  const pill = document.getElementById('fast-pill');
  const label = document.getElementById('fast-label');
  if (!pill || !label) return;
  if (state.selection?.kind === 'twist') {
    const info = indexTwists(state)[state.selection.id];
    if (info && isFast(info.twist)) {
      pill.classList.add('on');
      label.textContent = 'Fast';
      return;
    }
    pill.classList.remove('on');
    label.textContent = 'Loose';
    return;
  }
  pill.classList.remove('on');
  label.textContent = 'Fast / Loose';
}

function rerender() {
  renderEditor();
  buildScene();
  updateStatus();
  saveSession();
}

document.getElementById('btn-add-line').addEventListener('click', () => {
  addLine();
  rerender();
});

document.getElementById('btn-add-twist').addEventListener('click', () => {
  if (state.selection?.kind === 'twist') {
    const info = indexTwists(state)[state.selection.id];
    if (info) {
      addTwistAtLine(info.lineIdx, info.twistIdx + 1);
      rerender();
      return;
    }
  }
  let li = state.lines.length - 1;
  if (state.selection?.kind === 'line') {
    li = state.lines.findIndex((l) => l.id === state.selection.id);
  }
  addTwistAtLine(li);
  rerender();
});

document.getElementById('btn-toggle-fast').addEventListener('click', () => {
  if (state.selection?.kind !== 'twist') { flash('Select a twist first'); return; }
  const info = indexTwists(state)[state.selection.id];
  if (!info) return;
  setFast(info.twist.id, !isFast(info.twist));
  rerender();
});

document.getElementById('btn-remove').addEventListener('click', () => {
  if (state.selection?.kind === 'twist') removeTwist(state.selection.id);
  else if (state.selection?.kind === 'line') removeLine(state.selection.id);
  else { flash('Nothing selected'); return; }
  state.selection = null;
  rerender();
});

document.getElementById('btn-import').addEventListener('click', () => {
  document.getElementById('file-input').click();
});
document.getElementById('file-input').addEventListener('change', (ev) => {
  const f = ev.target.files?.[0];
  if (f) importJson(f);
  ev.target.value = '';
});
document.getElementById('btn-export-json').addEventListener('click', exportJson);
document.getElementById('btn-export-scad').addEventListener('click', exportScad);
document.getElementById('btn-export-3mf').addEventListener('click', export3mf);

window.addEventListener('keydown', (ev) => {
  if (ev.target instanceof HTMLInputElement) return;
  if (ev.key === 'Delete' || ev.key === 'Backspace') {
    document.getElementById('btn-remove').click();
    ev.preventDefault();
  } else if (ev.key === 'f' || ev.key === 'F') {
    document.getElementById('btn-toggle-fast').click();
  } else if (ev.key === 'n' || ev.key === 'N') {
    document.getElementById('btn-add-line').click();
  } else if (ev.key === 't' || ev.key === 'T') {
    document.getElementById('btn-add-twist').click();
  } else if (ev.key === 'Escape') {
    state.selection = null;
    rerender();
  }
});

// ---------------------------------------------------------------- init ----

const session = restoreSession();
if (!session.cameraRestored) initCamera();
bindParams();
rerender();
resize3D();
tick();

// The camera changes during orbiting (which does not call rerender), so
// flush one more save right before unload to capture the latest view.
window.addEventListener('beforeunload', saveSession);

// ---- theme toggle ----
{
  const SUN  = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/></svg>';
  const MOON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M11.4 10.4A5.2 5.2 0 0 1 5 4a5 5 0 0 0-.7 9.4 5.2 5.2 0 0 0 7.1-3z"/></svg>';
  const root = document.documentElement;
  const icon = document.getElementById('theme-toggle-icon');
  function setTheme(t) {
    root.classList.remove('theme-dark', 'theme-light');
    root.classList.add('theme-' + t);
    if (icon) icon.innerHTML = t === 'light' ? SUN : MOON;
    try { localStorage.setItem('toda3d.theme', t); } catch (_) {}
  }
  const current = root.classList.contains('theme-light') ? 'light' : 'dark';
  setTheme(current);
  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    setTheme(root.classList.contains('theme-light') ? 'dark' : 'light');
  });
}

// ---- controls strip scroll affordance ----
{
  const controls = document.getElementById('params');
  const fade = document.getElementById('controls-fade');
  if (controls && fade) {
    const syncFade = () => {
      const atEnd = controls.scrollLeft + controls.clientWidth >= controls.scrollWidth - 4;
      fade.classList.toggle('hidden', atEnd);
    };
    controls.addEventListener('scroll', syncFade);
    new ResizeObserver(syncFade).observe(controls);
    fade.addEventListener('click', () => controls.scrollBy({ left: 200, behavior: 'smooth' }));
    syncFade();
  }
}
