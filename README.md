# herdr-viewer

A document viewer pane for the [Herdr](https://herdr.dev) desktop app. Run
`view spec.pdf`, `view README.md` or `view diagram.png` in a terminal, and the
file opens in a pane beside it: a PDF as a scrollable column of pages, a
Markdown file rendered as a page with highlighted code, Mermaid diagrams and
images, and an image fitted to the pane.

![The viewer showing a Markdown page beside a terminal](preview.png)

> [!IMPORTANT]
> **This is a personal tool, written using AI.**
> The code, tests and docs in this repo were written by an AI coding assistant ([Claude Code](https://claude.com/claude-code)).
> I directed the work, tried the tool, reviewed and decided what to keep, but I did not write it by hand.
> I built it for my own use, so expect no support, no roadmap and no stability promises.
> Read the code before you depend on it.

## Requirements

- macOS, with the Herdr app 0.1.13 or newer (`herdr-app`)
- [poppler](https://poppler.freedesktop.org) for PDFs: `brew install poppler` (provides `pdftoppm` and `pdfinfo`)
- Python 3, for placing the pane (`place.py`)
- [mermaid-cli](https://github.com/mermaid-js/mermaid-cli), only for Mermaid diagrams: `npm install -g @mermaid-js/mermaid-cli`

## Install

```sh
git clone https://github.com/slara/herdr-viewer
cd herdr-viewer
ln -s "$PWD/mods/pdf-viewer" ~/.config/herdr-app/mods/pdf-viewer
ln -s "$PWD/mods/pdf-links"  ~/.config/herdr-app/mods/pdf-links
ln -s "$PWD/bin/view" ~/.local/bin/view
herdr-app check ~/.config/herdr-app/mods/pdf-viewer
herdr-app check ~/.config/herdr-app/mods/pdf-links
```

`~/.local/bin` must come before `/usr/bin` in your `PATH`. macOS already has a
`view` command (vim, read-only); this one only takes PDF, Markdown and image
files and passes everything else to `/usr/bin/view`, so that keeps working.

For the popup that opens PDFs mentioned in a terminal, add this key to the
`global` section of `~/.config/herdr-app/keys.json` (it's also in this repo's
`keys.json`):

```json
"cmd-shift-o": "mod.open:pdf-links"
```

Herdr updates an untouched `keys.json` with new default shortcuts. Once you
edit it, the file is yours and new defaults have to be added by hand.

## Use

```sh
view spec.pdf          # beside this terminal (see "Where the viewer opens")
view README.md         # Markdown, rendered
view diagram.png       # an image: PNG, JPEG, GIF, WebP, BMP or SVG
view --tab spec.pdf    # in a new tab
```

Outside Herdr, `view` opens the file in its default app.

When the file changes on disk (a LaTeX or Typst rebuild, a save in your
editor), the viewer reloads it within about 2 seconds; a PDF stays on the same
page. The toolbar's **↗** opens the file in its default app.

### Opening a PDF an agent mentioned

Herdr hands clicked terminal links straight to macOS, which opens Preview, and
a mod can't intercept the click. Instead, press **Cmd-Shift-O** in the terminal:
a popup lists the PDF files mentioned in its output and scrollback, newest
first. Enter, a click or `1`–`9` opens one, placed the same way `view` places it.

It finds absolute paths, `~/…`, `file://` URLs and names relative to the
terminal's folder, including paths an agent wrapped over two lines. Only files
that exist are listed. Paths with spaces aren't detected.

### Keys

Click the viewer first. In a PDF:

| Key | Action |
|---|---|
| `j` `n` `↓` `→` `Space` `PageDown` | next page |
| `k` `p` `↑` `←` `Shift-Space` `PageUp` | previous page |
| `g` `Home` / `G` `End` | first / last page |
| `+` `=` / `-` | zoom in / out |
| `0` | fit width |
| `1` | 100% |
| `r` | reload |
| `o` | open in the default app |
| `Cmd-O` | open another document |

An image takes the zoom keys (`+` `=` `-` `0` `1`) and `r`, `o`, `Cmd-O`. A
Markdown page scrolls with the mouse or trackpad; only `r`, `o` and `Cmd-O`
apply to it.

To bind these elsewhere, use the `mod:pdf-viewer` section of `keys.json`, for
example `"ctrl-shift-]": "pdf-viewer.next"`. The commands are `next`, `prev`,
`first`, `last`, `zoom_in`, `zoom_out`, `fit`, `actual`, `reload`, `external`
and `pick`.

## What it shows

### PDF

Pages show as one continuous column, fitted to the pane's width, with page
navigation and zoom. Only the visible pages and one on either side are
rendered, so a long document doesn't render every page up front.

### Images

PNG, JPEG, GIF, WebP, BMP and SVG. The image is centered and shrunk to fit the
pane, never enlarged; the toolbar shows its size in pixels and the zoom, and
past the pane's size it scrolls both ways. Like Markdown images, it's copied
to `~/.config/herdr-app/data/pdf-viewer/md/` first, since a mod can only draw
images from Herdr's folder.

### Markdown

The page is drawn natively, block by block:

- **Text** with Herdr's Markdown view: headings, lists, task lists, tables,
  quotes and links. GitHub alerts (`> [!NOTE]`) show as a label.
- **Code blocks** with Herdr's read-only code editor: syntax colors from your
  theme, selectable text, and a **Copy** button on each block.
- **Mermaid** diagrams, rendered to SVG by `mmdc` in the light or dark theme.
  The first render of each diagram takes a second or two; after that it's
  cached.
- **Images** (PNG, JPG, SVG) that sit on a line of their own, from paths
  relative to the file.

Front matter (`---` YAML or `+++` TOML at the top) is left out. Links to other
Markdown files, PDFs or images open in the same viewer; web links open in the
browser, and other files in their default app.

Not shown: remote (https) images, images inside a paragraph, math, and
`#heading` links within the page. Files over 1 MiB can't be read.

> [!NOTE]
> Scrolling over a code block scrolls the block, not the page, and can carry
> the code out of sight; the block snaps back when the wheel stops. Herdr's code
> editor owns the wheel and mods can't turn that off yet.

This is the native counterpart of
[tmdview](https://github.com/slara/terminal-markdown-renderer), which renders
Markdown in a browser inside the terminal. tmdview's plugins are JavaScript for
a browser, so they don't run here; the viewer does their job with Herdr's own
pieces instead.

## Where the viewer opens

`view` and the popup place the viewer from the terminal you used:

- **From a plain terminal (a shell):** the viewer takes that terminal's place,
  and the terminal is *parked*: off screen, still running.
- **From an agent (Claude Code or any terminal that reports an agent status):**
  the viewer takes the place of the pane on the agent's right. A viewer there is
  replaced; a terminal there is parked. With no pane on the right, the agent's
  pane is split and the viewer takes its right half.

A viewer that takes a pane's place keeps that pane's width. The toolbar's
**↩ Terminal** button puts the parked terminal back in the viewer's place;
closing the viewer puts it back beside its old neighbour.

While a terminal is parked, Herdr doesn't protect it from a herdr-core crash.

Open viewers with `view` or the popup. A viewer opened with a bare
`herdr-app do pane.split --mod pdf-viewer` isn't registered, so a later `view`
from an agent opens a new pane instead of replacing it.

## How it works

Herdr mods are JavaScript that describes native GPUI elements; there is no web
view. So:

- **PDF pages** are rasterized on demand with `pdftoppm` and drawn as images,
  at a resolution that follows the zoom and your screen's scale.
- **Markdown** is split into text, code, diagram and image blocks, each drawn
  with Herdr's own element for it.
- **Images** are copied under Herdr's folder and drawn with its image element,
  sized from the SVG's `viewBox` or from `sips`.
- **Placement** is a Python script, `mods/pdf-viewer/place.py`, that drives
  `herdr-app do`. It finds the neighbouring pane with `pane.go`; when the
  window hasn't drawn the panes yet, the tab's pane order (left first) decides.
  It records which viewer parked which terminal in
  `~/.config/herdr-app/data/pdf-viewer/state.json`.

Rendered pages are cached in `~/.config/herdr-app/data/pdf-viewer/<hash>/`, and
a document's cache is deleted after 14 days unused. Diagrams and copies of
Markdown images go to `~/.config/herdr-app/data/pdf-viewer/md/`, since a mod can
only draw images from Herdr's folder; that folder isn't cleaned automatically.

## Uninstall

```sh
rm ~/.config/herdr-app/mods/pdf-viewer ~/.config/herdr-app/mods/pdf-links ~/.local/bin/view
rm -r ~/.config/herdr-app/data/pdf-viewer
```

Then remove the `cmd-shift-o` line from `~/.config/herdr-app/keys.json`.

## Development

```sh
node --test tests/                    # path detection, Markdown blocks, front matter and links
python3 -m unittest discover tests    # placement rules, against a fake window
herdr-app check ~/.config/herdr-app/mods/pdf-viewer
```

The mods load from this folder through the symlinks, but Herdr's hot reload
doesn't follow a symlink: after editing, close and reopen a viewer to get the
new code. The rendering itself is only tested by hand, in Herdr.

## License

Licensed under either of these, at your option:

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE-MIT](LICENSE-MIT))

Unless you say otherwise, any contribution you submit for inclusion in this work, as defined in the Apache-2.0 license, is dual licensed as above, with no extra terms or conditions.
