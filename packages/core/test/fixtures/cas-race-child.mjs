// Races against a sibling instance of this same script (a different OS
// process, not a different promise in the same process) to advance a shared
// record's revision via CAS `update`, one revision at a time, until
// `targetRevision` is reached. Reports how many of ITS OWN update attempts
// actually committed ("wins") — used to prove the repo lock serializes
// concurrent PROCESSES, not just concurrent in-process async calls.
import { createMemoryRuntime } from "../../dist/repository/runtime.js";
import * as crypto from "node:crypto";

const [, , root, id, targetRevisionArg, label] = process.argv;
const targetRevision = Number(targetRevisionArg);
const principal = { principal_id: "local:owner", owner_id: "local:owner", kind: "user", auth: "local" };
const rt = createMemoryRuntime({ root, mode: "local" }, principal);
const ctx = { principal, channel: "sdk" };

let wins = 0;
let attempts = 0;

await rt.run(async () => {
  for (;;) {
    const read = await rt.repository.get(id, ctx);
    const current = read.items[0];
    if (!current || current.revision >= targetRevision) break;
    attempts += 1;
    const receipt = await rt.repository.mutate(
      { op: "update", id, patch: { content: `${label}-rev${current.revision + 1}` } },
      current.revision, crypto.randomUUID(), ctx,
    );
    if (receipt.status === "committed") wins += 1;
    // "conflict" (another process/promise won this revision first) -> loop
    // and re-read the now-current revision. Anything else is a real bug.
    else if (receipt.status !== "conflict") {
      throw new Error(`unexpected mutate() status "${receipt.status}": ${JSON.stringify(receipt)}`);
    }
  }
});

await rt.close();
process.stdout.write(`${JSON.stringify({ wins, attempts })}\n`);
process.exit(0);
