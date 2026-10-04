<p align="center"><img src="icon.svg" alt="cœurf icon" width="128" height="128"></p>

# cœurf

A cubic Bézier curve editor with anchor-based snapping that runs entirely in the browser and exports clean SVG.

Points can snap to a grid, but every curve also carries anchors that other curves can attach to, so joins are exact even when the artwork is off-grid. `cœurf` gives you the tools to draw, style, and arrange curves, then export them as SVG.

## Features

- **Optional grid snapping**: with *Snap to grid* on (the default), points and dragged curves snap to a configurable grid; turn it off for free placement. The grid also offers center, thirds and golden-section guides
- **Circle tool**: drag from the center to draw a circle as four joined quarter-arc Bézier curves (about 0.03% radial error), snapped like any other point
- **Anchors**: each curve has start/end anchors plus any number of extra ones, placed by arc length. Add them with presets (mid, thirds, quarters, divide evenly), the panel, or by double-clicking the selected curve; drag to slide, double-click to remove
- **Attached curves**: endpoints snap to other curves' anchors and stay attached, so moving, reshaping or sliding the host drags attached curves along. Optional *tangent* anchors also lock the attached curve's control point onto the host's tangent
- **Symbols**: select curves (a leaf, say) and press *Make symbol*, then place copies with the Symbol tool by clicking a start and an end point. Each instance is rotated and scaled to fit between its two pins (optionally mirrored), pins snap and stay attached to anchors, and editing the template curves updates every instance
- **Curve styling**: solid or gradient colors, per-stop opacity, and tapered strokes
- **Palette**: a shared palette is the single source of colors for all other tools
- **Arrange and mirror**: reorder curves (front/back), mirror a curve across its own endpoints, or across the page's horizontal or vertical axis
- **Page settings**: set the page size and zoom or fit the canvas to the window
- **Undo/redo and auto-save**: your work is kept in `localStorage`
- **Optional server storage**: when served by the `coeurf` binary with a database, designs can be saved to the server. Every save adds an immutable version, and any earlier version can be reopened
- **Import/export**: download and import designs as JSON, or export the artwork as SVG
- **No build step and no runtime dependencies in the browser**: plain HTML, CSS, and JavaScript

## Usage

Serve the folder with any static file server and open it in a browser:

```
python3 -m http.server 8000
```

Then visit <http://localhost:8000>.

### Server storage (optional)

The `coeurf` binary serves the editor with its static files embedded. Set `COEURF_DB_DSN` to a MariaDB/MySQL DSN and the toolbar gains **Open…**, **Save** and **Save as…**; without it (or with any plain static server) the editor works as before, using only `localStorage`.

```
just db-setup     # once: create the coeurf database and user (needs MariaDB root)
just run          # serve on :2547 (COEURF_ADDR overrides)
just build        # single static binary ./coeurf
```

- The DSN must contain `parseTime=true`, e.g. `coeurf:coeurf@/coeurf?parseTime=true`. Tables are created on startup.
- **Save** appends a new version of the linked design. If someone else saved in between, it is refused instead of overwriting; use **Save as…** to keep your copy. **Open…** lists designs, their versions, and offers rename and delete. Opening an old version and saving puts it on top as a new version.
- `localStorage` autosave stays on and is independent of server saves.

### Anchors and snapping

- Click empty canvas to start a curve, click again to finish it. Either end snaps to an anchor within a few pixels and links to it. Otherwise it snaps to the grid, if enabled. Hold `Alt` to place a point freely.
- Clicking an anchor starts a curve from it; `Ctrl/Cmd`+click does so even for the selected curve's own anchors.
- Dragging a curve detaches the ends that were attached to curves left behind. Select host and child together to move them as one. The curve panel lists attachments and can detach them.
- Anchors take priority over the grid. Grid snapping is toggled in the Grid tool.

### Symbols

- Select the curves of a shape with the Curve tool (Shift-click for several) and press **Make symbol**. The two most distant endpoints become its start and end pins; for a leaf, that is the shared start and end. The curves stay on the canvas as the *template*.
- In the Symbol tool, click a start point and an end point. Both snap to anchors (and stay attached to them) unless you hold `Alt`. *Mirrored* places the reflected shape.
- In the Curve tool, click an instance to select it, drag it to move it, or drag one of its pins to rotate and scale it or attach it to another anchor. Instances can be duplicated, detached into plain curves, or reordered.
- Deleting a template curve dissolves its symbol; the instances remain as plain curves.

### Shortcuts

| Key | Action |
|---|---|
| `P` / `G` / `L` / `C` / `O` / `S` | Page / Grid / Palette / Curve / Circle / Symbol tool |
| `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z` | Undo / redo |
| `]` / `[` | Bring forward / send backward (hold `Shift` for front / back) |
| `Delete` / `Backspace` | Delete the selected curve |
| `Esc` | Cancel / deselect |
| `Ctrl/Cmd` `+` / `-` / `0` | Zoom in / out / reset |

## Requirements

- A modern web browser
- Any static file server (e.g. Python 3's `http.server`), or the Go binary
- For server storage: Go, [just](https://just.systems) and MariaDB or MySQL

## Running the tests

`just test` runs everything. The Go tests include repository tests against a real database (`COEURF_DB_DSN`, which `just` defaults to the DSN above; they skip if it is unset) and clean up after themselves. Browser tests use [Playwright](https://playwright.dev) with a mocked API:

```bash
npm install
npx playwright install chromium
just test-go
just test-e2e
```

## License

MIT
