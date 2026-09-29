const fs = require("fs");
const { test, expect, curve, design } = require("./helpers");

test.describe("zoom and pan", () => {
  test("button controls change the zoom and the stage size", async ({ app }) => {
    await app.page.click("#zoom-level-btn");
    await expect(app.zoomLabel()).toHaveText("100%");
    await expect(app.page.locator("#stage")).toHaveAttribute("width", "800");
    await app.page.click("#zoom-in-btn");
    await expect(app.zoomLabel()).toHaveText("125%");
    await expect(app.page.locator("#stage")).toHaveAttribute("width", "1000");
    await app.page.click("#zoom-out-btn");
    await app.page.click("#zoom-out-btn");
    await expect(app.zoomLabel()).toHaveText("80%");
  });

  test("fit makes the page fit the viewport", async ({ app }) => {
    await app.page.click("#zoom-level-btn");
    await app.page.click("#zoom-fit-btn");
    const [stage, scroller] = await Promise.all([
      app.page.locator("#stage").boundingBox(),
      app.page.locator("#canvas-scroll").boundingBox(),
    ]);
    expect(stage.width).toBeLessThanOrEqual(scroller.width);
    expect(stage.height).toBeLessThanOrEqual(scroller.height);
  });

  test("zoom is clamped to 10%-800%", async ({ app }) => {
    for (let i = 0; i < 30; i++) await app.page.click("#zoom-in-btn");
    await expect(app.zoomLabel()).toHaveText("800%");
    for (let i = 0; i < 40; i++) await app.page.click("#zoom-out-btn");
    await expect(app.zoomLabel()).toHaveText("10%");
  });

  test("keyboard zoom: Ctrl+=, Ctrl+-, Ctrl+0, plain +/-", async ({ app }) => {
    await app.page.keyboard.press("Control+0");
    await expect(app.zoomLabel()).toHaveText("100%");
    await app.page.keyboard.press("Control+=");
    await expect(app.zoomLabel()).toHaveText("125%");
    await app.page.keyboard.press("-");
    await app.page.keyboard.press("-");
    await expect(app.zoomLabel()).toHaveText("80%");
    await app.page.keyboard.press("Control+0");
    await expect(app.zoomLabel()).toHaveText("100%");
  });

  test("Ctrl+wheel zooms, plain wheel does not", async ({ app }) => {
    await app.page.click("#zoom-level-btn");
    const box = await app.page.locator("#canvas-scroll").boundingBox();
    await app.page.mouse.move(box.x + 300, box.y + 300);
    await app.page.mouse.wheel(0, 100);
    await expect(app.zoomLabel()).toHaveText("100%");
    await app.page.keyboard.down("Control");
    await app.page.mouse.wheel(0, -300);
    await app.page.keyboard.up("Control");
    await expect.poll(async () => parseInt(await app.zoomLabel().textContent(), 10)).toBeGreaterThan(100);
  });

  test("zoom is not part of history or saved design", async ({ app }) => {
    await app.page.click("#zoom-in-btn");
    await expect(app.undoBtn).toBeDisabled();
  });

  test("drawing still lands on the right grid points when zoomed", async ({ app }) => {
    await app.page.click("#zoom-level-btn");
    await app.page.click("#zoom-in-btn");
    await app.draw([100, 100], [200, 160]);
    const [c] = await app.curves();
    expect(c.p0).toEqual({ x: 100, y: 100 });
    expect(c.p3).toEqual({ x: 200, y: 160 });
  });

  test("space + drag pans instead of drawing", async ({ app }) => {
    await app.page.click("#zoom-level-btn");
    await app.page.click("#zoom-in-btn");
    await app.page.click("#zoom-in-btn");
    const scroller = app.page.locator("#canvas-scroll");
    const before = await scroller.evaluate(el => el.scrollLeft);
    await app.page.keyboard.down("Space");
    await expect(scroller).toHaveClass(/space-pan/);
    const box = await scroller.boundingBox();
    await app.page.mouse.move(box.x + 400, box.y + 300);
    await app.page.mouse.down();
    await app.page.mouse.move(box.x + 300, box.y + 250, { steps: 5 });
    await app.page.mouse.up();
    await app.page.keyboard.up("Space");
    await expect(scroller).not.toHaveClass(/space-pan/);
    expect(await scroller.evaluate(el => el.scrollLeft)).toBeGreaterThan(before);
    expect(await app.curves()).toEqual([]);
    await expect(app.hint).not.toContainText("finish the curve");
  });

  test("middle-button drag pans", async ({ app }) => {
    await app.page.click("#zoom-level-btn");
    await app.page.click("#zoom-in-btn");
    await app.page.click("#zoom-in-btn");
    const scroller = app.page.locator("#canvas-scroll");
    const box = await scroller.boundingBox();
    await app.page.mouse.move(box.x + 400, box.y + 300);
    await app.page.mouse.down({ button: "middle" });
    await app.page.mouse.move(box.x + 300, box.y + 250, { steps: 5 });
    await app.page.mouse.up({ button: "middle" });
    expect(await scroller.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
    expect(await app.curves()).toEqual([]);
  });
});

test.describe("export, download and import", () => {
  const sample = design({
    curves: [
      curve({ x: 100, y: 100 }, { x: 300, y: 200 }, { id: "a", color: "#e6453c" }),
      curve({ x: 400, y: 100 }, { x: 600, y: 200 }, { id: "b", colorMode: "gradient", color2: "#5b8cff", gradientAngle: 30, width2: 10 }),
    ],
  });

  test("Export SVG downloads a clean standalone SVG", async ({ app }) => {
    await app.load(sample);
    await app.page.click("#tool-curve");
    await app.click(200, 150); // select a curve; selection glow must not leak into export
    const [dl] = await Promise.all([app.page.waitForEvent("download"), app.page.click("#export-btn")]);
    expect(dl.suggestedFilename()).toBe("coeurf-export.svg");
    const svg = fs.readFileSync(await dl.path(), "utf8");
    expect(svg).toMatch(/^<\?xml/);
    expect(svg).toContain('width="800" height="600" viewBox="0 0 800 600"');
    expect(svg).toContain('stroke="#e6453c"');
    expect(svg).toContain("<linearGradient");
    expect(svg).not.toContain("curve-glow");
    expect(svg).not.toContain("data-handle");
    expect(svg).not.toContain("gridpat");
    // must be well-formed
    const ok = await app.page.evaluate(s => !new DOMParser().parseFromString(s, "image/svg+xml").querySelector("parsererror"), svg);
    expect(ok).toBe(true);
  });

  test("Download saves a JSON file that Import restores", async ({ app }) => {
    await app.load(sample);
    const [dl] = await Promise.all([app.page.waitForEvent("download"), app.page.click("#download-btn")]);
    expect(dl.suggestedFilename()).toMatch(/^coeurf-\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d\.json$/);
    const file = await dl.path();
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(json.curves).toHaveLength(2);

    await app.page.click("#tool-curve");
    await app.click(200, 150);
    await app.page.keyboard.press("Delete");
    await app.click(500, 150);
    await app.page.keyboard.press("Delete");
    expect(await app.curves()).toEqual([]);

    await app.page.setInputFiles("#import-input", file);
    await expect(app.hint).toContainText("Design imported");
    expect(await app.curves()).toHaveLength(2);
    // import is a history step
    await app.undoBtn.click();
    expect(await app.curves()).toEqual([]);
  });

  test("importing an invalid file reports an error and changes nothing", async ({ app }) => {
    await app.load(sample);
    await app.page.setInputFiles("#import-input", {
      name: "bad.json", mimeType: "application/json", buffer: Buffer.from("{\"nope\":true}"),
    });
    await expect(app.hint).toContainText("invalid");
    expect(await app.curves()).toHaveLength(2);
    await app.page.setInputFiles("#import-input", {
      name: "bad.json", mimeType: "application/json", buffer: Buffer.from("not json at all"),
    });
    await expect(app.hint).toContainText("invalid");
    expect(await app.curves()).toHaveLength(2);
  });

  test("the same file can be imported twice in a row", async ({ app }) => {
    const file = { name: "d.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(sample)) };
    await app.page.setInputFiles("#import-input", file);
    await expect(app.curvePaths()).toHaveCount(2);
    await app.page.keyboard.press("Control+z");
    await expect(app.curvePaths()).toHaveCount(0);
    await app.page.setInputFiles("#import-input", file);
    await expect(app.curvePaths()).toHaveCount(2);
  });
});

test.describe("rendering", () => {
  test("gradient and opacity produce defs; tapered curves render as filled ribbons", async ({ app }) => {
    await app.load(design({ curves: [
      curve({ x: 100, y: 100 }, { x: 300, y: 200 }, { id: "g", colorMode: "gradient", color2: "#5b8cff", gradientAngle: 0 }),
      curve({ x: 100, y: 300 }, { x: 300, y: 400 }, { id: "t", width2: 12 }),
      curve({ x: 400, y: 300 }, { x: 600, y: 400 }, { id: "o", opacityMode: "gradient", opacity: 1, opacity2: 0, opacityAngle: 0 }),
    ] }));
    await expect(app.page.locator("#stage linearGradient")).not.toHaveCount(0);
    await expect(app.page.locator("#stage mask")).toHaveCount(1);
    await expect(app.curvePaths()).toHaveCount(3);
  });

  test("resizing the window keeps the stage rendered", async ({ app }) => {
    await app.page.setViewportSize({ width: 900, height: 600 });
    await expect(app.page.locator("#stage")).toBeVisible();
  });
});
