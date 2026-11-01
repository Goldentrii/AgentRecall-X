import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "cards-at-cap-fixture.mjs");
const SENTINEL = ".cards-at-cap-fixture";
const made = [];
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

/** Spawns the script isolated from the owner's real store (no AGENT_RECALL_ROOT, throwaway HOME). */
function run(...args) {
  const home = tmp("cards-at-cap-home-");
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.AGENT_RECALL_ROOT;
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: "utf-8", timeout: 170_000 });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
const listing = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).sort();

describe("cards-at-cap-fixture", () => {
  it("refuses a non-empty directory it did not create: exit 2, nothing touched", () => {
    const dir = tmp("cards-at-cap-foreign-");
    fs.writeFileSync(path.join(dir, "precious.txt"), "do not delete");
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "sub", "nested.txt"), "nested");
    const before = listing(dir);
    const r = run(dir);
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /refusing/i);
    assert.deepEqual(listing(dir), before);
    assert.equal(fs.readFileSync(path.join(dir, "precious.txt"), "utf-8"), "do not delete");
  });

  it("refuses a path that is a regular file", () => {
    const file = path.join(tmp("cards-at-cap-file-"), "plain.txt");
    fs.writeFileSync(file, "keep");
    const r = run(file);
    assert.equal(r.code, 2, r.stderr);
    assert.equal(fs.readFileSync(file, "utf-8"), "keep");
  });

  it("a new or empty directory is populated and stamped with the sentinel; a stamped directory is regenerated", () => {
    const parent = tmp("cards-at-cap-parent-"), fresh = path.join(parent, "fresh");
    const first = run(fresh);
    assert.equal(first.code, 0, first.stderr);
    assert.ok(fs.existsSync(path.join(fresh, SENTINEL)), "sentinel written on success");
    assert.ok(fs.existsSync(path.join(fresh, "identity-card.md")), "identity card seeded");
    assert.ok(fs.readdirSync(path.join(fresh, "projects")).length > 0, "projects copied");
    const empty = path.join(parent, "empty");
    fs.mkdirSync(empty);
    assert.equal(run(empty).code, 0);
    assert.ok(fs.existsSync(path.join(empty, SENTINEL)));
    // regenerate: stale content inside a stamped directory is replaced, the sentinel survives
    fs.writeFileSync(path.join(fresh, "stale.txt"), "left over from an earlier run");
    const again = run(fresh);
    assert.equal(again.code, 0, again.stderr);
    assert.ok(!fs.existsSync(path.join(fresh, "stale.txt")), "stale file removed");
    assert.ok(fs.existsSync(path.join(fresh, SENTINEL)) && fs.existsSync(path.join(fresh, "identity-card.md")));
  });

  it("no argument: a mkdtemp directory under the OS temp dir is created, populated and its path printed", () => {
    const r = run();
    assert.equal(r.code, 0, r.stderr);
    const printed = /cards-at-cap fixture written: (.+)/.exec(r.stdout)?.[1]?.trim();
    assert.ok(printed, r.stdout);
    assert.ok(path.basename(printed).startsWith("cards-at-cap-") && path.dirname(path.resolve(printed)) === path.resolve(os.tmpdir()), printed);
    made.push(printed); // registered for cleanup only after it is proven to be a cards-at-cap-* dir directly under the temp dir
    assert.ok(fs.existsSync(path.join(printed, SENTINEL)) && fs.existsSync(path.join(printed, "identity-card.md")));
    assert.ok(fs.readdirSync(path.join(printed, "projects")).length > 0);
  });
});
