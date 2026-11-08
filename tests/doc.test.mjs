// node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { isMarkdown, stripFrontMatter, labelAlerts, splitMarkdown, svgSize, editorLanguage, markdownTitle, resolveLink }
  from "../mods/pdf-viewer/doc.js";

test("markdown extensions", () => {
  assert.ok(isMarkdown("/a/README.md") && isMarkdown("x.MARKDOWN"));
  assert.ok(!isMarkdown("/a/b.pdf") && !isMarkdown("/a/md"));
});

test("front matter is left out, YAML or TOML, only at the top", () => {
  assert.equal(stripFrontMatter("---\ntitle: A\n---\n# Hi\n"), "# Hi\n");
  assert.equal(stripFrontMatter("+++\ntitle = 'A'\n+++\nBody"), "Body");
  assert.equal(stripFrontMatter("# Hi\n\n---\nnot: front\n---\n"), "# Hi\n\n---\nnot: front\n---\n");
});

test("title is the first # heading", () => {
  assert.equal(markdownTitle("intro\n## Sub\n# Main Title ##\n"), "Main Title");
  assert.equal(markdownTitle("no heading"), "");
});

test("links resolve from the file's folder", () => {
  const f = "/repo/docs/guide.md";
  assert.deepEqual(resolveLink("../README.md#usage", f), { kind: "doc", target: "/repo/README.md" });
  assert.deepEqual(resolveLink("spec%20v2.pdf", f), { kind: "doc", target: "/repo/docs/spec v2.pdf" });
  assert.deepEqual(resolveLink("./img/a.png", f), { kind: "file", target: "/repo/docs/img/a.png" });
  assert.deepEqual(resolveLink("file:///tmp/x.md", f), { kind: "doc", target: "/tmp/x.md" });
  assert.deepEqual(resolveLink("https://herdr.dev", f), { kind: "web", target: "https://herdr.dev" });
  assert.deepEqual(resolveLink("#usage", f), { kind: "anchor", target: "#usage" });
});

test("GitHub alerts become a bold label", () => {
  assert.equal(labelAlerts("> [!IMPORTANT]\n> Read this.\n"), "> **Important**\n>\n> Read this.\n");
  assert.equal(labelAlerts("> not [!NOTE] an alert\n"), "> not [!NOTE] an alert\n");
});

test("the document splits into text, code, diagrams and images", () => {
  const doc = "---\nt: 1\n---\n# T\n\n```rust\nfn a() {}\n\n```\n\n![shot](docs/a.png)\n\ntext ![x](i.png) here\n\n~~~mermaid\ngraph TD; A-->B\n~~~\n";
  assert.deepEqual(splitMarkdown(doc).map((b) => b.type), ["md", "code", "image", "md", "mermaid"]);
  const [, code, img, , mer] = splitMarkdown(doc);
  assert.deepEqual(code, { type: "code", lang: "rust", code: "fn a() {}\n" });
  assert.deepEqual(img, { type: "image", alt: "shot", src: "docs/a.png" });
  assert.equal(mer.code, "graph TD; A-->B");
});

test("alerts inside code are left alone, and an unclosed fence runs to the end", () => {
  const blocks = splitMarkdown("```md\n> [!NOTE]\n");
  assert.deepEqual(blocks, [{ type: "code", lang: "md", code: "> [!NOTE]\n" }]);
});

test("fence names map to the editor's languages", () => {
  assert.equal(editorLanguage("Rust"), "rs");
  assert.equal(editorLanguage("bash"), "sh");
  assert.equal(editorLanguage("json"), "json");
});

test("svg size comes from the viewBox, else width and height", () => {
  assert.deepEqual(svgSize('<svg width="100%" viewBox="0 0 300 120"><g/></svg>'), { w: 300, h: 120 });
  assert.deepEqual(svgSize('<?xml?><svg width="40px" height="20"><g/></svg>'), { w: 40, h: 20 });
  assert.equal(svgSize("<svg><g/></svg>"), null);
});
