const { test, expect, curve, design, STORAGE_KEY } = require("./helpers");

test.describe("undo / redo", () => {
  test("buttons start disabled", async ({ app }) => {
    await expect(app.undoBtn).toBeDisabled();
    await expect(app.redoBtn).toBeDisabled();
  });

  test("buttons and keyboard shortcuts step through history", async ({ app }) => {
    await app.draw([100, 100], [300, 100]);
    await app.draw([100, 300], [300, 300]);
    expect(await app.curves()).toHaveLength(2);
    await expect(app.redoBtn).toBeDisabled();

    await app.undoBtn.click();
    expect(await app.curves()).toHaveLength(1);
    await expect(app.redoBtn).toBeEnabled();
    await app.page.keyboard.press("Control+z");
    expect(await app.curves()).toHaveLength(0);
    await expect(app.undoBtn).toBeDisabled();

    await app.page.keyboard.press("Control+Shift+z");
    await app.page.keyboard.press("Control+y");
    expect(await app.curves()).toHaveLength(2);
    await expect(app.redoBtn).toBeDisabled();
  });

  test("a new edit discards the redo branch", async ({ app }) => {
    await app.draw([100, 100], [300, 100]);
    await app.undoBtn.click();
    await app.draw([100, 200], [300, 200]);
    await expect(app.redoBtn).toBeDisabled();
    expect(await app.curves()).toHaveLength(1);
  });

  test("undo covers grid, page and palette edits", async ({ app }) => {
    await app.tool("grid");
    await app.page.uncheck("#g-visible");
    await app.tool("palette");
    await app.page.click("#pal-delete");
    await app.undoBtn.click();
    expect((await app.state()).palette).toHaveLength(7);
    await app.undoBtn.click();
    expect((await app.state()).grid.visible).toBe(true);
  });

  test("undo clears the selection", async ({ app }) => {
    await app.draw([100, 100], [300, 100]);
    await app.undoBtn.click();
    expect((await app.state()).selection).toBeNull();
  });
});

test.describe("autosave", () => {
  test("design is saved on every change and restored on reload", async ({ app }) => {
    await app.draw([100, 100], [300, 100]);
    expect((await app.saved()).curves).toHaveLength(1);
    await app.page.reload();
    expect(await app.curves()).toHaveLength(1);
    await expect(app.curvePaths()).toHaveCount(1);
  });

  test("a restored design starts a fresh history", async ({ app }) => {
    await app.draw([100, 100], [300, 100]);
    await app.page.reload();
    await expect(app.undoBtn).toBeDisabled();
  });

  test("ids do not collide after reload", async ({ app }) => {
    await app.draw([100, 100], [300, 100]);
    await app.page.reload();
    await app.draw([100, 300], [300, 300]);
    const ids = (await app.curves()).map(c => c.id);
    expect(new Set(ids).size).toBe(2);
  });

  test("corrupt storage is ignored", async ({ app }) => {
    await app.page.evaluate(k => localStorage.setItem(k, "{not json"), STORAGE_KEY);
    await app.page.reload();
    expect(await app.curves()).toEqual([]);
    await expect(app.page.locator("#stage")).toBeVisible();
  });

  test("storage with the wrong shape is ignored", async ({ app }) => {
    await app.page.evaluate(k => localStorage.setItem(k, JSON.stringify({ hello: 1 })), STORAGE_KEY);
    await app.page.reload();
    expect((await app.state()).grid.width).toBe(800);
  });

  test("older designs without a palette get one seeded from used colors", async ({ app }) => {
    const d = design({ curves: [curve({ x: 100, y: 100 }, { x: 300, y: 100 }, { color: "#123456" })] });
    delete d.palette;
    await app.load(d);
    const pal = (await app.state()).palette;
    expect(pal).toContain("#123456");
    expect(pal).toContain("#33363d");
  });

  test("older designs without visible/specialLines get defaults", async ({ app }) => {
    const d = design();
    delete d.grid.visible; delete d.grid.specialLines;
    await app.load(d);
    const g = (await app.state()).grid;
    expect(g.visible).toBe(true);
    expect(g.specialLines).toEqual({ center: false, thirds: false, golden: false });
  });

  test("still works when localStorage throws", async ({ page }) => {
    await page.addInitScript(() => {
      Storage.prototype.setItem = () => { throw new Error("quota"); };
      Storage.prototype.getItem = () => { throw new Error("denied"); };
    });
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto("/");
    await page.evaluate(() => { state.curves.push({ id: "x", p0: { x: 0, y: 0 }, c1: { x: 0, y: 0 }, c2: { x: 0, y: 0 }, p3: { x: 20, y: 20 }, width: 3, color: "#000" }); pushHistory(); });
    expect(errors).toEqual([]);
  });
});
