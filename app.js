"use strict";
/* cœurf — grid-snapped cubic bezier editor with planar surface detection.
   No build step: this file is loaded directly as a classic script. */

const SVGNS = "http://www.w3.org/2000/svg";

/* ---------------------------------------------------------------------- */
/* Geometry helpers                                                        */
/* ---------------------------------------------------------------------- */

function lerp(a, b, t) { return a + (b - a) * t; }

function cubicPoint(p0, c1, c2, p3, t) {
  const u = 1 - t;
  const x = u*u*u*p0.x + 3*u*u*t*c1.x + 3*u*t*t*c2.x + t*t*t*p3.x;
  const y = u*u*u*p0.y + 3*u*u*t*c1.y + 3*u*t*t*c2.y + t*t*t*p3.y;
  return { x, y };
}

function flattenCubic(p0, c1, c2, p3, segments) {
  const pts = [];
  for (let i = 0; i <= segments; i++) pts.push(cubicPoint(p0, c1, c2, p3, i / segments));
  return pts;
}

const FLATTEN_SEGMENTS = 20;

function departureAngle(from, primary, fallbackA, fallbackB) {
  let dx = primary.x - from.x, dy = primary.y - from.y;
  if (Math.hypot(dx, dy) < 1e-4) {
    dx = fallbackA.x - from.x; dy = fallbackA.y - from.y;
    if (Math.hypot(dx, dy) < 1e-4) {
      dx = fallbackB.x - from.x; dy = fallbackB.y - from.y;
    }
  }
  let a = Math.atan2(dy, dx);
  if (a < 0) a += 2 * Math.PI;
  return a;
}

function shoelaceArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    const intersect = ((yi > pt.y) !== (yj > pt.y)) &&
      (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInFace(pt, face) {
  if (!pointInPolygon(pt, face.outerFlat)) return false;
  for (const hole of face.holes) {
    if (pointInPolygon(pt, hole.flat)) return false;
  }
  return true;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx*dx + dy*dy;
  let t = lenSq > 1e-9 ? ((px - x1) * dx + (py - y1) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function distToPolyline(pt, poly) {
  let min = Infinity;
  for (let i = 0; i < poly.length - 1; i++) {
    const d = distToSegment(pt.x, pt.y, poly[i].x, poly[i].y, poly[i+1].x, poly[i+1].y);
    if (d < min) min = d;
  }
  return min;
}

function snapToGrid(x, y, res, w, h) {
  let sx = Math.round(x / res) * res;
  let sy = Math.round(y / res) * res;
  sx = Math.max(0, Math.min(w, sx));
  sy = Math.max(0, Math.min(h, sy));
  return { x: sx, y: sy };
}

function vkey(p) { return `${Math.round(p.x * 100)},${Math.round(p.y * 100)}`; }

/* ---------------------------------------------------------------------- */
/* Application state                                                       */
/* ---------------------------------------------------------------------- */

const state = {
  grid: { width: 800, height: 600, resolution: 20, borderColor: "#33363d", borderWidth: 2 },
  curves: [],        // {id, isBorder, p0,c1,c2,p3, width, color}
  faceStyles: {},     // signature -> {type:'solid', color} | {type:'gradient', color1, color2, angle}
  selection: null,    // {type:'curve', id} | {type:'face', signature}
  tool: "select",
  curveIdCounter: 1,
};

let facesCache = [];  // last computed faces, for click hit-testing & inheritance
let drawPending = null; // {x,y} snapped anchor while placing a new curve
let dragCtx = null;    // active drag context

const history = [];
let historyIndex = -1;

function cloneState() {
  return JSON.parse(JSON.stringify({
    grid: state.grid,
    curves: state.curves,
    faceStyles: state.faceStyles,
    curveIdCounter: state.curveIdCounter,
  }));
}

function pushHistory() {
  history.length = historyIndex + 1;
  history.push(cloneState());
  historyIndex = history.length - 1;
  updateUndoRedoButtons();
}

function restoreFromSnapshot(snap) {
  state.grid = JSON.parse(JSON.stringify(snap.grid));
  state.curves = JSON.parse(JSON.stringify(snap.curves));
  state.faceStyles = JSON.parse(JSON.stringify(snap.faceStyles));
  state.curveIdCounter = snap.curveIdCounter;
  state.selection = null;
  syncGridInputs();
  recomputeFaces();
  render();
}

function undo() {
  if (historyIndex <= 0) return;
  historyIndex--;
  restoreFromSnapshot(history[historyIndex]);
  updateUndoRedoButtons();
}
function redo() {
  if (historyIndex >= history.length - 1) return;
  historyIndex++;
  restoreFromSnapshot(history[historyIndex]);
  updateUndoRedoButtons();
}
function updateUndoRedoButtons() {
  document.getElementById("undo-btn").disabled = historyIndex <= 0;
  document.getElementById("redo-btn").disabled = historyIndex >= history.length - 1;
}

/* ---------------------------------------------------------------------- */
/* Save / load (localStorage for now)                                      */
/* ---------------------------------------------------------------------- */

const STORAGE_KEY = "coeurf:design:v1";

function saveToLocalStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cloneState()));
    showHint("Design saved.");
  } catch (e) {
    showHint("Could not save: " + e.message);
  }
}

function loadFromLocalStorage() {
  let raw;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { raw = null; }
  if (!raw) { showHint("No saved design found."); return; }
  let snap;
  try { snap = JSON.parse(raw); } catch (e) { snap = null; }
  if (!snap || !snap.grid || !Array.isArray(snap.curves) || typeof snap.faceStyles !== "object") {
    showHint("Saved data is corrupted and could not be loaded.");
    return;
  }
  restoreFromSnapshot(snap);
  pushHistory();
  showHint("Design loaded.");
}

/* ---------------------------------------------------------------------- */
/* Border management                                                       */
/* ---------------------------------------------------------------------- */

// The border is not stored: it is re-derived from the canvas rectangle plus
// wherever any user curve endpoint touches that rectangle's edge. This lets a
// curve ending on the border actually graph-connect to it (splitting the page)
// instead of merely sitting visually on top of an unrelated fixed border curve.
function computeBorderSegments() {
  const { width: W, height: H, borderColor, borderWidth } = state.grid;
  const EPS = 1e-6;
  const sides = { top: [], right: [], bottom: [], left: [] };
  const pushUnique = (arr, p) => {
    if (!arr.some(q => Math.abs(q.x - p.x) < EPS && Math.abs(q.y - p.y) < EPS)) arr.push({ x: p.x, y: p.y });
  };
  const addPoint = p => {
    if (Math.abs(p.y) < EPS) pushUnique(sides.top, p);
    if (Math.abs(p.y - H) < EPS) pushUnique(sides.bottom, p);
    if (Math.abs(p.x) < EPS) pushUnique(sides.left, p);
    if (Math.abs(p.x - W) < EPS) pushUnique(sides.right, p);
  };
  addPoint({ x: 0, y: 0 }); addPoint({ x: W, y: 0 }); addPoint({ x: W, y: H }); addPoint({ x: 0, y: H });
  for (const c of state.curves) { addPoint(c.p0); addPoint(c.p3); }

  sides.top.sort((a, b) => a.x - b.x);
  sides.right.sort((a, b) => a.y - b.y);
  sides.bottom.sort((a, b) => b.x - a.x);
  sides.left.sort((a, b) => b.y - a.y);

  const mkSeg = (p0, p3) => ({
    id: `border:${fmt(p0.x)},${fmt(p0.y)}-${fmt(p3.x)},${fmt(p3.y)}`,
    isBorder: true, p0,
    c1: { x: lerp(p0.x, p3.x, 1/3), y: lerp(p0.y, p3.y, 1/3) },
    c2: { x: lerp(p0.x, p3.x, 2/3), y: lerp(p0.y, p3.y, 2/3) },
    p3, width: borderWidth, color: borderColor,
  });
  const segs = [];
  const emit = pts => { for (let i = 0; i < pts.length - 1; i++) segs.push(mkSeg(pts[i], pts[i + 1])); };
  emit(sides.top); emit(sides.right); emit(sides.bottom); emit(sides.left);
  return segs;
}

/* ---------------------------------------------------------------------- */
/* Planar face detection                                                   */
/* ---------------------------------------------------------------------- */

class UnionFind {
  constructor() { this.parent = new Map(); }
  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    while (this.parent.get(x) !== root) { const next = this.parent.get(x); this.parent.set(x, root); x = next; }
    return root;
  }
  union(a, b) {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

function buildFaces(curves) {
  const outgoing = new Map(); // vkey -> halfedge[]
  const halfEdges = [];
  const uf = new UnionFind();
  const curvesById = {};

  for (const c of curves) {
    curvesById[c.id] = c;
    const kf = vkey(c.p0), kt = vkey(c.p3);
    uf.union(kf, kt);

    const flatF = flattenCubic(c.p0, c.c1, c.c2, c.p3, FLATTEN_SEGMENTS);
    const flatB = flatF.slice().reverse();
    const angF = departureAngle(c.p0, c.c1, c.c2, c.p3);
    const angB = departureAngle(c.p3, c.c2, c.c1, c.p0);

    const heF = { curveId: c.id, dir: "f", from: c.p0, to: c.p3, angle: angF, flat: flatF };
    const heB = { curveId: c.id, dir: "b", from: c.p3, to: c.p0, angle: angB, flat: flatB };
    heF.twin = heB; heB.twin = heF;
    halfEdges.push(heF, heB);

    if (!outgoing.has(kf)) outgoing.set(kf, []);
    outgoing.get(kf).push(heF);
    if (!outgoing.has(kt)) outgoing.set(kt, []);
    outgoing.get(kt).push(heB);
  }

  for (const list of outgoing.values()) list.sort((a, b) => a.angle - b.angle);

  for (const he of halfEdges) {
    const list = outgoing.get(vkey(he.to));
    const idx = list.indexOf(he.twin);
    const prevIdx = (idx - 1 + list.length) % list.length;
    he.next = list[prevIdx];
  }

  const visited = new Set();
  const cycles = [];
  for (const he of halfEdges) {
    if (visited.has(he)) continue;
    const cycle = [];
    let cur = he;
    let guard = 0;
    do {
      visited.add(cur);
      cycle.push(cur);
      cur = cur.next;
      guard++;
    } while (cur !== he && guard < halfEdges.length + 5);
    cycles.push(cycle);
  }

  // group by connected component
  const byComponent = new Map();
  for (const cycle of cycles) {
    const comp = uf.find(vkey(cycle[0].from));
    if (!byComponent.has(comp)) byComponent.set(comp, []);
    byComponent.get(comp).push(cycle);
  }

  const boundedFaces = [];
  const silhouettes = []; // one unbounded trace per component

  for (const [comp, compCycles] of byComponent) {
    let unbounded = null, unboundedArea = 0;
    const bounded = [];
    for (const cycle of compCycles) {
      const flat = [];
      for (const he of cycle) {
        for (let i = 0; i < he.flat.length - 1; i++) flat.push(he.flat[i]);
      }
      const area = shoelaceArea(flat);
      if (area > 1e-6) {
        bounded.push({ cycle, flat, area, curveIds: new Set(cycle.map(h => h.curveId)), component: comp });
      } else if (unbounded === null || Math.abs(area) > Math.abs(unboundedArea)) {
        if (unbounded !== null) bounded.push(unbounded); // shouldn't normally happen, keep as bounded fallback
        unbounded = { cycle, flat, area, curveIds: new Set(cycle.map(h => h.curveId)), component: comp };
        unboundedArea = area;
      }
    }
    boundedFaces.push(...bounded);
    if (unbounded) silhouettes.push({ ...unbounded, component: comp });
  }

  // assign holes: each silhouette nests inside the smallest bounded face (from a DIFFERENT
  // component) that contains it. A face can never be its own silhouette's container: the
  // silhouette's own vertices sit exactly on that face's boundary, which point-in-polygon
  // can misjudge as "inside" for degenerate/vertex-touching rays.
  for (const face of boundedFaces) face.holes = [];
  for (const sil of silhouettes) {
    const testPt = sil.flat[0];
    let best = null, bestArea = Infinity;
    for (const face of boundedFaces) {
      if (face.component === sil.component) continue;
      if (pointInPolygon(testPt, face.flat) && face.area < bestArea) {
        best = face; bestArea = face.area;
      }
    }
    if (best) {
      best.holes.push(sil);
      for (const id of sil.curveIds) best.curveIds.add(id);
    }
  }

  const faces = boundedFaces.map(f => {
    const ids = Array.from(f.curveIds).sort();
    return {
      signature: ids.join(","),
      cycle: f.cycle,
      outerFlat: f.flat,
      holes: f.holes.map(h => ({ cycle: h.cycle, flat: h.flat })),
      area: f.area,
    };
  });

  return { faces, curvesById };
}

function cubicPathFromCycle(cycle, curvesById) {
  let d = `M ${fmt(cycle[0].from.x)} ${fmt(cycle[0].from.y)}`;
  for (const he of cycle) {
    const c = curvesById[he.curveId];
    if (he.dir === "f") {
      d += ` C ${fmt(c.c1.x)} ${fmt(c.c1.y)}, ${fmt(c.c2.x)} ${fmt(c.c2.y)}, ${fmt(c.p3.x)} ${fmt(c.p3.y)}`;
    } else {
      d += ` C ${fmt(c.c2.x)} ${fmt(c.c2.y)}, ${fmt(c.c1.x)} ${fmt(c.c1.y)}, ${fmt(c.p0.x)} ${fmt(c.p0.y)}`;
    }
  }
  d += " Z";
  return d;
}

function fmt(n) { return Math.round(n * 100) / 100; }

function recomputeFaces() {
  const prevFaces = facesCache;
  const { faces, curvesById } = buildFaces(state.curves.concat(computeBorderSegments()));

  for (const face of faces) {
    if (state.faceStyles[face.signature]) continue;
    // topology changed here: find which previous face contained this new one, inherit its style
    const sample = interiorSamplePoint(face);
    let inherited = null;
    for (const pf of prevFaces) {
      if (pointInFace(sample, pf)) { inherited = state.faceStyles[pf.signature]; break; }
    }
    state.faceStyles[face.signature] = inherited
      ? JSON.parse(JSON.stringify(inherited))
      : { type: "solid", color: "#e9edf5" };
  }

  // prune unused signatures
  const live = new Set(faces.map(f => f.signature));
  for (const sig of Object.keys(state.faceStyles)) {
    if (!live.has(sig)) delete state.faceStyles[sig];
  }

  faces.curvesById = curvesById;
  facesCache = faces;
  facesCache.curvesById = curvesById;
}

function interiorSamplePoint(face) {
  // average of outer contour points, nudged toward an edge midpoint if it lands in a hole
  let sx = 0, sy = 0;
  for (const p of face.outerFlat) { sx += p.x; sy += p.y; }
  let pt = { x: sx / face.outerFlat.length, y: sy / face.outerFlat.length };
  if (pointInFace(pt, face)) return pt;
  // fallback: try midpoints between centroid and each outer vertex
  for (const p of face.outerFlat) {
    const mid = { x: (pt.x + p.x) / 2, y: (pt.y + p.y) / 2 };
    if (pointInFace(mid, face)) return mid;
  }
  return face.outerFlat[0];
}

/* ---------------------------------------------------------------------- */
/* Rendering                                                               */
/* ---------------------------------------------------------------------- */

const svg = document.getElementById("stage");
let gridLayer, facesLayer, curvesLayer, selectionLayer, handlesLayer, defsLayer;

// Stacking order matters: fills, then curve strokes, then the grid (on top so
// toggling it is actually visible over any fill/curve instead of being buried
// under the opaque face fills), then the selection highlight (always above
// the curves that bound a face, so it can't be hidden underneath them), then
// the draggable handles on top of everything.
function ensureLayers() {
  svg.innerHTML = "";
  defsLayer = document.createElementNS(SVGNS, "defs");
  facesLayer = document.createElementNS(SVGNS, "g");
  facesLayer.setAttribute("id", "layer-faces");
  curvesLayer = document.createElementNS(SVGNS, "g");
  curvesLayer.setAttribute("id", "layer-curves");
  gridLayer = document.createElementNS(SVGNS, "g");
  gridLayer.setAttribute("id", "layer-grid");
  gridLayer.style.pointerEvents = "none";
  selectionLayer = document.createElementNS(SVGNS, "g");
  selectionLayer.setAttribute("id", "layer-selection");
  selectionLayer.style.pointerEvents = "none";
  handlesLayer = document.createElementNS(SVGNS, "g");
  handlesLayer.setAttribute("id", "layer-handles");
  svg.appendChild(defsLayer);
  svg.appendChild(facesLayer);
  svg.appendChild(curvesLayer);
  svg.appendChild(gridLayer);
  svg.appendChild(selectionLayer);
  svg.appendChild(handlesLayer);
}

function gradientId(sig) {
  return "grad-" + sig.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 80) + "-" + hashStr(sig);
}
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }

function gradientVector(angleDeg) {
  const rad = (angleDeg % 360) * Math.PI / 180;
  const dx = Math.cos(rad), dy = Math.sin(rad);
  return { x1: 0.5 - dx * 0.5, y1: 0.5 - dy * 0.5, x2: 0.5 + dx * 0.5, y2: 0.5 + dy * 0.5 };
}

function buildDefsAndFaceMarkup(faces, curvesById) {
  let defs = "";
  let body = "";
  for (const face of faces) {
    const style = state.faceStyles[face.signature] || { type: "solid", color: "#e9edf5" };
    const d = cubicPathFromCycle(face.cycle, curvesById) + " " +
      face.holes.map(h => cubicPathFromCycle(h.cycle, curvesById)).join(" ");
    let fillAttr;
    if (style.type === "gradient") {
      const gid = gradientId(face.signature);
      const v = gradientVector(style.angle || 0);
      defs += `<linearGradient id="${gid}" x1="${v.x1}" y1="${v.y1}" x2="${v.x2}" y2="${v.y2}">` +
        `<stop offset="0%" stop-color="${style.color1}"/>` +
        `<stop offset="100%" stop-color="${style.color2}"/>` +
        `</linearGradient>`;
      fillAttr = `url(#${gid})`;
    } else {
      fillAttr = style.color;
    }
    body += `<path d="${d}" fill="${fillAttr}" fill-rule="evenodd" data-signature="${escapeAttr(face.signature)}"></path>`;
  }
  return { defs, body };
}

function escapeAttr(s) { return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;"); }

function curvesMarkup(curves) {
  let body = "";
  for (const c of curves) {
    const selected = state.selection && state.selection.type === "curve" && state.selection.id === c.id;
    const d = `M ${fmt(c.p0.x)} ${fmt(c.p0.y)} C ${fmt(c.c1.x)} ${fmt(c.c1.y)}, ${fmt(c.c2.x)} ${fmt(c.c2.y)}, ${fmt(c.p3.x)} ${fmt(c.p3.y)}`;
    const strokeColor = selected ? "#5b8cff" : c.color;
    body += `<path d="${d}" fill="none" stroke="${strokeColor}" stroke-width="${c.width}" stroke-linecap="round" data-curve-id="${escapeAttr(c.id)}"></path>`;
  }
  return body;
}

// Selected-face highlight: drawn in its own layer above the curve strokes so
// it can never be hidden underneath the very curves that bound the face. No
// flat fill/stroke color can be relied on to contrast an arbitrary
// user-chosen fill, so this doesn't try to pick one: classic two-tone
// marching ants, black and white dashes alternating and animated together.
// (An earlier version used a single white stroke with
// mix-blend-mode:difference to invert whatever's underneath, same trick
// renderGrid uses below - but the grid layer *also* difference-blends white
// over the canvas, and invert(invert(x)) === x, so wherever this editor's
// grid-snapped curves sit on a grid line - i.e. almost always - the two
// inversions exactly cancelled and the ants vanished. Two fixed, non-blended
// colors sidesteps that.)
function selectionOverlayMarkup(curvesById) {
  if (!state.selection || state.selection.type !== "face") return "";
  const face = facesCache.find(f => f.signature === state.selection.signature);
  if (!face) return "";
  const d = cubicPathFromCycle(face.cycle, curvesById) + " " +
    face.holes.map(h => cubicPathFromCycle(h.cycle, curvesById)).join(" ");
  const s = currentScale();
  const dash = 8 / s, w = 2 / s;
  return `<path d="${d}" fill="none" stroke="#000000" stroke-width="${w}" stroke-dasharray="${dash},${dash}">` +
    `<animate attributeName="stroke-dashoffset" from="${dash * 2}" to="0" dur="0.5s" repeatCount="indefinite"/>` +
    `</path>` +
    `<path d="${d}" fill="none" stroke="#ffffff" stroke-width="${w}" stroke-dasharray="${dash},${dash}" stroke-dashoffset="${dash}">` +
    `<animate attributeName="stroke-dashoffset" from="${dash * 3}" to="${dash}" dur="0.5s" repeatCount="indefinite"/>` +
    `</path>`;
}

function currentScale() {
  const rect = svg.getBoundingClientRect();
  if (!rect.width) return 1;
  return rect.width / state.grid.width;
}

function renderGrid() {
  const { width: W, height: H, resolution: res } = state.grid;
  const show = document.getElementById("toggle-grid").checked;
  if (!show) { gridLayer.innerHTML = ""; return; }
  const patId = "gridpat";
  const lw = 1 / currentScale();
  // White stroke + mix-blend-mode:difference inverts whatever is underneath,
  // so the grid stays visible over any fill/gradient/curve color instead of
  // needing a fixed color that only works on a light background.
  gridLayer.innerHTML =
    `<defs><pattern id="${patId}" width="${res}" height="${res}" patternUnits="userSpaceOnUse">` +
    `<path d="M ${res} 0 L 0 0 0 ${res}" fill="none" stroke="#ffffff" stroke-width="${lw}"/>` +
    `</pattern></defs>` +
    `<rect x="0" y="0" width="${W}" height="${H}" fill="url(#${patId})" style="mix-blend-mode:difference"></rect>`;
}

function renderHandles() {
  handlesLayer.innerHTML = "";
  if (!state.selection || state.selection.type !== "curve") return;
  const c = state.curves.find(cv => cv.id === state.selection.id);
  if (!c) return;
  const s = currentScale();
  const rA = 6 / s, rC = 5 / s, lw = 1.4 / s;
  let html = "";
  html += `<line x1="${c.p0.x}" y1="${c.p0.y}" x2="${c.c1.x}" y2="${c.c1.y}" stroke="#5b8cff" stroke-width="${lw}" stroke-dasharray="${3/s},${3/s}"></line>`;
  html += `<line x1="${c.p3.x}" y1="${c.p3.y}" x2="${c.c2.x}" y2="${c.c2.y}" stroke="#5b8cff" stroke-width="${lw}" stroke-dasharray="${3/s},${3/s}"></line>`;
  const mk = (p, r, fill, key) => `<circle class="handle" cx="${p.x}" cy="${p.y}" r="${r}" fill="${fill}" stroke="#1b1d22" stroke-width="${1/s}" data-handle="${key}"></circle>`;
  html += mk(c.c1, rC, "#ffb020", "c1");
  html += mk(c.c2, rC, "#ffb020", "c2");
  html += mk(c.p0, rA, "#5b8cff", "p0");
  html += mk(c.p3, rA, "#5b8cff", "p3");
  handlesLayer.innerHTML = html;
}

function render() {
  const { width: W, height: H } = state.grid;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", W);
  svg.setAttribute("height", H);

  if (!gridLayer) ensureLayers();
  renderGrid();

  const { defs, body } = buildDefsAndFaceMarkup(facesCache, facesCache.curvesById || {});
  defsLayer.innerHTML = defs;
  facesLayer.innerHTML = body;

  curvesLayer.innerHTML = curvesMarkup(state.curves) + curvesMarkup(computeBorderSegments());
  selectionLayer.innerHTML = selectionOverlayMarkup(facesCache.curvesById || {});

  renderHandles();
  renderPanel();
}

/* ---------------------------------------------------------------------- */
/* Panel                                                                    */
/* ---------------------------------------------------------------------- */

const panel = document.getElementById("panel");

function renderPanel() {
  if (!state.selection) {
    panel.innerHTML = `<div class="panel-empty">Nothing selected.<br>Draw a curve, or click inside a region to select the surface.</div>`;
    return;
  }
  if (state.selection.type === "curve") {
    renderCurvePanel();
  } else {
    renderFacePanel();
  }
}

function renderCurvePanel() {
  const c = state.curves.find(cv => cv.id === state.selection.id);
  if (!c) { state.selection = null; renderPanel(); return; }
  panel.innerHTML = `
    <div class="panel-section">
      <h3>Curve</h3>
      <div class="field-row">
        <label>Color</label>
        <input type="color" id="f-color" value="${c.color}">
      </div>
      <div class="field-row">
        <label>Width</label>
        <input type="range" id="f-width" min="0.5" max="30" step="0.5" value="${c.width}">
        <span class="num-out">${c.width}px</span>
      </div>
      <div class="coord-grid">
        <div class="coord-label">Start (P0)</div>
        <input type="number" id="f-p0x" value="${fmt(c.p0.x)}">
        <input type="number" id="f-p0y" value="${fmt(c.p0.y)}">
        <div class="coord-label">Control 1</div>
        <input type="number" id="f-c1x" value="${fmt(c.c1.x)}">
        <input type="number" id="f-c1y" value="${fmt(c.c1.y)}">
        <div class="coord-label">Control 2</div>
        <input type="number" id="f-c2x" value="${fmt(c.c2.x)}">
        <input type="number" id="f-c2y" value="${fmt(c.c2.y)}">
        <div class="coord-label">End (P3)</div>
        <input type="number" id="f-p3x" value="${fmt(c.p3.x)}">
        <input type="number" id="f-p3y" value="${fmt(c.p3.y)}">
      </div>
      <button class="danger-btn" id="f-delete">Delete curve</button>
    </div>
  `;
  document.getElementById("f-color").addEventListener("input", e => {
    c.color = e.target.value; render();
  });
  document.getElementById("f-color").addEventListener("change", () => pushHistory());
  const widthInput = document.getElementById("f-width");
  widthInput.addEventListener("input", e => {
    c.width = parseFloat(e.target.value);
    widthInput.nextElementSibling.textContent = c.width + "px";
    render();
  });
  widthInput.addEventListener("change", () => pushHistory());

  const coordMap = [["f-p0x","p0","x"],["f-p0y","p0","y"],["f-c1x","c1","x"],["f-c1y","c1","y"],
    ["f-c2x","c2","x"],["f-c2y","c2","y"],["f-p3x","p3","x"],["f-p3y","p3","y"]];
  for (const [id, pt, axis] of coordMap) {
    document.getElementById(id).addEventListener("change", e => {
      const res = state.grid.resolution;
      let v = parseFloat(e.target.value);
      if (isNaN(v)) v = c[pt][axis];
      v = Math.round(v / res) * res;
      const bound = axis === "x" ? state.grid.width : state.grid.height;
      v = Math.max(0, Math.min(bound, v));
      c[pt][axis] = v;
      recomputeFaces();
      render();
      pushHistory();
    });
  }

  document.getElementById("f-delete").addEventListener("click", () => {
    state.curves = state.curves.filter(cv => cv.id !== c.id);
    state.selection = null;
    recomputeFaces();
    render();
    pushHistory();
  });
}

function renderFacePanel() {
  const face = facesCache.find(f => f.signature === state.selection.signature);
  if (!face) { state.selection = null; renderPanel(); return; }
  const style = state.faceStyles[face.signature] || { type: "solid", color: "#e9edf5" };
  const isGrad = style.type === "gradient";
  panel.innerHTML = `
    <div class="panel-section">
      <h3>Surface</h3>
      <div class="seg">
        <button id="f-solid" class="${!isGrad ? "active" : ""}">Solid</button>
        <button id="f-grad" class="${isGrad ? "active" : ""}">Gradient</button>
      </div>
      <div id="fill-fields"></div>
    </div>
  `;
  const fields = document.getElementById("fill-fields");

  function paintSolid() {
    const s = state.faceStyles[face.signature];
    fields.innerHTML = `
      <div class="field-row">
        <label>Color</label>
        <input type="color" id="f-scolor" value="${s.color}">
      </div>
    `;
    document.getElementById("f-scolor").addEventListener("input", e => {
      s.color = e.target.value; render();
    });
    document.getElementById("f-scolor").addEventListener("change", () => pushHistory());
  }

  function paintGradient() {
    const s = state.faceStyles[face.signature];
    fields.innerHTML = `
      <div class="gradient-preview" id="f-gpreview"></div>
      <div class="field-row">
        <label>Start</label>
        <input type="color" id="f-g1" value="${s.color1}">
      </div>
      <div class="field-row">
        <label>End</label>
        <input type="color" id="f-g2" value="${s.color2}">
      </div>
      <div class="field-row">
        <label>Angle</label>
        <input type="range" id="f-gangle" min="0" max="359" step="1" value="${s.angle}">
        <span class="num-out">${s.angle}&deg;</span>
      </div>
    `;
    const updatePreview = () => {
      const el = document.getElementById("f-gpreview");
      el.style.background = `linear-gradient(${s.angle}deg, ${s.color1}, ${s.color2})`;
    };
    updatePreview();
    document.getElementById("f-g1").addEventListener("input", e => { s.color1 = e.target.value; updatePreview(); render(); });
    document.getElementById("f-g1").addEventListener("change", () => pushHistory());
    document.getElementById("f-g2").addEventListener("input", e => { s.color2 = e.target.value; updatePreview(); render(); });
    document.getElementById("f-g2").addEventListener("change", () => pushHistory());
    const angleInput = document.getElementById("f-gangle");
    angleInput.addEventListener("input", e => {
      s.angle = parseInt(e.target.value, 10);
      angleInput.nextElementSibling.innerHTML = s.angle + "&deg;";
      updatePreview(); render();
    });
    angleInput.addEventListener("change", () => pushHistory());
  }

  if (isGrad) paintGradient(); else paintSolid();

  document.getElementById("f-solid").addEventListener("click", () => {
    if (state.faceStyles[face.signature].type === "solid") return;
    state.faceStyles[face.signature] = { type: "solid", color: "#e9edf5" };
    renderFacePanel(); render(); pushHistory();
  });
  document.getElementById("f-grad").addEventListener("click", () => {
    if (state.faceStyles[face.signature].type === "gradient") return;
    const cur = state.faceStyles[face.signature];
    state.faceStyles[face.signature] = { type: "gradient", color1: cur.color || "#e9edf5", color2: "#5b8cff", angle: 90 };
    renderFacePanel(); render(); pushHistory();
  });
}

/* ---------------------------------------------------------------------- */
/* Interaction                                                             */
/* ---------------------------------------------------------------------- */

function toSvgPoint(evt) {
  const pt = svg.createSVGPoint();
  pt.x = evt.clientX; pt.y = evt.clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const loc = pt.matrixTransform(ctm.inverse());
  return { x: loc.x, y: loc.y };
}

function findNearVertex(pt, tolerance) {
  let best = null, bestD = tolerance;
  const { width: W, height: H } = state.grid;
  const candidates = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
  for (const c of state.curves) { candidates.push(c.p0, c.p3); }
  for (const p of candidates) {
    const d = Math.hypot(p.x - pt.x, p.y - pt.y);
    if (d < bestD) { bestD = d; best = { x: p.x, y: p.y }; }
  }
  return best;
}

function snapForDrawing(evt) {
  const raw = toSvgPoint(evt);
  const tol = 10 / currentScale();
  const near = findNearVertex(raw, tol);
  if (near) return near;
  return snapToGrid(raw.x, raw.y, state.grid.resolution, state.grid.width, state.grid.height);
}

function hitTestCurve(pt) {
  const tol = 7 / currentScale();
  let best = null, bestD = tol;
  for (const c of state.curves) {
    if (c.isBorder) continue;
    const flat = flattenCubic(c.p0, c.c1, c.c2, c.p3, FLATTEN_SEGMENTS);
    const d = distToPolyline(pt, flat);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

function hitTestFace(pt) {
  for (const f of facesCache) {
    if (pointInFace(pt, f)) return f;
  }
  return null;
}

function hitTestHandle(evt) {
  if (!state.selection || state.selection.type !== "curve") return null;
  const c = state.curves.find(cv => cv.id === state.selection.id);
  if (!c) return null;
  const pt = toSvgPoint(evt);
  const tol = 9 / currentScale();
  const candidates = [["p0", c.p0], ["c1", c.c1], ["c2", c.c2], ["p3", c.p3]];
  let best = null, bestD = tol;
  for (const [key, p] of candidates) {
    const d = Math.hypot(p.x - pt.x, p.y - pt.y);
    if (d < bestD) { bestD = d; best = key; }
  }
  return best ? { curve: c, key: best } : null;
}

function setSelection(sel) {
  state.selection = sel;
  render();
}

function showHint(text, persistent) {
  const el = document.getElementById("hint");
  el.textContent = text;
  el.classList.add("visible");
  if (!persistent) {
    clearTimeout(showHint._t);
    showHint._t = setTimeout(() => el.classList.remove("visible"), 2600);
  }
}
function hideHint() { document.getElementById("hint").classList.remove("visible"); }

function defaultCurveBetween(p0, p3, res) {
  if (Math.abs(p0.x - p3.x) < 1e-6 && Math.abs(p0.y - p3.y) < 1e-6) {
    // self-loop: bulge out to form a visible teardrop, flipping toward whichever
    // side keeps it on-canvas so it doesn't default off the visible edge.
    const bulge = res * 3;
    const { width: W, height: H } = state.grid;
    const dir = p0.x + bulge <= W ? 1 : -1;
    return {
      c1: { x: p0.x + dir * bulge, y: Math.max(0, p0.y - bulge / 2) },
      c2: { x: p0.x + dir * bulge, y: Math.min(H, p0.y + bulge / 2) },
    };
  }
  return {
    c1: { x: lerp(p0.x, p3.x, 1/3), y: lerp(p0.y, p3.y, 1/3) },
    c2: { x: lerp(p0.x, p3.x, 2/3), y: lerp(p0.y, p3.y, 2/3) },
  };
}

function onStageMouseDown(evt) {
  if (evt.button !== 0) return;

  if (state.tool === "draw") {
    const p = snapForDrawing(evt);
    if (!drawPending) {
      drawPending = p;
      showHint("Click another grid point to finish the curve. Esc to cancel.", true);
    } else {
      const { c1, c2 } = defaultCurveBetween(drawPending, p, state.grid.resolution);
      const id = "c" + (state.curveIdCounter++);
      const curve = { id, isBorder: false, p0: { ...drawPending }, c1, c2, p3: { ...p }, width: 3, color: "#2a2d34" };
      state.curves.push(curve);
      drawPending = null;
      hideHint();
      setTool("select");
      recomputeFaces();
      setSelection({ type: "curve", id });
      pushHistory();
    }
    return;
  }

  // select tool
  const handleHit = hitTestHandle(evt);
  if (handleHit) {
    dragCtx = { kind: "handle", curve: handleHit.curve, key: handleHit.key };
    window.addEventListener("mousemove", onWindowMouseMove);
    window.addEventListener("mouseup", onWindowMouseUp);
    return;
  }

  const pt = toSvgPoint(evt);
  const curveHit = hitTestCurve(pt);
  if (curveHit) {
    setSelection({ type: "curve", id: curveHit.id });
    return;
  }
  const faceHit = hitTestFace(pt);
  if (faceHit) {
    setSelection({ type: "face", signature: faceHit.signature });
    return;
  }
  setSelection(null);
}

function onWindowMouseMove(evt) {
  if (!dragCtx) return;
  const raw = toSvgPoint(evt);
  const tol = 10 / currentScale();
  const near = findNearVertex(raw, tol);
  const p = near || snapToGrid(raw.x, raw.y, state.grid.resolution, state.grid.width, state.grid.height);
  dragCtx.curve[dragCtx.key] = p;
  renderHandles();
  curvesLayer.innerHTML = curvesMarkup(state.curves) + curvesMarkup(computeBorderSegments());
}

function onWindowMouseUp() {
  if (!dragCtx) return;
  dragCtx = null;
  window.removeEventListener("mousemove", onWindowMouseMove);
  window.removeEventListener("mouseup", onWindowMouseUp);
  recomputeFaces();
  render();
  pushHistory();
}

function onStageMouseMove(evt) {
  if (state.tool !== "draw" || !drawPending) return;
  const p = snapForDrawing(evt);
  const { c1, c2 } = defaultCurveBetween(drawPending, p, state.grid.resolution);
  const preview = `M ${drawPending.x} ${drawPending.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p.x} ${p.y}`;
  handlesLayer.innerHTML =
    `<circle cx="${drawPending.x}" cy="${drawPending.y}" r="${5/currentScale()}" fill="#5b8cff"></circle>` +
    `<path d="${preview}" fill="none" stroke="#5b8cff" stroke-width="${1.5/currentScale()}" stroke-dasharray="${4/currentScale()},${3/currentScale()}"></path>` +
    `<circle cx="${p.x}" cy="${p.y}" r="${4/currentScale()}" fill="#5b8cff" opacity="0.6"></circle>`;
}

function setTool(tool) {
  state.tool = tool;
  drawPending = null;
  hideHint();
  document.getElementById("tool-select").classList.toggle("active", tool === "select");
  document.getElementById("tool-draw").classList.toggle("active", tool === "draw");
  svg.style.cursor = tool === "draw" ? "crosshair" : "default";
  if (tool === "draw") showHint("Click a grid point to start a curve.", true);
  else hideHint();
  renderHandles();
}

document.getElementById("tool-select").addEventListener("click", () => setTool("select"));
document.getElementById("tool-draw").addEventListener("click", () => setTool("draw"));

document.addEventListener("keydown", evt => {
  if (evt.key === "Escape") {
    if (drawPending) { drawPending = null; hideHint(); renderHandles(); }
    else setTool("select");
  } else if ((evt.key === "Delete" || evt.key === "Backspace") && state.selection && state.selection.type === "curve") {
    if (document.activeElement && ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
    const id = state.selection.id;
    state.curves = state.curves.filter(cv => cv.id !== id);
    state.selection = null;
    recomputeFaces(); render(); pushHistory();
  } else if (evt.key.toLowerCase() === "v" && !evt.ctrlKey && !evt.metaKey && !isTyping(evt)) {
    setTool("select");
  } else if (evt.key.toLowerCase() === "c" && !evt.ctrlKey && !evt.metaKey && !isTyping(evt)) {
    setTool("draw");
  } else if ((evt.ctrlKey || evt.metaKey) && evt.key.toLowerCase() === "z") {
    evt.preventDefault();
    if (evt.shiftKey) redo(); else undo();
  } else if ((evt.ctrlKey || evt.metaKey) && evt.key.toLowerCase() === "y") {
    evt.preventDefault();
    redo();
  } else if ((evt.ctrlKey || evt.metaKey) && evt.key.toLowerCase() === "s") {
    evt.preventDefault();
    saveToLocalStorage();
  } else if ((evt.ctrlKey || evt.metaKey) && evt.key.toLowerCase() === "o") {
    evt.preventDefault();
    loadFromLocalStorage();
  }
});
function isTyping(evt) {
  return document.activeElement && ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName);
}

svg.addEventListener("mousedown", onStageMouseDown);
svg.addEventListener("mousemove", onStageMouseMove);

/* ---------------------------------------------------------------------- */
/* Grid settings                                                           */
/* ---------------------------------------------------------------------- */

function syncGridInputs() {
  document.getElementById("grid-width").value = state.grid.width;
  document.getElementById("grid-height").value = state.grid.height;
  document.getElementById("grid-res").value = state.grid.resolution;
  document.getElementById("border-color").value = state.grid.borderColor;
  document.getElementById("border-width").value = state.grid.borderWidth;
}

document.getElementById("apply-grid").addEventListener("click", () => {
  const w = Math.max(20, parseInt(document.getElementById("grid-width").value, 10) || state.grid.width);
  const h = Math.max(20, parseInt(document.getElementById("grid-height").value, 10) || state.grid.height);
  const res = Math.max(2, parseInt(document.getElementById("grid-res").value, 10) || state.grid.resolution);
  state.grid.width = w;
  state.grid.height = h;
  state.grid.resolution = res;
  state.grid.borderColor = document.getElementById("border-color").value;
  state.grid.borderWidth = parseFloat(document.getElementById("border-width").value) || 0;
  recomputeFaces();
  render();
  pushHistory();
});

document.getElementById("toggle-grid").addEventListener("change", render);
document.getElementById("undo-btn").addEventListener("click", undo);
document.getElementById("redo-btn").addEventListener("click", redo);
document.getElementById("save-btn").addEventListener("click", saveToLocalStorage);
document.getElementById("load-btn").addEventListener("click", loadFromLocalStorage);

/* ---------------------------------------------------------------------- */
/* Export                                                                   */
/* ---------------------------------------------------------------------- */

function buildExportSVG() {
  const { width: W, height: H } = state.grid;
  const { defs, body } = buildDefsAndFaceMarkup(facesCache, facesCache.curvesById || {});
  const curves = curvesMarkup(state.curves) + curvesMarkup(computeBorderSegments());
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="${SVGNS}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n` +
    `<defs>${defs}</defs>\n` +
    `<g id="surfaces">${body}</g>\n` +
    `<g id="curves">${curves}</g>\n` +
    `</svg>\n`;
}

document.getElementById("export-btn").addEventListener("click", () => {
  const svgStr = buildExportSVG();
  const blob = new Blob([svgStr], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "coeurf-export.svg";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

/* ---------------------------------------------------------------------- */
/* Init                                                                     */
/* ---------------------------------------------------------------------- */

function init() {
  ensureLayers();
  recomputeFaces();
  syncGridInputs();
  render();
  pushHistory();
  setTool("select");
  window.addEventListener("resize", render);
}

// Debug hook (harmless in normal use): lets the browser console, or a headless
// test harness, inspect and drive internal state directly.
if (typeof window !== "undefined") {
  window.__coeurf = {
    state, computeBorderSegments, buildFaces, recomputeFaces, getFaces: () => facesCache,
    undo, redo, buildExportSVG, render, setSelection, saveToLocalStorage, loadFromLocalStorage,
  };
}

init();
