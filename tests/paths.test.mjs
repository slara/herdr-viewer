// node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { candidates } from "../mods/pdf-links/paths.js";

const HOME = "/Users/me";
const find = (text) => candidates(text, "/work", HOME);

test("absolute, ~, file:// and relative paths", () => {
  const got = find("see /tmp/a.pdf and ~/b.pdf\nlink file:///tmp/c%20d.pdf, also rel/e.pdf");
  for (const p of ["/tmp/a.pdf", `${HOME}/b.pdf`, "/tmp/c d.pdf", "/work/rel/e.pdf"]) {
    assert.ok(got.includes(p), `${p} in ${JSON.stringify(got)}`);
  }
});

test("newest mention first", () => {
  assert.deepEqual(find("/x/old.pdf then /x/new.pdf").slice(0, 2), ["/x/new.pdf", "/x/old.pdf"]);
});

test("a path an agent wrapped over two lines", () => {
  const got = find("  ⎿  /Users/me/quarterly-report-\n     draft-final.pdf\n");
  assert.ok(got.includes("/Users/me/quarterly-report-draft-final.pdf"), JSON.stringify(got));
});

test("prose glued to a path by a line break still offers the path", () => {
  const got = find("abrí tu\n  ~/spec.pdf ayer");
  assert.ok(got.includes(`${HOME}/spec.pdf`), JSON.stringify(got));
});

test("Markdown files too, but not lookalike extensions", () => {
  const got = find("see docs/guide.md, ~/notes.markdown and app.mdx or x.mdown");
  assert.deepEqual(got, [`${HOME}/notes.markdown`, "/work/docs/guide.md"]);
});

test("no PDFs, no candidates", () => {
  assert.deepEqual(find("nothing here, not even notes.pdfx or a.mdx"), []);
});
