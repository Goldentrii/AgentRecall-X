// Holds the repo lock for `holdMs` (simulating a legitimate slow-but-alive
// critical section — NOT a crash), writing a ready-marker the instant it has
// acquired so the parent test can start timing its own acquire attempt only
// once contention is guaranteed to be real.
import * as fs from "node:fs";
import { withRepoLock } from "../../dist/repository/local/lock.js";

const [, , root, readyMarkerPath, holdMsArg] = process.argv;
const holdMs = Number(holdMsArg);

withRepoLock(root, () => {
  fs.writeFileSync(readyMarkerPath, "ready");
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, holdMs);
});

process.exit(0);
