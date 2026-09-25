// @ts-check
const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.goto("/index.html");
  await page.waitForFunction(() => !!window.__coeurf);
});

test("an empty grid has exactly one bounded face: the page itself", async ({ page }) => {
  const result = await page.evaluate(() => {
    const api = window.__coeurf;
    api.recomputeFaces();
    const faces = api.getFaces();
    return { count: faces.length, area: faces[0] && faces[0].area };
  });
  expect(result.count).toBe(1);
  expect(result.area).toBeCloseTo(800 * 600, 3);
});

test("a simple non-self-intersecting curve to the border yields exactly one bounded face, not split", async ({ page }) => {
  const result = await page.evaluate(() => {
    const api = window.__coeurf;
    api.state.curves = [{
      id: "c1", isBorder: false, width: 3, color: "#000",
      p0: { x: 0, y: 0 }, c1: { x: 400, y: 100 }, c2: { x: 400, y: 500 }, p3: { x: 800, y: 600 },
    }];
    api.recomputeFaces();
    const faces = api.getFaces();
    return { count: faces.length, signatures: faces.map((f) => f.signature) };
  });
  expect(result.count).toBe(2); // curve splits the page rectangle into two, nothing more
  expect(result.signatures.every((s) => !s.includes("~"))).toBe(true); // no synthetic splits introduced
});

test("drawing a curve via the UI still forms a clickable, stylable face", async ({ page }) => {
  await page.click("#tool-draw");
  const box = await page.locator("#stage").boundingBox();
  const toPixel = (x, y) => ({ x: box.x + (x / 800) * box.width, y: box.y + (y / 600) * box.height });

  // inset by a couple pixels from the exact 0/600 edge so the click lands inside
  // the SVG's own bounding box, but still snaps to a border-touching grid point
  const a = toPixel(200, 2);
  const b = toPixel(200, 598);
  await page.mouse.click(a.x, a.y);
  await page.mouse.click(b.x, b.y);

  const faces = await page.evaluate(() => window.__coeurf.getFaces().map((f) => f.signature));
  expect(faces.length).toBe(2);

  await page.click("#tool-select");
  const mid = toPixel(100, 300);
  await page.mouse.click(mid.x, mid.y);
  const selection = await page.evaluate(() => window.__coeurf.state.selection);
  expect(selection.type).toBe("face");
});
