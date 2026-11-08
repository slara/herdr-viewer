# Herdr PDF viewer

A document viewer pane for the Herdr app (`herdr-app`). The first format is PDF:
the pages show as a continuous, scrollable column, with zoom and page navigation.

Herdr mods have no web view, so each page is rasterized on demand with poppler's
`pdftoppm` and drawn as an image. Only visible pages (plus one either side) are
rendered. The PNGs are cached in `~/.config/herdr-app/data/pdf-viewer/<hash>/`,
and cache folders unused for 14 days are deleted.

## Requirements

- Herdr app 0.1.13 or later, on macOS
- poppler (`brew install poppler`), which provides `pdftoppm` and `pdfinfo`

## Install

```sh
ln -s ~/devel/herdr-pdf-viewer/mods/pdf-viewer ~/.config/herdr-app/mods/pdf-viewer
herdr-app check ~/.config/herdr-app/mods/pdf-viewer
ln -s ~/devel/herdr-pdf-viewer/bin/view ~/.local/bin/view
```

`~/.local/bin` must come before `/usr/bin` in `PATH`. `view` only takes PDFs;
anything else goes to the system's `/usr/bin/view` (vim, read-only), so that
command keeps working.

The symlinked mod loads from this folder, but Herdr's hot reload doesn't follow
the symlink: after editing, close and reopen open viewers to get the new code.

## Use

```sh
view spec.pdf          # beside this terminal (see Placement)
view --tab spec.pdf    # in a new tab
```

Outside Herdr, `view file.pdf` opens the PDF in the default app.

### Placement

`view` and the Cmd-Shift-O popup place the viewer from the terminal you ran
them in (`mods/pdf-viewer/place.py`):

- **From a plain terminal (a shell):** the viewer takes that terminal's place,
  and the terminal is *parked* (`terminal.park`): off screen, still running.
- **From an agent (Claude Code):** the viewer takes the place of the pane on
  its right. A viewer there is replaced; a terminal there is parked. With no
  pane on the right, a new one opens there.

The **↩ Terminal** button puts the parked terminal back in the viewer's place.
Closing the viewer puts it back beside its old neighbour. Neighbours are found
with `pane.go`; when the window hasn't drawn the panes yet, the tab's pane order
(left first) decides. Agents are the terminals Herdr reports an `app` or status
for.

While parked, Herdr doesn't protect that terminal from a herdr-core crash.
Which viewer parked which terminal is recorded in
`~/.config/herdr-app/data/pdf-viewer/state.json`.

A pane opened without a `file` shows an **Open PDF…** button (macOS file picker).
If the file changes on disk (a LaTeX or Typst rebuild), the viewer reloads it
within about 2 seconds and stays on the same page.

Open viewers through `view` or the popup: a viewer opened with a bare
`herdr-app do pane.split --mod pdf-viewer` isn't registered, so a later `view`
from Claude opens a new pane instead of replacing it.

### PDFs mentioned in a terminal (Claude Code's links)

Herdr hands clicked terminal links straight to macOS, which opens Preview, and
mods can't intercept that. Instead, press **Cmd-Shift-O** in a terminal: the
`pdf-links` popup lists the PDF files mentioned in its output and scrollback
(newest first), and Enter, a click or `1`–`9` opens one, placed as `view` does.

It finds absolute paths, `~/…`, `file://` URLs, and names relative to the
terminal's folder, including paths the agent wrapped over two lines. Only
files that exist are listed. Paths with spaces aren't detected.

Install it with:

```sh
ln -s ~/devel/herdr-pdf-viewer/mods/pdf-links ~/.config/herdr-app/mods/pdf-links
```

and add `"cmd-shift-o": "mod.open:pdf-links"` to the `global` section of
`~/.config/herdr-app/keys.json`.

### Keys (click the pane first)

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
| `Cmd-O` | open another PDF |

The same actions can be bound in `keys.json` under `mod:pdf-viewer`, e.g.
`"ctrl-shift-]": "pdf-viewer.next"` (commands: `next`, `prev`, `first`, `last`,
`zoom_in`, `zoom_out`, `fit`, `actual`, `reload`, `external`, `pick`).

## Tests

```sh
node --test tests/                    # PDF path detection in terminal text
python3 -m unittest discover tests    # placement rules, against a fake window
```
