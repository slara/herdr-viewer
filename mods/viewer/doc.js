// What kind of document a path is, and where a link inside a Markdown file leads.
// No Herdr imports, so tests/ can run it with node.

export const isMarkdown = (path) => /\.(md|markdown|mdown|mkd)$/i.test(path);
export const isPdf = (path) => /\.pdf$/i.test(path);
// The formats image() draws.
export const isImage = (path) => /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(path);

// Front matter (`---` YAML or `+++` TOML at the very top) isn't shown.
export function stripFrontMatter(text) {
  const m = text.match(/^(---|\+\+\+)[ \t]*\r?\n[\s\S]*?\r?\n\1[ \t]*(?:\r?\n|$)/);
  return m ? text.slice(m[0].length) : text;
}

// GitHub alerts (`> [!NOTE]`) as a bold label on its own line, since TextView has no alert style.
export function labelAlerts(text) {
  return text.replace(/^(\s*>\s*)\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*$/gim,
    (_, quote, kind) => `${quote}**${kind[0].toUpperCase()}${kind.slice(1).toLowerCase()}**\n${quote.trimEnd()}`);
}

// Fence names people write, as the language names gpui's Editor knows (file extensions).
const LANG = {
  javascript: "js", typescript: "js", ts: "js", tsx: "js", jsx: "js", mjs: "js",
  rust: "rs", python: "py", shell: "sh", bash: "sh", zsh: "sh", console: "sh", shellsession: "sh",
  yml: "yaml", toml: "yaml", golang: "go", ruby: "rb", markdown: "md", jsonc: "json",
};
export const editorLanguage = (lang) => LANG[lang.toLowerCase()] ?? lang.toLowerCase();

// The document as blocks TextView can't draw on its own, between runs of Markdown:
//   { type: "md", text } | { type: "code", lang, code } | { type: "mermaid", code }
//   | { type: "image", alt, src }
// Images are taken only when alone on their line; inline ones stay in the text.
export function splitMarkdown(text) {
  const blocks = [];
  let md = [];
  const flush = () => {
    if (md.join("").trim()) blocks.push({ type: "md", text: labelAlerts(md.join("\n")) });
    md = [];
  };
  const lines = stripFrontMatter(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const fence = lines[i].match(/^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/);
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
      const code = [];
      while (++i < lines.length && !close.test(lines[i])) code.push(lines[i]);
      flush();
      const lang = fence[2];
      blocks.push(lang.toLowerCase() === "mermaid"
        ? { type: "mermaid", code: code.join("\n") }
        : { type: "code", lang, code: code.join("\n") });
      continue;
    }
    const img = lines[i].match(/^\s*!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)\s*$/);
    if (img) {
      flush();
      blocks.push({ type: "image", alt: img[1], src: img[2] });
      continue;
    }
    md.push(lines[i]);
  }
  flush();
  return blocks;
}

// An SVG's drawn size in px, from its viewBox (else width/height); null if neither.
export function svgSize(svg) {
  const head = svg.slice(0, svg.indexOf(">", svg.indexOf("<svg")) + 1);
  const box = head.match(/viewBox=["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (box) return { w: +box[1], h: +box[2] };
  const w = head.match(/\bwidth=["']([\d.]+)(px)?["']/), h = head.match(/\bheight=["']([\d.]+)(px)?["']/);
  return w && h ? { w: +w[1], h: +h[1] } : null;
}

// The first `# Heading`, for the toolbar.
export function markdownTitle(text) {
  return text.match(/^#[ \t]+(.+?)[ \t#]*$/m)?.[1] ?? "";
}

// A link clicked in `file`: { kind: "web" | "doc" | "file" | "anchor", target }.
// "doc" (Markdown, PDF or an image) opens in the viewer, "file" in its default app,
// "web" in the browser. Relative links start from the file's folder.
export function resolveLink(url, file) {
  if (url.startsWith("#")) return { kind: "anchor", target: url };
  let path;
  if (/^file:\/\//i.test(url)) {
    path = url.replace(/^file:\/\/(localhost)?/i, "");
  } else if (/^[a-z][\w+.-]*:/i.test(url)) {
    return { kind: "web", target: url };
  } else {
    path = url.startsWith("/") ? url : `${file.slice(0, file.lastIndexOf("/"))}/${url}`;
  }
  path = path.replace(/[?#].*$/, "");
  try { path = decodeURIComponent(path); } catch { /* keep it as written */ }
  const parts = [];
  for (const seg of path.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  const target = "/" + parts.join("/");
  return { kind: isMarkdown(target) || isPdf(target) || isImage(target) ? "doc" : "file", target };
}
