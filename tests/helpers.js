const { test: base, expect } = require("@playwright/test");

const STORAGE_KEY = "coeurf:design:v1";

// Every test starts on a fresh page (new context => empty localStorage).
const test = base.extend({
  app: async ({ page }, use) => {
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto("/");
    await use(new App(page));
    expect(errors, "uncaught page errors").toEqual([]);
  },
});

let curveSeq = 0;
function curve(p0, p3, extra = {}) {
  const lerp = (a, b, t) => a + (b - a) * t;
  return {
    id: `t${++curveSeq}`,
    p0, p3,
    c1: { x: lerp(p0.x, p3.x, 1 / 3), y: lerp(p0.y, p3.y, 1 / 3) },
    c2: { x: lerp(p0.x, p3.x, 2 / 3), y: lerp(p0.y, p3.y, 2 / 3) },
    width: 3, color: "#2a2d34",
    ...extra,
  };
}

function design({ curves = [], grid = {}, palette, fills = [] } = {}) {
  return {
    grid: {
      width: 800, height: 600, resolution: 20,
      visible: true, specialLines: { center: false, thirds: false, golden: false }, ...grid,
    },
    palette: palette || ["#2a2d34", "#ffffff", "#e6453c", "#ffb020", "#2ecc71", "#5b8cff", "#c14bff"],
    curves,
    fills,
    curveIdCounter: curves.length + 1,
  };
}

class App {
  constructor(page) { this.page = page; }

  // --- state access (top-level `const state` is reachable from evaluate) ---
  state() { return this.page.evaluate(() => JSON.parse(JSON.stringify({
    grid: state.grid, palette: state.palette, curves: state.curves, fills: state.fills,
    order: state.order, selection: state.selection, tool: state.tool,
  }))); }
  curves() { return this.page.evaluate(() => JSON.parse(JSON.stringify(state.curves))); }
  fills() { return this.page.evaluate(() => JSON.parse(JSON.stringify(state.fills))); }
  saved() { return this.page.evaluate(k => JSON.parse(localStorage.getItem(k)), STORAGE_KEY); }

  // Seed a design through autosave and reload, like a returning user.
  async load(d) {
    await this.page.evaluate(([k, v]) => localStorage.setItem(k, JSON.stringify(v)), [STORAGE_KEY, d]);
    await this.page.reload();
    await this.page.waitForSelector("#stage");
  }

  // --- coordinates: design units -> viewport pixels ---
  async toScreen(x, y) {
    return this.page.evaluate(([x, y]) => {
      const pt = svg.createSVGPoint(); pt.x = x; pt.y = y;
      const s = pt.matrixTransform(svg.getScreenCTM());
      return { x: s.x, y: s.y };
    }, [x, y]);
  }
  // Accepts { modifiers: ["Shift"] } like locator.click (page.mouse.click has no such option).
  async click(x, y, { modifiers = [] } = {}) {
    const s = await this.toScreen(x, y);
    for (const m of modifiers) await this.page.keyboard.down(m);
    await this.page.mouse.click(s.x, s.y);
    for (const m of modifiers) await this.page.keyboard.up(m);
  }
  async move(x, y) { const s = await this.toScreen(x, y); await this.page.mouse.move(s.x, s.y); }
  async drag(from, to, { steps = 8 } = {}) {
    const a = await this.toScreen(from[0], from[1]);
    const b = await this.toScreen(to[0], to[1]);
    await this.page.mouse.move(a.x, a.y);
    await this.page.mouse.down();
    await this.page.mouse.move(b.x, b.y, { steps });
    await this.page.mouse.up();
  }
  // Draw a curve with two clicks; returns nothing, read curves() afterwards.
  async draw(a, b) { await this.click(a[0], a[1]); await this.click(b[0], b[1]); }

  tool(name) { return this.page.click(`#tool-${name}`); }
  get panel() { return this.page.locator("#panel"); }
  get hint() { return this.page.locator("#hint"); }
  // The hint's text lingers after it is hidden; visibility is the .visible class.
  get hintVisible() { return this.page.locator("#hint.visible"); }
  get undoBtn() { return this.page.locator("#undo-btn"); }
  get redoBtn() { return this.page.locator("#redo-btn"); }
  zoomLabel() { return this.page.locator("#zoom-level-btn"); }
  // The <path> elements actually painted for curves.
  curvePaths() { return this.page.locator("#stage path[data-curve-id]"); }
  // The <path> elements actually painted for fills.
  fillPaths() { return this.page.locator("#stage path[data-fill-id]"); }
}

module.exports = { test, expect, curve, design, STORAGE_KEY };
