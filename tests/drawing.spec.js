const { test, expect, curve, design } = require("./helpers");

test.describe("drawing curves", () => {
  test("starts on the curve tool with an empty canvas", async ({ app }) => {
    await expect(app.page.locator("#tool-curve")).toHaveClass(/active/);
    await expect(app.panel).toContainText("Nothing selected");
    expect(await app.curves()).toEqual([]);
  });

  test("two clicks create a selected curve between the snapped points", async ({ app }) => {
    await app.draw([100, 100], [300, 200]);
    const [c] = await app.curves();
    expect(c.p0).toEqual({ x: 100, y: 100 });
    expect(c.p3).toEqual({ x: 300, y: 200 });
    expect((await app.state()).selection).toEqual({ type: "curve", id: c.id });
    await expect(app.curvePaths()).toHaveCount(1);
    await expect(app.panel).toContainText("Fill");
  });

  test("points snap to the grid", async ({ app }) => {
    await app.draw([107, 93], [292, 211]);
    const [c] = await app.curves();
    expect(c.p0).toEqual({ x: 100, y: 100 });
    expect(c.p3).toEqual({ x: 300, y: 220 });
  });

  test("snaps to a custom grid resolution", async ({ app }) => {
    await app.load(design({ grid: { resolution: 50 } }));
    await app.draw([110, 140], [390, 260]);
    const [c] = await app.curves();
    expect(c.p0).toEqual({ x: 100, y: 150 });
    expect(c.p3).toEqual({ x: 400, y: 250 });
  });

  test("shows a hint while a curve is pending and Escape cancels it", async ({ app }) => {
    await app.click(100, 100);
    await expect(app.hintVisible).toContainText("finish the curve");
    await app.page.keyboard.press("Escape");
    await expect(app.hintVisible).toHaveCount(0);
    await app.click(300, 300); // starts a fresh curve rather than finishing one
    expect(await app.curves()).toEqual([]);
  });

  test("a click on the same point creates a self-loop", async ({ app }) => {
    await app.draw([200, 200], [200, 200]);
    const [c] = await app.curves();
    expect(c.p0).toEqual(c.p3);
    expect(c.c1.x).toBeGreaterThan(c.p0.x);
  });

  test("endpoints snap to existing curve endpoints (even off-grid ones)", async ({ app }) => {
    await app.load(design({ curves: [curve({ x: 105, y: 105 }, { x: 405, y: 305 })] }));
    await app.draw([300, 400], [108, 108]); // 3px from the off-grid vertex
    const c = (await app.curves())[1];
    expect(c.p3).toEqual({ x: 105, y: 105 });
  });

  test("endpoints snap to page corners", async ({ app }) => {
    await app.draw([4, 5], [796, 597]);
    const [c] = await app.curves();
    expect(c.p0).toEqual({ x: 0, y: 0 });
    expect(c.p3).toEqual({ x: 800, y: 600 });
  });

  test("hover preview follows the cursor", async ({ app }) => {
    await app.move(200, 200);
    await expect(app.page.locator("#stage circle")).toHaveCount(1);
    await app.click(200, 200);
    await app.move(400, 200);
    await expect(app.page.locator("#stage circle")).toHaveCount(2);
    await expect(app.page.locator("#stage path[stroke-dasharray]")).toHaveCount(1);
  });

  test("drawing pushes history so it can be undone", async ({ app }) => {
    await app.draw([100, 100], [300, 100]);
    await app.undoBtn.click();
    expect(await app.curves()).toEqual([]);
    await app.redoBtn.click();
    expect(await app.curves()).toHaveLength(1);
  });
});

test.describe("circle tool", () => {
  test("dragging from the center draws four joined quarter arcs", async ({ app }) => {
    await app.tool("circle");
    await app.drag([300, 300], [400, 300]);
    const curves = await app.curves();
    expect(curves).toHaveLength(4);
    // every point on every arc lies within 0.1% of the radius
    const radii = await app.page.evaluate(() => state.curves.flatMap(c =>
      [0, 0.25, 0.5, 0.75, 1].map(t => { const p = cubicPoint(c.p0, c.c1, c.c2, c.p3, t); return Math.hypot(p.x - 300, p.y - 300); })));
    for (const r of radii) expect(Math.abs(r - 100)).toBeLessThan(0.1);
    // closed ring, each arc attached to the previous one
    for (let i = 0; i < 4; i++) {
      const next = curves[(i + 1) % 4];
      expect(curves[i].p3.x).toBeCloseTo(next.p0.x, 6);
      expect(curves[i].p3.y).toBeCloseTo(next.p0.y, 6);
    }
    expect(curves[1].links.p0).toEqual({ curve: curves[0].id, anchor: "end" });
    const st = await app.state();
    expect(st.tool).toBe("curve");
    expect(st.selection).toEqual({ type: "curves", ids: curves.map(c => c.id) });
  });

  test("two clicks work too, and Escape cancels", async ({ app }) => {
    await app.tool("circle");
    await app.click(200, 200);
    await app.click(200, 300);
    expect(await app.curves()).toHaveLength(4);
    await app.page.keyboard.press("o");
    await app.click(400, 400);
    await app.page.keyboard.press("Escape");
    await app.click(500, 400);
    expect(await app.curves()).toHaveLength(4);
  });
});
