// @ts-check
const { test, expect } = require("@playwright/test");

// A cubic that is known (verified by brute-force flattened-segment intersection
// search) to cross itself once, at global t ~= 0.283 and t ~= 0.717.
const LOOP_CURVE = {
  p0: { x: 0, y: 0 },
  c1: { x: 300, y: 300 },
  c2: { x: 300, y: -100 },
  p3: { x: 0, y: 100 },
};

test.beforeEach(async ({ page }) => {
  await page.goto("/index.html");
  await page.waitForFunction(() => !!window.__coeurf);
});

test("splitCurvesAtIntersections cuts a self-crossing curve into three pieces at the crossing", async ({ page }) => {
  const pieces = await page.evaluate((loop) => {
    const api = window.__coeurf;
    const curve = { id: "loop1", isBorder: false, width: 3, color: "#000", ...loop };
    return api.splitCurvesAtIntersections([curve]).map((c) => ({ id: c.id, p0: c.p0, p3: c.p3 }));
  }, LOOP_CURVE);

  expect(pieces.map((p) => p.id)).toEqual(["loop1~0", "loop1~1", "loop1~2"]);
  // the middle piece is the pinched-off loop: its own start and end coincide...
  expect(pieces[1].p0.x).toBeCloseTo(pieces[1].p3.x, 5);
  expect(pieces[1].p0.y).toBeCloseTo(pieces[1].p3.y, 5);
  // ...and that shared point is exactly what joins it to both neighbors.
  expect(pieces[0].p3).toEqual(pieces[1].p0);
  expect(pieces[2].p0).toEqual(pieces[1].p3);
});

test("a self-intersecting curve produces multiple distinct bounded surfaces, not one", async ({ page }) => {
  const result = await page.evaluate((loop) => {
    const api = window.__coeurf;
    // p0/p3 both sit on the left border edge, so the crossing carves the page
    // into three bounded regions: the pinched-off loop, a sliver between the
    // arc and the border edge, and the remaining page.
    api.state.curves = [{ id: "loop1", isBorder: false, width: 3, color: "#000", ...loop }];
    api.recomputeFaces();
    const faces = api.getFaces();
    return { count: faces.length, signatures: faces.map((f) => f.signature) };
  }, LOOP_CURVE);

  expect(result.count).toBe(3);
  expect(new Set(result.signatures).size).toBe(3);
  // the pinched loop is its own, single-curve-piece surface
  expect(result.signatures).toContain("loop1~1");
});

test("two curves crossing away from a shared endpoint split into distinct faces", async ({ page }) => {
  const result = await page.evaluate(() => {
    const api = window.__coeurf;
    api.state.grid.width = 200;
    api.state.grid.height = 200;
    const mk = (id, p0, p3) => ({
      id, isBorder: false, width: 3, color: "#000", p0, p3,
      c1: { x: p0.x + (p3.x - p0.x) / 3, y: p0.y + (p3.y - p0.y) / 3 },
      c2: { x: p0.x + (p3.x - p0.x) * 2 / 3, y: p0.y + (p3.y - p0.y) * 2 / 3 },
    });
    // the two diagonals of the border square, crossing dead center
    api.state.curves = [
      mk("d1", { x: 0, y: 0 }, { x: 200, y: 200 }),
      mk("d2", { x: 200, y: 0 }, { x: 0, y: 200 }),
    ];
    api.recomputeFaces();
    const faces = api.getFaces();
    return { count: faces.length, signatures: faces.map((f) => f.signature).sort(), areas: faces.map((f) => f.area) };
  });

  expect(result.count).toBe(4);
  expect(new Set(result.signatures).size).toBe(4);
  for (const area of result.areas) expect(area).toBeCloseTo(10000, 3); // four equal triangles
});

test("clicking each lobe of a self-intersecting surface selects a different, independently stylable surface", async ({ page }) => {
  await page.evaluate((loop) => {
    const api = window.__coeurf;
    // Anchor the arc's open ends onto the border so all three regions
    // (loop, sliver, and remaining page) become bounded, clickable faces.
    api.state.grid.width = 400;
    api.state.grid.height = 400;
    const shifted = {
      p0: { x: 0, y: 100 },
      c1: { x: 300, y: 400 },
      c2: { x: 300, y: 0 },
      p3: { x: 0, y: 200 },
    };
    api.state.curves = [{ id: "loop1", isBorder: false, width: 3, color: "#000", ...shifted }];
    api.recomputeFaces();
    api.render();
  }, LOOP_CURVE);

  const faces = await page.evaluate(() => window.__coeurf.getFaces().map((f) => f.signature));
  expect(faces.length).toBe(3);

  await page.click("#tool-surface");

  // interiorSamplePoint just guarantees "inside the polygon", which for the
  // thin sliver face lands within the curve's own hit-test tolerance (curve
  // hit-testing wins over face hit-testing by design). Hand-picked points,
  // each verified to sit well clear of every curve stroke for this exact
  // geometry, so each face resolves as a face click rather than a curve click.
  const pointFor = (sig) => {
    if (sig === "loop1~1") return { x: 173.04, y: 178.8 };
    if (sig.includes("loop1~0,loop1~2")) return { x: 24.2, y: 154.03 };
    return { x: 350, y: 350 }; // remaining big outer face
  };

  const box = await page.locator("#stage").boundingBox();
  const scale = box.width / 400;
  const signatures = new Set();
  for (const sig of faces) {
    const sample = pointFor(sig);
    await page.mouse.click(box.x + sample.x * scale, box.y + sample.y * scale);
    const selection = await page.evaluate(() => window.__coeurf.state.selection);
    expect(selection).toEqual({ type: "face", signature: sig });
    signatures.add(selection.signature);

    // it's independently stylable: assigning a color here must not affect the other lobes
    await page.evaluate((s) => {
      const api = window.__coeurf;
      api.state.faceStyles[s] = { type: "solid", color: "#ff0000" };
      api.render();
    }, sig);
  }
  expect(signatures.size).toBe(3);

  const styles = await page.evaluate(() => window.__coeurf.state.faceStyles);
  const colors = new Set(Object.values(styles).map((s) => s.color));
  expect(colors).toEqual(new Set(["#ff0000"]));
});
