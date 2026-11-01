import { it } from "node:test";
import assert from "node:assert/strict";
import { Readable, PassThrough } from "node:stream";
import { resolveHookSessionId as sid, hookLockKey, readHookStdin as read } from "../dist/index.js";

it("precedence stdin → CLAUDE_CODE_SESSION_ID → CLAUDE_SESSION_ID → SESSION_ID; blanks absent; lock key", () => {
  const env = { CLAUDE_CODE_SESSION_ID: "cc", CLAUDE_SESSION_ID: "cs", SESSION_ID: "s" }, now = new Date("2026-10-31T11:42:00Z");
  assert.deepEqual([sid({ session_id: "in" }, env), sid({ session_id: " " }, env), sid(undefined, { ...env, CLAUDE_CODE_SESSION_ID: "" }), sid({}, { SESSION_ID: "s" }), sid({}, {})], ["in", "cc", "cs", "s", undefined]);
  assert.deepEqual([hookLockKey("abc", now), hookLockKey(undefined, now)], ["abc", "nosid-2026-10-31T11"]);
});
it("readHookStdin: object parsed; empty/invalid/array/TTY/never-ending → {}", async () => {
  assert.deepEqual(await read(Readable.from(['{"session_id":"x"}'])), { session_id: "x" });
  for (const s of [Readable.from([]), Readable.from(["nope"]), Readable.from(["[1]"]), Object.assign(new PassThrough(), { isTTY: true }), new PassThrough()]) assert.deepEqual(await read(s, 50), {});
});
