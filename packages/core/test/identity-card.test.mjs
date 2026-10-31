import { it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { useTempCore, stderrOf } from "./helpers/temp-core.mjs";

const t = useTempCore("ar-identity-"), file = () => path.join(t.root, "identity-card.md");
beforeEach(() => fs.rmSync(file(), { force: true }));
const read = () => stderrOf(() => t.core.readIdentityCard(), "identity-card.md");

it("missing → null; each write bumps version; over-cap and secret bodies rejected; no tmp leftovers", () => {
  const { core } = t;
  assert.equal(core.readIdentityCard(), null);
  core.writeIdentityCard("# Owner\n- terse");
  assert.equal(core.writeIdentityCard("keep me").version, 2);
  assert.throws(() => core.writeIdentityCard("x".repeat(1601)), (e) => e.code === "too_long" && /1600/.test(e.message) && /1601/.test(e.message));
  assert.throws(() => core.writeIdentityCard("token " + "gh" + "p_" + "A".repeat(36)), (e) => e.code === "secret" && /GitHub PAT/.test(e.message));
  assert.deepEqual([core.readIdentityCard().body, fs.readdirSync(t.root).filter((f) => f.includes(".tmp."))], ["keep me", []]);
});
it("malformed → v0 + whole file; empty/binary → null; one stderr line each", async () => {
  fs.writeFileSync(file(), "---\nkind: nope\n---\nhello");
  assert.deepEqual(await read(), [{ version: 0, updated: "", body: "---\nkind: nope\n---\nhello" }, 1]);
  for (const c of ["", Buffer.from([0, 255])]) { fs.writeFileSync(file(), c); assert.deepEqual(await read(), [null, 1]); }
});
it("a UTF-8 BOM before the frontmatter is tolerated: parsed as a versioned card, not as a malformed body", () => {
  const text = "---\nkind: identity-card\nversion: 7\nupdated: 2026-10-01T00:00:00.000Z\n---\n# Owner\n- terse\n";
  assert.deepEqual(t.core.parseIdentityCard("\uFEFF" + text), t.core.parseIdentityCard(text));
  assert.deepEqual(t.core.parseIdentityCard("\uFEFF" + text), { card: { version: 7, updated: "2026-10-01T00:00:00.000Z", body: "# Owner\n- terse" }, malformed: false });
  fs.writeFileSync(file(), "\uFEFF" + text.replace(/\n/g, "\r\n"));
  assert.deepEqual(t.core.readIdentityCard(), { version: 7, updated: "2026-10-01T00:00:00.000Z", body: "# Owner\n- terse" });
});
it("hand-edited card holding a token: read serves the redacted body and warns once, never echoing the value", async () => {
  const tok = "gh" + "p_" + "A".repeat(36);
  fs.writeFileSync(file(), `---\nkind: identity-card\nversion: 3\nupdated: 2026-10-01T00:00:00.000Z\n---\n# Owner\n- token ${tok} here\n`);
  const [card, allLines, labelLines, leakLines] = await stderrOf(() => t.core.readIdentityCard(), "", "GitHub PAT", tok);
  assert.ok(!card.body.includes(tok), "the token must not be served");
  assert.match(card.body, /\[REDACTED/, "a redaction marker replaces it");
  assert.equal(card.version, 3);
  assert.equal(allLines, 1, "exactly one stderr line");
  assert.equal(labelLines, 1, "the line names the rule label");
  assert.equal(leakLines, 0, "the line never contains the token");
});
it("personal tier; the sync walker never enumerates it", async () => {
  const { core } = t;
  core.writeIdentityCard("# Owner\n- private");
  await core.journalWrite({ content: "## Brief\nsync walker fixture\n", project: "id-sync" });
  const files = core.gatherProjectBackfillFiles("id-sync");
  assert.ok(core.classifyPath(core.identityCardPath()) === "personal" && files.length > 0 && files.every((f) => !f.path.endsWith("identity-card.md")));
});
