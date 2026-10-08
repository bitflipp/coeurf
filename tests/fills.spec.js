const fs = require("fs");
const { test, expect, curve, design: baseDesign } = require("./helpers");

// Clicks land on whole pixels, so seeded geometry stays exactly where it is put.
const design = (d = {}) => baseDesign({ ...d, grid: { snap: false, ...(d.grid || {}) } });

// A 200x200 square: four straight curves joined end to end by links, so the
// endpoints are exactly coincident and the loop closes without any fudging.
const square = () => [
  curve({ x: 100, y: 100 }, { x: 300, y: 100 }, { id: "s1", width: 3 }),
  curve({ x: 300, y: 100 }, { x: 300, y: 300 }, { id: "s2", links: { p0: { curve: "s1", anchor: "end" } } }),
  curve({ x: 300, y: 300 }, { x: 100, y: 300 }, { id: "s3", links: { p0: { curve: "s2", anchor: "end" } } }),
  curve({ x: 100, y: 300 }, { x: 100, y: 100 }, { id: "s4", links: { p0: { curve: "s3", anchor: "end" }, p3: { curve: "s1", anchor: "start" } } }),
];

// The same square with the closing curve missing: an open chain of three.
const openChain = () => square().slice(0, 3);

// A 200x200 square inside a 300x300 one, to exercise nested faces.
const nested = () => [
  curve({ x: 50, y: 50 }, { x: 350, y: 50 }, { id: "o1", width: 3 }),
  curve({ x: 350, y: 50 }, { x: 350, y: 350 }, { id: "o2", links: { p0: { curve: "o1", anchor: "end" } } }),
  curve({ x: 350, y: 350 }, { x: 50, y: 350 }, { id: "o3", links: { p0: { curve: "o2", anchor: "end" } } }),
  curve({ x: 50, y: 350 }, { x: 50, y: 50 }, { id: "o4", links: { p0: { curve: "o3", anchor: "end" }, p3: { curve: "o1", anchor: "start" } } }),
  curve({ x: 150, y: 150 }, { x: 250, y: 150 }, { id: "i1", width: 3 }),
  curve({ x: 250, y: 150 }, { x: 250, y: 250 }, { id: "i2", links: { p0: { curve: "i1", anchor: "end" } } }),
  curve({ x: 250, y: 250 }, { x: 150, y: 250 }, { id: "i3", links: { p0: { curve: "i2", anchor: "end" } } }),
  curve({ x: 150, y: 250 }, { x: 150, y: 150 }, { id: "i4", links: { p0: { curve: "i3", anchor: "end" }, p3: { curve: "i1", anchor: "start" } } }),
];

const fillOf = (ids, extra = {}) => ({
  id: "fl1",
  edges: ids.map(id => ({ curve: id, rev: false })),
  color: "#e6453c", colorMode: "solid", opacity: 1,
  ...extra,
});

// Click the midpoints of the given square's four edges (Shift for the rest),
// which is enough to put every one of its curves in the selection.
async function selectAll(app, ids) {
  const points = { s1: [200, 100], s2: [300, 200], s3: [200, 300], s4: [100, 200] };
  for (let i = 0; i < ids.length; i++) {
    await app.click(...points[ids[i]], { modifiers: i ? ["Shift"] : [] });
  }
}

test.describe("fill selection", () => {
  test("turns a closed loop of curves into an editable fill", async ({ app }) => {
    await app.load(design({ curves: square() }));
    await app.tool("curve");
    await selectAll(app, ["s1", "s2", "s3", "s4"]);
    await app.page.click("#f-fill-multi");

    const fills = await app.fills();
    expect(fills).toHaveLength(1);
    expect(fills[0].edges.map(e => e.curve).sort()).toEqual(["s1", "s2", "s3", "s4"]);
    expect((await app.state()).selection).toEqual({ type: "fill", id: fills[0].id });
    await expect(app.fillPaths()).toHaveCount(1);
    await expect(app.panel).toContainText("Boundary");
  });

  test("a fill leaves the curves themselves untouched", async ({ app }) => {
    await app.load(design({ curves: square() }));
    await app.tool("curve");
    await selectAll(app, ["s1", "s2", "s3", "s4"]);
    await app.page.click("#f-fill-multi");
    expect(await app.curves()).toHaveLength(4);
    await expect(app.curvePaths()).toHaveCount(4);
  });

  test("refuses an open boundary instead of closing it silently", async ({ app }) => {
    await app.load(design({ curves: openChain() }));
    await app.tool("curve");
    await selectAll(app, ["s1", "s2", "s3"]);
    await app.page.click("#f-fill-multi");
    expect(await app.fills()).toEqual([]);
    await expect(app.hintVisible).toContainText("closed loop");
  });

  test("the panel can hand the boundary curves back for reshaping", async ({ app }) => {
    await app.load(design({ curves: square(), fills: [fillOf(["s1", "s2", "s3", "s4"])] }));
    await app.tool("fill");
    await app.click(200, 200);
    await app.page.click("#fl-boundary");
    expect((await app.state()).tool).toBe("curve");
    expect((await app.state()).selection.type).toBe("curves");
    expect((await app.state()).selection.ids.sort()).toEqual(["s1", "s2", "s3", "s4"]);
  });
});

test.describe("fill lifecycle", () => {
  test("deleting a boundary curve dissolves the fill", async ({ app }) => {
    await app.load(design({ curves: square(), fills: [fillOf(["s1", "s2", "s3", "s4"])] }));
    await expect(app.fillPaths()).toHaveCount(1);
    await app.tool("curve");
    await app.click(200, 100); // s1
    await app.page.click("#f-delete");
    expect(await app.fills()).toEqual([]);
    await expect(app.fillPaths()).toHaveCount(0);
    // The other three curves are still there: only the fill went.
    expect(await app.curves()).toHaveLength(3);
  });

  test("undo brings a dissolved fill back", async ({ app }) => {
    await app.load(design({ curves: square(), fills: [fillOf(["s1", "s2", "s3", "s4"])] }));
    await app.tool("curve");
    await app.click(200, 100);
    await app.page.click("#f-delete");
    expect(await app.fills()).toEqual([]);
    await app.page.keyboard.press("Control+z");
    expect(await app.fills()).toHaveLength(1);
    await expect(app.fillPaths()).toHaveCount(1);
  });

  test("Delete removes a selected fill but leaves its curves", async ({ app }) => {
    await app.load(design({ curves: square(), fills: [fillOf(["s1", "s2", "s3", "s4"])] }));
    await app.tool("fill");
    await app.click(200, 200); // select the existing fill
    await app.page.keyboard.press("Delete");
    expect(await app.fills()).toEqual([]);
    expect(await app.curves()).toHaveLength(4);
    await app.page.keyboard.press("Control+z");
    expect(await app.fills()).toHaveLength(1);
  });

  test("fills survive a reload", async ({ app }) => {
    await app.load(design({ curves: square(), fills: [fillOf(["s1", "s2", "s3", "s4"])] }));
    await app.page.reload();
    await app.page.waitForSelector("#stage");
    expect(await app.fills()).toHaveLength(1);
    await expect(app.fillPaths()).toHaveCount(1);
  });

  test("a fill starts behind the strokes but can be lifted in front of them", async ({ app }) => {
    await app.load(design({ curves: square(), fills: [fillOf(["s1", "s2", "s3", "s4"])] }));
    // Paint order as actually rendered, read off the shared art layer.
    const paintOrder = () => app.page.evaluate(() =>
      [...document.querySelectorAll("#layer-art [data-fill-id], #layer-art [data-curve-id]")]
        .map(el => (el.hasAttribute("data-fill-id") ? "fill" : "curve")));
    const UNDER = ["fill", "curve", "curve", "curve", "curve"];
    expect(await paintOrder()).toEqual(UNDER);

    await app.tool("fill");
    await app.click(200, 200); // select the existing fill
    await app.page.click("#fl-to-front");
    expect(await paintOrder()).toEqual(["curve", "curve", "curve", "curve", "fill"]);

    // One step at a time past a single curve, not just to either extreme.
    await app.page.click("#fl-to-back");
    expect(await paintOrder()).toEqual(UNDER);
    await app.page.keyboard.press("]");
    expect(await paintOrder()).toEqual(["curve", "fill", "curve", "curve", "curve"]);
    await app.page.keyboard.press("[");
    expect(await paintOrder()).toEqual(UNDER);

    // The stack is part of history, so a restack can be undone.
    await app.page.keyboard.press("Control+z");
    expect(await paintOrder()).toEqual(["curve", "fill", "curve", "curve", "curve"]);
  });

  test("paint order survives a reload", async ({ app }) => {
    await app.load(design({ curves: square(), fills: [fillOf(["s1", "s2", "s3", "s4"])] }));
    await app.tool("fill");
    await app.click(200, 200);
    await app.page.click("#fl-to-front");
    await app.page.reload();
    await app.page.waitForSelector("#stage");
    const paintOrder = await app.page.evaluate(() =>
      [...document.querySelectorAll("#layer-art [data-fill-id], #layer-art [data-curve-id]")]
        .map(el => (el.hasAttribute("data-fill-id") ? "fill" : "curve")));
    expect(paintOrder).toEqual(["curve", "curve", "curve", "curve", "fill"]);
  });

  test("reshaping a boundary curve reshapes the fill", async ({ app }) => {
    await app.load(design({ curves: square(), fills: [fillOf(["s1", "s2", "s3", "s4"])] }));
    const before = await app.page.locator("path[data-fill-id]").getAttribute("d");
    await app.tool("curve");
    await app.click(200, 100); // select s1
    // Dragging from a different point on s1: starting the drag where the
    // selecting click landed would be read as a double-click (add anchor).
    await app.drag([250, 100], [250, 40]);
    const after = await app.page.locator("path[data-fill-id]").getAttribute("d");
    expect(after).not.toBe(before);
  });
});

test.describe("fill tool", () => {
  test("clicking inside an enclosed area fills it", async ({ app }) => {
    await app.load(design({ curves: square() }));
    await app.page.keyboard.press("f");
    expect((await app.state()).tool).toBe("fill");
    await app.click(200, 200);
    const fills = await app.fills();
    expect(fills).toHaveLength(1);
    expect(fills[0].edges.map(e => e.curve).sort()).toEqual(["s1", "s2", "s3", "s4"]);
    await expect(app.fillPaths()).toHaveCount(1);
  });

  test("clicking an open chain is refused with a hint", async ({ app }) => {
    await app.load(design({ curves: openChain() }));
    await app.tool("fill");
    await app.click(200, 200);
    expect(await app.fills()).toEqual([]);
    await expect(app.hintVisible).toContainText("No enclosed area");
  });

  test("clicking an already filled area selects it instead of stacking a copy", async ({ app }) => {
    await app.load(design({ curves: square() }));
    await app.tool("fill");
    await app.click(200, 200);
    const first = (await app.fills())[0].id;
    await app.click(200, 200);
    expect(await app.fills()).toHaveLength(1);
    expect((await app.state()).selection).toEqual({ type: "fill", id: first });
  });

  test("a nested area takes the innermost face", async ({ app }) => {
    await app.load(design({ curves: nested() }));
    await app.tool("fill");
    await app.click(200, 200); // inside both squares: the inner one wins
    expect((await app.fills())[0].edges.map(e => e.curve).sort()).toEqual(["i1", "i2", "i3", "i4"]);
    await app.click(80, 200); // the ring between them: only the outer face contains it
    expect((await app.fills())[1].edges.map(e => e.curve).sort()).toEqual(["o1", "o2", "o3", "o4"]);
  });

  test("fills stack in array order and can be reordered", async ({ app }) => {
    const two = [
      ...square(),
      curve({ x: 500, y: 100 }, { x: 700, y: 100 }, { id: "t1", width: 3 }),
      curve({ x: 700, y: 100 }, { x: 700, y: 300 }, { id: "t2", links: { p0: { curve: "t1", anchor: "end" } } }),
      curve({ x: 700, y: 300 }, { x: 500, y: 300 }, { id: "t3", links: { p0: { curve: "t2", anchor: "end" } } }),
      curve({ x: 500, y: 300 }, { x: 500, y: 100 }, { id: "t4", links: { p0: { curve: "t3", anchor: "end" }, p3: { curve: "t1", anchor: "start" } } }),
    ];
    await app.load(design({ curves: two }));
    await app.tool("fill");
    await app.click(200, 200);
    await app.click(600, 200);
    const ids = (await app.fills()).map(f => f.id);
    expect(ids).toHaveLength(2);
    await app.page.click("#fl-to-back"); // the second fill is selected
    expect((await app.fills()).map(f => f.id)).toEqual([ids[1], ids[0]]);
    await app.page.keyboard.press("]"); // and the keyboard restacks it again
    expect((await app.fills()).map(f => f.id)).toEqual([ids[0], ids[1]]);
  });
});

test.describe("fill styling and export", () => {
  const seeded = () => design({ curves: square(), fills: [fillOf(["s1", "s2", "s3", "s4"])] });

  test("switches between solid and gradient, and sets opacity", async ({ app }) => {
    await app.load(seeded());
    await app.tool("fill");
    await app.click(200, 200);
    await app.page.click("#fl-grad");
    expect((await app.fills())[0].colorMode).toBe("gradient");
    await expect(app.page.locator("#stage defs linearGradient[id^=fill-grad]")).toHaveCount(1);

    await app.page.fill("#fl-op-num", "40");
    await app.page.locator("#fl-op-num").blur();
    expect((await app.fills())[0].opacity).toBeCloseTo(0.4, 5);
  });

  test("the fill's color comes from the palette", async ({ app }) => {
    await app.load(seeded());
    await app.tool("fill");
    await app.click(200, 200);
    await app.panel.locator('.swatch[data-swatch="#2ecc71"]').click();
    expect((await app.fills())[0].color).toBe("#2ecc71");
    await expect(app.page.locator('path[data-fill-id]')).toHaveAttribute("fill", "#2ecc71");
  });

  test("a new fill starts in the palette's selected color", async ({ app }) => {
    await app.load(design({ curves: square() }));
    await app.tool("palette");
    await app.page.locator(".palette-swatch[data-index]").nth(4).click(); // #2ecc71
    await app.tool("fill");
    await app.click(200, 200);
    expect((await app.fills())[0].color).toBe("#2ecc71");
  });

  test("exports fills and curves in their on-canvas order", async ({ app }) => {
    await app.load(seeded());
    const exportSVG = async () => {
      const [dl] = await Promise.all([app.page.waitForEvent("download"), app.page.click("#export-btn")]);
      return fs.readFileSync(await dl.path(), "utf8");
    };
    // The fill sits behind the strokes, so it is written first...
    let svg = await exportSVG();
    expect(svg).toContain('<g id="art">');
    expect(svg.indexOf("data-fill-id")).toBeLessThan(svg.indexOf("data-curve-id"));

    // ...and once brought forward, it is written after them.
    await app.tool("fill");
    await app.click(200, 200);
    await app.page.click("#fl-to-front");
    svg = await exportSVG();
    expect(svg.indexOf("data-fill-id")).toBeGreaterThan(svg.indexOf("data-curve-id"));

    const ok = await app.page.evaluate(s => !new DOMParser().parseFromString(s, "image/svg+xml").querySelector("parsererror"), svg);
    expect(ok).toBe(true);
  });

  test("Exclude from SVG leaves a fill out of the export", async ({ app }) => {
    await app.load(seeded());
    await app.tool("fill");
    await app.click(200, 200);
    await app.page.check("#fl-no-export");
    expect((await app.fills())[0].noExport).toBe(true);
    const [dl] = await Promise.all([app.page.waitForEvent("download"), app.page.click("#export-btn")]);
    const svg = fs.readFileSync(await dl.path(), "utf8");
    expect(svg).not.toContain("data-fill-id");
    expect(svg).toContain("data-curve-id");
  });
});
