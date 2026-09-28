"use strict";
/* cœurf — grid-snapped cubic bezier editor.
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

/* ---------------------------------------------------------------------- */
/* Application state                                                       */
/* ---------------------------------------------------------------------- */

const state = {
  grid: { width: 800, height: 600, resolution: 20, borderColor: "#33363d", borderWidth: 2, visible: true, specialLines: { center: false, thirds: false, golden: false } },
  curves: [],        // {id, p0,c1,c2,p3, width, width2?, drift?, color, colorMode?, color2?, gradientAngle?}
  selection: null,    // {type:'curve', id} | {type:'curves', ids}
  tool: "curve",      // "page" | "grid" | "curve"
  curveIdCounter: 1,
};

let drawPending = null; // {x,y} snapped anchor while placing a new curve
let dragCtx = null;    // active drag context

// Which sub-panel the Page tool shows - purely a UI concern (like `zoom`),
// so it's kept out of `state` and never saved/undone.
let pageSubtool = "dimensions"; // "dimensions" | "border"

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
    curveIdCounter: state.curveIdCounter,
  }));
}

function pushHistory() {
  history.length = historyIndex + 1;
  history.push(cloneState());
  historyIndex = history.length - 1;
  updateUndoRedoButtons();
  autoSaveToLocalStorage();
}

function restoreFromSnapshot(snap) {
  state.grid = JSON.parse(JSON.stringify(snap.grid));
  if (state.grid.visible === undefined) state.grid.visible = true;
  if (!state.grid.specialLines) state.grid.specialLines = { center: false, thirds: false, golden: false };
  state.curves = JSON.parse(JSON.stringify(snap.curves));
  state.curveIdCounter = snap.curveIdCounter;
  state.selection = null;
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
/* Auto-save (localStorage)                                                */
/*                                                                          */
/* The design is persisted to the browser automatically on every change    */
/* (via pushHistory) and restored automatically on load - no explicit      */
/* save/load actions.                                                      */
/* ---------------------------------------------------------------------- */

const STORAGE_KEY = "coeurf:design:v1";

function autoSaveToLocalStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cloneState()));
  } catch (e) {
    // Ignore (e.g. private browsing / storage quota) - autosave is best-effort.
  }
}

// Restores the last autosaved design, if any, without touching history.
// Returns whether a design was found and restored.
function loadAutoSavedDesign() {
  let raw;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { raw = null; }
  if (!raw) return false;
  let snap;
  try { snap = JSON.parse(raw); } catch (e) { snap = null; }
  if (!snap || !snap.grid || !Array.isArray(snap.curves)) return false;
  restoreFromSnapshot(snap);
  return true;
}

// Parses `raw` as a design snapshot and, if valid, restores it and records
// history. Used by file import.
function restoreFromJSON(raw) {
  let snap;
  try { snap = JSON.parse(raw); } catch (e) { snap = null; }
  if (!snap || !snap.grid || !Array.isArray(snap.curves)) return false;
  restoreFromSnapshot(snap);
  pushHistory();
  return true;
}

function timestampForFilename() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function downloadDesign() {
  const json = JSON.stringify(cloneState(), null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `coeurf-${timestampForFilename()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showHint("Design downloaded.");
}

function importDesignFromFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    if (!restoreFromJSON(String(reader.result))) showHint("Imported file is invalid and could not be loaded.");
    else showHint("Design imported.");
  };
  reader.onerror = () => showHint("Could not read file.");
  reader.readAsText(file);
}

/* ---------------------------------------------------------------------- */
/* Border rendering                                                        */
/* ---------------------------------------------------------------------- */

const BORDER_GRADIENT_ID = "page-border-grad";

// Mirrors curvesMarkup's per-curve gradient handling (see gradientVector)
// for the page border, which is a single shared stroke rather than a
// per-item list, so it gets one fixed gradient id instead of one per id.
function borderFillInfo() {
  const g = state.grid;
  if (g.borderColorMode === "gradient" && g.borderColor2) {
    const v = gradientVector(g.borderGradientAngle || 0);
    const defs = `<linearGradient id="${BORDER_GRADIENT_ID}" x1="${v.x1}" y1="${v.y1}" x2="${v.x2}" y2="${v.y2}">` +
      `<stop offset="0%" stop-color="${g.borderColor}"/>` +
      `<stop offset="100%" stop-color="${g.borderColor2}"/>` +
      `</linearGradient>`;
    return { defs, paint: `url(#${BORDER_GRADIENT_ID})` };
  }
  return { defs: "", paint: g.borderColor };
}

function borderMarkup() {
  const { width: W, height: H, borderWidth } = state.grid;
  const { paint } = borderFillInfo();
  return `<rect x="0" y="0" width="${W}" height="${H}" fill="none" stroke="${paint}" stroke-width="${borderWidth}"></rect>`;
}

function fmt(n) { return Math.round(n * 100) / 100; }

/* ---------------------------------------------------------------------- */
/* Rendering                                                               */
/* ---------------------------------------------------------------------- */

const svg = document.getElementById("stage");
let gridLayer, curvesLayer, handlesLayer, previewLayer, defsLayer;

// Stacking order matters: curve strokes, then the grid (on top so toggling
// it is actually visible over any curve instead of being buried under it),
// then the draggable handles, then the hover-only draw preview on top of
// all of it.
function ensureLayers() {
  svg.innerHTML = "";
  defsLayer = document.createElementNS(SVGNS, "defs");
  curvesLayer = document.createElementNS(SVGNS, "g");
  curvesLayer.setAttribute("id", "layer-curves");
  gridLayer = document.createElementNS(SVGNS, "g");
  gridLayer.setAttribute("id", "layer-grid");
  gridLayer.style.pointerEvents = "none";
  handlesLayer = document.createElementNS(SVGNS, "g");
  handlesLayer.setAttribute("id", "layer-handles");
  previewLayer = document.createElementNS(SVGNS, "g");
  previewLayer.setAttribute("id", "layer-preview");
  previewLayer.style.pointerEvents = "none";
  svg.appendChild(defsLayer);
  svg.appendChild(curvesLayer);
  svg.appendChild(gridLayer);
  svg.appendChild(handlesLayer);
  svg.appendChild(previewLayer);
}

function gradientVector(angleDeg) {
  const rad = (angleDeg % 360) * Math.PI / 180;
  const dx = Math.cos(rad), dy = Math.sin(rad);
  return { x1: 0.5 - dx * 0.5, y1: 0.5 - dy * 0.5, x2: 0.5 + dx * 0.5, y2: 0.5 + dy * 0.5 };
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

// The selected curve used to be forced to a flat blue paint, which hid its
// actual color/gradient and made edits to it invisible until deselected.
// Instead, the real paint is always drawn, and selection is shown as a
// blurred halo of the accent color underneath it - visible without ever
// covering up the true appearance.
const CURVE_GLOW_FILTER = `<filter id="curve-glow" x="-60%" y="-60%" width="220%" height="220%">` +
  `<feGaussianBlur stdDeviation="2.5"/>` +
  `</filter>`;
const SELECTION_GLOW_COLOR = "#5b8cff";
const SELECTION_GLOW_OPACITY = 0.55;
const SELECTION_GLOW_EXTRA_WIDTH = 5;

// True when curve `id` is part of the current selection, whether that's a
// single-curve selection or a Shift-click multi-selection.
function isCurveSelected(id) {
  if (!state.selection) return false;
  if (state.selection.type === "curve") return state.selection.id === id;
  if (state.selection.type === "curves") return state.selection.ids.includes(id);
  return false;
}

function curvesMarkup(curves, includeSelection = true) {
  let defs = CURVE_GLOW_FILTER;
  let glowBody = "";
  let body = "";
  for (const c of curves) {
    const selected = includeSelection && isCurveSelected(c.id);
    const w0 = c.width;
    const w1 = c.width2 != null ? c.width2 : c.width;
    // The ribbon path is what carries the "drift" bulge (see
    // offsetBezierRail), so it's used whenever Taper is on - even with equal
    // start/end widths - so the Drift control still has something to act on.
    const tapered = c.width2 != null;
    const drift = c.drift != null ? c.drift : 1;

    let paint;
    if (c.colorMode === "gradient" && c.color2) {
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
      if (selected) {
        glowBody += `<g opacity="${SELECTION_GLOW_OPACITY}">` +
          `<path d="${ribbon.d}" fill="${SELECTION_GLOW_COLOR}" filter="url(#curve-glow)"></path>`;
        for (const cap of [ribbon.capStart, ribbon.capEnd]) {
          if (!cap) continue;
          glowBody += `<circle cx="${fmt(cap.x)}" cy="${fmt(cap.y)}" r="${fmt(cap.r)}" fill="${SELECTION_GLOW_COLOR}" filter="url(#curve-glow)"></circle>`;
        }
        glowBody += `</g>`;
      }
      body += `<path d="${ribbon.d}" fill="${paint}" data-curve-id="${escapeAttr(c.id)}"></path>`;
      for (const cap of [ribbon.capStart, ribbon.capEnd]) {
        if (!cap) continue;
        body += `<circle cx="${fmt(cap.x)}" cy="${fmt(cap.y)}" r="${fmt(cap.r)}" fill="${paint}" data-curve-id="${escapeAttr(c.id)}"></circle>`;
      }
    } else {
      const d = `M ${fmt(c.p0.x)} ${fmt(c.p0.y)} C ${fmt(c.c1.x)} ${fmt(c.c1.y)}, ${fmt(c.c2.x)} ${fmt(c.c2.y)}, ${fmt(c.p3.x)} ${fmt(c.p3.y)}`;
      if (selected) {
        glowBody += `<path d="${d}" fill="none" stroke="${SELECTION_GLOW_COLOR}" stroke-width="${w0 + SELECTION_GLOW_EXTRA_WIDTH}" stroke-linecap="round" filter="url(#curve-glow)" opacity="${SELECTION_GLOW_OPACITY}"></path>`;
      }
      body += `<path d="${d}" fill="none" stroke="${paint}" stroke-width="${w0}" stroke-linecap="round" data-curve-id="${escapeAttr(c.id)}"></path>`;
    }
  }
  return { defs, body: glowBody + body };
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

  const curveA = curvesMarkup(state.curves);
  defsLayer.innerHTML = curveA.defs + borderFillInfo().defs;
  curvesLayer.innerHTML = curveA.body + borderMarkup();

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
  if (state.grid.borderColorMode === "gradient") add(state.grid.borderColor2);
  for (const c of state.curves) {
    add(c.color);
    if (c.colorMode === "gradient") add(c.color2);
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
    panel.innerHTML = `<div class="panel-empty">Nothing selected.<br>Click an existing curve to select it, or click an empty grid point to draw one.</div>`;
    return;
  }
  if (state.selection.type === "curve") {
    renderCurvePanel();
  } else {
    renderMultiCurvePanel();
  }
}

// Multiple curves selected via Shift-click: kept deliberately limited to
// move (via drag, handled in the pointer handlers) and delete - editing
// per-curve properties (color, width, ...) for a mixed group has no single
// obvious value to show, so that's left to single-curve selection for now.
// Moves the selected curve(s) within state.curves, which doubles as their
// paint order (see curvesMarkup) - later entries draw on top. "forward" and
// "backward" swap each selected curve past its one non-selected neighbor on
// that side, processing from the topmost/bottommost index inward so a
// contiguous selection moves as a single block instead of interleaving.
function reorderSelection(direction) {
  if (!state.selection) return;
  const ids = state.selection.type === "curve" ? [state.selection.id]
    : state.selection.type === "curves" ? state.selection.ids
    : null;
  if (!ids || !ids.length) return;
  const idSet = new Set(ids);
  const curves = state.curves;

  if (direction === "front" || direction === "back") {
    const selected = curves.filter(c => idSet.has(c.id));
    const rest = curves.filter(c => !idSet.has(c.id));
    state.curves = direction === "front" ? rest.concat(selected) : selected.concat(rest);
  } else if (direction === "forward") {
    for (let i = curves.length - 2; i >= 0; i--) {
      if (idSet.has(curves[i].id) && !idSet.has(curves[i + 1].id)) {
        [curves[i], curves[i + 1]] = [curves[i + 1], curves[i]];
      }
    }
  } else if (direction === "backward") {
    for (let i = 1; i < curves.length; i++) {
      if (idSet.has(curves[i].id) && !idSet.has(curves[i - 1].id)) {
        [curves[i - 1], curves[i]] = [curves[i], curves[i - 1]];
      }
    }
  }
  renderCanvas();
  pushHistory();
}

function renderMultiCurvePanel() {
  const ids = state.selection.ids;
  const count = ids.filter(id => state.curves.some(cv => cv.id === id)).length;
  panel.innerHTML = `
    <div class="panel-empty">${count} curves selected.<br>Drag to move them together, or press Delete to remove them.</div>
    <div class="panel-section" style="margin-top:16px">
      <div class="action-row">
        <button class="icon-btn" id="f-to-front-multi" title="Bring to front (Shift+])">${ICON_TO_FRONT}</button>
        <button class="icon-btn" id="f-forward-multi" title="Bring forward (])">${ICON_FORWARD}</button>
        <button class="icon-btn" id="f-backward-multi" title="Send backward ([)">${ICON_BACKWARD}</button>
        <button class="icon-btn" id="f-to-back-multi" title="Send to back (Shift+[)">${ICON_TO_BACK}</button>
      </div>
      <div class="action-row">
        <button class="icon-btn danger" id="f-delete-multi" title="Delete all selected curves permanently.">${ICON_TRASH}</button>
      </div>
    </div>
  `;
  document.getElementById("f-to-front-multi").addEventListener("click", () => reorderSelection("front"));
  document.getElementById("f-forward-multi").addEventListener("click", () => reorderSelection("forward"));
  document.getElementById("f-backward-multi").addEventListener("click", () => reorderSelection("backward"));
  document.getElementById("f-to-back-multi").addEventListener("click", () => reorderSelection("back"));
  document.getElementById("f-delete-multi").addEventListener("click", () => {
    const idSet = new Set(ids);
    state.curves = state.curves.filter(cv => !idSet.has(cv.id));
    state.selection = null;
    render();
    pushHistory();
  });
}

function renderPagePanel() {
  const isBorder = pageSubtool === "border";
  panel.innerHTML = `
    <div class="seg">
      <button id="pg-sub-dim" class="${!isBorder ? "active" : ""}">Dimensions</button>
      <button id="pg-sub-border" class="${isBorder ? "active" : ""}">Border</button>
    </div>
    <div id="page-subtool-body"></div>
  `;
  document.getElementById("pg-sub-dim").addEventListener("click", () => {
    if (pageSubtool === "dimensions") return;
    pageSubtool = "dimensions";
    renderPagePanel();
  });
  document.getElementById("pg-sub-border").addEventListener("click", () => {
    if (pageSubtool === "border") return;
    pageSubtool = "border";
    renderPagePanel();
  });
  if (isBorder) renderPageBorderFields(); else renderPageDimensionsFields();
}

function renderPageDimensionsFields() {
  const g = state.grid;
  document.getElementById("page-subtool-body").innerHTML = `
    <div class="panel-section">
      <div class="field-row"><label>Width</label><input type="number" min="20" step="1" id="p-width" value="${g.width}"></div>
      <div class="field-row"><label>Height</label><input type="number" min="20" step="1" id="p-height" value="${g.height}"></div>
    </div>
  `;
  const applyDimFields = () => {
    const w = Math.max(20, parseInt(document.getElementById("p-width").value, 10) || state.grid.width);
    const h = Math.max(20, parseInt(document.getElementById("p-height").value, 10) || state.grid.height);
    state.grid.width = w;
    state.grid.height = h;
    render();
    pushHistory();
  };
  for (const id of ["p-width", "p-height"]) {
    document.getElementById(id).addEventListener("change", applyDimFields);
  }
}

// Fill section mirrors renderCurvePanel's Solid/Gradient toggle (see
// paintSolidFields/paintGradientFields there) - kept as its own copy rather
// than shared, since the target here is state.grid.border* fields rather
// than a curve object.
function renderPageBorderFields() {
  const g = state.grid;
  const isGrad = g.borderColorMode === "gradient";
  document.getElementById("page-subtool-body").innerHTML = `
    <div class="panel-section">
      <h3>Fill</h3>
      <div class="seg">
        <button id="pb-solid" class="${!isGrad ? "active" : ""}">Solid</button>
        <button id="pb-grad" class="${isGrad ? "active" : ""}">Gradient</button>
      </div>
      <div id="border-color-fields"></div>
    </div>
    <div class="panel-section">
      <h3>Width</h3>
      <div class="field-row"><label>Border width</label><input type="number" min="0" step="0.5" id="p-bwidth" value="${g.borderWidth}"></div>
    </div>
  `;

  const colorFields = document.getElementById("border-color-fields");

  function paintSolidFields() {
    colorFields.innerHTML = `
      <div class="field-row">
        <label>Color</label>
        <input type="color" id="p-bcolor" value="${g.borderColor}">
      </div>
      ${swatchesMarkup()}
    `;
    const input = document.getElementById("p-bcolor");
    input.addEventListener("input", e => {
      state.grid.borderColor = e.target.value;
      renderCanvas();
    });
    input.addEventListener("change", () => pushHistory());
    wireSwatches(colorFields, input);
  }

  function paintGradientFields() {
    colorFields.innerHTML = `
      <div class="gradient-preview" id="pb-gpreview"></div>
      <div class="field-row">
        <label>Start</label>
        <input type="color" id="p-bcolor" value="${g.borderColor}">
      </div>
      ${swatchesMarkup()}
      <div class="field-row">
        <label>End</label>
        <input type="color" id="p-bcolor2" value="${g.borderColor2}">
      </div>
      ${swatchesMarkup()}
      <div class="field-row">
        <label>Angle</label>
        <input type="range" id="p-bangle" min="0" max="359" step="1" value="${g.borderGradientAngle}">
        <input type="number" class="num-in" id="p-bangle-num" min="0" max="359" step="1" value="${g.borderGradientAngle}">
        <span class="unit">&deg;</span>
      </div>
    `;
    const updatePreview = () => {
      document.getElementById("pb-gpreview").style.background =
        `linear-gradient(${state.grid.borderGradientAngle}deg, ${document.getElementById("p-bcolor").value}, ${document.getElementById("p-bcolor2").value})`;
    };
    updatePreview();
    const c1Input = document.getElementById("p-bcolor");
    const c2Input = document.getElementById("p-bcolor2");
    c1Input.addEventListener("input", e => {
      state.grid.borderColor = e.target.value;
      updatePreview(); renderCanvas();
    });
    c1Input.addEventListener("change", () => pushHistory());
    c2Input.addEventListener("input", e => {
      state.grid.borderColor2 = e.target.value;
      updatePreview(); renderCanvas();
    });
    c2Input.addEventListener("change", () => pushHistory());
    const swatchBlocks = colorFields.querySelectorAll(".swatches");
    wireSwatches(swatchBlocks[0], c1Input);
    wireSwatches(swatchBlocks[1], c2Input);
    const angleInput = document.getElementById("p-bangle");
    const angleNum = document.getElementById("p-bangle-num");
    angleInput.addEventListener("input", e => {
      state.grid.borderGradientAngle = parseInt(e.target.value, 10);
      angleNum.value = state.grid.borderGradientAngle;
      updatePreview(); renderCanvas();
    });
    angleInput.addEventListener("change", () => pushHistory());
    angleNum.addEventListener("input", e => {
      const v = parseInt(e.target.value, 10);
      if (!Number.isFinite(v)) return;
      state.grid.borderGradientAngle = v;
      angleInput.value = v;
      updatePreview(); renderCanvas();
    });
    angleNum.addEventListener("change", e => {
      const v = Math.max(0, Math.min(359, parseInt(e.target.value, 10) || 0));
      state.grid.borderGradientAngle = v;
      e.target.value = v;
      angleInput.value = v;
      updatePreview(); renderCanvas();
      pushHistory();
    });
  }

  if (isGrad) paintGradientFields(); else paintSolidFields();

  document.getElementById("pb-solid").addEventListener("click", () => {
    if (state.grid.borderColorMode !== "gradient") return;
    state.grid.borderColorMode = "solid";
    renderPageBorderFields(); renderCanvas(); pushHistory();
  });
  document.getElementById("pb-grad").addEventListener("click", () => {
    if (state.grid.borderColorMode === "gradient") return;
    state.grid.borderColorMode = "gradient";
    state.grid.borderColor2 = state.grid.borderColor2 || "#5b8cff";
    state.grid.borderGradientAngle = state.grid.borderGradientAngle != null ? state.grid.borderGradientAngle : 90;
    renderPageBorderFields(); renderCanvas(); pushHistory();
  });

  document.getElementById("p-bwidth").addEventListener("change", () => {
    state.grid.borderWidth = parseFloat(document.getElementById("p-bwidth").value) || 0;
    renderCanvas();
    pushHistory();
  });
}

const SPECIAL_LINE_LABELS = { center: "Center", thirds: "Thirds", golden: "Golden ratio" };

function renderGridPanel() {
  const g = state.grid;
  const specialRows = Object.keys(SPECIAL_LINE_LABELS).map(key =>
    `<div class="field-row"><label>${SPECIAL_LINE_LABELS[key]}</label><input type="checkbox" class="g-special" data-key="${key}" ${g.specialLines[key] ? "checked" : ""}></div>`
  ).join("");
  panel.innerHTML = `
    <div class="panel-section">
      <div class="field-row"><label>Visible</label><input type="checkbox" id="g-visible" ${g.visible ? "checked" : ""}></div>
      <div class="field-row"><label>Resolution</label><input type="number" min="2" step="1" id="g-res" value="${g.resolution}"></div>
    </div>
    <div class="panel-section">
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

const ICON_ATTRS = `viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"`;
const ICON_MIRROR_SELF = `<svg ${ICON_ATTRS}><path d="M4 12c4-7 12-7 16 0"/><path d="M4 12c4 7 12 7 16 0"/><line x1="4" y1="12" x2="20" y2="12" stroke-dasharray="2.5 2.5"/></svg>`;
const ICON_FLIP_V = `<svg ${ICON_ATTRS}><line x1="3" y1="12" x2="21" y2="12" stroke-dasharray="2.5 2.5"/><path d="M12 3l-4 4M12 3l4 4"/><path d="M12 21l-4-4M12 21l4-4"/></svg>`;
const ICON_FLIP_H = `<svg ${ICON_ATTRS}><line x1="12" y1="3" x2="12" y2="21" stroke-dasharray="2.5 2.5"/><path d="M3 12l4-4M3 12l4 4"/><path d="M21 12l-4-4M21 12l-4 4"/></svg>`;
const ICON_TRASH = `<svg ${ICON_ATTRS}><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/></svg>`;
const ICON_TO_FRONT = `<svg ${ICON_ATTRS}><path d="M6 17l6-6 6 6"/><path d="M6 10l6-6 6 6"/></svg>`;
const ICON_FORWARD = `<svg ${ICON_ATTRS}><path d="M6 15l6-6 6 6"/></svg>`;
const ICON_BACKWARD = `<svg ${ICON_ATTRS}><path d="M6 9l6 6 6-6"/></svg>`;
const ICON_TO_BACK = `<svg ${ICON_ATTRS}><path d="M6 7l6 6 6-6"/><path d="M6 14l6 6 6-6"/></svg>`;

function renderCurvePanel() {
  const c = state.curves.find(cv => cv.id === state.selection.id);
  if (!c) { state.selection = null; renderPanel(); return; }
  const isGrad = c.colorMode === "gradient";
  const isTapered = c.width2 != null;
  panel.innerHTML = `
    <div class="panel-section">
      <h3>Fill</h3>
      <div class="seg">
        <button id="c-solid" class="${!isGrad ? "active" : ""}">Solid</button>
        <button id="c-grad" class="${isGrad ? "active" : ""}">Gradient</button>
      </div>
      <div id="color-fields"></div>
    </div>
    <div class="panel-section">
      <h3>Width</h3>
      <div class="field-row">
        <label>${isTapered ? "Start width" : "Width"}</label>
        <input type="range" id="f-width" min="0.5" max="30" step="0.5" value="${c.width}">
        <input type="number" class="num-in" id="f-width-num" min="0.5" max="30" step="0.5" value="${c.width}">
      </div>
      <div class="field-row"><label>Taper</label><input type="checkbox" id="f-taper" ${isTapered ? "checked" : ""}></div>
      <div id="taper-fields"></div>
    </div>
    <div class="panel-section">
      <h3>Actions</h3>
      <div class="action-row">
        <button class="icon-btn" id="f-to-front" title="Bring to front (Shift+])">${ICON_TO_FRONT}</button>
        <button class="icon-btn" id="f-forward" title="Bring forward (])">${ICON_FORWARD}</button>
        <button class="icon-btn" id="f-backward" title="Send backward ([)">${ICON_BACKWARD}</button>
        <button class="icon-btn" id="f-to-back" title="Send to back (Shift+[)">${ICON_TO_BACK}</button>
      </div>
      <div class="action-row">
        <button class="icon-btn" id="f-mirror" title="Mirror copy: add a new curve reflected across the straight line joining this curve's two endpoints, forming a symmetric lens shape.">${ICON_MIRROR_SELF}</button>
        <button class="icon-btn" id="f-mirror-h" title="Mirror horizontal axis: add a new curve flipped top-to-bottom across the page's horizontal centerline.">${ICON_FLIP_V}</button>
        <button class="icon-btn" id="f-mirror-v" title="Mirror vertical axis: add a new curve flipped left-to-right across the page's vertical centerline.">${ICON_FLIP_H}</button>
        <button class="icon-btn danger" id="f-delete" title="Delete this curve permanently.">${ICON_TRASH}</button>
      </div>
    </div>
  `;
  document.getElementById("f-to-front").addEventListener("click", () => reorderSelection("front"));
  document.getElementById("f-forward").addEventListener("click", () => reorderSelection("forward"));
  document.getElementById("f-backward").addEventListener("click", () => reorderSelection("backward"));
  document.getElementById("f-to-back").addEventListener("click", () => reorderSelection("back"));

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
    setSelection({ type: "curve", id: mirrored.id });
    pushHistory();
  });

  document.getElementById("f-mirror-h").addEventListener("click", () => {
    const mirrored = mirrorCurveHorizontalAxis(c);
    state.curves.push(mirrored);
    setSelection({ type: "curve", id: mirrored.id });
    pushHistory();
  });

  document.getElementById("f-mirror-v").addEventListener("click", () => {
    const mirrored = mirrorCurveVerticalAxis(c);
    state.curves.push(mirrored);
    setSelection({ type: "curve", id: mirrored.id });
    pushHistory();
  });

  document.getElementById("f-delete").addEventListener("click", () => {
    state.curves = state.curves.filter(cv => cv.id !== c.id);
    state.selection = null;
    render();
    pushHistory();
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
    const flat = flattenCubic(c.p0, c.c1, c.c2, c.p3, FLATTEN_SEGMENTS);
    const d = distToPolyline(pt, flat);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
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

// Shift-click toggles one curve's membership in the selection, growing a
// single-curve selection into a "curves" multi-selection (or shrinking one
// back down to a plain single-curve selection, or clearing it entirely).
function toggleCurveInSelection(id) {
  let ids;
  if (state.selection && state.selection.type === "curve") {
    ids = state.selection.id === id ? [] : [state.selection.id, id];
  } else if (state.selection && state.selection.type === "curves") {
    ids = state.selection.ids.includes(id)
      ? state.selection.ids.filter(x => x !== id)
      : state.selection.ids.concat(id);
  } else {
    ids = [id];
  }
  if (ids.length === 0) setSelection(null);
  else if (ids.length === 1) setSelection({ type: "curve", id: ids[0] });
  else setSelection({ type: "curves", ids });
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
  return { id, p0: { ...p0 }, c1: reflect(c.c1), c2: reflect(c.c2), p3: { ...p3 },
    width: c.width, width2: c.width2, drift: c.drift, color: c.color,
    colorMode: c.colorMode, color2: c.color2, gradientAngle: c.gradientAngle };
}

// Mirrors a curve across the page's horizontal center axis (flips top/bottom).
function mirrorCurveHorizontalAxis(c) {
  const H = state.grid.height;
  const reflect = p => ({ x: p.x, y: H - p.y });
  const id = "c" + (state.curveIdCounter++);
  return { id, p0: reflect(c.p0), c1: reflect(c.c1), c2: reflect(c.c2), p3: reflect(c.p3),
    width: c.width, width2: c.width2, drift: c.drift, color: c.color,
    colorMode: c.colorMode, color2: c.color2, gradientAngle: c.gradientAngle };
}

// Mirrors a curve across the page's vertical center axis (flips left/right).
function mirrorCurveVerticalAxis(c) {
  const W = state.grid.width;
  const reflect = p => ({ x: W - p.x, y: p.y });
  const id = "c" + (state.curveIdCounter++);
  return { id, p0: reflect(c.p0), c1: reflect(c.c1), c2: reflect(c.c2), p3: reflect(c.p3),
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

  // curve tool: selecting/dragging existing curves takes priority over
  // starting a new one, except while a draw is already in progress, where
  // the click always finishes/connects it (never reinterpreted as a select).
  if (drawPending) {
    const p = snapForDrawing(evt);
    const { c1, c2 } = defaultCurveBetween(drawPending, p, state.grid.resolution);
    const id = "c" + (state.curveIdCounter++);
    const curve = { id, p0: { ...drawPending }, c1, c2, p3: { ...p }, width: 3, color: "#2a2d34" };
    state.curves.push(curve);
    drawPending = null;
    hideHint();
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
    if (evt.shiftKey) {
      toggleCurveInSelection(curveHit.id);
      return;
    }
    // Clicking a curve that's already part of a multi-selection drags the
    // whole group; clicking any other curve replaces the selection with just
    // that one, same as before Shift-selection existed.
    let idsToMove;
    if (state.selection && state.selection.type === "curves" && state.selection.ids.includes(curveHit.id)) {
      idsToMove = state.selection.ids.slice();
    } else {
      setSelection({ type: "curve", id: curveHit.id });
      idsToMove = [curveHit.id];
    }
    const curves = idsToMove.map(id => state.curves.find(cv => cv.id === id)).filter(Boolean);
    dragCtx = {
      kind: "curve",
      curves,
      clickedId: curveHit.id,
      start: pt,
      moved: false,
      orig: curves.map(c => ({ p0: { ...c.p0 }, c1: { ...c.c1 }, c2: { ...c.c2 }, p3: { ...c.p3 } })),
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
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const o of orig) {
      for (const p of [o.p0, o.c1, o.c2, o.p3]) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
    }
    let dx = Math.round((raw.x - dragCtx.start.x) / res) * res;
    let dy = Math.round((raw.y - dragCtx.start.y) / res) * res;
    dx = Math.max(-minX, Math.min(W - maxX, dx));
    dy = Math.max(-minY, Math.min(H - maxY, dy));
    dragCtx.moved = dx !== 0 || dy !== 0;
    dragCtx.curves.forEach((c, i) => {
      const o = orig[i];
      c.p0 = { x: o.p0.x + dx, y: o.p0.y + dy };
      c.c1 = { x: o.c1.x + dx, y: o.c1.y + dy };
      c.c2 = { x: o.c2.x + dx, y: o.c2.y + dy };
      c.p3 = { x: o.p3.x + dx, y: o.p3.y + dy };
    });
    renderHandles();
    curvesLayer.innerHTML = curvesMarkup(state.curves).body + borderMarkup();
    return;
  }
  const raw = toSvgPoint(evt);
  const tol = 11 / currentScale();
  const near = findNearVertex(raw, tol);
  const p = near || snapToGrid(raw.x, raw.y, state.grid.resolution, state.grid.width, state.grid.height);
  dragCtx.curve[dragCtx.key] = p;
  renderHandles();
  curvesLayer.innerHTML = curvesMarkup(state.curves).body + borderMarkup();
}

function onWindowMouseUp() {
  if (!dragCtx) return;
  const wasNoOpCurveDrag = dragCtx.kind === "curve" && !dragCtx.moved;
  // A plain click (no drag) on one member of a multi-selection re-focuses
  // just that curve, so it can be selected individually without Shift.
  if (wasNoOpCurveDrag && dragCtx.curves.length > 1) {
    setSelection({ type: "curve", id: dragCtx.clickedId });
  }
  dragCtx = null;
  window.removeEventListener("mousemove", onWindowMouseMove);
  window.removeEventListener("mouseup", onWindowMouseUp);
  if (state.tool === "curve") svg.style.cursor = "default";
  if (wasNoOpCurveDrag) return;
  render();
  pushHistory();
}

// Drawn into previewLayer, never handlesLayer, so this hover-only feedback
// can never overwrite the selected curve's actual drag handles underneath it.
function onStageMouseMove(evt) {
  if (spacePanning) { previewLayer.innerHTML = ""; return; }
  if (state.tool === "curve" && !dragCtx) {
    const s = currentScale();
    const rA = 7 / s, lw = 1 / s;
    if (drawPending) {
      const p = snapForDrawing(evt);
      const { c1, c2 } = defaultCurveBetween(drawPending, p, state.grid.resolution);
      const preview = `M ${drawPending.x} ${drawPending.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p.x} ${p.y}`;
      previewLayer.innerHTML =
        `<circle cx="${drawPending.x}" cy="${drawPending.y}" r="${rA}" fill="#2ecc71" stroke="#1b1d22" stroke-width="${lw}"></circle>` +
        `<path d="${preview}" fill="none" stroke="#5b8cff" stroke-width="${1.6/s}" stroke-dasharray="${4/s},${3/s}"></path>` +
        `<circle cx="${p.x}" cy="${p.y}" r="${rA}" fill="#e6453c" stroke="#1b1d22" stroke-width="${lw}" opacity="0.6"></circle>`;
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
      `<circle cx="${p.x}" cy="${p.y}" r="${rA}" fill="#2ecc71" stroke="#1b1d22" stroke-width="${lw}" opacity="0.6"></circle>`;
    return;
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
  svg.style.cursor = "default";
  if (tool === "curve") {
    showHint("Click an existing curve to select it, or an empty grid point to draw a new one.", true);
  }
  render();
}

document.getElementById("tool-page").addEventListener("click", () => setTool("page"));
document.getElementById("tool-grid").addEventListener("click", () => setTool("grid"));
document.getElementById("tool-curve").addEventListener("click", () => setTool("curve"));

document.addEventListener("keydown", evt => {
  if (evt.key === "Escape") {
    if (drawPending) { drawPending = null; hideHint(); renderHandles(); }
    else if (state.selection) { state.selection = null; render(); }
  } else if ((evt.key === "Delete" || evt.key === "Backspace") && state.selection &&
      (state.selection.type === "curve" || state.selection.type === "curves")) {
    if (document.activeElement && ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
    const idSet = new Set(state.selection.type === "curve" ? [state.selection.id] : state.selection.ids);
    state.curves = state.curves.filter(cv => !idSet.has(cv.id));
    state.selection = null;
    render(); pushHistory();
  } else if ((evt.key === "]" || evt.key === "}") && !evt.ctrlKey && !evt.metaKey && !isTyping(evt) &&
      state.selection && (state.selection.type === "curve" || state.selection.type === "curves")) {
    reorderSelection(evt.shiftKey || evt.key === "}" ? "front" : "forward");
  } else if ((evt.key === "[" || evt.key === "{") && !evt.ctrlKey && !evt.metaKey && !isTyping(evt) &&
      state.selection && (state.selection.type === "curve" || state.selection.type === "curves")) {
    reorderSelection(evt.shiftKey || evt.key === "{" ? "back" : "backward");
  } else if (evt.key.toLowerCase() === "c" && !evt.ctrlKey && !evt.metaKey && !isTyping(evt)) {
    setTool("curve");
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
document.getElementById("download-btn").addEventListener("click", downloadDesign);
document.getElementById("import-btn").addEventListener("click", () => document.getElementById("import-input").click());
document.getElementById("import-input").addEventListener("change", evt => {
  const file = evt.target.files[0];
  if (file) importDesignFromFile(file);
  evt.target.value = "";
});

/* ---------------------------------------------------------------------- */
/* Export                                                                   */
/* ---------------------------------------------------------------------- */

function buildExportSVG() {
  const { width: W, height: H } = state.grid;
  const curveA = curvesMarkup(state.curves, false);
  const curves = curveA.body + borderMarkup();
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="${SVGNS}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n` +
    `<defs>${curveA.defs}${borderFillInfo().defs}</defs>\n` +
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
  loadAutoSavedDesign();
  pushHistory();
  setTool("curve");
  fitToScreen();
  window.addEventListener("resize", render);
}

init();
