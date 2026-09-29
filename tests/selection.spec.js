const { test, expect, curve, design } = require("./helpers");

const A = curve({ x: 100, y: 100 }, { x: 300, y: 100 }, { id: "a" });
const B = curve({ x: 100, y: 300 }, { x: 300, y: 300 }, { id: "b" });
const C = curve({ x: 500, y: 200 }, { x: 700, y: 200 }, { id: "c" });

test.describe("selecting, moving and editing", () => {
  test.beforeEach(async ({ app }) => {
    await app.load(design({ curves: [A, B, C] }));
  });

  test("clicking a curve selects it and shows handles", async ({ app }) => {
    await app.click(200, 100);
    expect((await app.state()).selection).toEqual({ type: "curve", id: "a" });
    await expect(app.page.locator("#stage .handle")).toHaveCount(4);
  });

  test("clicking empty space with a selection starts drawing, Escape deselects", async ({ app }) => {
    await app.click(200, 100);
    await app.page.keyboard.press("Escape");
    expect((await app.state()).selection).toBeNull();
    await expect(app.page.locator("#stage .handle")).toHaveCount(0);
  });

  test("clicking another curve replaces the selection", async ({ app }) => {
    await app.click(200, 100);
    await app.click(200, 300);
    expect((await app.state()).selection).toEqual({ type: "curve", id: "b" });
  });

  test("shift-click builds and shrinks a multi-selection", async ({ app }) => {
    await app.click(200, 100);
    await app.click(200, 300, { modifiers: ["Shift"] });
    expect((await app.state()).selection).toEqual({ type: "curves", ids: ["a", "b"] });
    await expect(app.panel).toContainText("2 curves selected");
    await app.click(600, 200, { modifiers: ["Shift"] });
    await expect(app.panel).toContainText("3 curves selected");
    await app.click(600, 200, { modifiers: ["Shift"] });
    await app.click(200, 300, { modifiers: ["Shift"] });
    expect((await app.state()).selection).toEqual({ type: "curve", id: "a" });
  });

  test("dragging a curve moves it in grid steps", async ({ app }) => {
    await app.drag([200, 100], [245, 165]);
    const a = (await app.curves()).find(c => c.id === "a");
    expect(a.p0).toEqual({ x: 140, y: 160 });
    expect(a.p3).toEqual({ x: 340, y: 160 });
  });

  test("dragging cannot move a curve off the page", async ({ app }) => {
    await app.drag([600, 200], [1200, 200]);
    const c = (await app.curves()).find(c => c.id === "c");
    expect(c.p3.x).toBe(800);
    expect(c.p0.x).toBe(600);
  });

  test("dragging a member of a multi-selection moves the whole group", async ({ app }) => {
    await app.click(200, 100);
    await app.click(200, 300, { modifiers: ["Shift"] });
    await app.drag([200, 100], [200, 140]);
    const cs = await app.curves();
    expect(cs.find(c => c.id === "a").p0.y).toBe(140);
    expect(cs.find(c => c.id === "b").p0.y).toBe(340);
    expect(cs.find(c => c.id === "c").p0.y).toBe(200);
  });

  test("plain click on a multi-selection member narrows it to that curve", async ({ app }) => {
    await app.click(200, 100);
    await app.click(200, 300, { modifiers: ["Shift"] });
    await app.click(200, 300);
    expect((await app.state()).selection).toEqual({ type: "curve", id: "b" });
  });

  test("a click without movement does not add history", async ({ app }) => {
    await app.click(200, 100);
    await expect(app.undoBtn).toBeDisabled();
  });

  test("dragging an endpoint handle reshapes the curve and snaps", async ({ app }) => {
    await app.click(200, 100);
    await app.drag([300, 100], [383, 177]);
    const a = (await app.curves()).find(c => c.id === "a");
    expect(a.p3).toEqual({ x: 380, y: 180 });
    expect(a.p0).toEqual({ x: 100, y: 100 });
  });

  test("dragging a control handle moves only that control point", async ({ app }) => {
    await app.click(200, 100);
    const before = (await app.curves()).find(c => c.id === "a");
    await app.drag([before.c1.x, before.c1.y], [160, 200]);
    const a = (await app.curves()).find(c => c.id === "a");
    expect(a.c1).toEqual({ x: 160, y: 200 });
    expect(a.c2).toEqual(before.c2);
  });

  test("Delete removes the selected curve; multi-selection deletes all", async ({ app }) => {
    await app.click(200, 100);
    await app.page.keyboard.press("Delete");
    expect((await app.curves()).map(c => c.id)).toEqual(["b", "c"]);
    await app.click(200, 300);
    await app.click(600, 200, { modifiers: ["Shift"] });
    await app.page.keyboard.press("Backspace");
    expect(await app.curves()).toEqual([]);
  });

  test("Delete does not remove the curve while typing in a field", async ({ app }) => {
    await app.click(200, 100);
    await app.page.locator("#f-width-num").focus();
    await app.page.keyboard.press("Delete");
    expect(await app.curves()).toHaveLength(3);
  });

  test("panel delete button removes the curve", async ({ app }) => {
    await app.click(200, 100);
    await app.page.click("#f-delete");
    expect(await app.curves()).toHaveLength(2);
    await expect(app.panel).toContainText("Nothing selected");
  });

  test("layer order: keys and buttons reorder curves", async ({ app }) => {
    const order = async () => (await app.curves()).map(c => c.id).join("");
    await app.click(200, 100);
    await app.page.keyboard.press("]");
    expect(await order()).toBe("bac");
    await app.page.keyboard.press("Shift+]");
    expect(await order()).toBe("bca");
    await app.page.keyboard.press("[");
    expect(await order()).toBe("bac");
    await app.page.click("#f-to-back");
    expect(await order()).toBe("abc");
    await app.page.click("#f-to-front");
    expect(await order()).toBe("bca");
    await app.page.click("#f-backward");
    expect(await order()).toBe("bac");
    await app.page.click("#f-forward");
    expect(await order()).toBe("bca");
  });

  test("layer order works on a multi-selection", async ({ app }) => {
    await app.click(200, 100);
    await app.click(600, 200, { modifiers: ["Shift"] });
    await app.page.click("#f-to-back-multi");
    expect((await app.curves()).map(c => c.id)).toEqual(["a", "c", "b"]);
  });

  test("mirror copy reflects across the endpoint line", async ({ app }) => {
    const bent = curve({ x: 100, y: 100 }, { x: 300, y: 100 }, { id: "m", c1: { x: 150, y: 40 }, c2: { x: 250, y: 40 } });
    await app.load(design({ curves: [bent] }));
    await app.click(200, 55);
    await app.page.click("#f-mirror");
    const cs = await app.curves();
    expect(cs).toHaveLength(2);
    expect(cs[1].c1).toEqual({ x: 150, y: 160 });
    expect(cs[1].p0).toEqual(bent.p0);
    expect((await app.state()).selection.id).toBe(cs[1].id);
  });

  test("mirror across page axes", async ({ app }) => {
    await app.click(200, 100);
    await app.page.click("#f-mirror-h");
    let cs = await app.curves();
    expect(cs[3].p0).toEqual({ x: 100, y: 500 });
    await app.click(200, 100);
    await app.page.click("#f-mirror-v");
    cs = await app.curves();
    expect(cs[4].p0).toEqual({ x: 700, y: 100 });
    expect(cs[4].p3).toEqual({ x: 500, y: 100 });
  });
});
