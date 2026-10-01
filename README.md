<p align="center"><img src="icon.svg" alt="cœurf icon" width="128" height="128"></p>

# cœurf

A cubic Bézier curve editor with anchor-based snapping that runs entirely in the browser and exports clean SVG.

Points can snap to a grid, but every curve also carries anchors that other curves can attach to, so joins are exact even when the artwork is off-grid. `cœurf` gives you the tools to draw, style, and arrange curves, then export them as SVG.

## Features

- **Optional grid snapping**: with *Snap to grid* on (the default), points and dragged curves snap to a configurable grid; turn it off for free placement. The grid also offers center, thirds and golden-section guides
- **Circle tool**: drag from the center to draw a circle as four joined quarter-arc Bézier curves (about 0.03% radial error), snapped like any other point
- **Anchors**: each curve has start/end anchors plus any number of extra ones, placed by arc length. Add them with presets (mid, thirds, quarters, divide evenly), the panel, or by double-clicking the selected curve; drag to slide, double-click to remove
- **Attached curves**: endpoints snap to other curves' anchors and stay attached, so moving, reshaping or sliding the host drags attached curves along. Optional *tangent* anchors also lock the attached curve's control point onto the host's tangent
- **Curve styling**: solid or gradient colors, per-stop opacity, and tapered strokes
- **Palette**: a shared palette is the single source of colors for all other tools
- **Arrange and mirror**: reorder curves (front/back), mirror a curve across its own endpoints, or across the page's horizontal or vertical axis
- **Page settings**: set the page size and zoom or fit the canvas to the window
- **Undo/redo and auto-save**: your work is kept in `localStorage`
- **Import/export**: download and import designs as JSON, or export the artwork as SVG
- **No build step and no runtime dependencies**: plain HTML, CSS, and JavaScript

## Usage

Serve the folder with any static file server and open it in a browser:

```
python3 -m http.server 8000
```

Then visit <http://localhost:8000>.

### Anchors and snapping

- Click empty canvas to start a curve, click again to finish it. Either end snaps to an anchor within a few pixels and links to it. Otherwise it snaps to the grid, if enabled. Hold `Alt` to place a point freely.
- Clicking an anchor starts a curve from it; `Ctrl/Cmd`+click does so even for the selected curve's own anchors.
- Dragging a curve detaches the ends that were attached to curves left behind. Select host and child together to move them as one. The curve panel lists attachments and can detach them.
- Anchors take priority over the grid. Grid snapping is toggled in the Grid tool.

### Shortcuts

| Key | Action |
|---|---|
| `P` / `G` / `L` / `C` / `O` | Page / Grid / Palette / Curve / Circle tool |
| `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z` | Undo / redo |
| `]` / `[` | Bring forward / send backward (hold `Shift` for front / back) |
| `Delete` / `Backspace` | Delete the selected curve |
| `Esc` | Cancel / deselect |
| `Ctrl/Cmd` `+` / `-` / `0` | Zoom in / out / reset |

## Requirements

- A modern web browser
- Any static file server (e.g. Python 3's `http.server`)

## Running the tests

Browser tests use [Playwright](https://playwright.dev):

```bash
npm install
npx playwright install chromium
npm test
```

## License

MIT
