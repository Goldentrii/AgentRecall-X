import { it } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter, normalizeCardText } from "../dist/index.js";

it("parses fields and body; BOM and CRLF tolerated; values keep inner colons; trailing comments dropped", () => {
  const text = "---\nkind: x\nupdated: 2026-10-31T11:02:00.000Z\nversion: 3   # bumped\nurl: https://a/b:c\n---\nbody line\n";
  const fm = parseFrontmatter(text);
  assert.deepEqual([...fm.fields], [["kind", "x"], ["updated", "2026-10-31T11:02:00.000Z"], ["version", "3"], ["url", "https://a/b:c"]]);
  assert.equal(fm.body, "body line\n");
  assert.deepEqual(parseFrontmatter("\uFEFF" + text.replace(/\n/g, "\r\n")), fm);
});
it("null when the text does not open with a frontmatter block; an empty block parses to no fields; EOF close gives an empty body", () => {
  for (const t of ["", "no frontmatter\n---\nkind: x\n---\n", "--- \nkind: x\n---\n", "---\nkind: x\n"]) assert.equal(parseFrontmatter(t), null, JSON.stringify(t));
  assert.deepEqual(parseFrontmatter("---\n\n---\nb"), { fields: new Map(), body: "b" });
  assert.deepEqual(parseFrontmatter("---\nkind: x\n---"), { fields: new Map([["kind", "x"]]), body: "" });
});
it("normalizeCardText strips one leading BOM and turns CRLF into LF, nothing else", () => {
  assert.equal(normalizeCardText("\uFEFFa\r\nb \n"), "a\nb \n");
});
