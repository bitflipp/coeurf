const { test, expect, design } = require("./helpers");

test.describe("page tool", () => {
  test.beforeEach(async ({ app }) => { await app.tool("page"); });

  test("changing dimensions resizes the stage", async ({ app }) => {
    await app.page.fill("#p-width", "400");
    await app.page.locator("#p-width").blur();
    await app.page.fill("#p-height", "300");
    await app.page.locator("#p-height").blur();
    const g = (await app.state()).grid;
    expect([g.width, g.height]).toEqual([400, 300]);
    await expect(app.page.locator("#stage")).toHaveAttribute("viewBox", "0 0 400 300");
  });

  test("dimensions have a 20px minimum and reject junk", async ({ app }) => {
    await app.page.fill("#p-width", "5");
    await app.page.locator("#p-width").blur();
    expect((await app.state()).grid.width).toBe(20);
    await app.page.fill("#p-height", "");
    await app.page.locator("#p-height").blur();
    expect((await app.state()).grid.height).toBe(600);
  });

  test("border: color, width, gradient", async ({ app }) => {
    await app.page.click("#pg-sub-border");
    await app.panel.locator('.swatch[data-swatch="#e6453c"]').click();
    expect((await app.state()).grid.borderColor).toBe("#e6453c");
    await expect(app.page.locator("#stage rect[fill=none]")).toHaveAttribute("stroke", "#e6453c");
    await app.page.fill("#p-bwidth", "6");
    await app.page.locator("#p-bwidth").blur();
    expect((await app.state()).grid.borderWidth).toBe(6);
    await app.page.click("#pb-grad");
    const g = (await app.state()).grid;
    expect(g.borderColorMode).toBe("gradient");
    expect(g.borderStops).toHaveLength(2);
    await expect(app.page.locator("#stage rect[fill=none]")).toHaveAttribute("stroke", "url(#page-border-grad)");
    await app.page.click("#pb-solid");
    await expect(app.page.locator("#stage rect[fill=none]")).toHaveAttribute("stroke", "#e6453c");
  });

  test("sub-tab choice survives switching tools", async ({ app }) => {
    await app.page.click("#pg-sub-border");
    await app.tool("grid");
    await app.tool("page");
    await expect(app.page.locator("#p-bwidth")).toBeVisible();
  });
});

test.describe("grid tool", () => {
  test.beforeEach(async ({ app }) => { await app.tool("grid"); });

  test("visibility toggle hides the grid pattern", async ({ app }) => {
    await expect(app.page.locator("#stage pattern")).toHaveCount(1);
    await app.page.uncheck("#g-visible");
    await expect(app.page.locator("#stage pattern")).toHaveCount(0);
    expect((await app.state()).grid.visible).toBe(false);
  });

  test("resolution updates the pattern, with a minimum of 2", async ({ app }) => {
    await app.page.fill("#g-res", "50");
    await app.page.locator("#g-res").blur();
    await expect(app.page.locator("#stage pattern")).toHaveAttribute("width", "50");
    await app.page.fill("#g-res", "1");
    await app.page.locator("#g-res").blur();
    expect((await app.state()).grid.resolution).toBe(2);
  });

  test("special guide lines", async ({ app }) => {
    const lines = app.page.locator("#stage g[style*=difference] line");
    await expect(lines).toHaveCount(0);
    await app.page.check('.g-special[data-key="center"]');
    await expect(lines).toHaveCount(2);
    await app.page.check('.g-special[data-key="thirds"]');
    await expect(lines).toHaveCount(6);
    await app.page.check('.g-special[data-key="golden"]');
    await expect(lines).toHaveCount(10);
    await app.page.uncheck('.g-special[data-key="thirds"]');
    await expect(lines).toHaveCount(6);
  });

  test("grid settings are not part of any curve and persist", async ({ app }) => {
    await app.page.uncheck("#g-visible");
    await app.page.reload();
    expect((await app.state()).grid.visible).toBe(false);
  });
});

test.describe("palette tool", () => {
  test.beforeEach(async ({ app }) => { await app.tool("palette"); });

  const swatches = app => app.page.locator(".palette-swatch[data-index]");

  test("shows the default palette", async ({ app }) => {
    await expect(swatches(app)).toHaveCount(7);
  });

  test("add duplicates the selected color and selects the new one", async ({ app }) => {
    await swatches(app).nth(2).click();
    await app.page.click("#pal-add");
    const pal = (await app.state()).palette;
    expect(pal).toHaveLength(8);
    expect(pal[7]).toBe(pal[2]);
    await expect(swatches(app).nth(7)).toHaveClass(/active/);
  });

  test("hex edit normalises, invalid input is reverted", async ({ app }) => {
    await app.page.fill("#pal-hex", "ABCDEF");
    await app.page.locator("#pal-hex").blur();
    expect((await app.state()).palette[0]).toBe("#abcdef");
    await app.page.fill("#pal-hex", "nope");
    await app.page.locator("#pal-hex").blur();
    await expect(app.page.locator("#pal-hex")).toHaveValue("#abcdef");
    expect((await app.state()).palette[0]).toBe("#abcdef");
  });

  test("native color input edits the selected color", async ({ app }) => {
    await app.page.locator("#pal-color").evaluate(el => {
      el.value = "#123456";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect((await app.state()).palette[0]).toBe("#123456");
    await expect(app.page.locator("#pal-hex")).toHaveValue("#123456");
  });

  test("delete removes the selected color; empty palette is handled", async ({ app }) => {
    await app.page.click("#pal-delete");
    expect((await app.state()).palette).toHaveLength(6);
    for (let i = 0; i < 6; i++) await app.page.click("#pal-delete");
    expect((await app.state()).palette).toEqual([]);
    await expect(app.page.locator("#pal-hex")).toHaveCount(0);
    await app.page.click("#pal-add");
    expect((await app.state()).palette).toEqual(["#808080"]);
  });

  test("drag and drop reorders", async ({ app }) => {
    const before = (await app.state()).palette;
    await swatches(app).nth(0).dragTo(swatches(app).nth(3));
    const after = (await app.state()).palette;
    expect(after).toEqual([before[1], before[2], before[3], before[0], ...before.slice(4)]);
  });

  test("editing or deleting a palette color leaves curves untouched", async ({ app }) => {
    await app.tool("curve");
    await app.draw([100, 100], [300, 100]);
    await app.panel.locator('.swatch[data-swatch="#e6453c"]').click();
    await app.tool("palette");
    await swatches(app).nth(2).click();
    await app.page.fill("#pal-hex", "#000000");
    await app.page.locator("#pal-hex").blur();
    await app.page.click("#pal-delete");
    expect((await app.curves())[0].color).toBe("#e6453c");
  });

  test("palette changes show up in the other tools' swatches", async ({ app }) => {
    await app.page.fill("#pal-hex", "#010203");
    await app.page.locator("#pal-hex").blur();
    await app.tool("page");
    await app.page.click("#pg-sub-border");
    await expect(app.panel.locator('.swatch[data-swatch="#010203"]')).toHaveCount(1);
  });

  test("an empty palette shows a message in other tools", async ({ app }) => {
    await app.load(design({ palette: [] }));
    await app.tool("page");
    await app.page.click("#pg-sub-border");
    await expect(app.panel).toContainText("palette is empty");
  });
});

test.describe("tool switching", () => {
  test("keyboard shortcuts", async ({ app }) => {
    for (const [key, tool] of [["p", "page"], ["g", "grid"], ["l", "palette"], ["c", "curve"]]) {
      await app.page.keyboard.press(key);
      await expect(app.page.locator(`#tool-${tool}`)).toHaveClass(/active/);
      expect((await app.state()).tool).toBe(tool);
    }
  });

  test("shortcuts are ignored while typing in a field", async ({ app }) => {
    await app.tool("grid");
    await app.page.locator("#g-res").focus();
    await app.page.keyboard.press("p");
    expect((await app.state()).tool).toBe("grid");
  });

  test("switching tools cancels a pending curve and clears selection", async ({ app }) => {
    await app.click(100, 100);
    await app.tool("grid");
    await app.tool("curve");
    await app.click(300, 300);
    expect(await app.curves()).toEqual([]);
  });

  test("canvas clicks do nothing outside the curve tool", async ({ app }) => {
    await app.tool("grid");
    await app.draw([100, 100], [300, 300]);
    expect(await app.curves()).toEqual([]);
  });
});
