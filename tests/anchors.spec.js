const { test, expect, curve, design: baseDesign } = require("./helpers");

// These tests place things at exact, off-grid coordinates, so snapping is off
// unless a test turns it on.
const design = (d = {}) => baseDesign({ ...d, grid: { snap: false, ...(d.grid || {}) } });

// A straight horizontal host (arc length 400, so s maps linearly to x) and a
// child whose end is already attached to the host's midpoint anchor.
const HOST = curve({ x: 100, y: 300 }, { x: 500, y: 300 }, {
  id: "h",
  anchors: [{ id: "start", s: 0 }, { id: "a1", s: 0.5 }, { id: "end", s: 1 }],
});
const CHILD = curve({ x: 300, y: 100 }, { x: 300, y: 300 }, { id: "k", links: { p3: { curve: "h", anchor: "a1" } } });
const byId = (cs, id) => cs.find(c => c.id === id);

test.describe("anchors", () => {
  test("designs without anchors get start/end anchors on load", async ({ app }) => {
    await app.load(design({ curves: [curve({ x: 100, y: 100 }, { x: 300, y: 100 }, { id: "a" })] }));
    expect((await app.curves())[0].anchors).toEqual([{ id: "start", s: 0 }, { id: "end", s: 1 }]);
  });

  test("presets add evenly spaced anchors and Ends removes them", async ({ app }) => {
    await app.load(design({ curves: [curve({ x: 100, y: 100 }, { x: 500, y: 100 }, { id: "a" })] }));
    await app.click(300, 100);
    await app.page.click('#a-presets button[data-div="3"]');
    let a = (await app.curves())[0].anchors;
    expect(a.map(x => x.s.toFixed(3))).toEqual(["0.000", "0.333", "0.667", "1.000"]);
    await app.page.click('#a-presets button[data-div="1"]');
    a = (await app.curves())[0].anchors;
    expect(a.map(x => x.id)).toEqual(["start", "end"]);
  });

  test("Divide evenly accepts any count and the add/remove buttons work", async ({ app }) => {
    await app.load(design({ curves: [curve({ x: 100, y: 100 }, { x: 500, y: 100 }, { id: "a" })] }));
    await app.click(300, 100);
    await app.page.fill("#a-divs", "5");
    await app.page.locator("#a-divs").blur();
    expect((await app.curves())[0].anchors).toHaveLength(6);
    await app.page.locator(".a-del").first().click();
    expect((await app.curves())[0].anchors).toHaveLength(5);
    await app.page.click("#a-add");
    expect((await app.curves())[0].anchors).toHaveLength(6);
  });

  test("anchors are spaced by arc length, not by t", async ({ app }) => {
    // Control points bunched at p0: t=0.5 sits far from the arc-length midpoint.
    const c = curve({ x: 100, y: 100 }, { x: 500, y: 100 }, { id: "a", c1: { x: 100, y: 100 }, c2: { x: 120, y: 100 } });
    await app.load(design({ curves: [c] }));
    await app.click(300, 100);
    await app.page.click('#a-presets button[data-div="2"]');
    const mid = await app.page.evaluate(() => { const c = state.curves[0]; return curveFrame(c, 0.5); });
    expect(mid.x).toBeCloseTo(300, -1);
  });

  test("double-click adds an anchor on the selected curve; double-click on it removes it", async ({ app }) => {
    await app.load(design({ curves: [curve({ x: 100, y: 100 }, { x: 500, y: 100 }, { id: "a" })] }));
    await app.click(300, 100);
    const pt = await app.toScreen(400, 100);
    await app.page.mouse.dblclick(pt.x, pt.y);
    let a = (await app.curves())[0].anchors;
    expect(a).toHaveLength(3);
    expect(a[1].s).toBeCloseTo(0.75, 1);
    await app.page.mouse.dblclick(pt.x, pt.y);
    expect((await app.curves())[0].anchors).toHaveLength(2);
  });

  test("dragging an anchor slides it along the curve", async ({ app }) => {
    await app.load(design({ curves: [HOST] }));
    await app.click(200, 300);
    await app.drag([300, 300], [400, 330]);
    const a = byId(await app.curves(), "h").anchors[1];
    expect(a.s).toBeCloseTo(0.75, 2);
  });

  test("anchor positions can be typed and tangent toggled", async ({ app }) => {
    await app.load(design({ curves: [HOST] }));
    await app.click(200, 300);
    await app.page.fill('[data-anchor="a1"] .a-s', "25");
    await app.page.locator('[data-anchor="a1"] .a-s').blur();
    expect(byId(await app.curves(), "h").anchors[1].s).toBe(0.25);
    await app.page.check('[data-anchor="a1"] .a-tan');
    expect(byId(await app.curves(), "h").anchors[1].tangent).toBe(true);
  });
});

test.describe("links", () => {
  test("moving the host drags attached curves along", async ({ app }) => {
    await app.load(design({ curves: [HOST, CHILD] }));
    await app.drag([200, 300], [250, 360]);
    const cs = await app.curves();
    const h = byId(cs, "h"), k = byId(cs, "k");
    expect(h.p0.x).toBeCloseTo(150, -1);
    expect(k.p3.x).toBeCloseTo(350, -1);
    expect(k.p3.y).toBeCloseTo(360, -1);
    expect(k.p0).toEqual({ x: 300, y: 100 }); // far end stays put
    expect(k.links).toEqual({ p3: { curve: "h", anchor: "a1" } });
  });

  test("reshaping the host keeps the attached endpoint on the anchor", async ({ app }) => {
    await app.load(design({ curves: [HOST, CHILD] }));
    await app.click(200, 300);
    await app.drag([500, 300], [500, 400]);
    const cs = await app.curves();
    const frame = await app.page.evaluate(() => curveFrame(state.curves[0], 0.5));
    expect(byId(cs, "k").p3.x).toBeCloseTo(frame.x, 3);
    expect(byId(cs, "k").p3.y).toBeCloseTo(frame.y, 3);
  });

  test("sliding the anchor moves the attached endpoint", async ({ app }) => {
    await app.load(design({ curves: [HOST, CHILD] }));
    await app.click(200, 300);
    await app.drag([300, 300], [400, 300]);
    expect(byId(await app.curves(), "k").p3.x).toBeCloseTo(400, -1);
  });

  test("links chain: a grandchild follows when the host moves", async ({ app }) => {
    const grand = curve({ x: 600, y: 100 }, { x: 300, y: 100 }, { id: "g", links: { p3: { curve: "k", anchor: "start" } } });
    await app.load(design({ curves: [HOST, CHILD, grand] }));
    await app.drag([200, 300], [200, 340]);
    const cs = await app.curves();
    // k's start is a free end, so g's attachment to it must not move.
    expect(byId(cs, "g").p3).toEqual({ x: 300, y: 100 });
    expect(byId(cs, "k").p3.y).toBeCloseTo(340, 0);
  });

  test("dragging an attached curve itself detaches it", async ({ app }) => {
    await app.load(design({ curves: [HOST, CHILD] }));
    await app.drag([300, 150], [360, 150]);
    const k = byId(await app.curves(), "k");
    expect(k.links).toBeUndefined();
    expect(k.p3.x).toBeCloseTo(360, -1);
  });

  test("dragging host and child together keeps the link", async ({ app }) => {
    await app.load(design({ curves: [HOST, CHILD] }));
    await app.click(200, 300);
    await app.click(300, 150, { modifiers: ["Shift"] });
    await app.drag([200, 300], [240, 300]);
    const k = byId(await app.curves(), "k");
    expect(k.links).toEqual({ p3: { curve: "h", anchor: "a1" } });
    expect(k.p3.x).toBeCloseTo(340, -1);
  });

  test("dragging an attached endpoint away detaches; onto another anchor re-links", async ({ app }) => {
    await app.load(design({ curves: [HOST, CHILD] }));
    await app.click(300, 200);
    await app.drag([300, 300], [450, 200]);
    let k = byId(await app.curves(), "k");
    expect(k.links).toBeUndefined();
    expect(k.p3.x).toBeCloseTo(450, -1);
    await app.drag([450, 200], [500, 303]);
    k = byId(await app.curves(), "k");
    expect(k.links).toEqual({ p3: { curve: "h", anchor: "end" } });
    expect(k.p3).toEqual({ x: 500, y: 300 });
  });

  test("the panel lists links and Detach removes one", async ({ app }) => {
    await app.load(design({ curves: [HOST, CHILD] }));
    await app.click(300, 150);
    await expect(app.panel).toContainText("End attached to #2 of h");
    await app.page.click(".detach");
    expect(byId(await app.curves(), "k").links).toBeUndefined();
  });

  test("deleting the host drops the dangling link but keeps the child", async ({ app }) => {
    await app.load(design({ curves: [HOST, CHILD] }));
    await app.click(200, 300);
    await app.page.keyboard.press("Delete");
    const cs = await app.curves();
    expect(cs).toHaveLength(1);
    expect(cs[0].links).toBeUndefined();
  });

  test("Ctrl+click on an anchor starts a curve from it, linked", async ({ app }) => {
    await app.load(design({ curves: [HOST] }));
    await app.click(300, 300, { modifiers: ["Control"] });
    await app.click(300, 450);
    const k = (await app.curves())[1];
    expect(k.p0).toEqual({ x: 300, y: 300 });
    expect(k.links).toEqual({ p0: { curve: "h", anchor: "a1" } });
  });

  test("clicking an anchor of an unselected curve also starts a curve", async ({ app }) => {
    await app.load(design({ curves: [HOST] }));
    await app.click(500, 300);
    await app.click(500, 450);
    expect((await app.curves())[1].links).toEqual({ p0: { curve: "h", anchor: "end" } });
  });

  test("undo restores links and anchors", async ({ app }) => {
    await app.load(design({ curves: [HOST, CHILD] }));
    await app.drag([200, 300], [250, 360]);
    await app.undoBtn.click();
    const k = byId(await app.curves(), "k");
    expect(k.p3).toEqual({ x: 300, y: 300 });
    expect(k.links).toEqual({ p3: { curve: "h", anchor: "a1" } });
  });

  test("mirror copies carry anchors but no links", async ({ app }) => {
    await app.load(design({ curves: [HOST, CHILD] }));
    await app.click(300, 150);
    await app.page.click("#f-mirror-v");
    const m = (await app.curves())[2];
    expect(m.links).toBeUndefined();
    expect(m.anchors).toHaveLength(2);
  });
});

test.describe("tangent anchors", () => {
  test("an attached control point is held on the anchor's tangent", async ({ app }) => {
    const host = { ...HOST, anchors: [{ id: "start", s: 0 }, { id: "a1", s: 0.5, tangent: true }, { id: "end", s: 1 }] };
    await app.load(design({ curves: [host, CHILD] }));
    await app.click(300, 150);
    await app.drag([300, 200], [350, 230]); // c2: tangent is horizontal
    const k = byId(await app.curves(), "k");
    expect(k.c2.y).toBeCloseTo(300, 3);
  });

  test("a new curve ending on a tangent anchor arrives along it", async ({ app }) => {
    const host = { ...HOST, anchors: [{ id: "start", s: 0 }, { id: "a1", s: 0.5, tangent: true }, { id: "end", s: 1 }] };
    await app.load(design({ curves: [host] }));
    await app.draw([200, 100], [300, 300]);
    const k = (await app.curves())[1];
    expect(k.c2.y).toBeCloseTo(300, 3);
    expect(k.c2.x).not.toBe(300);
  });
});

test.describe("grid snapping", () => {
  test("is on by default and can be toggled off for free placement", async ({ app }) => {
    await app.draw([107, 93], [292, 211]);
    expect((await app.curves())[0].p0).toEqual({ x: 100, y: 100 });
    await app.tool("grid");
    await app.page.uncheck("#g-snap");
    expect((await app.state()).grid.snap).toBe(false);
    await app.tool("curve");
    await app.draw([107, 93], [292, 211]);
    expect((await app.curves())[1].p0.x).toBeCloseTo(107, -1);
    expect((await app.curves())[1].p0.x % 20).not.toBe(0);
  });

  test("anchors win over the grid, and Alt bypasses the grid", async ({ app }) => {
    await app.load(baseDesign({ curves: [curve({ x: 105, y: 105 }, { x: 405, y: 305 }, { id: "h" })] }));
    await app.draw([300, 400], [108, 108]);
    expect((await app.curves())[1].p3).toEqual({ x: 105, y: 105 });
    await app.click(600, 400);
    await app.page.keyboard.down("Alt");
    await app.click(607, 413);
    await app.page.keyboard.up("Alt");
    expect((await app.curves())[2].p3.x).toBeCloseTo(607, -1);
  });

  test("snapping the grid off then on persists with the design", async ({ app }) => {
    await app.tool("grid");
    await app.page.uncheck("#g-snap");
    expect((await app.saved()).grid.snap).toBe(false);
    await app.undoBtn.click();
    expect((await app.state()).grid.snap).toBe(true);
  });

  test("changing the grid resolution never moves curves", async ({ app }) => {
    await app.load(design({ curves: [HOST] }));
    await app.tool("grid");
    await app.page.fill("#g-res", "37");
    await app.page.locator("#g-res").blur();
    expect(byId(await app.curves(), "h").p0).toEqual({ x: 100, y: 300 });
  });
});
