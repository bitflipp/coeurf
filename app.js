"use strict";
/* cœurf — cubic bezier editor with anchor-based snapping.
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
/* Anchors & links                                                         */
/*                                                                          */
/* Every curve carries anchors: points addressed by `s`, the fraction of    */
/* the curve's arc length (0 = p0, 1 = p3), so they stay put along the     */
/* curve as it is reshaped. The "start" and "end" anchors are fixed to the  */
/* endpoints; any others are free to slide. An endpoint of another curve    */
/* can be linked to an anchor (`curve.links.p0 / p3 = {curve, anchor}`) and */
/* then follows it for good. An anchor flagged `tangent` also forces the    */
/* linked curve's adjacent control point onto the anchor's tangent line.    */
/* ---------------------------------------------------------------------- */

const ARC_SAMPLES = 100;
const LINK_EPS = 1e-6;

function arcTable(c) {
  const pts = [c.p0], cum = [0];
  for (let i = 1; i <= ARC_SAMPLES; i++) {
    const p = cubicPoint(c.p0, c.c1, c.c2, c.p3, i / ARC_SAMPLES);
    const q = pts[i - 1];
    pts.push(p);
    cum.push(cum[i - 1] + Math.hypot(p.x - q.x, p.y - q.y));
  }
  return { pts, cum, total: cum[ARC_SAMPLES] };
}

function tAtS(table, s) {
  const { cum, total } = table;
  if (total < 1e-9) return s;
  const target = Math.max(0, Math.min(1, s)) * total;
  let i = 0;
  while (i < ARC_SAMPLES - 1 && cum[i + 1] < target) i++;
  const seg = cum[i + 1] - cum[i];
  const f = seg > 1e-12 ? (target - cum[i]) / seg : 0;
  return (i + f) / ARC_SAMPLES;
}

// Position and unit tangent (in the direction of increasing s) at arc-length
// fraction `s`.
function curveFrame(c, s) {
  const t = tAtS(arcTable(c), s);
  const pt = s <= 0 ? c.p0 : s >= 1 ? c.p3 : cubicPoint(c.p0, c.c1, c.c2, c.p3, t);
  // Tangents vanish at an endpoint whose control point sits on it; sample a
  // hair inside instead, and fall back to the chord for fully degenerate curves.
  const tt = Math.max(1e-3, Math.min(1 - 1e-3, t));
  let tan = cubicTangent(c.p0, c.c1, c.c2, c.p3, tt);
  let len = Math.hypot(tan.x, tan.y);
  if (len < 1e-9) {
    tan = { x: c.p3.x - c.p0.x, y: c.p3.y - c.p0.y };
    len = Math.hypot(tan.x, tan.y);
  }
  if (len < 1e-9) return { x: pt.x, y: pt.y, tx: 1, ty: 0 };
  return { x: pt.x, y: pt.y, tx: tan.x / len, ty: tan.y / len };
}

// Arc-length fraction of the point on the curve nearest to `pt`.
function nearestS(c, pt) {
  const { pts, cum, total } = arcTable(c);
  if (total < 1e-9) return 0;
  let best = 0, bestD = Infinity;
  for (let i = 0; i < ARC_SAMPLES; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    const f = lenSq > 1e-12 ? Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / lenSq)) : 0;
    const d = Math.hypot(pt.x - (a.x + f * dx), pt.y - (a.y + f * dy));
    if (d < bestD) { bestD = d; best = (cum[i] + f * Math.sqrt(lenSq)) / total; }
  }
  return best;
}

function isEndAnchor(a) { return a.id === "start" || a.id === "end"; }

// Guarantees the start/end anchors exist and keeps the list ordered
// (start, free anchors by position, end). Also covers designs saved before
// anchors existed.
function ensureAnchors(c) {
  const list = Array.isArray(c.anchors) ? c.anchors : [];
  const free = list.filter(a => !isEndAnchor(a)).sort((a, b) => a.s - b.s);
  c.anchors = [{ id: "start", s: 0 }, ...free, { id: "end", s: 1 }];
  for (const a of c.anchors) {
    if (a.tangent) a.tangent = true; else delete a.tangent;
  }
  return c;
}

function nextAnchorId(c) {
  let n = 0;
  for (const a of c.anchors) {
    const m = /^a(\d+)$/.exec(a.id);
    if (m) n = Math.max(n, parseInt(m[1], 10));
  }
  return "a" + (n + 1);
}

function addAnchor(c, s) {
  const a = { id: nextAnchorId(c), s: Math.max(0.001, Math.min(0.999, s)) };
  c.anchors.push(a);
  ensureAnchors(c);
  return a;
}

// Replaces the free anchors with `n - 1` evenly spaced ones (n divisions).
// Existing ids are reused in order so links stay attached, just relocated.
function setEvenAnchors(c, n) {
  const old = c.anchors.filter(a => !isEndAnchor(a));
  c.anchors = [c.anchors[0], c.anchors[c.anchors.length - 1]];
  for (let i = 1; i < n; i++) {
    const prev = old[i - 1];
    c.anchors.push(prev ? { ...prev, s: i / n } : { id: nextAnchorId(c), s: i / n });
  }
  ensureAnchors(c);
}

// Reverses a curve's direction: start and end swap places, together with
// their control points, widths, anchors and links, so it looks identical.
// Links on other curves that point at this curve's start/end anchors are
// retargeted so those curves stay attached to the same spot.
function flipCurve(c) {
  [c.p0, c.p3] = [c.p3, c.p0];
  [c.c1, c.c2] = [c.c2, c.c1];
  if (c.width2 != null) [c.width, c.width2] = [c.width2, c.width];
  for (const a of c.anchors) {
    a.s = 1 - a.s;
    if (a.id === "start") a.id = "end"; else if (a.id === "end") a.id = "start";
  }
  ensureAnchors(c);
  if (c.links) {
    const { p0, p3 } = c.links;
    delete c.links;
    if (p3) setLink(c, "p0", p3);
    if (p0) setLink(c, "p3", p0);
  }
  for (const o of state.curves) {
    if (!o.links) continue;
    for (const end of ["p0", "p3"]) {
      const l = o.links[end];
      if (l && l.curve === c.id) {
        if (l.anchor === "start") l.anchor = "end"; else if (l.anchor === "end") l.anchor = "start";
      }
    }
  }
}

function linkedAnchor(c, end) {
  const l = c.links && c.links[end];
  if (!l) return null;
  const host = state.curves.find(h => h.id === l.curve);
  const anchor = host && host !== c ? host.anchors.find(a => a.id === l.anchor) : null;
  return anchor ? { host, anchor } : null;
}

function setLink(c, end, link) {
  if (link) {
    c.links = c.links || {};
    c.links[end] = { curve: link.curve, anchor: link.anchor };
  } else if (c.links) {
    delete c.links[end];
    if (!c.links.p0 && !c.links.p3) delete c.links;
  }
}

// Pulls every linked endpoint onto its anchor, carrying the adjacent control
// point along (so the curve is translated at that end, not stretched), then
// settles tangent-locked controls. Hosts may themselves be linked, so repeat
// until stable; dangling links (deleted curve/anchor) are dropped.
function resolveLinks() {
  for (let pass = 0; pass <= state.curves.length; pass++) {
    let changed = syncInstances();
    for (const c of state.curves) {
      if (!c.links) continue;
      for (const end of ["p0", "p3"]) {
        if (!c.links[end]) continue;
        const la = linkedAnchor(c, end);
        if (!la) { setLink(c, end, null); continue; }
        const f = curveFrame(la.host, la.anchor.s);
        const ctrl = end === "p0" ? "c1" : "c2";
        const dx = f.x - c[end].x, dy = f.y - c[end].y;
        if (Math.abs(dx) > LINK_EPS || Math.abs(dy) > LINK_EPS) {
          c[end] = { x: f.x, y: f.y };
          c[ctrl] = { x: c[ctrl].x + dx, y: c[ctrl].y + dy };
          changed = true;
        }
        if (la.anchor.tangent) {
          const vx = c[ctrl].x - c[end].x, vy = c[ctrl].y - c[end].y;
          const d = vx * f.tx + vy * f.ty;
          let sign = d >= 0 ? 1 : -1, len = Math.abs(d);
          if (len < 1e-6) {
            // Control point sits on (or square to) the endpoint: give it a
            // default reach pointing away from the curve's body.
            len = Math.hypot(c.p3.x - c.p0.x, c.p3.y - c.p0.y) / 3 || 20;
            sign = end === "p0" ? 1 : -1;
          }
          const nx = c[end].x + sign * len * f.tx, ny = c[end].y + sign * len * f.ty;
          if (Math.abs(nx - c[ctrl].x) > LINK_EPS || Math.abs(ny - c[ctrl].y) > LINK_EPS) {
            c[ctrl] = { x: nx, y: ny };
            changed = true;
          }
        }
      }
    }
    if (!changed) break;
  }
}

/* ---------------------------------------------------------------------- */
/* Symbols & instances                                                     */
/*                                                                          */
/* A symbol is a set of ordinary "template" curves plus two pins (anchors on  */
/* them). An instance places the symbol between two points a and b by a     */
/* similarity transform (rotate + uniform scale, optionally mirrored across */
/* the pin chord), so moving a pin rotates and scales the whole instance.   */
/* Instances are materialized as read-only curves in state.curves (flagged  */
/* `inst`, `ix`) so rendering, export and anchor snapping need no special   */
/* cases; syncInstances() regenerates them from the templates. Each pin can   */
/* be linked to an anchor like a curve endpoint (`inst.links.a / b`).       */
/* ---------------------------------------------------------------------- */

const INSTANCE_STYLE_KEYS = ["width", "width2", "drift", "color", "colorMode", "stops", "gradientAngle", "opacity", "opacityMode", "opacityStops", "opacityAngle"];

function symbolPins(sym) {
  const pin = p => {
    const host = state.curves.find(c => c.id === p.curve);
    const anchor = host && !host.inst && host.anchors.find(a => a.id === p.anchor);
    return anchor ? curveFrame(host, anchor.s) : null;
  };
  const a = pin(sym.pinA), b = pin(sym.pinB);
  return a && b && Math.hypot(b.x - a.x, b.y - a.y) > 1e-6 ? { a, b } : null;
}

function symbolTemplates(sym) {
  const templates = sym.curves.map(id => state.curves.find(c => c.id === id));
  return templates.every(c => c && !c.inst) ? templates : null;
}

// Curves for an instance of `sym` between points a and b. `idPrefix` makes
// the ids stable across rebuilds, so links to an instance's anchors survive.
function buildInstanceCurves(sym, a, b, flip, idPrefix, instId) {
  const pins = symbolPins(sym), templates = symbolTemplates(sym);
  if (!pins || !templates) return null;
  const ct = { x: pins.b.x - pins.a.x, y: pins.b.y - pins.a.y };
  const ci = { x: b.x - a.x, y: b.y - a.y };
  const lt = Math.hypot(ct.x, ct.y), li = Math.hypot(ci.x, ci.y);
  if (li < 1e-6) return null;
  const u = { x: ct.x / lt, y: ct.y / lt };
  const m = { x: (ci.x * ct.x + ci.y * ct.y) / (lt * lt), y: (ci.y * ct.x - ci.x * ct.y) / (lt * lt) };
  const k = Math.hypot(m.x, m.y);
  const phiT = Math.atan2(ct.y, ct.x) * 180 / Math.PI;
  const rot = Math.atan2(m.y, m.x) * 180 / Math.PI;
  const map = p => {
    let vx = p.x - pins.a.x, vy = p.y - pins.a.y;
    if (flip) { // v -> u^2 * conj(v): reflection across the template chord
      const ux = u.x * u.x - u.y * u.y, uy = 2 * u.x * u.y;
      [vx, vy] = [ux * vx + uy * vy, uy * vx - ux * vy];
    }
    return { x: a.x + m.x * vx - m.y * vy, y: a.y + m.x * vy + m.y * vx };
  };
  const angle = th => ((flip ? 2 * phiT - th : th) + rot) % 360;
  return templates.map((c, i) => {
    const o = { id: `${idPrefix}:${i}`, inst: instId, ix: i,
      p0: map(c.p0), c1: map(c.c1), c2: map(c.c2), p3: map(c.p3),
      anchors: JSON.parse(JSON.stringify(c.anchors)) };
    for (const key of INSTANCE_STYLE_KEYS) if (c[key] != null) o[key] = JSON.parse(JSON.stringify(c[key]));
    o.width = c.width * k;
    if (c.width2 != null) o.width2 = c.width2 * k;
    if (c.gradientAngle != null) o.gradientAngle = angle(c.gradientAngle);
    if (c.opacityAngle != null) o.opacityAngle = angle(c.opacityAngle);
    return o;
  });
}

// Turns a symbol's instances into plain curves (they keep their ids and
// links) and forgets the instances; the symbol itself is left to the caller.
function bakeInstances(pred) {
  for (const inst of state.instances.filter(pred)) {
    for (const c of state.curves) if (c.inst === inst.id) { delete c.inst; delete c.ix; }
  }
  state.instances = state.instances.filter(i => !pred(i));
}

function removeSymbol(id) {
  bakeInstances(i => i.symbol === id);
  state.symbols = state.symbols.filter(s => s.id !== id);
}

// Brings the materialized curves in line with the templates and instances.
// Returns whether a linked pin moved. Symbols whose templates or pins are gone
// are dissolved, and their instances kept as plain curves.
function syncInstances() {
  for (const sym of state.symbols.slice()) {
    if (!symbolTemplates(sym) || !symbolPins(sym)) removeSymbol(sym.id);
  }
  let moved = false;
  const live = new Set();
  for (const inst of state.instances) {
    for (const end of ["a", "b"]) {
      const l = inst.links && inst.links[end];
      if (!l) continue;
      const host = state.curves.find(c => c.id === l.curve);
      const anchor = host && host.inst !== inst.id && host.anchors.find(x => x.id === l.anchor);
      if (!anchor) { delete inst.links[end]; continue; }
      const f = curveFrame(host, anchor.s);
      if (Math.abs(f.x - inst[end].x) > LINK_EPS || Math.abs(f.y - inst[end].y) > LINK_EPS) {
        inst[end] = { x: f.x, y: f.y };
        moved = true;
      }
    }
    if (inst.links && !inst.links.a && !inst.links.b) delete inst.links;
    const sym = state.symbols.find(s => s.id === inst.symbol);
    const built = sym && buildInstanceCurves(sym, inst.a, inst.b, !!inst.flip, inst.id, inst.id);
    if (!built) continue;
    for (const c of built) {
      live.add(c.id);
      const at = state.curves.findIndex(o => o.id === c.id);
      if (at >= 0) state.curves[at] = c; else state.curves.push(c);
    }
  }
  state.curves = state.curves.filter(c => !c.inst || live.has(c.id));
  return moved;
}

// Makes a symbol from curves, pinned at the two most distant endpoints
// (for a leaf, its shared start and end).
function makeSymbol(curves) {
  const ends = [];
  for (const c of curves) {
    ends.push({ curve: c.id, anchor: "start", p: c.p0 }, { curve: c.id, anchor: "end", p: c.p3 });
  }
  let best = null, bestD = 1e-6;
  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      const d = Math.hypot(ends[i].p.x - ends[j].p.x, ends[i].p.y - ends[j].p.y);
      if (d > bestD + 1e-9) { bestD = d; best = [ends[i], ends[j]]; }
    }
  }
  if (!best) return null;
  const sym = {
    id: "s" + (state.curveIdCounter++), name: "Symbol " + (state.symbols.length + 1),
    curves: curves.map(c => c.id),
    pinA: { curve: best[0].curve, anchor: best[0].anchor },
    pinB: { curve: best[1].curve, anchor: best[1].anchor },
  };
  state.symbols.push(sym);
  return sym;
}

function newInstance(sym, snapA, snapB, flip) {
  const inst = { id: "i" + (state.curveIdCounter++), symbol: sym.id, flip: !!flip,
    a: { x: snapA.x, y: snapA.y }, b: { x: snapB.x, y: snapB.y } };
  if (snapA.link) setInstanceLink(inst, "a", snapA.link);
  if (snapB.link) setInstanceLink(inst, "b", snapB.link);
  state.instances.push(inst);
  resolveLinks();
  return inst;
}

function setInstanceLink(inst, end, link) {
  if (link) {
    inst.links = inst.links || {};
    inst.links[end] = { curve: link.curve, anchor: link.anchor };
  } else if (inst.links) {
    delete inst.links[end];
    if (!inst.links.a && !inst.links.b) delete inst.links;
  }
}

function instanceCurveIds(id) { return state.curves.filter(c => c.inst === id).map(c => c.id); }

// Nearest anchor (of any curve but `excludeId`) within `tol`, as a snap target.
function findNearAnchor(pt, tol, excludeId) {
  let best = null, bestD = tol;
  for (const c of state.curves) {
    if (c.id === excludeId || (c.inst && c.inst === excludeId)) continue;
    for (const a of c.anchors) {
      const f = curveFrame(c, a.s);
      const d = Math.hypot(f.x - pt.x, f.y - pt.y);
      if (d < bestD) { bestD = d; best = { x: f.x, y: f.y, link: { curve: c.id, anchor: a.id } }; }
    }
  }
  return best;
}

function anchorLabel(c, a) {
  return "#" + (c.anchors.indexOf(a) + 1);
}

/* ---------------------------------------------------------------------- */
/* Application state                                                       */
/* ---------------------------------------------------------------------- */

// Colors are copied into curves as literal hex values when picked, so
// editing or deleting a palette entry never touches anything already using it.
const DEFAULT_PALETTE = ["#2a2d34", "#ffffff", "#e6453c", "#ffb020", "#2ecc71", "#5b8cff", "#c14bff"];

const state = {
  grid: { width: 800, height: 600, resolution: 20, snap: true, visible: true, specialLines: { center: false, thirds: false, golden: false } },
  palette: DEFAULT_PALETTE.slice(),   // hex strings; the only colors other tools can pick from
  curves: [],        // {id, p0,c1,c2,p3, anchors, links?, width, width2?, drift?, color, colorMode?, stops?, gradientAngle?, opacity?, opacityMode?, opacityStops?, opacityAngle?}
  selection: null,    // {type:'curve', id} | {type:'curves', ids} | {type:'instance', id}
  tool: "curve",      // "page" | "grid" | "palette" | "curve" | "circle" | "symbol"
  symbols: [],       // {id, name, curves: [templateIds], pinA/pinB: {curve, anchor}}
  instances: [],     // {id, symbol, a, b, flip, links?: {a?, b?}}
  curveIdCounter: 1,
};

const BLANK_DESIGN = JSON.parse(JSON.stringify({
  grid: state.grid, palette: state.palette, curves: [], symbols: [], instances: [], curveIdCounter: 1,
}));

let drawPending = null; // {x,y,link?} start point while placing a new curve
let circlePending = null; // {x,y} center while sizing a new circle (Circle tool)
let lastCurveCreatedAt = -Infinity; // guards the dblclick that follows a quick two-click draw
let dragCtx = null;    // active drag context
let symbolPending = null; // {x,y,link?} start pin while placing a symbol instance (Symbol tool)
let activeSymbolId = null; // symbol the Symbol tool places
let symbolFlip = false;    // whether the Symbol tool places mirrored instances

// Which sub-panel the Page tool shows - purely a UI concern (like `zoom`),
// so it's kept out of `state` and never saved/undone.

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
    palette: state.palette,
    curves: state.curves,
    symbols: state.symbols,
    instances: state.instances,
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
  if (state.grid.snap === undefined) state.grid.snap = true;
  if (!state.grid.specialLines) state.grid.specialLines = { center: false, thirds: false, golden: false };
  state.curves = JSON.parse(JSON.stringify(snap.curves));
  for (const c of state.curves) { ensureAnchors(c); migrateStops(c); }
  for (const k of Object.keys(state.grid)) if (k.startsWith("border")) delete state.grid[k];
  state.symbols = JSON.parse(JSON.stringify(snap.symbols || []));
  state.instances = JSON.parse(JSON.stringify(snap.instances || []));
  resolveLinks();
  state.palette = Array.isArray(snap.palette) ? snap.palette.slice() : paletteFromUsedColors(snap);
  state.curveIdCounter = snap.curveIdCounter;
  state.selection = null;
  render();
}

// Designs saved before the palette existed have none; seed it with the colors
// they already use so those stay one click away.
function paletteFromUsedColors(snap) {
  const seen = new Set();
  const add = c => { if (c) seen.add(c.toLowerCase()); };
  for (const c of snap.curves) {
    add(c.color);
    if (c.colorMode === "gradient") { add(c.color2); for (const t of c.stops || []) add(t.color); }
  }
  return seen.size ? [...seen] : DEFAULT_PALETTE.slice();
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

// Starts an empty design with default page settings and palette. Recorded in
// history, so it can be undone.
function newDesign() {
  restoreFromSnapshot(BLANK_DESIGN);
  pushHistory();
  showHint("New design.");
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

// Angle is in screen space (0 = left to right, 90 = top to bottom, matching
// cssGradientAngle). The gradient line is centered on the box and sized like
// CSS does, so the end colors land exactly on the box's far corners.
function gradientAttrs(angleDeg, x, y, w, h) {
  const rad = (angleDeg % 360) * Math.PI / 180;
  const dx = Math.cos(rad), dy = Math.sin(rad);
  const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
  const cx = x + w / 2, cy = y + h / 2;
  return `gradientUnits="userSpaceOnUse" x1="${fmt(cx - dx * half)}" y1="${fmt(cy - dy * half)}" ` +
    `x2="${fmt(cx + dx * half)}" y2="${fmt(cy + dy * half)}"`;
}

// CSS gradient angles start at "up" and run clockwise; ours start at "right".
function cssGradientAngle(angleDeg) { return angleDeg + 90; }

// Tight bounds of the curve itself (Bezier extrema, not control points), so a
// gradient's end stops land exactly on the curve's start and end. Axes with
// no extent get a 1px floor so a straight horizontal/vertical curve still has
// a non-degenerate box; the gradient's spread clamps the end colors beyond it.
function curveBox(c) {
  const axis = k => {
    const [a, b, d, e] = [c.p0[k], c.c1[k], c.c2[k], c.p3[k]];
    const vals = [a, e];
    // derivative coefficients: A t^2 + B t + C
    const A = -a + 3 * b - 3 * d + e, B = 2 * (a - 2 * b + d), C = b - a;
    const roots = [];
    if (Math.abs(A) < 1e-9) { if (Math.abs(B) > 1e-9) roots.push(-C / B); }
    else {
      const disc = B * B - 4 * A * C;
      if (disc >= 0) { const r = Math.sqrt(disc); roots.push((-B + r) / (2 * A), (-B - r) / (2 * A)); }
    }
    for (const t of roots) {
      if (t > 0 && t < 1) {
        const u = 1 - t;
        vals.push(u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * d + t * t * t * e);
      }
    }
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (hi - lo < 1) { const m = (lo + hi) / 2; lo = m - 0.5; hi = m + 0.5; }
    return [lo, hi];
  };
  const [x0, x1] = axis("x"), [y0, y1] = axis("y");
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Region an opacity mask must cover: the tight box grown by the stroke's
// reach, so the mask doesn't clip the stroke (unlike the gradient line, which
// must stay tight).
function curveMaskRegion(c) {
  const b = curveBox(c);
  const pad = Math.max(c.width, c.width2 != null ? c.width2 : 0) * 3 + 4;
  return { x: b.x - pad, y: b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad };
}

function escapeAttr(s) { return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;"); }

// Gradients are enumerations of stops, each {o: 0..1, color} (or {o, a} for an
// opacity gradient), kept ordered by offset; there is always at least two.
function stopsCss(list, opacity) {
  return list.map(t => {
    const v = opacity ? `rgba(220,224,232,${t.a})` : t.color;
    return `${v} ${fmt(t.o * 100)}%`;
  }).join(", ");
}

function mixHex(a, b, t) {
  const p = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const [pa, pb] = [p(a), p(b)];
  return "#" + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, "0")).join("");
}

// Converts the old start/end fields (color+color2, opacity+opacity2) into stop lists, for designs saved before stops.
function migrateStops(o) {
  if (!o.stops && (o.colorMode === "gradient" || o.color2)) {
    o.stops = [{ o: 0, color: o.color }, { o: 1, color: o.color2 || "#5b8cff" }];
  }
  delete o.color2;
  if (!o.opacityStops && (o.opacityMode === "gradient" || o.opacity2 != null)) {
    o.opacityStops = [{ o: 0, a: o.opacity != null ? o.opacity : 1 }, { o: 1, a: o.opacity2 != null ? o.opacity2 : 1 }];
  }
  delete o.opacity2;
}

function curveGradientId(id) {
  return "curve-grad-" + String(id).replace(/[^a-zA-Z0-9]/g, "_");
}

function curveOpacityMaskId(id) {
  return "curve-opmask-" + String(id).replace(/[^a-zA-Z0-9]/g, "_");
}

// Opacity is applied to a group wrapping all of a curve's elements, so the
// overlapping ribbon and cap discs of a tapered curve don't double up. A flat
// opacity is a plain attribute; a gradient is a luminance-free alpha mask
// (white stops with varying stop-opacity) whose gradient line spans the curve's
// tight bounds, inside a padded mask region.
function curveOpacityInfo(c) {
  const a0 = c.opacity != null ? c.opacity : 1;
  if (c.opacityMode === "gradient" && c.opacityStops) {
    const mid = curveOpacityMaskId(c.id);
    const gb = curveBox(c);
    const { x, y, w, h } = curveMaskRegion(c);
    const defs = `<linearGradient id="${mid}-g" ${gradientAttrs(c.opacityAngle || 0, gb.x, gb.y, gb.w, gb.h)}>` +
      c.opacityStops.map(t => `<stop offset="${fmt(t.o * 100)}%" stop-color="#fff" stop-opacity="${t.a}"/>`).join("") +
      `</linearGradient>` +
      `<mask id="${mid}" maskUnits="userSpaceOnUse" x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}">` +
      `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" fill="url(#${mid}-g)"/>` +
      `</mask>`;
    return { defs, attr: ` mask="url(#${mid})"` };
  }
  return { defs: "", attr: a0 < 1 ? ` opacity="${a0}"` : "" };
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
  if (state.selection.type === "instance") return id.startsWith(state.selection.id + ":");
  return false;
}

function curvesMarkup(curves, includeSelection = true) {
  let defs = includeSelection ? CURVE_GLOW_FILTER : "";
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
    if (c.colorMode === "gradient" && c.stops) {
      const gid = curveGradientId(c.id);
      const b = curveBox(c);
      defs += `<linearGradient id="${gid}" ${gradientAttrs(c.gradientAngle || 0, b.x, b.y, b.w, b.h)}>` +
        c.stops.map(t => `<stop offset="${fmt(t.o * 100)}%" stop-color="${t.color}"/>`).join("") +
        `</linearGradient>`;
      paint = `url(#${gid})`;
    } else {
      paint = c.color;
    }

    const op = curveOpacityInfo(c);
    defs += op.defs;
    let curveBody = "";

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
      curveBody += `<path d="${ribbon.d}" fill="${paint}" data-curve-id="${escapeAttr(c.id)}"></path>`;
      for (const cap of [ribbon.capStart, ribbon.capEnd]) {
        if (!cap) continue;
        curveBody += `<circle cx="${fmt(cap.x)}" cy="${fmt(cap.y)}" r="${fmt(cap.r)}" fill="${paint}" data-curve-id="${escapeAttr(c.id)}"></circle>`;
      }
    } else {
      const d = `M ${fmt(c.p0.x)} ${fmt(c.p0.y)} C ${fmt(c.c1.x)} ${fmt(c.c1.y)}, ${fmt(c.c2.x)} ${fmt(c.c2.y)}, ${fmt(c.p3.x)} ${fmt(c.p3.y)}`;
      if (selected) {
        glowBody += `<path d="${d}" fill="none" stroke="${SELECTION_GLOW_COLOR}" stroke-width="${w0 + SELECTION_GLOW_EXTRA_WIDTH}" stroke-linecap="round" filter="url(#curve-glow)" opacity="${SELECTION_GLOW_OPACITY}"></path>`;
      }
      curveBody += `<path d="${d}" fill="none" stroke="${paint}" stroke-width="${w0}" stroke-linecap="round" data-curve-id="${escapeAttr(c.id)}"></path>`;
    }
    body += op.attr ? `<g${op.attr}>${curveBody}</g>` : curveBody;
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

function diamond(x, y, r, attrs) {
  return `<polygon points="${x},${y - r} ${x + r},${y} ${x},${y + r} ${x - r},${y}" ${attrs}></polygon>`;
}

// Tangent-locked anchors get a short tick along their tangent.
function anchorMarkup(c, a, r, s, opacity, fill) {
  const f = curveFrame(c, a.s);
  let html = "";
  if (a.tangent) {
    const k = r * 2.2;
    html += `<line x1="${f.x - f.tx * k}" y1="${f.y - f.ty * k}" x2="${f.x + f.tx * k}" y2="${f.y + f.ty * k}" stroke="#c14bff" stroke-width="${1.4 / s}" opacity="${opacity}"></line>`;
  }
  html += diamond(f.x, f.y, r, `fill="${fill}" stroke="#1b1d22" stroke-width="${1 / s}" opacity="${opacity}"`);
  return html;
}

function renderHandles() {
  handlesLayer.innerHTML = "";
  if (state.tool !== "curve" && state.tool !== "symbol") return; // symbols snap to anchors too
  const s = currentScale();
  let html = "";
  // Every curve shows its anchors faintly so snap targets are visible; the
  // selected curve's are drawn in full below, as draggable handles.
  for (const c of state.curves) {
    if (state.selection && state.selection.type === "curve" && state.selection.id === c.id) continue;
    for (const a of c.anchors) html += anchorMarkup(c, a, 4 / s, s, 0.55, "#c14bff");
  }
  const inst = state.selection && state.selection.type === "instance" && state.instances.find(i => i.id === state.selection.id);
  if (inst) {
    html += `<line x1="${inst.a.x}" y1="${inst.a.y}" x2="${inst.b.x}" y2="${inst.b.y}" stroke="#5b8cff" stroke-width="${1.6 / s}" stroke-dasharray="${3 / s},${3 / s}"></line>`;
    for (const [key, fill] of [["a", "#2ecc71"], ["b", "#e6453c"]]) {
      const linked = inst.links && inst.links[key];
      html += `<circle class="handle" cx="${inst[key].x}" cy="${inst[key].y}" r="${7 / s}" fill="${fill}" stroke="${linked ? "#ffffff" : "#1b1d22"}" stroke-width="${(linked ? 2.2 : 1) / s}" data-handle="${key}"></circle>`;
    }
  }
  const c = state.selection && state.selection.type === "curve" && state.curves.find(cv => cv.id === state.selection.id);
  if (c) {
    const rA = 7 / s, rC = 6 / s, lw = 1.6 / s;
    html += `<line x1="${c.p0.x}" y1="${c.p0.y}" x2="${c.c1.x}" y2="${c.c1.y}" stroke="#5b8cff" stroke-width="${lw}" stroke-dasharray="${3/s},${3/s}"></line>`;
    html += `<line x1="${c.p3.x}" y1="${c.p3.y}" x2="${c.c2.x}" y2="${c.c2.y}" stroke="#5b8cff" stroke-width="${lw}" stroke-dasharray="${3/s},${3/s}"></line>`;
    for (const a of c.anchors) if (!isEndAnchor(a)) html += anchorMarkup(c, a, 6 / s, s, 1, "#c14bff");
    const mk = (p, r, fill, key) => {
      const linked = (key === "p0" || key === "p3") && c.links && c.links[key];
      const stroke = linked ? "#ffffff" : "#1b1d22";
      return `<circle class="handle" cx="${p.x}" cy="${p.y}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${(linked ? 2.2 : 1) / s}" data-handle="${key}"></circle>`;
    };
    html += mk(c.c1, rC, "#ffb020", "c1");
    html += mk(c.c2, rC, "#ffb020", "c2");
    html += mk(c.p0, rA, "#2ecc71", "p0");
    html += mk(c.p3, rA, "#e6453c", "p3");
  }
  handlesLayer.innerHTML = html;
}

// Split out from render() so a color input's live preview (fired continuously
// while dragging inside the native picker) can repaint the canvas without
// touching the panel: replacing the panel's innerHTML mid-drag would tear out
// the very <input type="color"> the OS picker is attached to and cut the drag
// short.
function renderCanvas() {
  syncInstances(); // template edits (color, width, ...) reach every instance
  const { width: W, height: H } = state.grid;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", W * zoom);
  svg.setAttribute("height", H * zoom);

  if (!gridLayer) ensureLayers();
  renderGrid();

  const curveA = curvesMarkup(state.curves);
  defsLayer.innerHTML = curveA.defs;
  curvesLayer.innerHTML = curveA.body;

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

// Which palette entry the Palette tool is editing - a UI concern like
// `pageSubtool`, so it's kept out of `state`.
let paletteSelected = 0;

function swatchesMarkup() {
  if (!state.palette.length) {
    return `<div class="panel-empty swatches-empty">The palette is empty. Add colors with the Palette tool.</div>`;
  }
  return `<div class="swatches">` +
    state.palette.map(c => `<button type="button" class="swatch" style="background:${c}" data-swatch="${c}" title="${c}"></button>`).join("") +
    `</div>`;
}

// A color field that can only be set from the palette: a label above the
// palette's swatches, with the current color's swatch highlighted. `onPick` receives the chosen hex; the caller commits it.
function mountColorField(parent, label, value, onPick) {
  const wrap = document.createElement("div");
  wrap.innerHTML =
    `<div class="field-label">${label}</div>` +
    swatchesMarkup();
  const buttons = wrap.querySelectorAll(".swatch");
  const sync = v => {
    for (const btn of buttons) btn.classList.toggle("active", btn.dataset.swatch.toLowerCase() === v.toLowerCase());
  };
  sync(value);
  for (const btn of buttons) {
    btn.addEventListener("click", () => {
      sync(btn.dataset.swatch);
      onPick(btn.dataset.swatch);
    });
  }
  parent.appendChild(wrap);
}

function movePaletteColor(from, to) {
  if (from === to) return;
  const [c] = state.palette.splice(from, 1);
  state.palette.splice(to, 0, c);
  paletteSelected = to;
  renderPanel();
  pushHistory();
}

function renderPalettePanel() {
  const pal = state.palette;
  paletteSelected = Math.min(paletteSelected, pal.length - 1);
  const sel = paletteSelected;
  panel.innerHTML = `
    <div class="panel-section">
      <h3>Colors</h3>
      <div class="palette-grid">
        ${pal.map((c, i) => `<button type="button" class="palette-swatch ${i === sel ? "active" : ""}" draggable="true" data-index="${i}" style="background:${c}" title="${c}"></button>`).join("")}
        <button type="button" class="palette-swatch palette-add" id="pal-add" title="Add color">+</button>
      </div>
    </div>
    ${pal.length ? `
    <div class="panel-section">
      <h3>Edit</h3>
      <div class="field-row">
        <label>Color</label>
        <input type="color" id="pal-color" value="${pal[sel]}">
      </div>
      <div class="field-row">
        <label>Hex</label>
        <input type="text" class="hex-in" id="pal-hex" maxlength="7" spellcheck="false" value="${pal[sel]}">
      </div>
      <div class="action-row">
        <button class="icon-btn danger" id="pal-delete" title="Delete this color from the palette.">${ICON_TRASH}</button>
      </div>
    </div>` : ""}
    <div class="panel-empty">Other tools can only pick from these colors. Changing or deleting one here doesn't affect anything already using it. Drag to reorder.</div>
  `;

  document.getElementById("pal-add").addEventListener("click", () => {
    pal.push(pal.length ? pal[sel] : "#808080");
    paletteSelected = pal.length - 1;
    renderPanel();
    pushHistory();
  });

  const swatchEls = panel.querySelectorAll(".palette-swatch[data-index]");
  for (const el of swatchEls) {
    const i = parseInt(el.dataset.index, 10);
    el.addEventListener("click", () => { paletteSelected = i; renderPanel(); });
    el.addEventListener("dragstart", e => { e.dataTransfer.setData("text/plain", String(i)); e.dataTransfer.effectAllowed = "move"; });
    el.addEventListener("dragover", e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; });
    el.addEventListener("drop", e => {
      e.preventDefault();
      const from = parseInt(e.dataTransfer.getData("text/plain"), 10);
      if (Number.isInteger(from)) movePaletteColor(from, i);
    });
  }

  if (!pal.length) return;
  const colorInput = document.getElementById("pal-color");
  const hexInput = document.getElementById("pal-hex");
  const selEl = swatchEls[sel];
  // Live 'input' only patches the existing DOM (see renderCanvas's note on
  // why the panel isn't rebuilt while the native picker is open).
  const setColor = v => {
    pal[sel] = v;
    selEl.style.background = v;
    selEl.title = v;
    hexInput.value = v;
  };
  colorInput.addEventListener("input", e => setColor(e.target.value));
  colorInput.addEventListener("change", () => pushHistory());
  hexInput.addEventListener("change", e => {
    const m = /^#?([0-9a-f]{6})$/i.exec(e.target.value.trim());
    if (!m) { e.target.value = pal[sel]; return; }
    const v = "#" + m[1].toLowerCase();
    setColor(v);
    colorInput.value = v;
    pushHistory();
  });
  document.getElementById("pal-delete").addEventListener("click", () => {
    pal.splice(sel, 1);
    paletteSelected = Math.max(0, Math.min(sel, pal.length - 1));
    renderPanel();
    pushHistory();
  });
}

function renderPanel() {
  if (state.tool === "page") { renderPagePanel(); return; }
  if (state.tool === "grid") { renderGridPanel(); return; }
  if (state.tool === "palette") { renderPalettePanel(); return; }
  if (state.tool === "circle") {
    panel.innerHTML = `<div class="panel-empty">Drag from the center outwards to draw a circle.<br>It is made of four quarter-arc curves, joined end to end and left selected so you can move or style them.</div>`;
    return;
  }
  if (state.tool === "symbol") { renderSymbolToolPanel(); return; }
  if (!state.selection) {
    panel.innerHTML = `<div class="panel-empty">Nothing selected.<br>Click an existing curve to select it, or click anywhere empty to draw one.</div>`;
    return;
  }
  if (state.selection.type === "curve") {
    renderCurvePanel();
  } else if (state.selection.type === "instance") {
    renderInstancePanel();
  } else {
    renderMultiCurvePanel();
  }
}

// Make-symbol button shared by the single and multi-curve panels.
function makeSymbolButtonHtml(id) {
  return `<button class="icon-btn" id="${id}" title="Make symbol: turn the selected curves into a reusable symbol (a leaf, say) that can be placed between any two points. The curves stay as its template: editing them updates every instance.">&#10070; Make symbol</button>`;
}

function wireMakeSymbolButton(id, curves) {
  document.getElementById(id).addEventListener("click", () => {
    if (curves.some(c => c.inst)) { showHint("Instances can't be made into symbols; use their template curves."); return; }
    if (state.symbols.some(sym => sym.curves.some(cid => curves.some(c => c.id === cid)))) {
      showHint("These curves already belong to a symbol.");
      return;
    }
    const sym = makeSymbol(curves);
    if (!sym) { showHint("A symbol needs curves with two distinct endpoints."); return; }
    activeSymbolId = sym.id;
    pushHistory();
    setTool("symbol");
    showHint(`${sym.name} made. Click two points to place it; the first click is the start pin, the second the end pin.`);
  });
}

function symbolTemplateNote(curves) {
  const sym = state.symbols.find(sy => sy.curves.some(cid => curves.some(c => c.id === cid)));
  if (!sym) return "";
  const n = state.instances.filter(i => i.symbol === sym.id).length;
  return `<div class="panel-note">Template of <b>${escapeAttr(sym.name)}</b> (${n} instance${n === 1 ? "" : "s"})</div>`;
}

function renderSymbolToolPanel() {
  if (!state.symbols.length) {
    panel.innerHTML = `<div class="panel-empty">No symbols yet.<br>Draw a shape (a leaf: two curves sharing start and end), select its curves with the Curve tool and press <b>Make symbol</b>.</div>`;
    return;
  }
  if (!state.symbols.some(sy => sy.id === activeSymbolId)) activeSymbolId = state.symbols[0].id;
  panel.innerHTML = `
    <div class="panel-section">
      <h3>Symbol</h3>
      ${state.symbols.map(sy => {
        const n = state.instances.filter(i => i.symbol === sy.id).length;
        return `<div class="field-row symbol-row" data-symbol="${sy.id}">
          <input type="radio" name="sym" ${sy.id === activeSymbolId ? "checked" : ""} title="Place this symbol">
          <input type="text" class="sym-name" value="${escapeAttr(sy.name)}">
          <span class="unit">&times;${n}</span>
          <button class="icon-btn danger sym-del" title="Dissolve this symbol: its instances stay as plain curves, the template curves are untouched.">${ICON_TRASH}</button>
        </div>`;
      }).join("")}
      <div class="field-row"><label>Mirrored</label><input type="checkbox" id="sym-flip" ${symbolFlip ? "checked" : ""}></div>
    </div>
    <div class="panel-empty">Click a start point, then an end point. Either snaps to anchors and stays attached to them; hold Alt to place freely. Esc cancels.</div>`;
  for (const row of panel.querySelectorAll(".symbol-row")) {
    const sym = state.symbols.find(sy => sy.id === row.dataset.symbol);
    row.querySelector('input[type="radio"]').addEventListener("change", () => { activeSymbolId = sym.id; });
    row.querySelector(".sym-name").addEventListener("change", e => {
      sym.name = e.target.value.trim() || sym.name;
      pushHistory();
    });
    row.querySelector(".sym-del").addEventListener("click", () => {
      removeSymbol(sym.id);
      resolveLinks();
      render();
      pushHistory();
    });
  }
  document.getElementById("sym-flip").addEventListener("change", e => { symbolFlip = e.target.checked; });
}

function renderInstancePanel() {
  const inst = state.instances.find(i => i.id === state.selection.id);
  const sym = inst && state.symbols.find(sy => sy.id === inst.symbol);
  if (!sym) { state.selection = null; renderPanel(); return; }
  const pinRow = (end, label) => {
    const l = inst.links && inst.links[end];
    const host = l && state.curves.find(c => c.id === l.curve);
    const anchor = host && host.anchors.find(a => a.id === l.anchor);
    return `<div class="field-row"><label>${label} ${anchor ? `attached to ${anchorLabel(host, anchor)} of ${escapeAttr(host.id)}` : "is free"}</label>` +
      (anchor ? `<button class="detach" data-end="${end}" title="Detach: the pin stays here but no longer follows the anchor">Detach</button>` : "") + `</div>`;
  };
  panel.innerHTML = `
    <div class="panel-section">
      <h3>Instance of ${escapeAttr(sym.name)}</h3>
      <div class="field-row"><label>Mirrored</label><input type="checkbox" id="i-flip" ${inst.flip ? "checked" : ""}></div>
      ${pinRow("a", "Start pin")}
      ${pinRow("b", "End pin")}
      <div class="panel-empty">Drag the pins to rotate and scale it; drop one on an anchor to attach it.</div>
    </div>
    <div class="panel-section">
      <h3>Actions</h3>
      <div class="action-row">
        <button class="icon-btn" id="i-to-front" title="Bring to front (Shift+])">${ICON_TO_FRONT}</button>
        <button class="icon-btn" id="i-forward" title="Bring forward (])">${ICON_FORWARD}</button>
        <button class="icon-btn" id="i-backward" title="Send backward ([)">${ICON_BACKWARD}</button>
        <button class="icon-btn" id="i-to-back" title="Send to back (Shift+[)">${ICON_TO_BACK}</button>
      </div>
      <div class="action-row">
        <button class="icon-btn" id="i-template" title="Select the template curves of this symbol">Edit template</button>
        <button class="icon-btn" id="i-dup" title="Duplicate this instance, shifted by one grid step">Duplicate</button>
        <button class="icon-btn" id="i-bake" title="Detach from the symbol: this instance becomes plain curves that no longer follow the template.">Detach</button>
        <button class="icon-btn danger" id="i-delete" title="Delete this instance.">${ICON_TRASH}</button>
      </div>
    </div>`;
  document.getElementById("i-to-front").addEventListener("click", () => reorderSelection("front"));
  document.getElementById("i-forward").addEventListener("click", () => reorderSelection("forward"));
  document.getElementById("i-backward").addEventListener("click", () => reorderSelection("backward"));
  document.getElementById("i-to-back").addEventListener("click", () => reorderSelection("back"));
  document.getElementById("i-flip").addEventListener("change", e => {
    inst.flip = e.target.checked;
    resolveLinks(); render(); pushHistory();
  });
  for (const b of panel.querySelectorAll(".detach")) {
    b.addEventListener("click", () => { setInstanceLink(inst, b.dataset.end, null); render(); pushHistory(); });
  }
  document.getElementById("i-template").addEventListener("click", () => {
    const ids = sym.curves.slice();
    setSelection(ids.length === 1 ? { type: "curve", id: ids[0] } : { type: "curves", ids });
  });
  document.getElementById("i-dup").addEventListener("click", () => {
    const d = state.grid.resolution;
    const copy = newInstance(sym, { x: inst.a.x + d, y: inst.a.y + d }, { x: inst.b.x + d, y: inst.b.y + d }, inst.flip);
    setSelection({ type: "instance", id: copy.id });
    pushHistory();
  });
  document.getElementById("i-bake").addEventListener("click", () => {
    bakeInstances(i => i.id === inst.id);
    const ids = state.curves.filter(c => c.id.startsWith(inst.id + ":")).map(c => c.id);
    setSelection(ids.length === 1 ? { type: "curve", id: ids[0] } : { type: "curves", ids });
    pushHistory();
  });
  document.getElementById("i-delete").addEventListener("click", deleteSelectedInstance);
}

function deleteSelectedInstance() {
  const id = state.selection.id;
  state.instances = state.instances.filter(i => i.id !== id);
  resolveLinks();
  state.selection = null;
  render();
  pushHistory();
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
    : state.selection.type === "instance" ? instanceCurveIds(state.selection.id)
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
  const selCurves = state.curves.filter(cv => ids.includes(cv.id));
  const count = selCurves.length;
  panel.innerHTML = `
    ${symbolTemplateNote(state.curves.filter(cv => ids.includes(cv.id)))}
    <div class="panel-empty">${count} curves selected.<br>Drag to move them together, or press Delete to remove them.</div>
    <div class="panel-section">
      <div class="action-row">${makeSymbolButtonHtml("f-make-symbol-multi")}</div>
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
    <div class="panel-section">
      <h3>Misc</h3>
      <div class="field-row"><label title="Leave the selected curves out of the exported SVG (handy for symbol templates)">Exclude from SVG</label><input type="checkbox" id="f-no-export-multi" ${selCurves.length && selCurves.every(cv => cv.noExport) ? "checked" : ""}></div>
    </div>
  `;
  wireMakeSymbolButton("f-make-symbol-multi", selCurves);
  document.getElementById("f-no-export-multi").addEventListener("change", e => {
    for (const cv of selCurves) { if (e.target.checked) cv.noExport = true; else delete cv.noExport; }
    pushHistory();
  });
  document.getElementById("f-to-front-multi").addEventListener("click", () => reorderSelection("front"));
  document.getElementById("f-forward-multi").addEventListener("click", () => reorderSelection("forward"));
  document.getElementById("f-backward-multi").addEventListener("click", () => reorderSelection("backward"));
  document.getElementById("f-to-back-multi").addEventListener("click", () => reorderSelection("back"));
  document.getElementById("f-delete-multi").addEventListener("click", () => {
    const idSet = new Set(ids);
    state.curves = state.curves.filter(cv => !idSet.has(cv.id));
    resolveLinks();
    state.selection = null;
    render();
    pushHistory();
  });
}

function renderPagePanel() {
  renderPageDimensionsFields();
}

function renderPageDimensionsFields() {
  const g = state.grid;
  panel.innerHTML = `
    <div class="panel-section">
      <div class="field-row"><label>Width</label><input type="number" class="num-in" min="20" step="1" id="p-width" value="${g.width}"><span class="unit">px</span></div>
      <div class="field-row"><label>Height</label><input type="number" class="num-in" min="20" step="1" id="p-height" value="${g.height}"><span class="unit">px</span></div>
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

const SPECIAL_LINE_LABELS = { center: "Center", thirds: "Thirds", golden: "Golden ratio" };

function renderGridPanel() {
  const g = state.grid;
  const specialRows = Object.keys(SPECIAL_LINE_LABELS).map(key =>
    `<div class="field-row"><label>${SPECIAL_LINE_LABELS[key]}</label><input type="checkbox" class="g-special" data-key="${key}" ${g.specialLines[key] ? "checked" : ""}></div>`
  ).join("");
  panel.innerHTML = `
    <div class="panel-section">
      <div class="field-row"><label>Visible</label><input type="checkbox" id="g-visible" ${g.visible ? "checked" : ""}></div>
      <div class="field-row"><label title="Snap new points and dragged curves to grid intersections. Anchors take priority; hold Alt to bypass.">Snap to grid</label><input type="checkbox" id="g-snap" ${g.snap ? "checked" : ""}></div>
      <div class="field-row"><label>Resolution</label><input type="number" class="num-in" min="2" step="1" id="g-res" value="${g.resolution}"><span class="unit">px</span></div>
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
  document.getElementById("g-snap").addEventListener("change", e => {
    state.grid.snap = e.target.checked;
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
const ICON_FLIP_DIR = `<svg ${ICON_ATTRS}><path d="M4 8h15M15 4l4 4-4 4"/><path d="M20 16H5M9 12l-4 4 4 4"/></svg>`;
const ICON_FLIP_H = `<svg ${ICON_ATTRS}><line x1="12" y1="3" x2="12" y2="21" stroke-dasharray="2.5 2.5"/><path d="M3 12l4-4M3 12l4 4"/><path d="M21 12l-4-4M21 12l-4 4"/></svg>`;
const ICON_TRASH = `<svg ${ICON_ATTRS}><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/></svg>`;
const ICON_TO_FRONT = `<svg ${ICON_ATTRS}><path d="M6 17l6-6 6 6"/><path d="M6 10l6-6 6 6"/></svg>`;
const ICON_FORWARD = `<svg ${ICON_ATTRS}><path d="M6 15l6-6 6 6"/></svg>`;
const ICON_BACKWARD = `<svg ${ICON_ATTRS}><path d="M6 9l6 6 6-6"/></svg>`;
const ICON_TO_BACK = `<svg ${ICON_ATTRS}><path d="M6 7l6 6 6-6"/><path d="M6 14l6 6 6-6"/></svg>`;

// Table editor for a gradient's stops: one row per stop (number, position,
// color or opacity, delete). `list` is edited in place and kept sorted;
// onChange repaints the preview and canvas, history is pushed on commit.
function mountStopTable(host, list, opacity, onChange) {
  const paint = () => {
    list.sort((a, b) => a.o - b.o);
    host.innerHTML = (opacity ? "" : `<datalist id="stop-palette">${state.palette.map(p => `<option value="${p}"></option>`).join("")}</datalist>`) +
      `<div class="tbl"><div class="tbl-row tbl-head"><span>#</span><span>Position (%)</span><span>${opacity ? "Opacity (%)" : "Color"}</span><span></span></div>` +
      list.map((t, i) => `<div class="tbl-row anchor-row" data-i="${i}">
        <span>${i + 1}</span>
        <span><input type="number" class="s-o" min="0" max="100" step="1" value="${Math.round(t.o * 1000) / 10}" title="Position along the gradient"></span>
        <span>${opacity
          ? `<input type="number" class="s-v" min="0" max="100" step="1" value="${Math.round(t.a * 100)}" title="Opacity">`
          : `<input type="color" class="s-v" list="stop-palette" value="${t.color}" title="Color">`}</span>
        <span><button class="icon-btn s-del" title="Remove this stop" ${list.length <= 2 ? "disabled" : ""}>${ICON_TRASH}</button></span>
      </div>`).join("") + `</div>` +
      `<div class="action-row"><button class="icon-btn s-add" title="Add a stop in the widest gap">+ Add stop</button></div>`;
    for (const row of host.querySelectorAll(".anchor-row")) {
      const t = list[parseInt(row.dataset.i, 10)];
      const v = row.querySelector(".s-v");
      row.querySelector(".s-o").addEventListener("change", e => {
        const n = parseFloat(e.target.value);
        if (Number.isFinite(n)) t.o = Math.max(0, Math.min(100, n)) / 100;
        paint(); onChange(); pushHistory();
      });
      if (opacity) {
        v.addEventListener("input", e => {
          const n = parseInt(e.target.value, 10);
          if (Number.isFinite(n)) { t.a = Math.max(0, Math.min(100, n)) / 100; onChange(); }
        });
        v.addEventListener("change", e => {
          t.a = Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0)) / 100;
          e.target.value = Math.round(t.a * 100);
          onChange(); pushHistory();
        });
      } else {
        v.addEventListener("input", e => { t.color = e.target.value; onChange(); });
        v.addEventListener("change", () => pushHistory());
      }
      row.querySelector(".s-del").addEventListener("click", () => {
        if (list.length <= 2) return;
        list.splice(list.indexOf(t), 1);
        paint(); onChange(); pushHistory();
      });
    }
    host.querySelector(".s-add").addEventListener("click", () => {
      let i = 0, gap = -1;
      for (let k = 0; k < list.length - 1; k++) if (list[k + 1].o - list[k].o > gap) { gap = list[k + 1].o - list[k].o; i = k; }
      const [p, q] = [list[i], list[i + 1]], o = (p.o + q.o) / 2;
      list.push(opacity ? { o, a: Math.round((p.a + q.a) * 50) / 100 } : { o, color: mixHex(p.color, q.color, 0.5) });
      paint(); onChange(); pushHistory();
    });
  };
  paint();
}

// Anchor list, presets and link summary of the curve panel. Edits go through
// ensureAnchors/resolveLinks so linked curves follow immediately.
function mountAnchorFields(c) {
  const commit = () => { ensureAnchors(c); resolveLinks(); render(); pushHistory(); };

  for (const b of document.querySelectorAll("#a-presets button")) {
    b.addEventListener("click", () => { setEvenAnchors(c, parseInt(b.dataset.div, 10)); commit(); });
  }
  document.getElementById("a-divs").addEventListener("change", e => {
    const n = Math.max(1, Math.min(64, parseInt(e.target.value, 10) || 1));
    setEvenAnchors(c, n);
    commit();
  });
  document.getElementById("a-add").addEventListener("click", () => {
    // Bisect the widest gap so repeated clicks spread out.
    let at = 0.5, gap = 0;
    for (let i = 0; i < c.anchors.length - 1; i++) {
      const g = c.anchors[i + 1].s - c.anchors[i].s;
      if (g > gap) { gap = g; at = (c.anchors[i].s + c.anchors[i + 1].s) / 2; }
    }
    addAnchor(c, at);
    commit();
  });

  const list = document.getElementById("a-list");
  list.innerHTML = `<div class="tbl tbl-anchors"><div class="tbl-row tbl-head"><span>#</span><span>Position (%)</span><span title="Curves attached to an anchor leave along its tangent">Tangent</span><span></span></div>` +
    c.anchors.map(a => {
      const end = isEndAnchor(a);
      return `<div class="tbl-row anchor-row" data-anchor="${a.id}">
        <span>${c.anchors.indexOf(a) + 1}</span>
        <span><input type="number" class="a-s" min="0" max="100" step="1" value="${Math.round(a.s * 1000) / 10}" ${end ? "disabled" : ""}></span>
        <span><input type="checkbox" class="a-tan" title="Snap tangent: curves attached here leave along this anchor's tangent" ${a.tangent ? "checked" : ""}></span>
        <span>${end ? "" : `<button class="icon-btn a-del" title="Remove this anchor">${ICON_TRASH}</button>`}</span>
      </div>`;
    }).join("") + `</div>`;
  for (const row of list.querySelectorAll(".anchor-row")) {
    const a = c.anchors.find(x => x.id === row.dataset.anchor);
    row.querySelector(".a-tan").addEventListener("change", e => { a.tangent = e.target.checked; commit(); });
    if (isEndAnchor(a)) continue;
    row.querySelector(".a-s").addEventListener("change", e => {
      const v = parseFloat(e.target.value);
      if (Number.isFinite(v)) a.s = Math.max(0.1, Math.min(99.9, v)) / 100;
      commit();
    });
    row.querySelector(".a-del").addEventListener("click", () => {
      c.anchors = c.anchors.filter(x => x !== a);
      commit();
    });
  }

  // Which anchors this curve's own endpoints are attached to.
  const links = document.getElementById("a-links");
  links.innerHTML = ["p0", "p3"].map(end => {
    const la = linkedAnchor(c, end);
    if (!la) return "";
    return `<div class="field-row"><label>${end === "p0" ? "Start" : "End"} attached to ${anchorLabel(la.host, la.anchor)} of ${la.host.id}</label><button class="detach" data-end="${end}" title="Detach: the endpoint stays here but no longer follows the anchor">Detach</button></div>`;
  }).join("");
  for (const b of links.querySelectorAll(".detach")) {
    b.addEventListener("click", () => { setLink(c, b.dataset.end, null); render(); pushHistory(); });
  }
}

function renderCurvePanel() {
  const c = state.curves.find(cv => cv.id === state.selection.id);
  if (!c) { state.selection = null; renderPanel(); return; }
  const isGrad = c.colorMode === "gradient";
  const isTapered = c.width2 != null;
  const isOpGrad = c.opacityMode === "gradient";
  panel.innerHTML = `
    ${symbolTemplateNote([c])}
    <div class="panel-section">
      <h3>Fill</h3>
      <div class="seg">
        <button id="c-solid" class="${!isGrad ? "active" : ""}">Solid</button>
        <button id="c-grad" class="${isGrad ? "active" : ""}">Gradient</button>
      </div>
      <div id="color-fields"></div>
    </div>
    <div class="panel-section">
      <h3>Opacity</h3>
      <div class="seg">
        <button id="c-op-flat" class="${!isOpGrad ? "active" : ""}">Flat</button>
        <button id="c-op-grad" class="${isOpGrad ? "active" : ""}">Gradient</button>
      </div>
      <div id="opacity-fields"></div>
    </div>
    <div class="panel-section">
      <h3>Width</h3>
      <div class="field-row">
        <label>${isTapered ? "Start width" : "Width"}</label>
        <input type="range" id="f-width" min="0.5" max="30" step="0.5" value="${c.width}">
        <input type="number" class="num-in" id="f-width-num" min="0.5" max="30" step="0.5" value="${c.width}">
        <span class="unit">px</span>
      </div>
      <div class="field-row"><label>Taper</label><input type="checkbox" id="f-taper" ${isTapered ? "checked" : ""}></div>
      <div id="taper-fields"></div>
    </div>
    <div class="panel-section">
      <h3>Anchors</h3>
      <div class="seg" id="a-presets">
        <button data-div="1" title="Only the start and end anchors">Ends</button>
        <button data-div="2" title="Add an anchor at the midpoint">Mid</button>
        <button data-div="3" title="Anchors at every third">Thirds</button>
        <button data-div="4" title="Anchors at every quarter">Quarters</button>
      </div>
      <div class="field-row"><label title="Spread anchors evenly by arc length">Divide evenly</label><input type="number" class="num-in" id="a-divs" min="1" max="64" step="1" value="${c.anchors.length - 1}"><span class="unit">&times;</span></div>
      <div id="a-list"></div>
      <div class="action-row"><button class="icon-btn" id="a-add" title="Add an anchor (or double-click the selected curve)">+ Add anchor</button></div>
      <div id="a-links"></div>
    </div>
    <div class="panel-section">
      <h3>Actions</h3>
      <div class="action-row">
        <button class="icon-btn" id="f-to-front" title="Bring to front (Shift+])">${ICON_TO_FRONT}</button>
        <button class="icon-btn" id="f-forward" title="Bring forward (])">${ICON_FORWARD}</button>
        <button class="icon-btn" id="f-backward" title="Send backward ([)">${ICON_BACKWARD}</button>
        <button class="icon-btn" id="f-to-back" title="Send to back (Shift+[)">${ICON_TO_BACK}</button>
      </div>
      <div class="action-row">${makeSymbolButtonHtml("f-make-symbol")}</div>
      <div class="action-row">
        <button class="icon-btn" id="f-mirror" title="Mirror copy: add a new curve reflected across the straight line joining this curve's two endpoints, forming a symmetric lens shape.">${ICON_MIRROR_SELF}</button>
        <button class="icon-btn" id="f-mirror-h" title="Mirror horizontal axis: add a new curve flipped top-to-bottom across the page's horizontal centerline.">${ICON_FLIP_V}</button>
        <button class="icon-btn" id="f-mirror-v" title="Mirror vertical axis: add a new curve flipped left-to-right across the page's vertical centerline.">${ICON_FLIP_H}</button>
        <button class="icon-btn" id="f-flip" title="Flip: swap this curve's start and end points.">${ICON_FLIP_DIR}</button>
        <button class="icon-btn danger" id="f-delete" title="Delete this curve permanently.">${ICON_TRASH}</button>
      </div>
    </div>
    <div class="panel-section">
      <h3>Misc</h3>
      <div class="field-row"><label title="Leave this curve out of the exported SVG (handy for symbol templates)">Exclude from SVG</label><input type="checkbox" id="f-no-export" ${c.noExport ? "checked" : ""}></div>
    </div>
  `;
  mountAnchorFields(c);
  wireMakeSymbolButton("f-make-symbol", [c]);
  document.getElementById("f-no-export").addEventListener("change", e => {
    if (e.target.checked) c.noExport = true; else delete c.noExport;
    pushHistory();
  });

  document.getElementById("f-to-front").addEventListener("click", () => reorderSelection("front"));
  document.getElementById("f-forward").addEventListener("click", () => reorderSelection("forward"));
  document.getElementById("f-backward").addEventListener("click", () => reorderSelection("backward"));
  document.getElementById("f-to-back").addEventListener("click", () => reorderSelection("back"));

  const colorFields = document.getElementById("color-fields");

  function paintSolidFields() {
    colorFields.innerHTML = "";
    mountColorField(colorFields, "Color", c.color, v => {
      c.color = v;
      renderCanvas(); pushHistory();
    });
  }

  function paintGradientFields() {
    colorFields.innerHTML = `
      <div class="gradient-preview" id="f-gpreview"></div>
      <div id="f-stops"></div>
      <div class="field-row">
        <label>Angle</label>
        <input type="range" id="f-gangle" min="0" max="359" step="1" value="${c.gradientAngle}">
        <input type="number" class="num-in" id="f-gangle-num" min="0" max="359" step="1" value="${c.gradientAngle}">
        <span class="unit">&deg;</span>
      </div>
    `;
    const updatePreview = () => {
      document.getElementById("f-gpreview").style.background =
        `linear-gradient(${cssGradientAngle(c.gradientAngle)}deg, ${stopsCss(c.stops)})`;
    };
    updatePreview();
    mountStopTable(document.getElementById("f-stops"), c.stops, false, () => { updatePreview(); renderCanvas(); });
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
    c.stops = c.stops || [{ o: 0, color: c.color }, { o: 1, color: "#5b8cff" }];
    c.gradientAngle = c.gradientAngle != null ? c.gradientAngle : 90;
    renderCurvePanel(); renderCanvas(); pushHistory();
  });

  // Opacity: a percent slider + number pair per stop. Like the other live
  // controls, 'input' only repaints the canvas and 'change' commits history.
  const opacityFields = document.getElementById("opacity-fields");
  function opacityRow(label, id, prop, dflt) {
    const pct = Math.round((c[prop] != null ? c[prop] : dflt) * 100);
    return `
      <div class="field-row">
        <label>${label}</label>
        <input type="range" id="${id}" min="0" max="100" step="1" value="${pct}">
        <input type="number" class="num-in" id="${id}-num" min="0" max="100" step="1" value="${pct}">
        <span class="unit">%</span>
      </div>`;
  }
  function wireOpacity(id, prop, onChange) {
    const range = document.getElementById(id);
    const num = document.getElementById(id + "-num");
    const apply = v => { c[prop] = v / 100; onChange(); renderCanvas(); };
    range.addEventListener("input", e => {
      const v = parseInt(e.target.value, 10);
      num.value = v; apply(v);
    });
    range.addEventListener("change", () => pushHistory());
    num.addEventListener("input", e => {
      const v = parseInt(e.target.value, 10);
      if (!Number.isFinite(v)) return;
      range.value = v; apply(Math.max(0, Math.min(100, v)));
    });
    num.addEventListener("change", e => {
      const v = Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0));
      e.target.value = v; range.value = v; apply(v);
      pushHistory();
    });
  }
  function paintOpacityFields() {
    if (!isOpGrad) {
      opacityFields.innerHTML = opacityRow("Opacity", "f-op", "opacity", 1);
      wireOpacity("f-op", "opacity", () => {});
      return;
    }
    const angle = c.opacityAngle || 0;
    opacityFields.innerHTML = `
      <div class="gradient-preview opacity-preview"><div id="f-oppreview"></div></div>
      <div id="f-ostops"></div>
      <div class="field-row">
        <label>Angle</label>
        <input type="range" id="f-opangle" min="0" max="359" step="1" value="${angle}">
        <input type="number" class="num-in" id="f-opangle-num" min="0" max="359" step="1" value="${angle}">
        <span class="unit">&deg;</span>
      </div>
    `;
    const updatePreview = () => {
      document.getElementById("f-oppreview").style.background =
        `linear-gradient(${cssGradientAngle(c.opacityAngle || 0)}deg, ${stopsCss(c.opacityStops, true)})`;
    };
    updatePreview();
    mountStopTable(document.getElementById("f-ostops"), c.opacityStops, true, () => { updatePreview(); renderCanvas(); });
    const angleInput = document.getElementById("f-opangle");
    const angleNum = document.getElementById("f-opangle-num");
    angleInput.addEventListener("input", e => {
      c.opacityAngle = parseInt(e.target.value, 10);
      angleNum.value = c.opacityAngle;
      updatePreview(); renderCanvas();
    });
    angleInput.addEventListener("change", () => pushHistory());
    angleNum.addEventListener("input", e => {
      const v = parseInt(e.target.value, 10);
      if (!Number.isFinite(v)) return;
      c.opacityAngle = v;
      angleInput.value = v;
      updatePreview(); renderCanvas();
    });
    angleNum.addEventListener("change", e => {
      const v = Math.max(0, Math.min(359, parseInt(e.target.value, 10) || 0));
      c.opacityAngle = v;
      e.target.value = v;
      angleInput.value = v;
      updatePreview(); renderCanvas();
      pushHistory();
    });
  }
  paintOpacityFields();

  document.getElementById("c-op-flat").addEventListener("click", () => {
    if (!isOpGrad) return;
    c.opacityMode = "flat";
    renderCurvePanel(); renderCanvas(); pushHistory();
  });
  document.getElementById("c-op-grad").addEventListener("click", () => {
    if (isOpGrad) return;
    c.opacityMode = "gradient";
    c.opacityStops = c.opacityStops || [{ o: 0, a: c.opacity != null ? c.opacity : 1 }, { o: 1, a: 0 }];
    c.opacityAngle = c.opacityAngle != null ? c.opacityAngle : 90;
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
        <span class="unit">px</span>
      </div>
      <div class="field-row">
        <label>Drift</label>
        <input type="range" id="f-drift" min="0" max="5" step="0.1" value="${drift}">
        <input type="number" class="num-in" id="f-drift-num" min="0" max="5" step="0.1" value="${drift}">
        <span class="unit">&times;</span>
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

  document.getElementById("f-flip").addEventListener("click", () => {
    flipCurve(c);
    resolveLinks();
    render();
    pushHistory();
  });

  document.getElementById("f-delete").addEventListener("click", () => {
    state.curves = state.curves.filter(cv => cv.id !== c.id);
    resolveLinks();
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

function hitTestPin(evt) {
  if (!state.selection || state.selection.type !== "instance") return null;
  const inst = state.instances.find(i => i.id === state.selection.id);
  if (!inst) return null;
  const pt = toSvgPoint(evt);
  let best = null, bestD = 10 / currentScale();
  for (const key of ["a", "b"]) {
    const d = Math.hypot(inst[key].x - pt.x, inst[key].y - pt.y);
    if (d < bestD) { bestD = d; best = { inst, key }; }
  }
  return best;
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
function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

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
    anchors: JSON.parse(JSON.stringify(c.anchors)),
    width: c.width, width2: c.width2, drift: c.drift, color: c.color,
    colorMode: c.colorMode, stops: clone(c.stops), gradientAngle: c.gradientAngle,
    opacity: c.opacity, opacityMode: c.opacityMode, opacityStops: clone(c.opacityStops), opacityAngle: c.opacityAngle };
}

// Mirrors a curve across the page's horizontal center axis (flips top/bottom).
function mirrorCurveHorizontalAxis(c) {
  const H = state.grid.height;
  const reflect = p => ({ x: p.x, y: H - p.y });
  const id = "c" + (state.curveIdCounter++);
  return { id, p0: reflect(c.p0), c1: reflect(c.c1), c2: reflect(c.c2), p3: reflect(c.p3),
    anchors: JSON.parse(JSON.stringify(c.anchors)),
    width: c.width, width2: c.width2, drift: c.drift, color: c.color,
    colorMode: c.colorMode, stops: clone(c.stops), gradientAngle: c.gradientAngle,
    opacity: c.opacity, opacityMode: c.opacityMode, opacityStops: clone(c.opacityStops), opacityAngle: c.opacityAngle };
}

// Mirrors a curve across the page's vertical center axis (flips left/right).
function mirrorCurveVerticalAxis(c) {
  const W = state.grid.width;
  const reflect = p => ({ x: W - p.x, y: p.y });
  const id = "c" + (state.curveIdCounter++);
  return { id, p0: reflect(c.p0), c1: reflect(c.c1), c2: reflect(c.c2), p3: reflect(c.p3),
    anchors: JSON.parse(JSON.stringify(c.anchors)),
    width: c.width, width2: c.width2, drift: c.drift, color: c.color,
    colorMode: c.colorMode, stops: clone(c.stops), gradientAngle: c.gradientAngle,
    opacity: c.opacity, opacityMode: c.opacityMode, opacityStops: clone(c.opacityStops), opacityAngle: c.opacityAngle };
}

// Snap target for a point being placed: an anchor of another curve (which
// also links to it), else a page corner, else the grid (if snapping) or the
// raw point. Alt bypasses all of it.
function snapPoint(evt, excludeId) {
  const raw = toSvgPoint(evt);
  if (evt.altKey) return { x: raw.x, y: raw.y };
  const tol = 11 / currentScale();
  const near = findNearAnchor(raw, tol, excludeId);
  if (near) return near;
  const { width: W, height: H } = state.grid;
  for (const k of [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }]) {
    if (Math.hypot(k.x - raw.x, k.y - raw.y) < tol) return { x: k.x, y: k.y };
  }
  return gridSnapOrRaw(raw);
}

function gridSnapOrRaw(raw) {
  const g = state.grid;
  return g.snap ? snapToGrid(raw.x, raw.y, g.resolution, g.width, g.height) : { x: raw.x, y: raw.y };
}

// Anchor under the cursor that a click should start a curve from.
function anchorStartAt(evt) {
  if (evt.altKey) return null;
  return findNearAnchor(toSvgPoint(evt), 7 / currentScale(), null);
}

function hitTestAnchor(evt) {
  if (!state.selection || state.selection.type !== "curve") return null;
  const c = state.curves.find(cv => cv.id === state.selection.id);
  if (!c) return null;
  const pt = toSvgPoint(evt);
  const tol = 8 / currentScale();
  let best = null, bestD = tol;
  for (const a of c.anchors) {
    if (isEndAnchor(a)) continue;
    const f = curveFrame(c, a.s);
    const d = Math.hypot(f.x - pt.x, f.y - pt.y);
    if (d < bestD) { bestD = d; best = { curve: c, anchor: a }; }
  }
  return best;
}

function newCurve(p0, p3) {
  const { c1, c2 } = defaultCurveBetween(p0, p3, state.grid.resolution);
  const id = "c" + (state.curveIdCounter++);
  const curve = ensureAnchors({ id, p0: { x: p0.x, y: p0.y }, c1, c2, p3: { x: p3.x, y: p3.y }, width: 3, color: "#2a2d34" });
  for (const [end, snap] of [["p0", p0], ["p3", p3]]) {
    if (!snap.link) continue;
    setLink(curve, end, snap.link);
    // Tangent-locked: start the control point on the endpoint so it takes the
    // default reach along the anchor's tangent.
    const la = linkedAnchor(curve, end);
    if (la && la.anchor.tangent) curve[end === "p0" ? "c1" : "c2"] = { ...curve[end] };
  }
  state.curves.push(curve);
  resolveLinks();
  lastCurveCreatedAt = performance.now();
  return curve;
}

// Standard control-point reach for a cubic approximating a quarter circle
// (4/3 * tan(pi/8)); the radial error is about 0.027%.
const QUARTER_KAPPA = 0.5522847498307936;

// A circle is four quarter-arc curves starting at the top and running
// clockwise. Each starts attached to the previous one's end anchor, so
// reshaping one arc drags its neighbor along. Returns the new curves.
function newCircle(center, r) {
  const arcs = [];
  for (let k = 0; k < 4; k++) {
    const a0 = (-90 + 90 * k) * Math.PI / 180, a1 = a0 + Math.PI / 2;
    const pt = a => ({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) });
    const p0 = pt(a0), p3 = pt(a1);
    const curve = newCurve(p0, p3);
    curve.c1 = { x: p0.x - QUARTER_KAPPA * r * Math.sin(a0), y: p0.y + QUARTER_KAPPA * r * Math.cos(a0) };
    curve.c2 = { x: p3.x + QUARTER_KAPPA * r * Math.sin(a1), y: p3.y - QUARTER_KAPPA * r * Math.cos(a1) };
    if (k > 0) setLink(curve, "p0", { curve: arcs[k - 1].id, anchor: "end" });
    arcs.push(curve);
  }
  resolveLinks();
  return arcs;
}

function finishCircle(edge) {
  const r = Math.hypot(edge.x - circlePending.x, edge.y - circlePending.y);
  const center = circlePending;
  cancelCircle();
  if (r < 2) return;
  const arcs = newCircle(center, r);
  setTool("curve");
  setSelection({ type: "curves", ids: arcs.map(c => c.id) });
  pushHistory();
}

function cancelCircle() {
  circlePending = null;
  previewLayer.innerHTML = "";
  hideHint();
}

function circleCenterAndEdge(evt) {
  const p = snapPoint(evt, null);
  return { x: p.x, y: p.y };
}

function onCircleMouseDown(evt) {
  if (circlePending) { finishCircle(circleCenterAndEdge(evt)); return; }
  circlePending = circleCenterAndEdge(evt);
  showHint("Drag or click to set the radius (hold Alt to place freely). Esc to cancel.", true);
  const startClient = { x: evt.clientX, y: evt.clientY };
  const onUp = up => {
    window.removeEventListener("mouseup", onUp);
    // A plain click leaves the center placed, awaiting a second click.
    if (circlePending && Math.hypot(up.clientX - startClient.x, up.clientY - startClient.y) >= DRAG_THRESHOLD_PX) {
      finishCircle(circleCenterAndEdge(up));
    }
  };
  window.addEventListener("mouseup", onUp);
}

function circlePreviewMarkup(center, edge) {
  const s = currentScale(), r = Math.hypot(edge.x - center.x, edge.y - center.y);
  return `<circle cx="${center.x}" cy="${center.y}" r="${r}" fill="none" stroke="#5b8cff" stroke-width="${1.6/s}" stroke-dasharray="${4/s},${3/s}"></circle>` +
    `<line x1="${center.x}" y1="${center.y}" x2="${edge.x}" y2="${edge.y}" stroke="#5b8cff" stroke-width="${1.6/s}" stroke-dasharray="${3/s},${3/s}"></line>` +
    `<circle cx="${center.x}" cy="${center.y}" r="${7/s}" fill="#2ecc71" stroke="#1b1d22" stroke-width="${1/s}"></circle>` +
    `<circle cx="${edge.x}" cy="${edge.y}" r="${7/s}" fill="#e6453c" stroke="#1b1d22" stroke-width="${1/s}" opacity="0.6"></circle>`;
}

const DRAG_THRESHOLD_PX = 3;

function startWindowDrag(ctx) {
  dragCtx = ctx;
  window.addEventListener("mousemove", onWindowMouseMove);
  window.addEventListener("mouseup", onWindowMouseUp);
}

function beginDrawAt(snap) {
  drawPending = snap;
  showHint("Click again to finish the curve (snaps to anchors; hold Alt to place freely). Esc to cancel.", true);
}

function onStageMouseDown(evt) {
  if (spacePanning || evt.button === 1 || evt.button === 2) {
    evt.preventDefault();
    startPan(evt);
    return;
  }
  if (evt.button !== 0) return;

  if (state.tool === "circle") { onCircleMouseDown(evt); return; }
  if (state.tool === "symbol") { onSymbolMouseDown(evt); return; }
  if (state.tool !== "curve") return;
  if (handleDoubleClick(evt)) return;

  // curve tool: selecting/dragging existing curves takes priority over
  // starting a new one, except while a draw is already in progress, where
  // the click always finishes/connects it (never reinterpreted as a select).
  if (drawPending) {
    let p = snapPoint(evt, null);
    // Clicking back on the start point makes a self-loop.
    if (!p.link && Math.hypot(p.x - drawPending.x, p.y - drawPending.y) < 6 / currentScale()) {
      p = { x: drawPending.x, y: drawPending.y };
    }
    const curve = newCurve(drawPending, p);
    drawPending = null;
    previewLayer.innerHTML = "";
    hideHint();
    setSelection({ type: "curve", id: curve.id });
    pushHistory();
    return;
  }

  const pt = toSvgPoint(evt);
  const forceStart = evt.ctrlKey || evt.metaKey;

  // Ctrl/Cmd-click always starts a curve from the anchor under the cursor,
  // even one of the selected curve's own.
  if (forceStart) {
    const start = anchorStartAt(evt);
    if (start) { beginDrawAt(start); return; }
  }

  const handleHit = hitTestHandle(evt);
  if (handleHit) {
    startWindowDrag({ kind: "handle", curve: handleHit.curve, key: handleHit.key, moved: false });
    return;
  }

  const pinHit = hitTestPin(evt);
  if (pinHit) {
    startWindowDrag({ kind: "pin", inst: pinHit.inst, key: pinHit.key, moved: false });
    return;
  }

  const anchorHit = hitTestAnchor(evt);
  if (anchorHit) {
    startWindowDrag({ kind: "anchor", curve: anchorHit.curve, anchor: anchorHit.anchor, moved: false });
    return;
  }

  const start = anchorStartAt(evt);
  if (start) { hideHint(); beginDrawAt(start); return; }

  const curveHit = hitTestCurve(pt);
  if (curveHit && curveHit.inst) {
    hideHint();
    const inst = state.instances.find(i => i.id === curveHit.inst);
    if (!state.selection || state.selection.type !== "instance" || state.selection.id !== inst.id) {
      setSelection({ type: "instance", id: inst.id });
    }
    svg.style.cursor = "grabbing";
    startWindowDrag({ kind: "instance", inst, start: pt, startClient: { x: evt.clientX, y: evt.clientY },
      moved: false, orig: { a: { ...inst.a }, b: { ...inst.b } } });
    return;
  }
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
    svg.style.cursor = "grabbing";
    startWindowDrag({
      kind: "curve",
      curves,
      clickedId: curveHit.id,
      start: pt,
      startClient: { x: evt.clientX, y: evt.clientY },
      moved: false,
      orig: curves.map(c => ({ p0: { ...c.p0 }, c1: { ...c.c1 }, c2: { ...c.c2 }, p3: { ...c.p3 } })),
    });
    return;
  }

  // empty canvas: start a new curve
  hideHint();
  beginDrawAt(snapPoint(evt, null));
}

function onSymbolMouseDown(evt) {
  const sym = state.symbols.find(sy => sy.id === activeSymbolId);
  if (!sym) { showHint("Make a symbol first: select curves with the Curve tool and press Make symbol."); return; }
  const p = snapPoint(evt, null);
  if (!symbolPending) {
    symbolPending = p;
    showHint("Click the end point to place the symbol (snaps to anchors; hold Alt to place freely). Esc to cancel.", true);
    return;
  }
  if (Math.hypot(p.x - symbolPending.x, p.y - symbolPending.y) < 6 / currentScale()) return;
  const inst = newInstance(sym, symbolPending, p, symbolFlip);
  symbolPending = null;
  previewLayer.innerHTML = "";
  hideHint();
  if (!state.instances.includes(inst)) return;
  pushHistory();
  render();
}

function symbolPreviewMarkup(evt) {
  const s = currentScale(), lw = 1 / s, rA = 7 / s;
  const p = snapPoint(evt, null);
  const dot = (q, fill, opacity) => snapRingMarkup(q) +
    `<circle cx="${q.x}" cy="${q.y}" r="${rA}" fill="${fill}" stroke="#1b1d22" stroke-width="${lw}" opacity="${opacity}"></circle>`;
  const sym = state.symbols.find(sy => sy.id === activeSymbolId);
  const built = sym && symbolPending && buildInstanceCurves(sym, symbolPending, p, symbolFlip, "preview", "preview");
  if (!built) return dot(p, "#2ecc71", 0.6);
  const m = curvesMarkup(built, false);
  return `<defs>${m.defs}</defs><g opacity="0.55">${m.body}</g>` + dot(symbolPending, "#2ecc71", 1) + dot(p, "#e6453c", 0.6);
}

function redrawDuringDrag() {
  renderHandles();
  curvesLayer.innerHTML = curvesMarkup(state.curves).body;
}

function snapRingMarkup(snap) {
  if (!snap || !snap.link) return "";
  const s = currentScale();
  return `<circle cx="${snap.x}" cy="${snap.y}" r="${11 / s}" fill="none" stroke="#c14bff" stroke-width="${2 / s}"></circle>`;
}

function onWindowMouseMove(evt) {
  if (!dragCtx) return;
  if (dragCtx.kind === "curve") {
    const raw = toSvgPoint(evt);
    if (!dragCtx.moved) {
      if (Math.hypot(evt.clientX - dragCtx.startClient.x, evt.clientY - dragCtx.startClient.y) < DRAG_THRESHOLD_PX) return;
      dragCtx.moved = true;
      // A dragged curve leaves the anchors it was attached to, unless their
      // host is being dragged along with it.
      const dragged = new Set(dragCtx.curves.map(c => c.id));
      for (const c of dragCtx.curves) {
        for (const end of ["p0", "p3"]) {
          if (c.links && c.links[end] && !dragged.has(c.links[end].curve)) setLink(c, end, null);
        }
      }
    }
    let dx = raw.x - dragCtx.start.x, dy = raw.y - dragCtx.start.y;
    if (state.grid.snap && !evt.altKey) {
      // Whole-step moves that keep the group on the page.
      const res = state.grid.resolution, { width: W, height: H } = state.grid;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const o of dragCtx.orig) {
        for (const p of [o.p0, o.c1, o.c2, o.p3]) {
          minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
          minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
        }
      }
      dx = Math.max(-minX, Math.min(W - maxX, Math.round(dx / res) * res));
      dy = Math.max(-minY, Math.min(H - maxY, Math.round(dy / res) * res));
    }
    dragCtx.curves.forEach((c, i) => {
      const o = dragCtx.orig[i];
      c.p0 = { x: o.p0.x + dx, y: o.p0.y + dy };
      c.c1 = { x: o.c1.x + dx, y: o.c1.y + dy };
      c.c2 = { x: o.c2.x + dx, y: o.c2.y + dy };
      c.p3 = { x: o.p3.x + dx, y: o.p3.y + dy };
    });
    resolveLinks(); // curves attached to the dragged ones come along
    redrawDuringDrag();
    return;
  }
  if (dragCtx.kind === "instance") {
    const ctx = dragCtx, inst = ctx.inst;
    if (!ctx.moved) {
      if (Math.hypot(evt.clientX - ctx.startClient.x, evt.clientY - ctx.startClient.y) < DRAG_THRESHOLD_PX) return;
      ctx.moved = true;
      delete inst.links; // a dragged instance leaves the anchors it was attached to
    }
    const raw = toSvgPoint(evt);
    let dx = raw.x - ctx.start.x, dy = raw.y - ctx.start.y;
    if (state.grid.snap && !evt.altKey) {
      const res = state.grid.resolution;
      dx = Math.round(dx / res) * res;
      dy = Math.round(dy / res) * res;
    }
    inst.a = { x: ctx.orig.a.x + dx, y: ctx.orig.a.y + dy };
    inst.b = { x: ctx.orig.b.x + dx, y: ctx.orig.b.y + dy };
    resolveLinks();
    redrawDuringDrag();
    return;
  }
  dragCtx.moved = true;
  if (dragCtx.kind === "pin") {
    const inst = dragCtx.inst, key = dragCtx.key;
    const snap = snapPoint(evt, inst.id);
    inst[key] = { x: snap.x, y: snap.y };
    setInstanceLink(inst, key, snap.link || null);
    previewLayer.innerHTML = snapRingMarkup(snap);
    resolveLinks();
    redrawDuringDrag();
    return;
  }
  if (dragCtx.kind === "anchor") {
    const s = nearestS(dragCtx.curve, toSvgPoint(evt));
    dragCtx.anchor.s = Math.max(0.001, Math.min(0.999, s));
    resolveLinks();
    redrawDuringDrag();
    return;
  }
  const c = dragCtx.curve, key = dragCtx.key;
  if (key === "p0" || key === "p3") {
    // An endpoint snaps to (and links with) other curves' anchors; anywhere
    // else it is free and any previous link is dropped.
    const snap = snapPoint(evt, c.id);
    const ctrl = key === "p0" ? "c1" : "c2";
    c[ctrl] = { x: c[ctrl].x + snap.x - c[key].x, y: c[ctrl].y + snap.y - c[key].y };
    c[key] = { x: snap.x, y: snap.y };
    setLink(c, key, snap.link || null);
    previewLayer.innerHTML = snapRingMarkup(snap);
  } else {
    const p = evt.altKey ? toSvgPoint(evt) : gridSnapOrRaw(toSvgPoint(evt));
    c[key] = { x: p.x, y: p.y };
  }
  resolveLinks();
  redrawDuringDrag();
}

function onWindowMouseUp() {
  if (!dragCtx) return;
  const wasNoOpDrag = !dragCtx.moved;
  // A plain click (no drag) on one member of a multi-selection re-focuses
  // just that curve, so it can be selected individually without Shift.
  if (wasNoOpDrag && dragCtx.kind === "curve" && dragCtx.curves.length > 1) {
    setSelection({ type: "curve", id: dragCtx.clickedId });
  }
  if (dragCtx.kind === "anchor") ensureAnchors(dragCtx.curve);
  dragCtx = null;
  previewLayer.innerHTML = "";
  window.removeEventListener("mousemove", onWindowMouseMove);
  window.removeEventListener("mouseup", onWindowMouseUp);
  if (state.tool === "curve") svg.style.cursor = "default";
  if (wasNoOpDrag) return;
  render();
  pushHistory();
}

// Double-click on the selected curve adds an anchor there; on one of its free
// anchors it removes that anchor. Detected from consecutive mousedowns because
// selecting re-renders the canvas, which stops the browser firing "dblclick".
// Returns whether the click was consumed.
let lastMouseDown = { t: -Infinity, x: 0, y: 0 };
function handleDoubleClick(evt) {
  const now = performance.now();
  const isDouble = now - lastMouseDown.t < 350 && Math.hypot(evt.clientX - lastMouseDown.x, evt.clientY - lastMouseDown.y) < 5;
  lastMouseDown = { t: isDouble ? -Infinity : now, x: evt.clientX, y: evt.clientY };
  if (!isDouble || drawPending || now - lastCurveCreatedAt < 600) return false;
  if (!state.selection || state.selection.type !== "curve") return false;
  const c = state.curves.find(cv => cv.id === state.selection.id);
  if (!c) return false;
  const anchorHit = hitTestAnchor(evt);
  if (anchorHit) {
    c.anchors = c.anchors.filter(a => a !== anchorHit.anchor);
  } else {
    const pt = toSvgPoint(evt);
    if (distToPolyline(pt, flattenCubic(c.p0, c.c1, c.c2, c.p3, FLATTEN_SEGMENTS)) > 8 / currentScale()) return false;
    addAnchor(c, nearestS(c, pt));
  }
  ensureAnchors(c);
  resolveLinks();
  render();
  pushHistory();
  return true;
}

// Drawn into previewLayer, never handlesLayer, so this hover-only feedback
// can never overwrite the selected curve's actual drag handles underneath it.
function onStageMouseMove(evt) {
  if (spacePanning) { previewLayer.innerHTML = ""; return; }
  if (state.tool === "circle") {
    svg.style.cursor = "crosshair";
    const p = circleCenterAndEdge(evt);
    const s = currentScale();
    previewLayer.innerHTML = circlePending
      ? circlePreviewMarkup(circlePending, p)
      : `<circle cx="${p.x}" cy="${p.y}" r="${7/s}" fill="#2ecc71" stroke="#1b1d22" stroke-width="${1/s}" opacity="0.6"></circle>`;
    return;
  }
  if (state.tool === "symbol") {
    svg.style.cursor = "crosshair";
    previewLayer.innerHTML = symbolPreviewMarkup(evt);
    return;
  }
  if (state.tool === "curve" && !dragCtx) {
    const s = currentScale();
    const rA = 7 / s, lw = 1 / s;
    if (drawPending) {
      const p = snapPoint(evt, null);
      const { c1, c2 } = defaultCurveBetween(drawPending, p, state.grid.resolution);
      const preview = `M ${drawPending.x} ${drawPending.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p.x} ${p.y}`;
      previewLayer.innerHTML =
        snapRingMarkup(drawPending) +
        `<circle cx="${drawPending.x}" cy="${drawPending.y}" r="${rA}" fill="#2ecc71" stroke="#1b1d22" stroke-width="${lw}"></circle>` +
        `<path d="${preview}" fill="none" stroke="#5b8cff" stroke-width="${1.6/s}" stroke-dasharray="${4/s},${3/s}"></path>` +
        snapRingMarkup(p) +
        `<circle cx="${p.x}" cy="${p.y}" r="${rA}" fill="#e6453c" stroke="#1b1d22" stroke-width="${lw}" opacity="0.6"></circle>`;
      return;
    }
    if (hitTestHandle(evt) || hitTestPin(evt) || hitTestAnchor(evt)) {
      svg.style.cursor = "grab";
      previewLayer.innerHTML = "";
      return;
    }
    const start = anchorStartAt(evt);
    if (start) {
      svg.style.cursor = "crosshair";
      previewLayer.innerHTML = snapRingMarkup(start) +
        `<circle cx="${start.x}" cy="${start.y}" r="${rA}" fill="#2ecc71" stroke="#1b1d22" stroke-width="${lw}" opacity="0.6"></circle>`;
      return;
    }
    const hoverCurve = hitTestCurve(toSvgPoint(evt));
    if (hoverCurve) {
      svg.style.cursor = "grab";
      const c = hoverCurve;
      previewLayer.innerHTML = isCurveSelected(c.id) ? "" :
        `<path d="M ${c.p0.x} ${c.p0.y} C ${c.c1.x} ${c.c1.y}, ${c.c2.x} ${c.c2.y}, ${c.p3.x} ${c.p3.y}" fill="none" stroke="#5b8cff" stroke-width="${3/s}" stroke-linecap="round" opacity="0.55"></path>`;
      return;
    }
    svg.style.cursor = "crosshair";
    const p = snapPoint(evt, null);
    previewLayer.innerHTML = snapRingMarkup(p) +
      `<circle cx="${p.x}" cy="${p.y}" r="${rA}" fill="#2ecc71" stroke="#1b1d22" stroke-width="${lw}" opacity="0.6"></circle>`;
    return;
  }
  previewLayer.innerHTML = "";
}

function setTool(tool) {
  state.tool = tool;
  drawPending = null;
  circlePending = null;
  symbolPending = null;
  state.selection = null;
  hideHint();
  previewLayer.innerHTML = "";
  document.getElementById("tool-page").classList.toggle("active", tool === "page");
  document.getElementById("tool-grid").classList.toggle("active", tool === "grid");
  document.getElementById("tool-palette").classList.toggle("active", tool === "palette");
  document.getElementById("tool-curve").classList.toggle("active", tool === "curve");
  document.getElementById("tool-circle").classList.toggle("active", tool === "circle");
  document.getElementById("tool-symbol").classList.toggle("active", tool === "symbol");
  svg.style.cursor = "default";
  if (tool === "curve") {
    showHint("Click a curve to select it, or click empty canvas (or an anchor) to start a new one.", true);
  } else if (tool === "circle") {
    showHint("Drag from the center to the edge to draw a circle (four quarter-arc curves).", true);
  } else if (tool === "symbol") {
    showHint("Click a start point, then an end point, to place the symbol between them.", true);
  }
  render();
}

document.getElementById("tool-page").addEventListener("click", () => setTool("page"));
document.getElementById("tool-grid").addEventListener("click", () => setTool("grid"));
document.getElementById("tool-palette").addEventListener("click", () => setTool("palette"));
document.getElementById("tool-curve").addEventListener("click", () => setTool("curve"));
document.getElementById("tool-circle").addEventListener("click", () => setTool("circle"));
document.getElementById("tool-symbol").addEventListener("click", () => setTool("symbol"));

document.addEventListener("keydown", evt => {
  if (evt.key === "Escape") {
    if (circlePending) cancelCircle();
    else if (symbolPending) { symbolPending = null; previewLayer.innerHTML = ""; hideHint(); }
    else if (drawPending) { drawPending = null; hideHint(); renderHandles(); }
    else if (state.selection) { state.selection = null; render(); }
  } else if ((evt.key === "Delete" || evt.key === "Backspace") && state.selection && state.selection.type === "instance") {
    if (isTyping(evt)) return;
    deleteSelectedInstance();
  } else if ((evt.key === "Delete" || evt.key === "Backspace") && state.selection &&
      (state.selection.type === "curve" || state.selection.type === "curves")) {
    if (document.activeElement && ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
    const idSet = new Set(state.selection.type === "curve" ? [state.selection.id] : state.selection.ids);
    state.curves = state.curves.filter(cv => !idSet.has(cv.id));
    resolveLinks();
    state.selection = null;
    render(); pushHistory();
  } else if ((evt.key === "]" || evt.key === "}") && !evt.ctrlKey && !evt.metaKey && !isTyping(evt) &&
      state.selection && ["curve", "curves", "instance"].includes(state.selection.type)) {
    reorderSelection(evt.shiftKey || evt.key === "}" ? "front" : "forward");
  } else if ((evt.key === "[" || evt.key === "{") && !evt.ctrlKey && !evt.metaKey && !isTyping(evt) &&
      state.selection && ["curve", "curves", "instance"].includes(state.selection.type)) {
    reorderSelection(evt.shiftKey || evt.key === "{" ? "back" : "backward");
  } else if (evt.key.toLowerCase() === "c" && !evt.ctrlKey && !evt.metaKey && !isTyping(evt)) {
    setTool("curve");
  } else if (evt.key.toLowerCase() === "s" && !evt.ctrlKey && !evt.metaKey && !isTyping(evt)) {
    setTool("symbol");
  } else if (evt.key.toLowerCase() === "o" && !evt.ctrlKey && !evt.metaKey && !isTyping(evt)) {
    setTool("circle");
  } else if (evt.key.toLowerCase() === "p" && !evt.ctrlKey && !evt.metaKey && !isTyping(evt)) {
    setTool("page");
  } else if (evt.key.toLowerCase() === "g" && !evt.ctrlKey && !evt.metaKey && !isTyping(evt)) {
    setTool("grid");
  } else if (evt.key.toLowerCase() === "l" && !evt.ctrlKey && !evt.metaKey && !isTyping(evt)) {
    setTool("palette");
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
svg.addEventListener("contextmenu", evt => evt.preventDefault()); // right button pans

document.getElementById("zoom-out-btn").addEventListener("click", () => zoomOut());
document.getElementById("zoom-in-btn").addEventListener("click", () => zoomIn());
document.getElementById("zoom-level-btn").addEventListener("click", () => resetZoom());
document.getElementById("zoom-fit-btn").addEventListener("click", () => fitToScreen());

document.getElementById("undo-btn").addEventListener("click", undo);
document.getElementById("redo-btn").addEventListener("click", redo);
document.getElementById("new-btn").addEventListener("click", newDesign);
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
  const curveA = curvesMarkup(state.curves.filter(c => !c.noExport), false);
  const curves = curveA.body;
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="${SVGNS}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n` +
    `<defs>${curveA.defs}</defs>\n` +
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
