// TODA Rig Designer — single-file logic
// Sections: state | edges | auto-pick | mutations | 2D editor | 3D scene
//           | 3MF export | JSON I/O | params | toolbar | init.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as BGU from 'three/addons/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------- state ----

const ids = { L: 1, t: 1 };
const nid = (p) => `${p}${ids[p]++}`;

const state = {
  lines: [{ id: nid('L'), twists: [] }],   // top line first (corkline)
  selection: null,                          // { kind: 'twist'|'line', id }
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

// Lines are visually staggered so adjacent rows never share an X position.
// Alternating half-spacing offset is enough to guarantee non-vertical edges
// for tether/lead/meet/post between any line and the one directly above.
function lineXOffset(lineIdx) {
  return (lineIdx % 2) * (state.params.twistSpacing / 2);
}

function twistX(lineIdx, twistIdx) {
  return lineXOffset(lineIdx) + twistIdx * state.params.twistSpacing;
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

// After any structural change, re-evaluate which fast twists on `lineIdx`
// are leads, and auto-pick a hoist for those that need one and don't have it.
// A lead now requires only one more fast after it (the meet); post is added
// automatically when a third fast appears (via deriveEdges).
function recomputeHoists(s, lineIdx) {
  const line = s.lines[lineIdx];
  const fasts = line.twists.map((t, i) => ({ t, i })).filter((o) => isFast(o.t));
  fasts.forEach((o, fi) => {
    const shouldHaveHoist = fi <= fasts.length - 2;
    if (!shouldHaveHoist) { o.t.hoist = null; return; }
    if (!o.t.hoist) o.t.hoist = autoPickHoist(s, lineIdx, o.i);
  });
}

// ----------------------------------------------------------- mutations ----

function addLine() {
  state.lines.push({ id: nid('L'), twists: [] });
}

function addTwistAtLine(lineIdx) {
  if (lineIdx < 0 || lineIdx >= state.lines.length) return null;
  const id = nid('t');
  state.lines[lineIdx].twists.push({ id });
  return id;
}

function setFast(twistId, fast) {
  const info = indexTwists(state)[twistId];
  if (!info) return;
  if (info.lineIdx === 0) { flash('Top line is always loose'); return; }
  if (fast) {
    if (!info.twist.tether) {
      const t = autoPickTether(state, info.lineIdx, info.twistIdx);
      if (!t) { flash('No twist above to tether to — add some first'); return; }
      info.twist.tether = t;
    }
  } else {
    info.twist.tether = null;
    info.twist.hoist = null;
  }
  recomputeHoists(state, info.lineIdx);
}

function setTether(twistId, targetId) {
  const idx = indexTwists(state);
  const src = idx[twistId], tgt = idx[targetId];
  if (!src || !tgt) return;
  if (tgt.lineIdx >= src.lineIdx) { flash('Tether must point to a line above'); return; }
  const xS = twistX(src.lineIdx, src.twistIdx);
  const xT = twistX(tgt.lineIdx, tgt.twistIdx);
  if (xT >= xS) { flash('Tether must go up-left (target must be left of source)'); return; }
  src.twist.tether = targetId;
  recomputeHoists(state, src.lineIdx);
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
scene.background = new THREE.Color(0x1a1a2e);

const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 2000);
const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true });
renderer.setPixelRatio(devicePixelRatio);

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
// is a CircleGeometry rotated so its normal points -Y (away from the dome),
// closing the hemisphere into a manifold solid.
function hemisphereGeom(radius, segs = 24) {
  const dome = new THREE.SphereGeometry(radius, segs, Math.max(8, segs / 2), 0, Math.PI * 2, 0, Math.PI / 2);
  const cap = new THREE.CircleGeometry(radius, segs);
  cap.rotateX(Math.PI / 2);   // disk now in XZ plane, normal -Y (outward, since dome is +Y)
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
  const edgeLift = Math.max(0.3, p.edgeRadius * 0.5);
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

// Three.js mesh -> {verts, tris} with Y/Z swap (Three Y-up -> 3MF Z-up) and
// reversed winding to keep outward normals correct after the handedness flip.
function extractMesh(threeMesh) {
  const geom = threeMesh.geometry;
  threeMesh.updateMatrixWorld(true);
  const M = threeMesh.matrixWorld;
  const pos = geom.attributes.position;
  const idxAttr = geom.index;
  const verts = [];
  const tmp = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    tmp.fromBufferAttribute(pos, i).applyMatrix4(M);
    verts.push([tmp.x, tmp.z, tmp.y]); // y<->z
  }
  const tris = [];
  if (idxAttr) {
    for (let i = 0; i < idxAttr.count; i += 3) {
      tris.push([idxAttr.getX(i), idxAttr.getX(i + 2), idxAttr.getX(i + 1)]);
    }
  } else {
    for (let i = 0; i < pos.count; i += 3) tris.push([i, i + 2, i + 1]);
  }
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

function export3mf() {
  const byKey = {};
  EXPORT_MATERIALS.forEach((m) => { byKey[m.key] = { verts: [], tris: [] }; });

  sceneRoot.traverse((o) => {
    if (!o.isMesh) return;
    const key = o.userData.exportColor;
    if (!byKey[key]) return;
    const m = extractMesh(o);
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
</Types>
`;
  const rels =
`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/3dmodel.model" Id="rel0"/>
</Relationships>
`;

  const zip = buildZip([
    { name: '[Content_Types].xml', data: strToBytes(contentTypes) },
    { name: '_rels/.rels',         data: strToBytes(rels) },
    { name: '3D/3dmodel.model',    data: strToBytes(modelXml) },
  ]);
  download(new Blob([zip], { type: 'model/3mf' }), 'rig.3mf');
  flash(`Exported ${totalTris} triangles to rig.3mf`);
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ------------------------------------------------------------ JSON I/O ----

function exportJson() {
  const data = JSON.stringify({
    version: 1,
    ids,
    lines: state.lines,
    params: state.params,
  }, null, 2);
  download(new Blob([data], { type: 'application/json' }), 'rig.json');
}

function importJson(file) {
  const r = new FileReader();
  r.onload = (ev) => {
    try {
      const obj = JSON.parse(ev.target.result);
      if (!obj || !Array.isArray(obj.lines)) throw new Error('missing lines[]');
      state.lines = obj.lines.map((l) => ({
        id: l.id, twists: (l.twists || []).map((t) => ({
          id: t.id, tether: t.tether || null, hoist: t.hoist || null,
        })),
      }));
      if (obj.params) Object.assign(state.params, obj.params);
      if (obj.ids) Object.assign(ids, obj.ids);
      state.selection = null;
      syncParamInputs();
      rerender();
      flash('Loaded ' + file.name);
    } catch (err) {
      flash('Failed to load: ' + err.message);
    }
  };
  r.readAsText(file);
}

// ---------------------------------------------------------- params UI ----

function syncParamInputs() {
  document.querySelectorAll('[data-p]').forEach((el) => {
    el.value = state.params[el.dataset.p];
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

function flash(msg) {
  const el = document.getElementById('status-info');
  if (!el) return;
  el.dataset.flashing = '1';
  el.textContent = msg;
  clearTimeout(flash._t);
  flash._t = setTimeout(() => { delete el.dataset.flashing; updateStatus(); }, 2200);
}

function updateStatus() {
  const el = document.getElementById('status-info');
  if (!el || el.dataset.flashing) return;
  const counts = state.lines.map((l, i) => `L${i}:${l.twists.length}`).join(' ');
  const sel = state.selection
    ? `sel=${state.selection.kind}:${state.selection.id}`
    : 'no selection';
  el.textContent = `${state.lines.length} line${state.lines.length === 1 ? '' : 's'}  ${counts}  ·  ${sel}`;
}

function rerender() {
  renderEditor();
  buildScene();
  updateStatus();
}

document.getElementById('btn-add-line').addEventListener('click', () => {
  addLine();
  rerender();
});

document.getElementById('btn-add-twist').addEventListener('click', () => {
  let li = state.lines.length - 1;
  if (state.selection?.kind === 'twist') {
    li = indexTwists(state)[state.selection.id]?.lineIdx ?? li;
  } else if (state.selection?.kind === 'line') {
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

bindParams();
initCamera();
rerender();
resize3D();
tick();
