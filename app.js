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

function cubicTangent(p0, c1, c2, p3, t) {
  const u = 1 - t;
  const x = 3*u*u*(c1.x - p0.x) + 6*u*t*(c2.x - c1.x) + 3*t*t*(p3.x - c2.x);
  const y = 3*u*u*(c1.y - p0.y) + 6*u*t*(c2.y - c1.y) + 3*t*t*(p3.y - c2.y);
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
/* Self/mutual curve-intersection splitting                                */
/*                                                                          */
/* Face detection below only joins curves at shared endpoints (p0/p3): a   */
/* curve that loops back and crosses itself mid-span, or two curves that   */
/* cross without sharing an endpoint, are geometrically two-or-more        */
/* surfaces but topologically invisible to that algorithm. To make those   */
/* crossings count as real graph vertices, every curve is pre-split at any */
/* point where its flattened polyline crosses another curve's (or its own) */
/* polyline away from an existing shared endpoint. The split only feeds    */
/* face detection - state.curves (drawing, editing, undo) is untouched.    */
/* ---------------------------------------------------------------------- */

function cubicSplitAt(p0, c1, c2, p3, t) {
  const p01 = { x: lerp(p0.x, c1.x, t), y: lerp(p0.y, c1.y, t) };
  const p12 = { x: lerp(c1.x, c2.x, t), y: lerp(c1.y, c2.y, t) };
  const p23 = { x: lerp(c2.x, p3.x, t), y: lerp(c2.y, p3.y, t) };
  const p012 = { x: lerp(p01.x, p12.x, t), y: lerp(p01.y, p12.y, t) };
  const p123 = { x: lerp(p12.x, p23.x, t), y: lerp(p12.y, p23.y, t) };
  const p0123 = { x: lerp(p012.x, p123.x, t), y: lerp(p012.y, p123.y, t) };
  return {
    left: { p0, c1: p01, c2: p012, p3: p0123 },
    right: { p0: p0123, c1: p123, c2: p23, p3 },
  };
}

// Intersection of segments p1->p2 and p3->p4, INCLUSIVE of their endpoints:
// on a grid-snapped shape a real crossing very often lands exactly on a
// flattened-polyline sample boundary (e.g. two straight diagonals of a square
// meeting dead center on a 20-segment flattening), so excluding segment
// endpoints here would miss it. Touches at a curve's *own* p0/p3 are instead
// filtered by the caller, using the curve's global t (EPS_T below) - that is
// robust regardless of which segment happened to catch the crossing.
function segmentIntersection(p1, p2, p3, p4) {
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x, d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-9) return null;
  const ex = p3.x - p1.x, ey = p3.y - p1.y;
  const t = (ex * d2y - ey * d2x) / denom;
  const u = (ex * d1y - ey * d1x) / denom;
  const EPS = 1e-9;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return { t, u, point: { x: p1.x + t * d1x, y: p1.y + t * d1y } };
}

// Splits one curve into consecutive sub-curves at the given sorted, distinct
// breakpoints ({t, point}), forcing each new shared anchor to the exact same
// coordinate on both sides so face detection's vkey union recognizes it as
// one graph vertex (a linear split-point estimate would otherwise leave the
// two sides a fraction of a unit apart).
function splitCurveAtParams(curve, breaks) {
  if (breaks.length === 0) return [curve];
  const pieces = [];
  let remaining = { p0: curve.p0, c1: curve.c1, c2: curve.c2, p3: curve.p3 };
  let tPrev = 0;
  for (const brk of breaks) {
    const tLocal = (brk.t - tPrev) / (1 - tPrev);
    const { left, right } = cubicSplitAt(remaining.p0, remaining.c1, remaining.c2, remaining.p3, tLocal);
    left.p3 = brk.point;
    right.p0 = brk.point;
    pieces.push(left);
    remaining = right;
    tPrev = brk.t;
  }
  pieces.push(remaining);
  return pieces.map((p, i) => ({ ...curve, id: `${curve.id}~${i}`, p0: p.p0, c1: p.c1, c2: p.c2, p3: p.p3 }));
}

function splitCurvesAtIntersections(curves) {
  const N = FLATTEN_SEGMENTS;
  const EPS_T = 1e-4;   // global-t margin excluded near each curve's own endpoints
  const EPS_MERGE = 1e-3; // global-t margin for merging near-duplicate breakpoints

  const flats = curves.map(c => flattenCubic(c.p0, c.c1, c.c2, c.p3, N));
  const breaksByCurve = curves.map(() => []);

  for (let a = 0; a < curves.length; a++) {
    for (let b = a; b < curves.length; b++) {
      const flatA = flats[a], flatB = flats[b];
      for (let i = 0; i < flatA.length - 1; i++) {
        const jStart = (a === b) ? i + 2 : 0;
        for (let j = jStart; j < flatB.length - 1; j++) {
          const hit = segmentIntersection(flatA[i], flatA[i + 1], flatB[j], flatB[j + 1]);
          if (!hit) continue;
          const tA = (i + hit.t) / N;
          const tB = (j + hit.u) / N;
          if (tA < EPS_T || tA > 1 - EPS_T) continue;
          if (tB < EPS_T || tB > 1 - EPS_T) continue;
          breaksByCurve[a].push({ t: tA, point: hit.point });
          breaksByCurve[b].push({ t: tB, point: hit.point });
        }
      }
    }
  }

  const result = [];
  for (let idx = 0; idx < curves.length; idx++) {
    const raw = breaksByCurve[idx];
    if (raw.length === 0) { result.push(curves[idx]); continue; }
    raw.sort((p, q) => p.t - q.t);
    const merged = [];
    for (const brk of raw) {
      if (merged.length && brk.t - merged[merged.length - 1].t < EPS_MERGE) continue;
      merged.push(brk);
    }
    result.push(...splitCurveAtParams(curves[idx], merged));
  }
  return result;
}

/* ---------------------------------------------------------------------- */
/* Application state                                                       */
/* ---------------------------------------------------------------------- */

const state = {
  grid: { width: 800, height: 600, resolution: 20, borderColor: "#33363d", borderWidth: 2, visible: true, specialLines: { center: false, thirds: false, golden: false } },
  curves: [],        // {id, isBorder, p0,c1,c2,p3, width, width2?, drift?, color, colorMode?, color2?, gradientAngle?}
  faceStyles: {},     // signature -> {type:'solid', color} | {type:'gradient', color1, color2, angle}
  selection: null,    // {type:'curve', id} | {type:'face', signature}
  tool: "curve",      // "page" | "grid" | "curve" | "surface"
  curveIdCounter: 1,
};

let facesCache = [];  // last computed faces, for click hit-testing & inheritance
let drawPending = null; // {x,y} snapped anchor while placing a new curve
let dragCtx = null;    // active drag context

/* ---------------------------------------------------------------------- */
/* View: zoom & pan                                                        */
/*                                                                          */
/* Purely a viewport concern, not design data - kept out of `state` so it   */
/* is never saved, undone/redone, or exported.                             */
/* ---------------------------------------------------------------------- */

const MIN_ZOOM = 0.1, MAX_ZOOM = 8;
let zoom = 1;
let spacePanning = false; // spacebar held: next drag on the canvas pans instead of drawing/editing
let panDragCtx = null;
const canvasScrollEl = document.getElementById("canvas-scroll");

// Screen point (or, with no event, the viewport center) to pivot a zoom
// change around, so the content under the cursor/center stays put.
function zoomPivotPoint(evt) {
  if (evt) return { clientX: evt.clientX, clientY: evt.clientY };
  const r = canvasScrollEl.getBoundingClientRect();
  return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
}

function setZoom(newZoom, evt) {
  const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));
  if (Math.abs(clamped - zoom) < 1e-6) return;
  const { clientX, clientY } = zoomPivotPoint(evt);
  const containerRect = canvasScrollEl.getBoundingClientRect();
  const style = getComputedStyle(canvasScrollEl);
  const padLeft = parseFloat(style.paddingLeft) || 0;
  const padTop = parseFloat(style.paddingTop) || 0;
  // Position of the pivot within the scrollable content, in current
  // (pre-zoom) CSS pixels, then converted to design (user-space) units.
  const contentX = canvasScrollEl.scrollLeft + (clientX - containerRect.left) - padLeft;
  const contentY = canvasScrollEl.scrollTop + (clientY - containerRect.top) - padTop;
  const userX = contentX / zoom;
  const userY = contentY / zoom;
  zoom = clamped;
  renderCanvas();
  updateZoomUI();
  // Re-derive scroll so the same design point lands under the same screen point.
  canvasScrollEl.scrollLeft = userX * zoom - (clientX - containerRect.left) + padLeft;
  canvasScrollEl.scrollTop = userY * zoom - (clientY - containerRect.top) + padTop;
}

function zoomIn(evt) { setZoom(zoom * 1.25, evt); }
function zoomOut(evt) { setZoom(zoom / 1.25, evt); }
function resetZoom() { setZoom(1); }

function fitToScreen() {
  const r = canvasScrollEl.getBoundingClientRect();
  const style = getComputedStyle(canvasScrollEl);
  const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  const padY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
  const availW = r.width - padX, availH = r.height - padY;
  const { width: W, height: H } = state.grid;
  if (availW <= 0 || availH <= 0) return;
  zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(availW / W, availH / H)));
  renderCanvas();
  updateZoomUI();
  canvasScrollEl.scrollLeft = 0;
  canvasScrollEl.scrollTop = 0;
}

function updateZoomUI() {
  const btn = document.getElementById("zoom-level-btn");
  if (btn) btn.textContent = Math.round(zoom * 100) + "%";
}

function startPan(evt) {
  panDragCtx = {
    startX: evt.clientX, startY: evt.clientY,
    scrollLeft: canvasScrollEl.scrollLeft, scrollTop: canvasScrollEl.scrollTop,
  };
  canvasScrollEl.classList.add("panning");
  window.addEventListener("mousemove", onPanMouseMove);
  window.addEventListener("mouseup", onPanMouseUp);
}
function onPanMouseMove(evt) {
  if (!panDragCtx) return;
  canvasScrollEl.scrollLeft = panDragCtx.scrollLeft - (evt.clientX - panDragCtx.startX);
  canvasScrollEl.scrollTop = panDragCtx.scrollTop - (evt.clientY - panDragCtx.startY);
}
function onPanMouseUp() {
  panDragCtx = null;
  canvasScrollEl.classList.remove("panning");
  window.removeEventListener("mousemove", onPanMouseMove);
  window.removeEventListener("mouseup", onPanMouseUp);
}

// Plain wheel/trackpad scroll pans natively via #canvas-scroll's own
// overflow:auto - only Ctrl/Cmd+wheel (also how browsers report trackpad
// pinch gestures) is intercepted here, to zoom instead of scroll.
canvasScrollEl.addEventListener("wheel", evt => {
  if (!(evt.ctrlKey || evt.metaKey)) return;
  evt.preventDefault();
  setZoom(zoom * Math.exp(-evt.deltaY * 0.001), evt);
}, { passive: false });

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
  if (state.grid.visible === undefined) state.grid.visible = true;
  if (!state.grid.specialLines) state.grid.specialLines = { center: false, thirds: false, golden: false };
  state.curves = JSON.parse(JSON.stringify(snap.curves));
  state.faceStyles = JSON.parse(JSON.stringify(snap.faceStyles));
  state.curveIdCounter = snap.curveIdCounter;
  state.selection = null;
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
  const rawCurves = state.curves.concat(computeBorderSegments());
  const { faces, curvesById } = buildFaces(splitCurvesAtIntersections(rawCurves));

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
let gridLayer, facesLayer, curvesLayer, selectionLayer, handlesLayer, previewLayer, defsLayer;

// Stacking order matters: fills, then curve strokes, then the grid (on top so
// toggling it is actually visible over any fill/curve instead of being buried
// under the opaque face fills), then the selection highlight (always above
// the curves that bound a face, so it can't be hidden underneath them), then
// the draggable handles, then the hover-only draw preview on top of all of it.
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
  previewLayer = document.createElementNS(SVGNS, "g");
  previewLayer.setAttribute("id", "layer-preview");
  previewLayer.style.pointerEvents = "none";
  svg.appendChild(defsLayer);
  svg.appendChild(facesLayer);
  svg.appendChild(curvesLayer);
  svg.appendChild(gridLayer);
  svg.appendChild(selectionLayer);
  svg.appendChild(handlesLayer);
  svg.appendChild(previewLayer);
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

function curveGradientId(id) {
  return "curve-grad-" + String(id).replace(/[^a-zA-Z0-9]/g, "_");
}

// Below this, a tangent is treated as "zero" - i.e. the curve's own control
// point sits right on its anchor, so there's no reliable direction left to
// offset in.
const TANGENT_EPS = 1e-4;

function unitNormal(tan) {
  const len = Math.hypot(tan.x, tan.y);
  if (len < 1e-6) return { x: 0, y: 1 };
  return { x: -tan.y / len, y: tan.x / len };
}

// Offsets one rail (sign +1/-1) of a cubic bezier by a half-width that
// tapers linearly from w0 to w1. The endpoints are pushed out along the
// normal at their end of the curve (p0 uses n0, p3 uses n1) - exact, not an
// approximation. The interior control points are where the approximation
// error - the "drift" from a true offset curve - actually lives: pushing
// them out along the same fixed n0/n1 (rather than the true, continuously
// turning normal) is what makes the rail bulge or lean on a curved
// baseline instead of tracking it exactly. `drift` blends each interior
// point between that approximation (drift=1, the default) and the point a
// perfectly straight-sided wedge would use (drift=0, no bulge at all);
// past 1 it extrapolates beyond the approximation, exaggerating the same
// bulge/lean for effect rather than correcting it.
function offsetBezierRail(c, w0, w1, sign, n0, n1, drift) {
  const h0 = sign * w0 / 2;
  const h1 = sign * w1 / 2;
  const hc1 = sign * lerp(w0, w1, 1 / 3) / 2;
  const hc2 = sign * lerp(w0, w1, 2 / 3) / 2;
  const p0 = { x: c.p0.x + n0.x * h0, y: c.p0.y + n0.y * h0 };
  const p3 = { x: c.p3.x + n1.x * h1, y: c.p3.y + n1.y * h1 };
  const approxC1 = { x: c.c1.x + n0.x * hc1, y: c.c1.y + n0.y * hc1 };
  const approxC2 = { x: c.c2.x + n1.x * hc2, y: c.c2.y + n1.y * hc2 };
  const flatC1 = { x: lerp(p0.x, p3.x, 1 / 3), y: lerp(p0.y, p3.y, 1 / 3) };
  const flatC2 = { x: lerp(p0.x, p3.x, 2 / 3), y: lerp(p0.y, p3.y, 2 / 3) };
  return {
    p0,
    c1: { x: flatC1.x + drift * (approxC1.x - flatC1.x), y: flatC1.y + drift * (approxC1.y - flatC1.y) },
    c2: { x: flatC2.x + drift * (approxC2.x - flatC2.x), y: flatC2.y + drift * (approxC2.y - flatC2.y) },
    p3,
  };
}

// Builds a filled ribbon outline for a curve whose start/end widths differ,
// since a plain stroked <path> can only ever have one constant stroke-width:
// two offset bezier "rails" (see offsetBezierRail) joined into one closed,
// filled path, i.e. two concurrent curves with the area between them filled.
//
// Where an endpoint's tangent is (near) zero there's no reliable normal to
// offset along, so unitNormal falls back to an arbitrary fixed direction and
// the ribbon closes with a flat edge there, angled however that guess landed
// - it can look visibly wrong rather than just imprecise. Since that flat
// edge's two corners are always exactly half-width from the anchor point
// (whatever direction they were pushed in), a circle of that same radius
// centered on the anchor fully encloses them regardless of the guessed
// direction. So instead of trusting the guess, this reports where a round
// cap disc is needed and lets the caller draw one over the arbitrary edge -
// the same fix stroke-linecap:"round" gives an ordinary stroke.
function taperedRibbonPath(c, w0, w1, drift) {
  const tan0 = cubicTangent(c.p0, c.c1, c.c2, c.p3, 0);
  const tan1 = cubicTangent(c.p0, c.c1, c.c2, c.p3, 1);
  const n0 = unitNormal(tan0);
  const n1 = unitNormal(tan1);
  const top = offsetBezierRail(c, w0, w1, 1, n0, n1, drift);
  const bottom = offsetBezierRail(c, w0, w1, -1, n0, n1, drift);
  const d = `M ${fmt(top.p0.x)} ${fmt(top.p0.y)} ` +
    `C ${fmt(top.c1.x)} ${fmt(top.c1.y)}, ${fmt(top.c2.x)} ${fmt(top.c2.y)}, ${fmt(top.p3.x)} ${fmt(top.p3.y)} ` +
    `L ${fmt(bottom.p3.x)} ${fmt(bottom.p3.y)} ` +
    `C ${fmt(bottom.c2.x)} ${fmt(bottom.c2.y)}, ${fmt(bottom.c1.x)} ${fmt(bottom.c1.y)}, ${fmt(bottom.p0.x)} ${fmt(bottom.p0.y)} Z`;
  return {
    d,
    capStart: Math.hypot(tan0.x, tan0.y) < TANGENT_EPS ? { x: c.p0.x, y: c.p0.y, r: w0 / 2 } : null,
    capEnd: Math.hypot(tan1.x, tan1.y) < TANGENT_EPS ? { x: c.p3.x, y: c.p3.y, r: w1 / 2 } : null,
  };
}

function curvesMarkup(curves) {
  let defs = "";
  let body = "";
  for (const c of curves) {
    const selected = state.selection && state.selection.type === "curve" && state.selection.id === c.id;
    const w0 = c.width;
    const w1 = c.width2 != null ? c.width2 : c.width;
    // The ribbon path is what carries the "drift" bulge (see
    // offsetBezierRail), so it's used whenever Taper is on - even with equal
    // start/end widths - so the Drift control still has something to act on.
    const tapered = c.width2 != null;
    const drift = c.drift != null ? c.drift : 1;

    let paint;
    if (selected) {
      paint = "#5b8cff";
    } else if (c.colorMode === "gradient" && c.color2) {
      const gid = curveGradientId(c.id);
      const v = gradientVector(c.gradientAngle || 0);
      defs += `<linearGradient id="${gid}" x1="${v.x1}" y1="${v.y1}" x2="${v.x2}" y2="${v.y2}">` +
        `<stop offset="0%" stop-color="${c.color}"/>` +
        `<stop offset="100%" stop-color="${c.color2}"/>` +
        `</linearGradient>`;
      paint = `url(#${gid})`;
    } else {
      paint = c.color;
    }

    if (tapered) {
      const ribbon = taperedRibbonPath(c, w0, w1, drift);
      body += `<path d="${ribbon.d}" fill="${paint}" data-curve-id="${escapeAttr(c.id)}"></path>`;
      for (const cap of [ribbon.capStart, ribbon.capEnd]) {
        if (!cap) continue;
        body += `<circle cx="${fmt(cap.x)}" cy="${fmt(cap.y)}" r="${fmt(cap.r)}" fill="${paint}" data-curve-id="${escapeAttr(c.id)}"></circle>`;
      }
    } else {
      const d = `M ${fmt(c.p0.x)} ${fmt(c.p0.y)} C ${fmt(c.c1.x)} ${fmt(c.c1.y)}, ${fmt(c.c2.x)} ${fmt(c.c2.y)}, ${fmt(c.p3.x)} ${fmt(c.p3.y)}`;
      body += `<path d="${d}" fill="none" stroke="${paint}" stroke-width="${w0}" stroke-linecap="round" data-curve-id="${escapeAttr(c.id)}"></path>`;
    }
  }
  return { defs, body };
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

// Fractional (0..1) positions of each special-line family along one axis.
// "center" is the midpoint; "thirds" is the rule-of-thirds pair; "golden"
// is the golden-section pair (1/phi and 1 - 1/phi), symmetric about center.
const SPECIAL_LINE_FRACTIONS = {
  center: [0.5],
  thirds: [1 / 3, 2 / 3],
  golden: [(Math.sqrt(5) - 1) / 2, (3 - Math.sqrt(5)) / 2],
};

function specialGuideLinesMarkup(W, H, scale) {
  const enabled = state.grid.specialLines || {};
  const lw = 1 / scale, dash = 5 / scale;
  let html = "";
  for (const key of Object.keys(SPECIAL_LINE_FRACTIONS)) {
    if (!enabled[key]) continue;
    for (const f of SPECIAL_LINE_FRACTIONS[key]) {
      const x = W * f, y = H * f;
      html += `<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="#ffffff" stroke-width="${lw}" stroke-dasharray="${dash},${dash}"/>`;
      html += `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#ffffff" stroke-width="${lw}" stroke-dasharray="${dash},${dash}"/>`;
    }
  }
  return html;
}

function renderGrid() {
  const { width: W, height: H, resolution: res, visible: show } = state.grid;
  if (!show) { gridLayer.innerHTML = ""; return; }
  const patId = "gridpat";
  const scale = currentScale();
  const lw = 1 / scale;
  // White stroke + mix-blend-mode:difference inverts whatever is underneath,
  // so the grid stays visible over any fill/gradient/curve color instead of
  // needing a fixed color that only works on a light background. The special
  // guide lines below reuse the same trick, dashed so they read as guides
  // rather than more grid.
  gridLayer.innerHTML =
    `<defs><pattern id="${patId}" width="${res}" height="${res}" patternUnits="userSpaceOnUse">` +
    `<path d="M ${res} 0 L 0 0 0 ${res}" fill="none" stroke="#ffffff" stroke-width="${lw}"/>` +
    `</pattern></defs>` +
    `<rect x="0" y="0" width="${W}" height="${H}" fill="url(#${patId})" style="mix-blend-mode:difference"></rect>` +
    `<g style="mix-blend-mode:difference">${specialGuideLinesMarkup(W, H, scale)}</g>`;
}

function renderHandles() {
  handlesLayer.innerHTML = "";
  if (!state.selection || state.selection.type !== "curve") return;
  const c = state.curves.find(cv => cv.id === state.selection.id);
  if (!c) return;
  const s = currentScale();
  const rA = 7 / s, rC = 6 / s, lw = 1.6 / s;
  let html = "";
  html += `<line x1="${c.p0.x}" y1="${c.p0.y}" x2="${c.c1.x}" y2="${c.c1.y}" stroke="#5b8cff" stroke-width="${lw}" stroke-dasharray="${3/s},${3/s}"></line>`;
  html += `<line x1="${c.p3.x}" y1="${c.p3.y}" x2="${c.c2.x}" y2="${c.c2.y}" stroke="#5b8cff" stroke-width="${lw}" stroke-dasharray="${3/s},${3/s}"></line>`;
  const mk = (p, r, fill, key) => `<circle class="handle" cx="${p.x}" cy="${p.y}" r="${r}" fill="${fill}" stroke="#1b1d22" stroke-width="${1/s}" data-handle="${key}"></circle>`;
  html += mk(c.c1, rC, "#ffb020", "c1");
  html += mk(c.c2, rC, "#ffb020", "c2");
  html += mk(c.p0, rA, "#2ecc71", "p0");
  html += mk(c.p3, rA, "#e6453c", "p3");
  handlesLayer.innerHTML = html;
}

// Split out from render() so a color input's live preview (fired continuously
// while dragging inside the native picker) can repaint the canvas without
// touching the panel: replacing the panel's innerHTML mid-drag would tear out
// the very <input type="color"> the OS picker is attached to and cut the drag
// short.
function renderCanvas() {
  const { width: W, height: H } = state.grid;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", W * zoom);
  svg.setAttribute("height", H * zoom);

  if (!gridLayer) ensureLayers();
  renderGrid();

  const { defs, body } = buildDefsAndFaceMarkup(facesCache, facesCache.curvesById || {});
  const curveA = curvesMarkup(state.curves);
  const curveB = curvesMarkup(computeBorderSegments());
  defsLayer.innerHTML = defs + curveA.defs + curveB.defs;
  facesLayer.innerHTML = body;

  curvesLayer.innerHTML = curveA.body + curveB.body;
  selectionLayer.innerHTML = selectionOverlayMarkup(facesCache.curvesById || {});

  renderHandles();
}

function render() {
  renderCanvas();
  renderPanel();
}

/* ---------------------------------------------------------------------- */
/* Panel                                                                    */
/* ---------------------------------------------------------------------- */

const panel = document.getElementById("panel");

// All colors currently in use anywhere in the design, so a color field can
// offer them as one-click swatches instead of requiring the OS picker for a
// color that's already on the canvas.
function usedColors() {
  const seen = new Set();
  const order = [];
  const add = c => {
    if (!c) return;
    const v = c.toLowerCase();
    if (!seen.has(v)) { seen.add(v); order.push(v); }
  };
  add(state.grid.borderColor);
  for (const c of state.curves) {
    add(c.color);
    if (c.colorMode === "gradient") add(c.color2);
  }
  for (const sig of Object.keys(state.faceStyles)) {
    const s = state.faceStyles[sig];
    if (s.type === "gradient") { add(s.color1); add(s.color2); } else { add(s.color); }
  }
  return order;
}

function swatchesMarkup() {
  const colors = usedColors();
  if (!colors.length) return "";
  return `<div class="swatches">` +
    colors.map(c => `<button type="button" class="swatch" style="background:${c}" data-swatch="${c}" title="${c}"></button>`).join("") +
    `</div>`;
}

// Wires up a swatches block's buttons to drive an existing <input
// type="color"> as if the user had picked that color themselves, so it
// reuses whatever 'input'/'change' listeners are already attached to it.
// Also keeps the swatch matching the input's current value highlighted,
// live, including while the OS picker is being dragged.
function wireSwatches(container, inputEl) {
  if (!container) return;
  const syncActive = () => {
    const cur = inputEl.value.toLowerCase();
    for (const btn of container.querySelectorAll(".swatch")) {
      btn.classList.toggle("active", btn.dataset.swatch === cur);
    }
  };
  syncActive();
  for (const btn of container.querySelectorAll(".swatch")) {
    btn.addEventListener("click", () => {
      inputEl.value = btn.dataset.swatch;
      inputEl.dispatchEvent(new Event("input", { bubbles: true }));
      inputEl.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  inputEl.addEventListener("input", syncActive);
}

function renderPanel() {
  if (state.tool === "page") { renderPagePanel(); return; }
  if (state.tool === "grid") { renderGridPanel(); return; }
  if (!state.selection) {
    const msg = state.tool === "surface"
      ? "Nothing selected.<br>Click inside a region to select its surface."
      : "Nothing selected.<br>Click an existing curve to select it, or click an empty grid point to draw one.";
    panel.innerHTML = `<div class="panel-empty">${msg}</div>`;
    return;
  }
  if (state.selection.type === "curve") {
    renderCurvePanel();
  } else {
    renderFacePanel();
  }
}

function renderPagePanel() {
  const g = state.grid;
  panel.innerHTML = `
    <div class="panel-section">
      <h3>Page</h3>
      <div class="field-row"><label>Width</label><input type="number" min="20" step="1" id="p-width" value="${g.width}"></div>
      <div class="field-row"><label>Height</label><input type="number" min="20" step="1" id="p-height" value="${g.height}"></div>
      <div class="field-row"><label>Border color</label><input type="color" id="p-bcolor" value="${g.borderColor}"></div>
      ${swatchesMarkup()}
      <div class="field-row"><label>Border width</label><input type="number" min="0" step="0.5" id="p-bwidth" value="${g.borderWidth}"></div>
    </div>
  `;
  wireSwatches(panel, document.getElementById("p-bcolor"));
  const applyPageFields = () => {
    const w = Math.max(20, parseInt(document.getElementById("p-width").value, 10) || state.grid.width);
    const h = Math.max(20, parseInt(document.getElementById("p-height").value, 10) || state.grid.height);
    state.grid.width = w;
    state.grid.height = h;
    state.grid.borderColor = document.getElementById("p-bcolor").value;
    state.grid.borderWidth = parseFloat(document.getElementById("p-bwidth").value) || 0;
    recomputeFaces();
    render();
    pushHistory();
  };
  for (const id of ["p-width", "p-height", "p-bcolor", "p-bwidth"]) {
    document.getElementById(id).addEventListener("change", applyPageFields);
  }
}

const SPECIAL_LINE_LABELS = { center: "Center", thirds: "Thirds", golden: "Golden ratio" };

function renderGridPanel() {
  const g = state.grid;
  const specialRows = Object.keys(SPECIAL_LINE_LABELS).map(key =>
    `<div class="field-row"><label>${SPECIAL_LINE_LABELS[key]}</label><input type="checkbox" class="g-special" data-key="${key}" ${g.specialLines[key] ? "checked" : ""}></div>`
  ).join("");
  panel.innerHTML = `
    <div class="panel-section">
      <h3>Grid</h3>
      <div class="field-row"><label>Visible</label><input type="checkbox" id="g-visible" ${g.visible ? "checked" : ""}></div>
      <div class="field-row"><label>Resolution</label><input type="number" min="2" step="1" id="g-res" value="${g.resolution}"></div>
    </div>
    <div class="panel-section">
      <h3>Guide lines</h3>
      ${specialRows}
    </div>
  `;
  document.getElementById("g-visible").addEventListener("change", e => {
    state.grid.visible = e.target.checked;
    renderCanvas();
    pushHistory();
  });
  document.getElementById("g-res").addEventListener("change", e => {
    const res = Math.max(2, parseInt(e.target.value, 10) || state.grid.resolution);
    state.grid.resolution = res;
    e.target.value = res;
    render();
    pushHistory();
  });
  for (const el of document.querySelectorAll(".g-special")) {
    el.addEventListener("change", e => {
      state.grid.specialLines[e.target.dataset.key] = e.target.checked;
      renderCanvas();
      pushHistory();
    });
  }
}

function renderCurvePanel() {
  const c = state.curves.find(cv => cv.id === state.selection.id);
  if (!c) { state.selection = null; renderPanel(); return; }
  const isGrad = c.colorMode === "gradient";
  const isTapered = c.width2 != null;
  panel.innerHTML = `
    <div class="panel-section">
      <h3>Curve</h3>
      <div class="seg">
        <button id="c-solid" class="${!isGrad ? "active" : ""}">Solid</button>
        <button id="c-grad" class="${isGrad ? "active" : ""}">Gradient</button>
      </div>
      <div id="color-fields"></div>
      <div class="field-row">
        <label>${isTapered ? "Start width" : "Width"}</label>
        <input type="range" id="f-width" min="0.5" max="30" step="0.5" value="${c.width}">
        <input type="number" class="num-in" id="f-width-num" min="0.5" max="30" step="0.5" value="${c.width}">
      </div>
      <div class="field-row"><label>Taper</label><input type="checkbox" id="f-taper" ${isTapered ? "checked" : ""}></div>
      <div id="taper-fields"></div>
      <button class="block-btn" id="f-mirror">Mirror copy</button>
      <button class="block-btn" id="f-mirror-h">Mirror horizontal axis</button>
      <button class="block-btn" id="f-mirror-v">Mirror vertical axis</button>
      <button class="danger-btn" id="f-delete">Delete</button>
    </div>
  `;

  const colorFields = document.getElementById("color-fields");

  function paintSolidFields() {
    colorFields.innerHTML = `
      <div class="field-row">
        <label>Color</label>
        <input type="color" id="f-color" value="${c.color}">
      </div>
      ${swatchesMarkup()}
    `;
    document.getElementById("f-color").addEventListener("input", e => {
      c.color = e.target.value;
      renderCanvas();
    });
    document.getElementById("f-color").addEventListener("change", () => pushHistory());
    wireSwatches(colorFields, document.getElementById("f-color"));
  }

  function paintGradientFields() {
    colorFields.innerHTML = `
      <div class="gradient-preview" id="f-gpreview"></div>
      <div class="field-row">
        <label>Start</label>
        <input type="color" id="f-g1" value="${c.color}">
      </div>
      ${swatchesMarkup()}
      <div class="field-row">
        <label>End</label>
        <input type="color" id="f-g2" value="${c.color2}">
      </div>
      ${swatchesMarkup()}
      <div class="field-row">
        <label>Angle</label>
        <input type="range" id="f-gangle" min="0" max="359" step="1" value="${c.gradientAngle}">
        <input type="number" class="num-in" id="f-gangle-num" min="0" max="359" step="1" value="${c.gradientAngle}">
        <span class="unit">&deg;</span>
      </div>
    `;
    const updatePreview = () => {
      document.getElementById("f-gpreview").style.background =
        `linear-gradient(${c.gradientAngle}deg, ${document.getElementById("f-g1").value}, ${document.getElementById("f-g2").value})`;
    };
    updatePreview();
    document.getElementById("f-g1").addEventListener("input", e => {
      c.color = e.target.value;
      updatePreview(); renderCanvas();
    });
    document.getElementById("f-g1").addEventListener("change", () => pushHistory());
    document.getElementById("f-g2").addEventListener("input", e => {
      c.color2 = e.target.value;
      updatePreview(); renderCanvas();
    });
    document.getElementById("f-g2").addEventListener("change", () => pushHistory());
    const swatchBlocks = colorFields.querySelectorAll(".swatches");
    wireSwatches(swatchBlocks[0], document.getElementById("f-g1"));
    wireSwatches(swatchBlocks[1], document.getElementById("f-g2"));
    const angleInput = document.getElementById("f-gangle");
    const angleNum = document.getElementById("f-gangle-num");
    angleInput.addEventListener("input", e => {
      c.gradientAngle = parseInt(e.target.value, 10);
      angleNum.value = c.gradientAngle;
      updatePreview(); renderCanvas();
    });
    angleInput.addEventListener("change", () => pushHistory());
    angleNum.addEventListener("input", e => {
      const v = parseInt(e.target.value, 10);
      if (!Number.isFinite(v)) return;
      c.gradientAngle = v;
      angleInput.value = v;
      updatePreview(); renderCanvas();
    });
    angleNum.addEventListener("change", e => {
      const v = Math.max(0, Math.min(359, parseInt(e.target.value, 10) || 0));
      c.gradientAngle = v;
      e.target.value = v;
      angleInput.value = v;
      updatePreview(); renderCanvas();
      pushHistory();
    });
  }

  if (isGrad) paintGradientFields(); else paintSolidFields();

  document.getElementById("c-solid").addEventListener("click", () => {
    if (c.colorMode !== "gradient") return;
    c.colorMode = "solid";
    renderCurvePanel(); renderCanvas(); pushHistory();
  });
  document.getElementById("c-grad").addEventListener("click", () => {
    if (c.colorMode === "gradient") return;
    c.colorMode = "gradient";
    c.color2 = c.color2 || "#5b8cff";
    c.gradientAngle = c.gradientAngle != null ? c.gradientAngle : 90;
    renderCurvePanel(); renderCanvas(); pushHistory();
  });

  // Live 'input' updates only repaint the canvas, never the panel: rebuilding
  // this input's own DOM node mid-drag/mid-keystroke would drop the browser's
  // focus/pointer-capture on it, stalling the drag or losing keystrokes.
  const widthInput = document.getElementById("f-width");
  const widthNum = document.getElementById("f-width-num");
  widthInput.addEventListener("input", e => {
    c.width = parseFloat(e.target.value);
    widthNum.value = c.width;
    renderCanvas();
  });
  widthInput.addEventListener("change", () => pushHistory());
  widthNum.addEventListener("input", e => {
    const v = parseFloat(e.target.value);
    if (!Number.isFinite(v)) return;
    c.width = v;
    widthInput.value = v;
    renderCanvas();
  });
  widthNum.addEventListener("change", e => {
    const v = Math.max(0.5, Math.min(30, parseFloat(e.target.value) || c.width));
    c.width = v;
    e.target.value = v;
    widthInput.value = v;
    renderCanvas();
    pushHistory();
  });

  const taperFields = document.getElementById("taper-fields");
  function paintTaperFields() {
    if (c.width2 == null) { taperFields.innerHTML = ""; return; }
    const drift = c.drift != null ? c.drift : 1;
    taperFields.innerHTML = `
      <div class="field-row">
        <label>End width</label>
        <input type="range" id="f-width2" min="0.5" max="30" step="0.5" value="${c.width2}">
        <input type="number" class="num-in" id="f-width2-num" min="0.5" max="30" step="0.5" value="${c.width2}">
      </div>
      <div class="field-row">
        <label>Drift</label>
        <input type="range" id="f-drift" min="0" max="5" step="0.1" value="${drift}">
        <input type="number" class="num-in" id="f-drift-num" min="0" max="5" step="0.1" value="${drift}">
      </div>
    `;
    const width2Input = document.getElementById("f-width2");
    const width2Num = document.getElementById("f-width2-num");
    width2Input.addEventListener("input", e => {
      c.width2 = parseFloat(e.target.value);
      width2Num.value = c.width2;
      renderCanvas();
    });
    width2Input.addEventListener("change", () => pushHistory());
    width2Num.addEventListener("input", e => {
      const v = parseFloat(e.target.value);
      if (!Number.isFinite(v)) return;
      c.width2 = v;
      width2Input.value = v;
      renderCanvas();
    });
    width2Num.addEventListener("change", e => {
      const v = Math.max(0.5, Math.min(30, parseFloat(e.target.value) || c.width2));
      c.width2 = v;
      e.target.value = v;
      width2Input.value = v;
      renderCanvas();
      pushHistory();
    });

    // Drift blends each rail's interior control point between a flat,
    // straight-sided wedge (0) and the tangent-based offset approximation
    // (1, the default); beyond 1 it extrapolates past the approximation,
    // exaggerating the same bulge/lean instead of correcting it.
    const driftInput = document.getElementById("f-drift");
    const driftNum = document.getElementById("f-drift-num");
    driftInput.addEventListener("input", e => {
      c.drift = parseFloat(e.target.value);
      driftNum.value = c.drift;
      renderCanvas();
    });
    driftInput.addEventListener("change", () => pushHistory());
    driftNum.addEventListener("input", e => {
      const v = parseFloat(e.target.value);
      if (!Number.isFinite(v)) return;
      c.drift = v;
      driftInput.value = v;
      renderCanvas();
    });
    driftNum.addEventListener("change", e => {
      const v = Math.max(0, Math.min(5, parseFloat(e.target.value)));
      c.drift = Number.isFinite(v) ? v : 1;
      e.target.value = c.drift;
      driftInput.value = c.drift;
      renderCanvas();
      pushHistory();
    });
  }
  paintTaperFields();

  document.getElementById("f-taper").addEventListener("change", e => {
    c.width2 = e.target.checked ? c.width : null;
    renderCurvePanel(); renderCanvas(); pushHistory();
  });

  document.getElementById("f-mirror").addEventListener("click", () => {
    const mirrored = mirrorCurve(c);
    state.curves.push(mirrored);
    recomputeFaces();
    setSelection({ type: "curve", id: mirrored.id });
    pushHistory();
  });

  document.getElementById("f-mirror-h").addEventListener("click", () => {
    const mirrored = mirrorCurveHorizontalAxis(c);
    state.curves.push(mirrored);
    recomputeFaces();
    setSelection({ type: "curve", id: mirrored.id });
    pushHistory();
  });

  document.getElementById("f-mirror-v").addEventListener("click", () => {
    const mirrored = mirrorCurveVerticalAxis(c);
    state.curves.push(mirrored);
    recomputeFaces();
    setSelection({ type: "curve", id: mirrored.id });
    pushHistory();
  });

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
      ${swatchesMarkup()}
    `;
    document.getElementById("f-scolor").addEventListener("input", e => {
      s.color = e.target.value;
      renderCanvas();
    });
    document.getElementById("f-scolor").addEventListener("change", () => pushHistory());
    wireSwatches(fields, document.getElementById("f-scolor"));
  }

  function paintGradient() {
    const s = state.faceStyles[face.signature];
    fields.innerHTML = `
      <div class="gradient-preview" id="f-gpreview"></div>
      <div class="field-row">
        <label>Start</label>
        <input type="color" id="f-g1" value="${s.color1}">
      </div>
      ${swatchesMarkup()}
      <div class="field-row">
        <label>End</label>
        <input type="color" id="f-g2" value="${s.color2}">
      </div>
      ${swatchesMarkup()}
      <div class="field-row">
        <label>Angle</label>
        <input type="range" id="f-gangle" min="0" max="359" step="1" value="${s.angle}">
        <input type="number" class="num-in" id="f-gangle-num" min="0" max="359" step="1" value="${s.angle}">
        <span class="unit">&deg;</span>
      </div>
    `;
    const updatePreview = () => {
      const el = document.getElementById("f-gpreview");
      el.style.background = `linear-gradient(${s.angle}deg, ${document.getElementById("f-g1").value}, ${document.getElementById("f-g2").value})`;
    };
    updatePreview();
    document.getElementById("f-g1").addEventListener("input", e => {
      s.color1 = e.target.value;
      updatePreview(); renderCanvas();
    });
    document.getElementById("f-g1").addEventListener("change", () => pushHistory());
    document.getElementById("f-g2").addEventListener("input", e => {
      s.color2 = e.target.value;
      updatePreview(); renderCanvas();
    });
    document.getElementById("f-g2").addEventListener("change", () => pushHistory());
    const swatchBlocks = fields.querySelectorAll(".swatches");
    wireSwatches(swatchBlocks[0], document.getElementById("f-g1"));
    wireSwatches(swatchBlocks[1], document.getElementById("f-g2"));
    // Same live-update/panel-decoupling as the width gauge above: only
    // renderCanvas(), never a full render(), while the value is still changing.
    const angleInput = document.getElementById("f-gangle");
    const angleNum = document.getElementById("f-gangle-num");
    angleInput.addEventListener("input", e => {
      s.angle = parseInt(e.target.value, 10);
      angleNum.value = s.angle;
      updatePreview(); renderCanvas();
    });
    angleInput.addEventListener("change", () => pushHistory());
    angleNum.addEventListener("input", e => {
      const v = parseInt(e.target.value, 10);
      if (!Number.isFinite(v)) return;
      s.angle = v;
      angleInput.value = v;
      updatePreview(); renderCanvas();
    });
    angleNum.addEventListener("change", e => {
      const v = Math.max(0, Math.min(359, parseInt(e.target.value, 10) || 0));
      s.angle = v;
      e.target.value = v;
      angleInput.value = v;
      updatePreview(); renderCanvas();
      pushHistory();
    });
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
  const tol = 11 / currentScale();
  const near = findNearVertex(raw, tol);
  if (near) return near;
  return snapToGrid(raw.x, raw.y, state.grid.resolution, state.grid.width, state.grid.height);
}

function hitTestCurve(pt) {
  const tol = 8 / currentScale();
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
  const tol = 10 / currentScale();
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

// Mirrors a curve across the line through its own start and end point,
// producing a new curve so symmetric shapes can be built from one half.
function mirrorCurve(c) {
  const p0 = c.p0, p3 = c.p3;
  let dx = p3.x - p0.x, dy = p3.y - p0.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) { dx = 0; dy = 1; } else { dx /= len; dy /= len; }
  const reflect = p => {
    const t = (p.x - p0.x) * dx + (p.y - p0.y) * dy;
    const projX = p0.x + t * dx, projY = p0.y + t * dy;
    return { x: 2 * projX - p.x, y: 2 * projY - p.y };
  };
  const id = "c" + (state.curveIdCounter++);
  return { id, isBorder: false, p0: { ...p0 }, c1: reflect(c.c1), c2: reflect(c.c2), p3: { ...p3 },
    width: c.width, width2: c.width2, drift: c.drift, color: c.color,
    colorMode: c.colorMode, color2: c.color2, gradientAngle: c.gradientAngle };
}

// Mirrors a curve across the page's horizontal center axis (flips top/bottom).
function mirrorCurveHorizontalAxis(c) {
  const H = state.grid.height;
  const reflect = p => ({ x: p.x, y: H - p.y });
  const id = "c" + (state.curveIdCounter++);
  return { id, isBorder: false, p0: reflect(c.p0), c1: reflect(c.c1), c2: reflect(c.c2), p3: reflect(c.p3),
    width: c.width, width2: c.width2, drift: c.drift, color: c.color,
    colorMode: c.colorMode, color2: c.color2, gradientAngle: c.gradientAngle };
}

// Mirrors a curve across the page's vertical center axis (flips left/right).
function mirrorCurveVerticalAxis(c) {
  const W = state.grid.width;
  const reflect = p => ({ x: W - p.x, y: p.y });
  const id = "c" + (state.curveIdCounter++);
  return { id, isBorder: false, p0: reflect(c.p0), c1: reflect(c.c1), c2: reflect(c.c2), p3: reflect(c.p3),
    width: c.width, width2: c.width2, drift: c.drift, color: c.color,
    colorMode: c.colorMode, color2: c.color2, gradientAngle: c.gradientAngle };
}

function onStageMouseDown(evt) {
  if (spacePanning || evt.button === 1) {
    evt.preventDefault();
    startPan(evt);
    return;
  }
  if (evt.button !== 0) return;

  if (state.tool === "page" || state.tool === "grid") return;

  if (state.tool === "surface") {
    const pt = toSvgPoint(evt);
    const faceHit = hitTestFace(pt);
    if (faceHit) {
      setSelection({ type: "face", signature: faceHit.signature });
    } else {
      setSelection(null);
    }
    return;
  }

  // curve tool: selecting/dragging existing curves takes priority over
  // starting a new one, except while a draw is already in progress, where
  // the click always finishes/connects it (never reinterpreted as a select).
  if (drawPending) {
    const p = snapForDrawing(evt);
    const { c1, c2 } = defaultCurveBetween(drawPending, p, state.grid.resolution);
    const id = "c" + (state.curveIdCounter++);
    const curve = { id, isBorder: false, p0: { ...drawPending }, c1, c2, p3: { ...p }, width: 3, color: "#2a2d34" };
    state.curves.push(curve);
    drawPending = null;
    hideHint();
    recomputeFaces();
    setSelection({ type: "curve", id });
    pushHistory();
    return;
  }

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
    hideHint();
    setSelection({ type: "curve", id: curveHit.id });
    dragCtx = {
      kind: "curve",
      curve: curveHit,
      start: pt,
      moved: false,
      orig: { p0: { ...curveHit.p0 }, c1: { ...curveHit.c1 }, c2: { ...curveHit.c2 }, p3: { ...curveHit.p3 } },
    };
    svg.style.cursor = "grabbing";
    window.addEventListener("mousemove", onWindowMouseMove);
    window.addEventListener("mouseup", onWindowMouseUp);
    return;
  }

  // empty grid point: start a new curve
  const p = snapForDrawing(evt);
  drawPending = p;
  showHint("Click another grid point to finish the curve. Esc to cancel.", true);
}

function onWindowMouseMove(evt) {
  if (!dragCtx) return;
  if (dragCtx.kind === "curve") {
    const raw = toSvgPoint(evt);
    const res = state.grid.resolution;
    const { width: W, height: H } = state.grid;
    const { orig } = dragCtx;
    const xs = [orig.p0.x, orig.c1.x, orig.c2.x, orig.p3.x];
    const ys = [orig.p0.y, orig.c1.y, orig.c2.y, orig.p3.y];
    let dx = Math.round((raw.x - dragCtx.start.x) / res) * res;
    let dy = Math.round((raw.y - dragCtx.start.y) / res) * res;
    dx = Math.max(-Math.min(...xs), Math.min(W - Math.max(...xs), dx));
    dy = Math.max(-Math.min(...ys), Math.min(H - Math.max(...ys), dy));
    dragCtx.moved = dx !== 0 || dy !== 0;
    const c = dragCtx.curve;
    c.p0 = { x: orig.p0.x + dx, y: orig.p0.y + dy };
    c.c1 = { x: orig.c1.x + dx, y: orig.c1.y + dy };
    c.c2 = { x: orig.c2.x + dx, y: orig.c2.y + dy };
    c.p3 = { x: orig.p3.x + dx, y: orig.p3.y + dy };
    renderHandles();
    curvesLayer.innerHTML = curvesMarkup(state.curves).body + curvesMarkup(computeBorderSegments()).body;
    return;
  }
  const raw = toSvgPoint(evt);
  const tol = 11 / currentScale();
  const near = findNearVertex(raw, tol);
  const p = near || snapToGrid(raw.x, raw.y, state.grid.resolution, state.grid.width, state.grid.height);
  dragCtx.curve[dragCtx.key] = p;
  renderHandles();
  curvesLayer.innerHTML = curvesMarkup(state.curves).body + curvesMarkup(computeBorderSegments()).body;
}

function onWindowMouseUp() {
  if (!dragCtx) return;
  const wasNoOpCurveDrag = dragCtx.kind === "curve" && !dragCtx.moved;
  dragCtx = null;
  window.removeEventListener("mousemove", onWindowMouseMove);
  window.removeEventListener("mouseup", onWindowMouseUp);
  if (state.tool === "curve") svg.style.cursor = "default";
  if (wasNoOpCurveDrag) return;
  recomputeFaces();
  render();
  pushHistory();
}

// Drawn into previewLayer, never handlesLayer, so this hover-only feedback
// can never overwrite the selected curve's actual drag handles underneath it.
function onStageMouseMove(evt) {
  if (spacePanning) { previewLayer.innerHTML = ""; return; }
  if (state.tool === "curve" && !dragCtx) {
    if (drawPending) {
      const p = snapForDrawing(evt);
      const { c1, c2 } = defaultCurveBetween(drawPending, p, state.grid.resolution);
      const preview = `M ${drawPending.x} ${drawPending.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p.x} ${p.y}`;
      previewLayer.innerHTML =
        `<circle cx="${drawPending.x}" cy="${drawPending.y}" r="${6/currentScale()}" fill="#5b8cff"></circle>` +
        `<path d="${preview}" fill="none" stroke="#5b8cff" stroke-width="${1.6/currentScale()}" stroke-dasharray="${4/currentScale()},${3/currentScale()}"></path>` +
        `<circle cx="${p.x}" cy="${p.y}" r="${5/currentScale()}" fill="#5b8cff" opacity="0.6"></circle>`;
      return;
    }
    if (hitTestHandle(evt) || hitTestCurve(toSvgPoint(evt))) {
      svg.style.cursor = "grab";
      previewLayer.innerHTML = "";
      return;
    }
    svg.style.cursor = "crosshair";
    const p = snapForDrawing(evt);
    previewLayer.innerHTML =
      `<circle cx="${p.x}" cy="${p.y}" r="${6/currentScale()}" fill="none" stroke="#5b8cff" stroke-width="${1.6/currentScale()}"></circle>`;
    return;
  }
  if (state.tool === "surface" && !dragCtx) {
    svg.style.cursor = hitTestFace(toSvgPoint(evt)) ? "pointer" : "default";
  }
  previewLayer.innerHTML = "";
}

function setTool(tool) {
  state.tool = tool;
  drawPending = null;
  state.selection = null;
  hideHint();
  previewLayer.innerHTML = "";
  document.getElementById("tool-page").classList.toggle("active", tool === "page");
  document.getElementById("tool-grid").classList.toggle("active", tool === "grid");
  document.getElementById("tool-curve").classList.toggle("active", tool === "curve");
  document.getElementById("tool-surface").classList.toggle("active", tool === "surface");
  svg.style.cursor = "default";
  if (tool === "curve") {
    showHint("Click an existing curve to select it, or an empty grid point to draw a new one.", true);
  } else if (tool === "surface") {
    showHint("Click inside a region to select its surface.", true);
  }
  render();
}

document.getElementById("tool-page").addEventListener("click", () => setTool("page"));
document.getElementById("tool-grid").addEventListener("click", () => setTool("grid"));
document.getElementById("tool-curve").addEventListener("click", () => setTool("curve"));
document.getElementById("tool-surface").addEventListener("click", () => setTool("surface"));

document.addEventListener("keydown", evt => {
  if (evt.key === "Escape") {
    if (drawPending) { drawPending = null; hideHint(); renderHandles(); }
    else if (state.selection) { state.selection = null; render(); }
  } else if ((evt.key === "Delete" || evt.key === "Backspace") && state.selection && state.selection.type === "curve") {
    if (document.activeElement && ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
    const id = state.selection.id;
    state.curves = state.curves.filter(cv => cv.id !== id);
    state.selection = null;
    recomputeFaces(); render(); pushHistory();
  } else if (evt.key.toLowerCase() === "c" && !evt.ctrlKey && !evt.metaKey && !isTyping(evt)) {
    setTool("curve");
  } else if (evt.key.toLowerCase() === "s" && !evt.ctrlKey && !evt.metaKey && !isTyping(evt)) {
    setTool("surface");
  } else if (evt.key.toLowerCase() === "p" && !evt.ctrlKey && !evt.metaKey && !isTyping(evt)) {
    setTool("page");
  } else if (evt.key.toLowerCase() === "g" && !evt.ctrlKey && !evt.metaKey && !isTyping(evt)) {
    setTool("grid");
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
  } else if (evt.code === "Space" && !isTyping(evt) && !spacePanning) {
    evt.preventDefault();
    spacePanning = true;
    canvasScrollEl.classList.add("space-pan");
  } else if ((evt.ctrlKey || evt.metaKey) && (evt.key === "=" || evt.key === "+")) {
    evt.preventDefault();
    zoomIn();
  } else if ((evt.ctrlKey || evt.metaKey) && evt.key === "-") {
    evt.preventDefault();
    zoomOut();
  } else if ((evt.ctrlKey || evt.metaKey) && evt.key === "0") {
    evt.preventDefault();
    resetZoom();
  } else if (!evt.ctrlKey && !evt.metaKey && !isTyping(evt) && (evt.key === "=" || evt.key === "+")) {
    zoomIn();
  } else if (!evt.ctrlKey && !evt.metaKey && !isTyping(evt) && evt.key === "-") {
    zoomOut();
  }
});
document.addEventListener("keyup", evt => {
  if (evt.code === "Space") {
    spacePanning = false;
    canvasScrollEl.classList.remove("space-pan");
  }
});
function isTyping(evt) {
  return document.activeElement && ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName);
}

svg.addEventListener("mousedown", onStageMouseDown);
svg.addEventListener("mousemove", onStageMouseMove);
svg.addEventListener("mouseleave", () => { previewLayer.innerHTML = ""; });
svg.addEventListener("contextmenu", evt => { if (panDragCtx) evt.preventDefault(); });

document.getElementById("zoom-out-btn").addEventListener("click", () => zoomOut());
document.getElementById("zoom-in-btn").addEventListener("click", () => zoomIn());
document.getElementById("zoom-level-btn").addEventListener("click", () => resetZoom());
document.getElementById("zoom-fit-btn").addEventListener("click", () => fitToScreen());

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
  const curveA = curvesMarkup(state.curves);
  const curveB = curvesMarkup(computeBorderSegments());
  const curves = curveA.body + curveB.body;
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="${SVGNS}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n` +
    `<defs>${defs}${curveA.defs}${curveB.defs}</defs>\n` +
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
  pushHistory();
  setTool("curve");
  updateZoomUI();
  window.addEventListener("resize", render);
}

// Debug hook (harmless in normal use): lets the browser console, or a headless
// test harness, inspect and drive internal state directly.
if (typeof window !== "undefined") {
  window.__coeurf = {
    state, computeBorderSegments, buildFaces, splitCurvesAtIntersections, recomputeFaces, getFaces: () => facesCache,
    interiorSamplePoint, undo, redo, buildExportSVG, render, setSelection, saveToLocalStorage, loadFromLocalStorage,
  };
}

init();
