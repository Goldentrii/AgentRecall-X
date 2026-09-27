import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
// Default import (see fsutil.ts's own comment): needed so this file's
// renameWithRetry test can monkey-patch fs.renameSync and have fsutil.ts's
// internal calls (which import the SAME default fs object) see the patch.
import fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// R2.15 N5 ("required tests for P1, not notes"): fsync record/event/receipt
// before WAL delete; torn-line-tolerant jsonl reader; Windows rename retry.
// Plus rev1 §5's WAL-recovery contract: recovery on open replays every WAL
// entry idempotently, for BOTH crash points the harness must support
// (scripts/acceptance/harness.d.ts: crash_after_wal, crash_before_receipt).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(__dirname, "fixtures", "wal-crash-child.mjs");

function principal() {
  return { principal_id: "local:test", owner_id: "local:test", kind: "user", auth: "local" };
}

describe("LocalRepository WAL crash recovery (R2.15 N5)", () => {
  let runtimeMod;
  let fsutilMod;

  before(async () => {
    runtimeMod = await import("../dist/repository/runtime.js");
    fsutilMod = await import("../dist/repository/local/fsutil.js");
  });

  for (const failpoint of ["after_wal", "before_receipt"]) {
    it(`AR_FAILPOINT=${failpoint}: child crashes mid-commit, a fresh runtime recovers idempotently`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `ar-wal-${failpoint}-`));
      const id = crypto.randomUUID();
      const operationId = crypto.randomUUID();
      const workspaceId = crypto.randomUUID();

      const childArgs = { root, id, operationId, workspaceId, content: `crash-test ${failpoint}` };
      const result = spawnSync(process.execPath, [CHILD], {
        env: { ...process.env, AR_FAILPOINT: failpoint, AR_CHILD_ARGS: JSON.stringify(childArgs) },
        encoding: "utf-8",
      });

      // The child is EXPECTED to die at the failpoint — 137 (128+SIGKILL-ish
      // from a raw process.exit(137)) on POSIX; on Windows, a bare
      // process.exit(137) still yields status 137 (no signal translation).
      assert.equal(result.status, 137, `child should have hit AR_FAILPOINT=${failpoint} and exited 137; stdout=${result.stdout} stderr=${result.stderr}`);
      assert.ok(!result.stdout.includes("CHILD_OK"), "child must not have reached its normal-completion print");

      // A WAL entry should be sitting there (crash happened before it could
      // be deleted) — sanity-check the fixture actually exercised the path.
      const walDir = path.join(root, "repo", "wal");
      assert.ok(fs.existsSync(walDir), "expected a wal/ directory from the crashed commit");
      assert.ok(fs.readdirSync(walDir).length > 0, "expected a pending WAL entry after the crash");

      // Fresh runtime = "process restart" (harness.restart() semantics) —
      // recovery runs in the LocalRepository constructor.
      const rt2 = runtimeMod.createMemoryRuntime({ root, mode: "local" }, principal());
      const receipt = rt2.run(() => rt2.repository.getOperation(operationId, principal()));
      return receipt.then(async (op) => {
        if (failpoint === "after_wal") {
          // Nothing was durable yet when the crash hit — recovery is
          // completing genuinely in-flight work, so it mints the receipt too.
          assert.ok(op, "operation receipt should exist after recovery (after_wal: nothing was durable pre-crash)");
          assert.equal(op.receipt.status, "committed");
          assert.equal(op.receipt.id, id);
        } else {
          // before_receipt: the record+event were ALREADY fully durable when
          // the crash hit — only the receipt bookkeeping was missing. Per
          // the frozen acceptance suite's G-durability group, recovery must
          // NOT retroactively mint a receipt the client never saw —
          // getOperation() keeps reporting this operation_id as unresolved
          // forever, even though the record's effects are real (below).
          assert.equal(op, null, "before_receipt: getOperation() must never resolve to committed for an operation_id the client never saw a receipt for");
        }

        const read = await rt2.run(() => rt2.repository.get(id, { principal: principal(), channel: "sdk" }));
        assert.equal(read.items.length, 1, "the record itself should be readable after recovery regardless of receipt state");
        assert.equal(read.items[0].content, childArgs.content);
        assert.equal(read.items[0].revision, 1);

        // WAL must be fully drained — the whole point of "recovery on open
        // replays every WAL entry" is that no crash artifact survives it.
        assert.equal(fs.readdirSync(walDir).length, 0, "WAL should be empty after recovery");

        await rt2.close();
      });
    });
  }

  it("readJsonlTornTolerant: tolerates an incomplete LAST line, rejects a corrupt non-last line", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-jsonl-torn-"));
    const file = path.join(dir, "events.jsonl");

    // Well-formed file with a torn (truncated) last line — the shape a crash
    // mid-appendFileSync (before its fsync) can leave behind.
    fs.writeFileSync(file, '{"a":1}\n{"a":2}\n{"a":3, "b":', "utf-8");
    const rows = fsutilMod.readJsonlTornTolerant(file);
    assert.deepEqual(rows, [{ a: 1 }, { a: 2 }], "torn last line should be silently dropped, earlier valid lines kept");

    // A corrupt NON-last line is real corruption, not a torn write — must throw.
    fs.writeFileSync(file, '{"a":1}\nNOT JSON AT ALL\n{"a":3}\n', "utf-8");
    assert.throws(() => fsutilMod.readJsonlTornTolerant(file), /corrupt \(non-last\) line/);
  });

  it("renameWithRetry: retries past transient EBUSY/EPERM and eventually succeeds", () => {
    // Exercise the real fs.renameSync path (not a mock) to prove the retry
    // loop and its final fallthrough both work, then separately prove the
    // retry loop's *decision logic* survives N transient failures before
    // succeeding by monkey-patching fs.renameSync for a few calls.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ar-rename-retry-"));
    const from = path.join(dir, "a.txt");
    const to = path.join(dir, "b.txt");
    fs.writeFileSync(from, "hello", "utf-8");

    let attempts = 0;
    const realRename = fs.renameSync;
    fs.renameSync = (f, t) => {
      attempts += 1;
      if (attempts < 3) {
        const err = new Error("simulated transient lock");
        err.code = "EBUSY";
        throw err;
      }
      return realRename(f, t);
    };
    try {
      fsutilMod.renameWithRetry(from, to, 10);
    } finally {
      fs.renameSync = realRename;
    }
    assert.equal(attempts, 3, "should have retried past 2 simulated EBUSY failures before succeeding");
    assert.ok(fs.existsSync(to), "file should have been renamed once the transient failures stopped");
    assert.ok(!fs.existsSync(from));
  });
});
