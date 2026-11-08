// pdf-links: a popup listing the PDF files mentioned in the focused terminal
// (Claude Code's output, a build log, `ls`), newest mention first. Enter or a
// click opens the chosen one in a pdf-viewer pane beside that terminal.
//
// Herdr hands clicked terminal links straight to the system, so this is how a
// PDF link from an agent reaches the viewer. Bound to a key in keys.json:
//   "cmd-shift-o": "mod.open:pdf-links"

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, hc, theme, home, appHome, props, focused, closeOverlay, notify } from "herdr";

const HISTORY = 2000;   // lines of scrollback to search
const MAX = 40;         // candidates checked against the disk

// A path ending in .pdf. Agents hard-wrap long paths, so a newline plus the
// next line's indentation may sit inside one; those are removed afterwards.
const PDF_RE = /(?<![\w.~\/-])(?:file:\/\/)?(?:~|\.{1,2})?\/?(?:[\w.@%+~,=-]|\/|\n[ \t ⎿│]*(?=[\w.@%+~,=\/-]))+?\.pdf\b/gi;
const BREAK = /\n[ \t ⎿│]*/;

function normalize(p, cwd) {
  if (/^file:\/\//i.test(p)) {
    try { p = decodeURIComponent(p.replace(/^file:\/\/(localhost)?/i, "")); } catch { return null; }
  }
  if (p.startsWith("~/")) return home() + p.slice(1);
  if (p.startsWith("/")) return p;
  return cwd ? `${cwd}/${p}`.replace(/\/\.\//g, "/") : null;
}

// Every path the text may mean, last mention first. A match that crosses line
// breaks may be one wrapped path or prose glued to a path, so the whole join
// and each tail after a break are all offered; the disk check picks the real one.
function candidates(text, cwd) {
  const seen = new Set();
  const out = [];
  const found = [...text.matchAll(PDF_RE)].reverse();
  for (const m of found) {
    const parts = m[0].split(BREAK);
    for (let i = 0; i < parts.length; i++) {
      const p = normalize(parts.slice(i).join(""), cwd);
      if (p && !seen.has(p)) { seen.add(p); out.push(p); }
    }
    if (out.length >= MAX) break;
  }
  return out.slice(0, MAX);
}

export default class PdfLinks extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(300, () => this.handle.focus());
    this.at = 0;
    this.files = null;
    this.error = null;

    const f = focused();
    this.terminal = f?.terminal ?? null;
    this.pane = f?.pane ?? null;
    this.cwd = f?.cwd ?? null;

    cx.spawn(async (cx) => {
      try {
        if (!this.terminal) throw new Error("Focus a terminal first");
        const r = await hc(["read", this.terminal, "--lines", String(HISTORY), "--json"]);
        if (r.code !== 0) throw new Error(r.stderr.trim() || "Cannot read the terminal");
        const list = candidates(JSON.parse(r.stdout).text ?? "", this.cwd);
        // Keep only files that exist, in one shell call.
        const ok = list.length
          ? await exec("sh", ["-c", 'for f; do [ -f "$f" ] && printf "%s\\n" "$f"; done', "sh", ...list])
          : { stdout: "" };
        const real = new Set(ok.stdout.split("\n").filter(Boolean));
        this.files = list.filter((p) => real.has(p));
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  close() {
    closeOverlay(props().overlay);
  }

  // The viewer's place.py decides where it goes (beside this terminal, in the
  // place of a viewer or a terminal already on its right). It runs as its own
  // process, so closing the popup right after doesn't cut it short.
  open(file) {
    const args = [`${appHome()}/mods/pdf-viewer/place.py`, file];
    if (this.terminal) args.splice(1, 0, "--from", this.terminal);
    this.close();
    exec("python3", args).then((r) => {
      if (r.code !== 0) notify({ title: "Cannot open PDF", body: r.stderr.trim(), level: "error" });
    }).catch(() => {});
  }

  render(cx) {
    const t = theme();
    const files = this.files ?? [];
    const short = (p) => (p.startsWith(home() + "/") ? "~" + p.slice(home().length) : p);

    const rows = files.map((p, i) => {
      const slash = p.lastIndexOf("/");
      return h_flex().id(`pdf-${i}`).h(38).flex_none().px(10).gap(10).items_center().rounded(6)
        .cursor_pointer()
        .when(i === this.at, (el) => el.bg(t.selected))
        .hover((s) => s.bg(t.hover))
        .on_click(() => this.open(p))
        .child(div().w(16).flex_none().text_size(11).text_color(t.dim).child(i < 9 ? String(i + 1) : ""))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_color(t.foreground).font_semibold().child(p.slice(slash + 1)))
          .child(div().truncate().text_size(11).text_color(t.dim).child(short(p.slice(0, slash)))));
    });

    const message = this.error ?? (this.files === null ? "Looking for PDFs…"
      : files.length ? null : "No PDF files mentioned in this terminal");

    // The popup sizes to its content, so the list needs a height of its own.
    const listH = Math.min(8, files.length) * 40;

    return v_flex().id("pdf-links").track_focus(this.handle).w_full().p(12).gap(8)
      .bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") return this.close();
        if (k === "down" || (k === "n" && e.modifiers.control)) this.at = Math.min(files.length - 1, this.at + 1);
        else if (k === "up" || (k === "p" && e.modifiers.control)) this.at = Math.max(0, this.at - 1);
        else if (k === "enter" && files[this.at]) return this.open(files[this.at]);
        else if (/^[1-9]$/.test(k) && files[+k - 1]) return this.open(files[+k - 1]);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().items_center().justify_between()
        .child(div().font_semibold().text_color(t.foreground).child("Open a PDF from this terminal"))
        .child(div().text_size(11).text_color(t.dim).child("↑↓ Enter · 1–9 · Esc")))
      .child(message
        ? div().h(48).flex_none().flex().items_center().text_color(t.muted).child(message)
        : v_flex().id("pdf-links-list").h(listH).flex_none().overflow_y_scrollbar().children(rows));
  }
}
