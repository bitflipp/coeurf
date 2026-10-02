const { test, expect, curve, design: baseDesign } = require("./helpers");

// Clicks land on whole pixels, so placed coordinates are only near their targets.
expect.extend({
  toBeNear(received, expected) {
    const pass = Math.abs(received - expected) < 1.5;
    return { pass, message: () => `expected ${received} to be within 1.5 of ${expected}` };
  },
});

const design = (d = {}) => baseDesign({ ...d, grid: { snap: false, ...(d.grid || {}) } });

// A leaf: two curves sharing start (100,300) and end (200,300), bulging up and down.
const UP = curve({ x: 100, y: 300 }, { x: 200, y: 300 }, { id: "up", c1: { x: 120, y: 260 }, c2: { x: 180, y: 260 }, width: 4 });
const DOWN = curve({ x: 100, y: 300 }, { x: 200, y: 300 }, { id: "down", c1: { x: 120, y: 340 }, c2: { x: 180, y: 340 }, width: 4,
  links: { p0: { curve: "up", anchor: "start" }, p3: { curve: "up", anchor: "end" } } });

const instCurves = app => app.page.evaluate(() => JSON.parse(JSON.stringify(state.curves.filter(c => c.inst))));
const instances = app => app.page.evaluate(() => JSON.parse(JSON.stringify(state.instances)));

async function makeLeaf(app) {
  await app.load(design({ curves: [UP, DOWN] }));
  await app.click(150, 270); // select UP
  await app.click(150, 330, { modifiers: ["Shift"] });
  await app.page.click("#f-make-symbol-multi");
}

test.describe("symbols", () => {
  test("Make symbol pins the two most distant endpoints and switches to the Symbol tool", async ({ app }) => {
    await makeLeaf(app);
    const s = await app.page.evaluate(() => JSON.parse(JSON.stringify(state.symbols)));
    expect(s).toHaveLength(1);
    expect(s[0].curves).toEqual(["up", "down"]);
    expect(s[0].pinA).toEqual({ curve: "up", anchor: "start" });
    expect(s[0].pinB).toEqual({ curve: "up", anchor: "end" });
    expect((await app.state()).tool).toBe("symbol");
  });

  test("two clicks place an instance, rotated and scaled between the points", async ({ app }) => {
    await makeLeaf(app);
    await app.click(400, 100);
    await app.click(400, 300); // length 200 (2x), pointing down: rotated by +90deg
    const cs = await instCurves(app);
    expect(cs).toHaveLength(2);
    const up = cs.find(c => c.ix === 0);
    expect(up.p0.x).toBeNear(400);
    expect(up.p0.y).toBeNear(100);
    expect(up.p3.x).toBeNear(400);
    expect(up.p3.y).toBeNear(300);
    // c1 offset (20,-40) from p0 -> rotated 90deg and doubled = (80,40)
    expect(up.c1.x).toBeNear(480);
    expect(up.c1.y).toBeNear(140);
    expect(up.width).toBeNear(8);
  });

  test("editing the template updates every instance", async ({ app }) => {
    await makeLeaf(app);
    await app.click(400, 100); await app.click(500, 100);
    await app.click(400, 300); await app.click(500, 300);
    await app.tool("curve");
    await app.click(150, 270);
    await app.page.evaluate(() => { state.curves.find(c => c.id === "up").color = "#e6453c"; render(); });
    const cs = await instCurves(app);
    expect(cs.filter(c => c.ix === 0).map(c => c.color)).toEqual(["#e6453c", "#e6453c"]);
  });

  test("mirrored placement reflects across the chord", async ({ app }) => {
    await makeLeaf(app);
    await app.page.check("#sym-flip");
    await app.click(400, 100); await app.click(500, 100);
    const up = (await instCurves(app)).find(c => c.ix === 0);
    expect(up.c1.x).toBeNear(420);
    expect(up.c1.y).toBeNear(140); // bulges down instead of up
  });

  test("a pin dropped on an anchor stays attached and follows the host", async ({ app }) => {
    const host = curve({ x: 100, y: 500 }, { x: 300, y: 500 }, { id: "h" });
    await app.load(design({ curves: [UP, DOWN, host] }));
    await app.click(150, 270); await app.click(150, 330, { modifiers: ["Shift"] });
    await app.page.click("#f-make-symbol-multi");
    await app.click(300, 500);   // host's end anchor
    await app.click(500, 400);
    let [inst] = await instances(app);
    expect(inst.links.a).toEqual({ curve: "h", anchor: "end" });
    await app.page.evaluate(() => { const h = state.curves.find(c => c.id === "h"); h.p3 = { x: 300, y: 450 }; h.c2 = { x: 250, y: 450 }; resolveLinks(); });
    [inst] = await instances(app);
    expect(inst.a).toEqual({ x: 300, y: 450 });
    expect((await instCurves(app)).find(c => c.ix === 0).p0).toEqual({ x: 300, y: 450 });
  });

  test("clicking an instance selects it; dragging a pin rotates it", async ({ app }) => {
    await makeLeaf(app);
    await app.click(400, 100); await app.click(500, 100);
    await app.tool("curve");
    await app.click(450, 72);   // UP bulges above the chord
    expect((await app.state()).selection.type).toBe("instance");
    await app.drag([500, 100], [400, 200]);
    const [inst] = await instances(app);
    expect(inst.b.x).toBeNear(400);
    expect(inst.b.y).toBeNear(200);
    const up = (await instCurves(app)).find(c => c.ix === 0);
    expect(up.p3.x).toBeNear(400);
    expect(up.p3.y).toBeNear(200);
  });

  test("deleting an instance removes its curves; deleting a template bakes instances", async ({ app }) => {
    await makeLeaf(app);
    await app.click(400, 100); await app.click(500, 100);
    await app.click(400, 300); await app.click(500, 300);
    await app.tool("curve");
    await app.click(450, 72);
    await app.page.keyboard.press("Delete");
    expect(await instances(app)).toHaveLength(1);
    expect(await instCurves(app)).toHaveLength(2);
    await app.click(150, 270);
    await app.page.keyboard.press("Delete");
    expect(await instances(app)).toHaveLength(0);
    expect(await app.page.evaluate(() => state.symbols.length)).toBe(0);
    const cs = await app.curves();
    expect(cs.filter(c => c.inst)).toHaveLength(0);
    expect(cs.length).toBe(3); // remaining template + the baked instance's two curves
  });

  test("symbols and instances survive reload and undo", async ({ app }) => {
    await makeLeaf(app);
    await app.click(400, 100); await app.click(500, 100);
    await app.page.reload();
    await app.page.waitForSelector("#stage");
    expect(await instances(app)).toHaveLength(1);
    expect(await instCurves(app)).toHaveLength(2);
    await app.tool("symbol");
    await app.click(400, 300); await app.click(500, 300);
    expect(await instances(app)).toHaveLength(2);
    await app.undoBtn.click();
    expect(await instances(app)).toHaveLength(1);
    await app.page.evaluate(() => { state.instances = []; resolveLinks(); });
    expect(await instCurves(app)).toHaveLength(0);
  });
});

test("the Symbol tool shows anchors as snap targets", async ({ app }) => {
  await app.load(design({ curves: [UP, DOWN] }));
  await app.tool("symbol");
  await expect(app.page.locator("#stage polygon")).not.toHaveCount(0);
});
