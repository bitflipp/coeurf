const { test, expect, curve, design } = require("./helpers");

const A = curve({ x: 100, y: 100 }, { x: 300, y: 100 }, { id: "a" });

test.describe("curve panel", () => {
  test.beforeEach(async ({ app }) => {
    await app.load(design({ curves: [A] }));
    await app.click(200, 100);
  });

  const cur = async app => (await app.curves())[0];

  test("picking a palette swatch sets the color", async ({ app }) => {
    await app.panel.locator('.swatch[data-swatch="#e6453c"]').click();
    expect((await cur(app)).color).toBe("#e6453c");
    await expect(app.panel.locator(".swatch.active")).toHaveAttribute("data-swatch", "#e6453c");
    await expect(app.curvePaths().first()).toHaveAttribute("stroke", "#e6453c");
  });

  test("the current color's swatch is highlighted", async ({ app }) => {
    await expect(app.panel.locator(".swatch.active")).toHaveAttribute("data-swatch", "#2a2d34");
  });

  test("gradient mode exposes a stop table and angle", async ({ app }) => {
    await app.page.click("#c-grad");
    const c = await cur(app);
    expect(c.colorMode).toBe("gradient");
    expect(c.stops).toHaveLength(2);
    await expect(app.page.locator("#stage linearGradient")).toHaveCount(1);
    await app.page.fill("#f-gangle-num", "45");
    await app.page.locator("#f-gangle-num").blur();
    expect((await cur(app)).gradientAngle).toBe(45);
    await app.panel.locator("#f-stops .s-v").nth(1).evaluate(el => {
      el.value = "#e6453c"; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect((await cur(app)).stops[1].color).toBe("#e6453c");
    await expect(app.page.locator(".angle-shortcuts")).toHaveCount(0);
    await app.page.click("#f-stops .s-add");
    expect((await cur(app)).stops.map(s => s.o)).toEqual([0, 0.5, 1]);
    await expect(app.page.locator("#stage linearGradient stop")).toHaveCount(3);
    await app.page.fill("#f-stops .s-o >> nth=1", "25");
    await app.page.locator("#f-stops .s-o >> nth=1").blur();
    expect((await cur(app)).stops[1].o).toBe(0.25);
    await app.page.click("#f-stops .s-del >> nth=1");
    expect((await cur(app)).stops).toHaveLength(2);
    await expect(app.page.locator("#f-stops .s-del").first()).toBeDisabled();
    await app.page.click("#c-solid");
    expect((await cur(app)).colorMode).toBe("solid");
    await expect(app.page.locator("#stage linearGradient")).toHaveCount(0);
  });

  test("angle number is clamped to 0-359", async ({ app }) => {
    await app.page.click("#c-grad");
    await app.page.fill("#f-gangle-num", "999");
    await app.page.locator("#f-gangle-num").blur();
    expect((await cur(app)).gradientAngle).toBe(359);
  });

  test("width slider and number stay in sync", async ({ app }) => {
    await app.page.fill("#f-width-num", "12");
    await app.page.locator("#f-width-num").blur();
    expect((await cur(app)).width).toBe(12);
    await expect(app.page.locator("#f-width")).toHaveValue("12");
    await expect(app.curvePaths().first()).toHaveAttribute("stroke-width", "12");
    await app.page.fill("#f-width-num", "1000");
    await app.page.locator("#f-width-num").blur();
    expect((await cur(app)).width).toBe(300);
  });

  test("taper adds an end width and drift, and can be removed", async ({ app }) => {
    await app.page.check("#f-taper");
    expect((await cur(app)).width2).toBe(3);
    await app.page.fill("#f-width2-num", "10");
    await app.page.locator("#f-width2-num").blur();
    expect((await cur(app)).width2).toBe(10);
    await app.page.fill("#f-drift-num", "2.5");
    await app.page.locator("#f-drift-num").blur();
    expect((await cur(app)).drift).toBe(2.5);
    await app.page.uncheck("#f-taper");
    expect((await cur(app)).width2).toBeNull();
    await expect(app.page.locator("#f-width2")).toHaveCount(0);
  });

  test("flat opacity", async ({ app }) => {
    await app.page.fill("#f-op-num", "40");
    await app.page.locator("#f-op-num").blur();
    expect((await cur(app)).opacity).toBe(0.4);
    await expect(app.page.locator("#f-op")).toHaveValue("40");
  });

  test("gradient opacity is a stop table with an angle", async ({ app }) => {
    await app.page.click("#c-op-grad");
    expect((await cur(app)).opacityMode).toBe("gradient");
    await app.page.fill("#f-ostops .s-v >> nth=1", "10");
    await app.page.locator("#f-ostops .s-v >> nth=1").blur();
    expect((await cur(app)).opacityStops[1].a).toBe(0.1);
    await expect(app.page.locator("#stage mask")).toHaveCount(1);
    await app.page.click("#c-op-flat");
    await expect(app.page.locator("#stage mask")).toHaveCount(0);
  });

  test("every panel edit is undoable", async ({ app }) => {
    await app.panel.locator('.swatch[data-swatch="#e6453c"]').click();
    await app.page.keyboard.press("Control+z");
    expect((await cur(app)).color).toBe("#2a2d34");
    await app.page.keyboard.press("Control+Shift+z");
    expect((await cur(app)).color).toBe("#e6453c");
  });
});
