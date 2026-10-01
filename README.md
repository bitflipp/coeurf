<p align="center">
  <img src="icon.svg" alt="cœurf icon" width="128" height="128">
</p>

<h1 align="center">cœurf</h1>

<p align="center">A grid-snapped cubic Bézier curve editor that runs entirely in the browser and exports clean SVG.</p>

## Features

- **Grid-snapped drawing:** click grid points to place curve endpoints and control points, with configurable grid resolution.
- **Curve styling:** solid or gradient colors, per-stop opacity, and tapered strokes.
- **Palette:** a shared palette is the single source of colors for all other tools.
- **Arrange and mirror:** reorder curves (front/back), mirror a curve across its own endpoints, or across the page's horizontal or vertical axis.
- **Page settings:** set the page size and zoom or fit the canvas to the window.
- **Undo/redo and auto-save:** your work is kept in `localStorage`.
- **Import/export:** download and import designs as JSON, or export the artwork as SVG.

## Usage

There is no build step. Serve the folder with any static file server and open it in a browser:

```sh
python3 -m http.server 8000
```

Then visit <http://localhost:8000>.

### Shortcuts

| Key | Action |
| --- | --- |
| `P` / `G` / `L` / `C` | Page / Grid / Palette / Curve tool |
| `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z` | Undo / redo |
| `]` / `[` | Bring forward / send backward (hold `Shift` for front / back) |
| `Delete` / `Backspace` | Delete the selected curve |
| `Esc` | Cancel / deselect |
| `Ctrl/Cmd` `+` / `-` / `0` | Zoom in / out / reset |

## Tests

Browser tests use [Playwright](https://playwright.dev):

```sh
npm install
npx playwright install chromium
npm test
```

## License

[MIT](LICENSE)
