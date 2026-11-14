// Proves a release exe carries no test hooks: none of their variable names and no test credential service,
// in either 8-bit or UTF-16 form (Rust string literals are 8-bit; Windows API strings are UTF-16).
// Usage: node e2e/check-release.mjs <exe> [more exes]

import assert from "node:assert/strict";
import * as fs from "node:fs";

const FORBIDDEN = ["AGENTRECALL_TRAY_TEST", "AgentRecall Tray (test)", "com.agentrecall.tray.test"];

const exes = process.argv.slice(2);
assert.ok(exes.length > 0, "usage: node e2e/check-release.mjs <exe>...");
for (const exe of exes) {
  const bytes = fs.readFileSync(exe);
  for (const text of FORBIDDEN) {
    for (const [form, needle] of [["8-bit", Buffer.from(text, "latin1")], ["UTF-16", Buffer.from(text, "utf16le")]]) {
      assert.equal(bytes.indexOf(needle), -1, `${exe} contains ${form} "${text}"`);
    }
  }
  console.log(`CLEAN ${exe} (${bytes.length} bytes, ${FORBIDDEN.length} names x 2 encodings absent)`);
}
