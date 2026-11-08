// viewer: a document viewer pane for Herdr. Shows a PDF as a continuous,
// scrollable column of pages. Pages are rasterized on demand with poppler's
// `pdftoppm` into a cache under the app home, and drawn with `image()`.
// An image is shown on its own, fitted to the pane. A Markdown file is drawn
// block by block with gpui's own elements: text with TextView, code with the
// read-only Editor (highlighting, copy), Mermaid diagrams rendered to SVG by
// `mmdc`, and images.
//
// Open one with `view doc.pdf` (bin/view → place.py), which places it and
// registers it so it can be replaced later.

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Scrollbar, VirtualListScrollHandle, TextView, Editor, EditorState } from "gpui-base";
import { exec, theme, appHome, home, props, nextCommand, readTextFile, settings, focused, panes, run } from "herdr";
import { createHash } from "crypto";
import * as fs from "fs/promises";
import { isMarkdown, isImage, splitMarkdown, markdownTitle, resolveLink, editorLanguage, svgSize } from "./doc.js";

const CACHE = "data/viewer";   // relative to appHome(); image() resolves from there
const GAP = 14;                    // px between pages
const PAD = 18;                    // px around the page column
const TOOLBAR = 32;                // px, the toolbar's height
const PX_PER_PT = 96 / 72;         // 100% zoom = the page at 96 dpi
const DEVICE_SCALE = 2;            // render for HiDPI screens
const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
const CACHE_DAYS = 14;
const ASSETS = `${CACHE}/md`;      // Mermaid SVGs and copies of a Markdown file's images
const MD_WIDTH = 880;              // px, the Markdown page column
const CODE_LINE = 20;              // px per line of a code block (Editor at 13 px)
const PLACE = () => `${appHome()}/mods/viewer/place.py`;   // placement and parked terminals
const ROUTER = () => `${appHome()}/mods/viewer/router/router.py`;   // Cmd-click support

const expand = (p) => (p.startsWith("~/") ? home() + p.slice(1) : p);
const basename = (p) => p.split("/").pop();

export default class Viewer extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    this.width = 0;
    this.height = 0;
    this.zoom = "fit";            // "fit" (fit width) or a number from ZOOMS
    this.visible = { start: 0, end: 1 };
    this.shownPage = 0;
    this.reset();

    const file = props()?.file;
    if (file) this.open(expand(String(file)), cx);

    cx.timer.every(150, (cx) => { this.syncFocus(cx); this.pump(cx); });
    cx.timer.every(2000, (cx) => this.checkChanged(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        this.command(c, cx);
        cx.notify();
      }
    });
  }

  reset() {
    for (const b of this.doc?.blocks ?? []) b.state?.release();
    this.doc = null;              // { file, dir, title, stamp, pages: [{w, h}] } (pt, rotation applied)
    this.error = null;
    this.ready = new Map();       // `${page}@${dpi}` -> image path
    this.latest = new Map();      // page -> last rendered image path, shown while re-rendering
    this.failed = new Set();
    this.busy = false;
    this.generation = (this.generation ?? 0) + 1;
  }

  // ---- loading -------------------------------------------------------------

  open(file, cx) {
    this.reset();
    if (file !== this.file) this.zoom = "fit";   // a reload keeps the zoom, another document doesn't
    this.file = file;
    const gen = this.generation;
    cx.spawn(async (cx) => {
      try {
        const doc = await this.inspect(file);
        if (gen !== this.generation) return;
        this.doc = doc;
        this.prune();
        if (doc.blocks) this.prepareBlocks(doc, gen, cx);
      } catch (e) {
        if (gen === this.generation) this.error = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  async inspect(file) {
    const st = await exec("stat", ["-f", "%m %z", file]);
    if (st.code !== 0) throw new Error(`Cannot read ${file}`);
    if (isMarkdown(file)) {
      const text = await readTextFile(file);   // up to 1 MiB
      if (text === null) throw new Error(`Cannot read ${file}`);
      return { file, kind: "md", blocks: splitMarkdown(text), title: markdownTitle(text), stamp: st.stdout.trim() };
    }
    if (isImage(file)) {
      return { file, kind: "image", asset: await this.picture(file, file), title: "", stamp: st.stdout.trim() };
    }
    const info = await exec("pdfinfo", ["-f", "1", "-l", "100000", file]);
    if (info.code !== 0) throw new Error(info.stderr.trim().split("\n").pop() || "Not a readable PDF");

    const pages = [];
    let title = "";
    for (const line of info.stdout.split("\n")) {
      let m;
      if ((m = line.match(/^Page\s+(\d+) size:\s+([\d.]+) x ([\d.]+)/))) {
        pages[+m[1] - 1] = { w: +m[2], h: +m[3] };
      } else if ((m = line.match(/^Page\s+(\d+) rot:\s+(\d+)/))) {
        const p = pages[+m[1] - 1];
        if (p && (+m[2] / 90) % 2 === 1) [p.w, p.h] = [p.h, p.w];
      } else if ((m = line.match(/^Title:\s+(.*)$/))) {
        title = m[1].trim();
      }
    }
    if (!pages.length) throw new Error("This PDF has no pages");

    const key = createHash("sha1").update(`${file}\0${st.stdout.trim()}`).digest("hex").slice(0, 16);
    const dir = `${CACHE}/${key}`;
    await fs.mkdir(`${appHome()}/${dir}`, { recursive: true });
    // Mark the cache as used: prune() goes by the folder's date.
    await exec("touch", [`${appHome()}/${dir}`]).catch(() => {});
    return { file, dir, title, stamp: st.stdout.trim(), pages };
  }

  // Reload when the file changes on disk (a LaTeX/Typst build, a new export).
  // A stat poll, not watchFolder: on macOS that watches the parent folder
  // recursively, which for a PDF in ~ means the whole home.
  checkChanged(cx) {
    const doc = this.doc;
    if (!doc || this.checking) return;
    this.checking = true;
    cx.spawn(async (cx) => {
      const st = await exec("stat", ["-f", "%m %z", doc.file]).catch(() => null);
      this.checking = false;
      if (st?.code === 0 && doc === this.doc && st.stdout.trim() !== doc.stamp) {
        // The cache is per version of the file: the old version's pages are dead weight.
        if (doc.dir) exec("rm", ["-rf", `${appHome()}/${doc.dir}`]).catch(() => {});
        const keep = this.shownPage;
        this.open(doc.file, cx);
        this.restorePage = keep;
      }
    });
  }

  // Drop what nobody opened for a while: PDF page folders whole, and diagrams
  // and image copies one by one (their folder is shared, and used files are touched).
  prune() {
    exec("find", [`${appHome()}/${CACHE}`, "-mindepth", "1", "-maxdepth", "1", "-type", "d", "!", "-name", "md",
      "-mtime", `+${CACHE_DAYS}`, "-exec", "rm", "-rf", "{}", "+"]).catch(() => {});
    exec("find", [`${appHome()}/${ASSETS}`, "-type", "f", "-mtime", `+${CACHE_DAYS}`, "-delete"]).catch(() => {});
  }

  // ---- geometry ------------------------------------------------------------

  maxWidthPt() {
    return Math.max(...this.doc.pages.map((p) => p.w));
  }

  // Logical px per pt.
  scale() {
    if (this.zoom !== "fit") return this.zoom * PX_PER_PT;
    const avail = Math.max(120, this.width - PAD * 2);
    return avail / this.maxWidthPt();
  }

  // An image's zoom: image px per screen px. "fit" shrinks it into the pane, never enlarges.
  imageScale() {
    if (this.zoom !== "fit") return this.zoom;
    const { w, h } = this.doc.asset;
    return Math.min(1, (this.width - PAD * 2) / w, (this.height - TOOLBAR - PAD * 2) / h);
  }

  // The zoom as a fraction of 100%, for either kind.
  zoomLevel() {
    return this.doc?.asset ? this.imageScale() : this.scale() / PX_PER_PT;
  }

  zoomPercent() {
    return Math.round(this.zoomLevel() * 100);
  }

  // Render resolution, in buckets so resizing doesn't re-render on every pixel.
  dpi() {
    const raw = this.scale() * 72 * DEVICE_SCALE;
    return Math.min(600, Math.max(48, Math.round(raw / 24) * 24));
  }

  // ---- rendering pages -----------------------------------------------------

  // Called by a timer: keeps the page indicator current and renders the next
  // page the reader needs (visible first, then one either side).
  pump(cx) {
    if (!this.doc?.pages) return;
    if (this.restorePage != null) {
      this.scroll.scroll_to_item(Math.min(this.restorePage, this.doc.pages.length - 1), "top");
      this.restorePage = null;
    }
    if (this.visible.start !== this.shownPage) {
      this.shownPage = this.visible.start;
      cx.notify();
    }
    if (this.busy || this.width === 0) return;

    const n = this.doc.pages.length;
    const dpi = this.dpi();
    const want = [];
    for (let i = this.visible.start; i < Math.min(this.visible.end, n); i++) want.push(i);
    if (this.visible.end < n) want.push(this.visible.end);
    if (this.visible.start > 0) want.push(this.visible.start - 1);
    const page = want.find((i) => !this.ready.has(`${i}@${dpi}`) && !this.failed.has(`${i}@${dpi}`));
    if (page === undefined) return;

    this.busy = true;
    const gen = this.generation;
    const doc = this.doc;
    cx.spawn(async (cx) => {
      const rel = `${doc.dir}/p${page + 1}-${dpi}.png`;
      const abs = `${appHome()}/${rel}`;
      try {
        if (!(await fs.exists(abs))) {
          const tmp = `${appHome()}/${doc.dir}/.p${page + 1}-${dpi}-${Date.now()}`;
          const r = await exec("pdftoppm", ["-png", "-r", String(dpi), "-f", String(page + 1),
            "-l", String(page + 1), "-singlefile", doc.file, tmp]);
          if (r.code !== 0) throw new Error(r.stderr);
          // Move into place whole, so the image loader never sees half a file.
          const mv = await exec("mv", ["-f", `${tmp}.png`, abs]);
          if (mv.code !== 0) throw new Error(mv.stderr);
        }
        if (gen === this.generation) {
          this.ready.set(`${page}@${dpi}`, rel);
          this.latest.set(page, rel);
        }
      } catch (e) {
        console.log(`viewer: page ${page + 1} failed: ${e?.message ?? e}`);
        if (gen === this.generation) this.failed.add(`${page}@${dpi}`);
      }
      this.busy = false;
      cx.notify();
    });
  }

  // ---- actions -------------------------------------------------------------

  goTo(page) {
    if (!this.doc) return;
    const p = Math.max(0, Math.min(this.doc.pages.length - 1, page));
    this.scroll.scroll_to_item(p, "top");
    this.shownPage = p;
  }

  setZoom(z) {
    const page = this.shownPage;
    this.zoom = z;
    this.restorePage = page;
  }

  zoomBy(dir) {
    const cur = this.zoomLevel();
    const next = dir > 0
      ? ZOOMS.find((z) => z > cur + 0.01) ?? ZOOMS[ZOOMS.length - 1]
      : [...ZOOMS].reverse().find((z) => z < cur - 0.01) ?? ZOOMS[0];
    this.setZoom(next);
  }

  // Close this viewer and put back the terminal it took the place of.
  restoreTerminal() {
    const id = props()?.id;
    if (id) exec("python3", [PLACE(), "--restore", String(id)]).catch(() => {});
  }

  // This viewer's pane id. A pane mod isn't told it, but place.py records it in
  // state.json under the viewer's id. Without it, the only viewer in the
  // focused tab counts as this one.
  myPane(cx) {
    if (this.pane) return this.pane;
    const id = props()?.id;
    if (id && this.lookup === undefined) {
      this.lookup = "pending";   // asked once: state.json is written before the viewer starts
      cx.spawn(async () => {
        try {
          const st = JSON.parse((await readTextFile(`${appHome()}/${CACHE}/state.json`)) ?? "{}");
          this.pane = st.viewers?.[id]?.pane ?? null;
        } catch { /* unreadable: use the fallback below */ }
        this.lookup = "done";
      });
    }
    if (id && this.lookup === "pending") return null;
    const tab = focused()?.tab;
    const mine = panes().filter((p) => p.mod === "viewer" && p.tab === tab);
    return mine.length === 1 ? mine[0].pane : null;
  }

  // Herdr focuses the pane on the first click but the mod only hears the
  // second; take the keyboard as soon as Herdr says this pane has focus.
  syncFocus(cx) {
    const pane = focused()?.pane;
    if (pane && pane === this.myPane(cx) && !this.handle.is_focused()) this.handle.focus();
  }

  // Ctrl-Q. The key only reaches the viewer while it has the
  // keyboard, so the focused pane is this one. Closing it runs close(), which
  // gives back a parked terminal.
  closePane() {
    const pane = focused()?.pane;
    if (pane && panes().some((p) => p.pane === pane && p.mod === "viewer")) run("pane.close", { pane });
  }

  // Through router.py: with Cmd-click support installed, plain `open` would hand
  // the file to the router, which sends it straight back here.
  openExternally() {
    if (this.file) exec("python3", [ROUTER(), "open", "--front", "", this.file]).catch(() => {});
  }

  pickFile(cx) {
    cx.spawn(async (cx) => {
      const r = await exec("osascript", ["-e", 'POSIX path of (choose file with prompt "Open a document" ' +
        'of type {"com.adobe.pdf", "net.daringfireball.markdown", "public.image"})']).catch(() => null);
      const path = r?.code === 0 ? r.stdout.trim() : "";
      if (path) this.open(path, cx);
      cx.notify();
    });
  }

  command(c, cx) {
    // Pages are a PDF's, zoom a PDF's or an image's; a Markdown view scrolls by itself.
    const any = ["focus", "reload", "external", "pick", "close"];
    const zoom = ["zoom_in", "zoom_out", "fit", "actual"];
    if (this.doc?.blocks && !any.includes(c)) return;
    if (this.doc?.asset && !any.includes(c) && !zoom.includes(c)) return;
    switch (c) {
      case "focus": this.handle.focus(); break;
      case "next": this.goTo(this.shownPage + 1); break;
      case "prev": this.goTo(this.shownPage - 1); break;
      case "first": this.goTo(0); break;
      case "last": this.goTo(Infinity); break;
      case "zoom_in": this.zoomBy(1); break;
      case "zoom_out": this.zoomBy(-1); break;
      case "fit": this.setZoom("fit"); break;
      case "actual": this.setZoom(1); break;
      case "reload": if (this.file) this.open(this.file, cx); break;
      case "external": this.openExternally(); break;
      case "pick": this.pickFile(cx); break;
      case "close": this.closePane(); break;
    }
  }

  key(e, cx) {
    const map = {
      "j": "next", "n": "next", "pagedown": "next", "space": "next", "right": "next", "down": "next",
      "k": "prev", "p": "prev", "pageup": "prev", "shift-space": "prev", "left": "prev", "up": "prev",
      "g": "first", "home": "first", "shift-g": "last", "end": "last",
      "+": "zoom_in", "=": "zoom_in", "cmd-=": "zoom_in", "shift-=": "zoom_in",
      "-": "zoom_out", "cmd--": "zoom_out",
      "0": "fit", "cmd-0": "fit", "1": "actual",
      "r": "reload", "o": "external", "cmd-o": "pick", "ctrl-q": "close",
    };
    const c = map[e.keystroke] ?? map[e.key_char];
    if (!c) return;
    this.command(c, cx);
    cx.stop_propagation?.();
    cx.notify();
  }

  // ---- UI ------------------------------------------------------------------

  button(id, label, onClick, t, opts = {}) {
    return div().id(id).h(22)
      .when(!!opts.wide, (el) => el.px(8))
      .when(!opts.wide, (el) => el.w(24))
      .flex().items_center().justify_center().rounded(5).cursor_pointer()
      .text_color(t.muted).text_size(12)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { onClick(cx); cx.notify(); })
      .child(label);
  }

  toolbar(t) {
    const doc = this.doc;
    const name = this.file ? basename(this.file) : "Viewer";
    const bar = h_flex().h(TOOLBAR).flex_none().px(8).gap(4).items_center()
      .bg(t.chrome).border_b(1).border_color(t.border).text_size(12)
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).font_semibold()
        .child(doc?.title ? `${doc.title} · ${name}` : name));
    if (!doc) return bar.child(this.button("pick", "Open…", (cx) => this.pickFile(cx), t, { wide: true }));
    const tail = (el) => el
      .child(this.button("external", "↗", () => this.openExternally(), t))
      .when(!!props()?.parked && !!props()?.id, (el) => el
        .child(div().w(1).h(16).mx(4).bg(t.border))
        .child(this.button("restore", "↩ Terminal", () => this.restoreTerminal(), t, { wide: true })));
    const zoomControls = (el) => el
      .child(this.button("zoom-out", "−", () => this.zoomBy(-1), t))
      .child(div().text_color(t.muted).min_w(42).text_center().child(`${this.zoomPercent()}%`))
      .child(this.button("zoom-in", "+", () => this.zoomBy(1), t))
      .child(this.button("fit", "Fit", () => this.setZoom("fit"), t, { wide: true }))
      .child(div().w(1).h(16).mx(4).bg(t.border));
    if (doc.asset) {
      return tail(zoomControls(bar.child(div().text_color(t.dim).mr(4)
        .child(`${Math.round(doc.asset.w)} × ${Math.round(doc.asset.h)}`))));
    }
    if (!doc.pages) return tail(bar);
    return tail(zoomControls(bar
      .child(this.button("prev", "‹", () => this.goTo(this.shownPage - 1), t))
      .child(div().text_color(t.muted).min_w(56).text_center()
        .child(`${this.shownPage + 1} / ${doc.pages.length}`))
      .child(this.button("next", "›", () => this.goTo(this.shownPage + 1), t))
      .child(div().w(1).h(16).mx(4).bg(t.border))));
  }

  // ---- Markdown blocks -----------------------------------------------------

  // Editors for code blocks now; diagrams and images one by one in the background.
  prepareBlocks(doc, gen, cx) {
    for (const b of doc.blocks) if (b.type === "code") b.state = this.codeEditor(b);
    cx.spawn(async (cx) => {
      await fs.mkdir(`${appHome()}/${ASSETS}`, { recursive: true });
      for (const b of doc.blocks) {
        if (gen !== this.generation) return;
        if (b.type !== "mermaid" && b.type !== "image") continue;
        try {
          b.asset = b.type === "mermaid" ? await this.mermaid(b.code) : await this.picture(b.src, doc.file);
        } catch (e) {
          b.error = String(e?.message ?? e).trim().split("\n").pop();
        }
        cx.notify();
      }
    });
  }

  codeEditor(b) {
    const t = theme();
    return EditorState.new({ language: editorLanguage(b.lang), value: b.code.replace(/\n$/, ""),
      readonly: true, line_numbers: false, folding: false,
      font_family: settings().font_family, font_size: 13,
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
  }

  // The Editor scrolls itself (past its last line too) and keeps the wheel, so
  // a block can scroll its code out of sight. A fresh editor puts it back once
  // the wheel stops. The page still doesn't scroll while the pointer is over a
  // code block: gpui-kit has no option to turn the Editor's scrolling off.
  snapBack(b, cx) {
    const n = (b.wheel = (b.wheel ?? 0) + 1);
    cx.timer.after(400, (cx) => {
      if (b.wheel !== n || !b.state) return;
      b.state.release();
      b.state = this.codeEditor(b);
      cx.notify();
    });
  }

  // A diagram as an SVG, rendered once per source and theme. Labels must be SVG
  // text: gpui's SVG renderer doesn't draw the HTML (<foreignObject>) mmdc uses by default.
  async mermaid(code) {
    const dark = !!settings().dark;
    const config = `${appHome()}/${ASSETS}/mermaid.json`;
    if (!(await fs.exists(config))) {
      await fs.writeFile(config, JSON.stringify({ htmlLabels: false, flowchart: { htmlLabels: false } }));
    }
    const rel = `${ASSETS}/${createHash("sha1").update(`svg-labels\0${dark}\0${code}`).digest("hex").slice(0, 16)}.svg`;
    const abs = `${appHome()}/${rel}`;
    if (!(await fs.exists(abs))) {
      const tmp = `${abs}.${Date.now()}`;
      await fs.writeFile(`${tmp}.mmd`, code);
      const r = await exec("mmdc", ["-q", "-i", `${tmp}.mmd`, "-o", `${tmp}.svg`,
        "-t", dark ? "dark" : "default", "-b", "transparent", "-c", config]);
      await fs.unlink(`${tmp}.mmd`).catch(() => {});
      if (r.code !== 0) throw new Error(r.stderr || "mmdc failed");
      const mv = await exec("mv", ["-f", `${tmp}.svg`, abs]);
      if (mv.code !== 0) throw new Error(mv.stderr);
    } else {
      await exec("touch", [abs]).catch(() => {});   // in use: keep it from prune()
    }
    const size = svgSize((await readTextFile(abs)) ?? "");
    if (!size) throw new Error("The diagram has no size");
    return { path: rel, ...size };
  }

  // A local image, copied under the app home (image() only reads from there).
  async picture(src, file) {
    const { kind, target } = resolveLink(src, file);
    if (kind === "web") throw new Error(`Remote image not shown: ${src}`);
    const st = await exec("stat", ["-f", "%m %z", target]);
    if (st.code !== 0) throw new Error(`Image not found: ${src}`);
    const ext = (target.match(/\.(\w+)$/)?.[1] ?? "img").toLowerCase();
    await fs.mkdir(`${appHome()}/${ASSETS}`, { recursive: true });
    const rel = `${ASSETS}/${createHash("sha1").update(`${target}\0${st.stdout.trim()}`).digest("hex").slice(0, 16)}.${ext}`;
    const abs = `${appHome()}/${rel}`;
    if (!(await fs.exists(abs))) {
      const cp = await exec("cp", [target, abs]);
      if (cp.code !== 0) throw new Error(cp.stderr);
    } else {
      await exec("touch", [abs]).catch(() => {});   // in use: keep it from prune()
    }
    if (ext === "svg") {
      const size = svgSize((await readTextFile(abs)) ?? "");
      if (!size) throw new Error(`SVG without a size: ${src}`);
      return { path: rel, ...size };
    }
    const r = await exec("sips", ["-g", "pixelWidth", "-g", "pixelHeight", abs]);
    const w = +r.stdout.match(/pixelWidth:\s*(\d+)/)?.[1], h = +r.stdout.match(/pixelHeight:\s*(\d+)/)?.[1];
    if (!w || !h) throw new Error(`Not an image: ${src}`);
    return { path: rel, w, h };
  }

  copyCode(text, i, cx) {
    try {
      cx.write_to_clipboard(text);
    } catch {
      exec("sh", ["-c", 'printf %s "$1" | pbcopy', "sh", text]).catch(() => {});
    }
    this.copied = i;
    cx.timer.after(1500, (cx) => { if (this.copied === i) { this.copied = null; cx.notify(); } });
  }

  // A clicked link: Markdown, PDFs and images open here, the web in the browser.
  // Any other file is only shown in Finder: opening it could run it (an .app, a
  // .command), and a document may come from anywhere. Handling the click
  // ourselves turns off TextView's own #anchor jumps.
  followLink(url, cx) {
    const { kind, target } = resolveLink(url, this.doc.file);
    if (kind === "doc") this.open(target, cx);
    else if (kind === "web") exec("open", [target]).catch(() => {});
    else if (kind === "file") exec("open", ["-R", target]).catch(() => {});
  }

  block(b, i, t, inner) {
    if (b.type === "md") {
      return TextView.markdown(`md-${i}`, b.text).selectable(true)
        .on_link_click((url, cx) => { this.followLink(url, cx); cx.notify(); })
        .w_full().text_color(t.foreground).text_size(14);
    }
    if (b.type === "code") {
      const lines = b.code.replace(/\n$/, "").split("\n").length;
      return v_flex().w_full().flex_none().rounded(6).border(1).border_color(t.border).bg(t.surface).overflow_hidden()
        .child(h_flex().h(26).px(10).items_center().justify_between().border_b(1).border_color(t.border)
          .text_size(11).text_color(t.dim)
          .child(div().child(b.lang || "text"))
          .child(div().id(`copy-${i}`).px(6).rounded(4).cursor_pointer()
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { this.copyCode(b.code.replace(/\n$/, ""), i, cx); cx.notify(); })
            .child(this.copied === i ? "Copied" : "Copy")))
        .child(div().id(`code-${i}`).w_full().on_scroll_wheel((_e, cx) => this.snapBack(b, cx))
          .child(Editor.new(b.state).w_full().h(lines * CODE_LINE + 12).px(6).py(6)));
    }
    // A diagram or an image: drawn at its own size, shrunk to fit the column.
    const a = b.asset;
    if (!a) {
      return div().w_full().h(48).flex_none().flex().items_center().justify_center().rounded(6)
        .border(1).border_color(t.border).text_size(12).text_color(t.dim)
        .child(b.error ?? (b.type === "mermaid" ? "Rendering diagram…" : `Loading ${b.alt || "image"}…`));
    }
    const k = Math.min(1, inner / a.w);
    return h_flex().w_full().flex_none().justify_center()
      .child(image(a.path).w(Math.round(a.w * k)).h(Math.round(a.h * k)));
  }

  markdown(t) {
    const col = Math.min(MD_WIDTH, this.width || MD_WIDTH);
    const inner = col - 64;
    return div().relative().flex_1().min_h(0).bg(t.canvas)
      .child(v_flex().id("md-scroll").size_full().overflow_y_scroll().items_center()
        .child(v_flex().w(col).flex_none().px(32).py(24).gap(14).bg(t.background)
          .children(this.doc.blocks.map((b, i) => this.block(b, i, t, inner)))))
      .child(Scrollbar.vertical("md-scroll").absolute().inset_0());
  }

  pageView(i, s, dpi, t) {
    const p = this.doc.pages[i];
    const w = Math.round(p.w * s), h = Math.round(p.h * s);
    const src = this.ready.get(`${i}@${dpi}`) ?? this.latest.get(i);
    const failed = this.failed.has(`${i}@${dpi}`);
    const sheet = div().w(w).h(h).flex_none().bg("#ffffff").shadow_md().overflow_hidden()
      .when(!!src, (el) => el.child(image(src).w(w).h(h)))
      .when(!src, (el) => el.flex().items_center().justify_center().text_size(12).text_color("#8a8a8a")
        .child(failed ? `Page ${i + 1} could not be rendered` : `Page ${i + 1}`));
    return h_flex().w_full().h(h + GAP).flex_none().justify_center().items_start().child(sheet);
  }

  pages(t) {
    const doc = this.doc;
    const s = this.scale();
    const dpi = this.dpi();
    const heights = doc.pages.map((p) => Math.round(p.h * s) + GAP);
    const contentW = Math.round(this.maxWidthPt() * s) + PAD * 2;
    const listW = Math.max(this.width, contentW);
    const lst = v_virtual_list("pdf-pages", doc.pages.length, heights, (i) => `p${i}`, (range) => {
      this.visible = range;   // read by pump(); no state changes here
      const out = [];
      for (let i = range.start; i < range.end; i++) out.push(this.pageView(i, s, dpi, t));
      return out;
    }).track_scroll(this.scroll).w(listW).h_full().pt(PAD);

    // Wider than the pane when zoomed in: let the column scroll sideways too.
    const wide = contentW > this.width;
    return div().relative().flex_1().min_h(0).bg(t.canvas)
      .child(wide
        ? div().id("pdf-wide").size_full().overflow_x_scroll().child(lst)
        : lst)
      .child(Scrollbar.vertical("pdf-pages").absolute().inset_0())
      .when(wide, (el) => el.child(Scrollbar.horizontal("pdf-wide").absolute().inset_0()));
  }

  // One image, centered while it fits, scrolling both ways once zoomed past the pane.
  imageView(t) {
    const a = this.doc.asset;
    const k = this.imageScale();
    return div().relative().flex_1().min_h(0).bg(t.canvas)
      .child(div().id("img-scroll").size_full().overflow_scroll()
        .child(h_flex().min_w_full().min_h_full().p(PAD).justify_center().items_center()
          .child(image(a.path).w(Math.round(a.w * k)).h(Math.round(a.h * k)).flex_none())))
      .child(Scrollbar.new("img-scroll").absolute().inset_0());
  }

  empty(t) {
    return v_flex().flex_1().items_center().justify_center().gap(10).bg(t.canvas).text_color(t.muted)
      .child(div().text_size(13).child(this.error ?? (this.file ? "Opening…" : "No document")))
      .when(!this.file || !!this.error, (el) => el.child(
        div().id("pick-empty").px(12).py(6).rounded(6).cursor_pointer().bg(t.solid)
          .text_color(t.solid_foreground).text_size(12)
          .on_click((_e, cx) => this.pickFile(cx))
          .child("Open document…")));
  }

  render(cx) {
    const t = theme();
    return v_flex().id("viewer-root").size_full().bg(t.canvas)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .on_mouse_down("left", () => this.handle.focus())
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.width) >= 1 || Math.abs(size.height - this.height) >= 1) {
          this.width = size.width; this.height = size.height; cx.notify();
        }
      })
      .child(this.toolbar(t))
      .child(this.doc?.blocks ? this.markdown(t)
        : this.doc?.asset && this.width > 0 ? this.imageView(t)
        : this.doc && this.width > 0 ? this.pages(t) : this.empty(t));
  }

  // place.py --closed gives back the terminal this viewer parked, unless the
  // viewer was replaced by another one (which then owns the parked terminal).
  async close() {
    this.scroll?.release();
    const id = props()?.id;
    if (id) await exec("python3", [PLACE(), "--closed", String(id)]).catch(() => {});
  }
}
