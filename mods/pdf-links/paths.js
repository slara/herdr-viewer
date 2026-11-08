// PDF paths mentioned in terminal text. No Herdr imports, so tests/ can run it with node.

const MAX = 40;         // candidates checked against the disk

// A path ending in .pdf. Agents hard-wrap long paths, so a newline plus the
// next line's indentation may sit inside one; those are removed afterwards.
const PDF_RE = /(?<![\w.~\/-])(?:file:\/\/)?(?:~|\.{1,2})?\/?(?:[\w.@%+~,=-]|\/|\n[ \t ⎿│]*(?=[\w.@%+~,=\/-]))+?\.pdf\b/gi;
const BREAK = /\n[ \t ⎿│]*/;

function normalize(p, cwd, home) {
  if (/^file:\/\//i.test(p)) {
    try { p = decodeURIComponent(p.replace(/^file:\/\/(localhost)?/i, "")); } catch { return null; }
  }
  if (p.startsWith("~/")) return home + p.slice(1);
  if (p.startsWith("/")) return p;
  return cwd ? `${cwd}/${p}`.replace(/\/\.\//g, "/") : null;
}

// Every path the text may mean, last mention first. A match that crosses line
// breaks may be one wrapped path or prose glued to a path, so the whole join
// and each tail after a break are all offered; the disk check picks the real one.
export function candidates(text, cwd, home) {
  const seen = new Set();
  const out = [];
  const found = [...text.matchAll(PDF_RE)].reverse();
  for (const m of found) {
    const parts = m[0].split(BREAK);
    for (let i = 0; i < parts.length; i++) {
      const p = normalize(parts.slice(i).join(""), cwd, home);
      if (p && !seen.has(p)) { seen.add(p); out.push(p); }
    }
    if (out.length >= MAX) break;
  }
  return out.slice(0, MAX);
}
