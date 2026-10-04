const { test, expect, curve, design } = require("./helpers");

// A minimal in-memory stand-in for the server API, so the UI is tested without
// a database. The real API is covered by the Go tests.
async function fakeServer(page, { storage = true } = {}) {
  const designs = new Map(); // id -> {name, versions: [data...], updated_at}
  let nextId = 1;
  const json = (route, status, body) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  const view = (id, d, v = d.versions.length) => ({
    id, name: d.name, version: v, latest: d.versions.length, data: d.versions[v - 1],
  });

  await page.route("**/api/**", async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace("/api", "");
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    let m;
    if (path === "/config") return json(route, 200, { storage });
    if (path === "/designs" && req.method() === "GET") {
      return json(route, 200, [...designs].map(([id, d]) =>
        ({ id, name: d.name, version: d.versions.length, updated_at: new Date().toISOString() })));
    }
    if (path === "/designs" && req.method() === "POST") {
      const id = nextId++;
      designs.set(id, { name: body.name, versions: [body.data] });
      return json(route, 201, view(id, designs.get(id)));
    }
    if ((m = path.match(/^\/designs\/(\d+)$/))) {
      const id = Number(m[1]), d = designs.get(id);
      if (!d) return json(route, 404, { error: "not found" });
      if (req.method() === "GET") return json(route, 200, view(id, d));
      if (req.method() === "PUT") {
        if (body.base_version && body.base_version !== d.versions.length) return json(route, 409, { error: "conflict" });
        d.versions.push(body.data);
        return json(route, 200, view(id, d));
      }
      if (req.method() === "PATCH") { d.name = body.name; return route.fulfill({ status: 204 }); }
      if (req.method() === "DELETE") { designs.delete(id); return route.fulfill({ status: 204 }); }
    }
    if ((m = path.match(/^\/designs\/(\d+)\/versions$/))) {
      const d = designs.get(Number(m[1]));
      return json(route, 200, d.versions.map((_, i) => ({ version: i + 1, created_at: new Date().toISOString() })).reverse());
    }
    if ((m = path.match(/^\/designs\/(\d+)\/versions\/(\d+)$/))) {
      return json(route, 200, view(Number(m[1]), designs.get(Number(m[1])), Number(m[2])));
    }
    return json(route, 404, { error: "not found" });
  });
  return designs;
}

async function reloadWith(app, opts) {
  const designs = await fakeServer(app.page, opts);
  await app.page.reload();
  await app.page.waitForSelector("#stage");
  return designs;
}

function answerPrompts(page, ...answers) {
  page.on("dialog", d => answers.length ? d.accept(answers.shift()) : d.accept());
}

test.describe("server storage", () => {
  test("controls are hidden without server storage", async ({ app }) => {
    await expect(app.page.locator("#storage-group")).toBeHidden();
    await reloadWith(app, { storage: false });
    await expect(app.page.locator("#storage-group")).toBeHidden();
  });

  test("controls are hidden when there is no API at all", async ({ app }) => {
    await app.page.route("**/api/**", r => r.fulfill({ status: 404, body: "<html>nope</html>" }));
    await app.page.reload();
    await expect(app.page.locator("#storage-group")).toBeHidden();
    await app.draw([100, 100], [300, 100]);
    expect(await app.curves()).toHaveLength(1);
  });

  test("save creates a design, saving again adds versions", async ({ app }) => {
    const designs = await reloadWith(app);
    await expect(app.page.locator("#storage-group")).toBeVisible();
    answerPrompts(app.page, "heart");

    await app.draw([100, 100], [300, 100]);
    await app.page.click("#save-btn");
    await expect(app.page.locator("#remote-label")).toHaveText("heart · v1");
    expect(designs.get(1).versions).toHaveLength(1);
    expect(designs.get(1).versions[0].curves).toHaveLength(1);

    await app.draw([100, 300], [300, 300]);
    await app.page.click("#save-btn");
    await expect(app.page.locator("#remote-label")).toHaveText("heart · v2");
    expect(designs.get(1).versions[1].curves).toHaveLength(2);
  });

  test("save as stores a separate design", async ({ app }) => {
    const designs = await reloadWith(app);
    answerPrompts(app.page, "one", "two");
    await app.page.click("#save-btn");
    await expect(app.page.locator("#remote-label")).toHaveText("one · v1");
    await app.page.click("#save-as-btn");
    await expect(app.page.locator("#remote-label")).toHaveText("two · v1");
    expect(designs.size).toBe(2);
  });

  test("cancelling the name prompt saves nothing", async ({ app }) => {
    const designs = await reloadWith(app);
    app.page.on("dialog", d => d.dismiss());
    await app.page.click("#save-btn");
    expect(designs.size).toBe(0);
    await expect(app.page.locator("#remote-label")).toHaveText("");
  });

  test("the link to the stored design survives a reload", async ({ app }) => {
    await reloadWith(app);
    answerPrompts(app.page, "kept");
    await app.page.click("#save-btn");
    await expect(app.page.locator("#remote-label")).toHaveText("kept · v1");
    await app.page.reload();
    await expect(app.page.locator("#remote-label")).toHaveText("kept · v1");
  });

  test("open loads the latest version and is undoable", async ({ app }) => {
    const designs = await reloadWith(app);
    designs.set(7, { name: "stored", versions: [design({ curves: [curve({ x: 40, y: 40 }, { x: 200, y: 40 })] })] });
    await app.page.click("#open-btn");
    await expect(app.page.locator("#design-list li")).toHaveCount(1);
    await app.page.click("#design-list >> text=Open");
    expect(await app.curves()).toHaveLength(1);
    await expect(app.page.locator("#remote-label")).toHaveText("stored · v1");
    await expect(app.page.locator("#open-dialog")).not.toBeVisible();
    await app.undoBtn.click();
    expect(await app.curves()).toHaveLength(0);
  });

  test("an old version can be reopened and saved on top", async ({ app }) => {
    const designs = await reloadWith(app);
    const c = curve({ x: 40, y: 40 }, { x: 200, y: 40 });
    designs.set(3, { name: "history", versions: [design(), design({ curves: [c] })] });
    await app.page.click("#open-btn");
    await app.page.click("#design-list >> text=Versions");
    await expect(app.page.locator(".versions li")).toHaveCount(2);
    await app.page.locator(".versions li", { hasText: "Version 1" }).getByText("Open").click();
    expect(await app.curves()).toHaveLength(0);
    await expect(app.page.locator("#remote-label")).toHaveText("history · v1");

    await app.page.click("#save-btn");
    await expect(app.page.locator("#remote-label")).toHaveText("history · v3");
    expect(designs.get(3).versions).toHaveLength(3);
    expect(designs.get(3).versions[2].curves).toHaveLength(0);
  });

  test("a conflicting save is refused and reported", async ({ app }) => {
    const designs = await reloadWith(app);
    answerPrompts(app.page, "shared");
    await app.page.click("#save-btn");
    designs.get(1).versions.push(design()); // someone else saved
    await app.page.click("#save-btn");
    await expect(app.hint).toContainText("Changed elsewhere");
    expect(designs.get(1).versions).toHaveLength(2);
    await expect(app.page.locator("#remote-label")).toHaveText("shared · v1");
  });

  test("saving a design deleted elsewhere unlinks it", async ({ app }) => {
    const designs = await reloadWith(app);
    answerPrompts(app.page, "gone");
    await app.page.click("#save-btn");
    designs.clear();
    await app.page.click("#save-btn");
    await expect(app.hint).toContainText("no longer exists");
    await expect(app.page.locator("#remote-label")).toHaveText("");
  });

  test("rename and delete from the list", async ({ app }) => {
    const designs = await reloadWith(app);
    answerPrompts(app.page, "first", "second");
    await app.page.click("#save-btn");
    await app.page.click("#open-btn");
    await app.page.click("#design-list >> text=Rename");
    await expect(app.page.locator("#design-list .name")).toHaveText("second");
    await expect(app.page.locator("#remote-label")).toHaveText("second · v1");

    await app.page.click("#design-list >> text=Delete");
    await expect(app.page.locator("#design-list .empty")).toBeVisible();
    expect(designs.size).toBe(0);
    await expect(app.page.locator("#remote-label")).toHaveText("");
  });

  test("names are shown as text, not markup", async ({ app }) => {
    const designs = await reloadWith(app);
    designs.set(1, { name: "<img src=x onerror=window.pwned=1>", versions: [design()] });
    await app.page.click("#open-btn");
    await expect(app.page.locator("#design-list .name")).toHaveText("<img src=x onerror=window.pwned=1>");
    expect(await app.page.evaluate(() => window.pwned)).toBeUndefined();
  });

  test("New unlinks from the stored design", async ({ app }) => {
    await reloadWith(app);
    answerPrompts(app.page, "linked");
    await app.page.click("#save-btn");
    await app.page.click("#new-btn");
    await expect(app.page.locator("#remote-label")).toHaveText("");
  });
});
