// Performs exactly one two-record mutation (supersede, or confirm-of-a-
// -proposal) with AR_FAILPOINT=between_records set, so a crash between the
// two underlying record commits can be reproduced by a REAL process death
// (not simulated in-process).
import { createMemoryRuntime } from "../../dist/repository/runtime.js";
import { mintTrustedUserEvent } from "../../dist/repository/trust.js";

const args = JSON.parse(process.env.AR_CHILD_ARGS);
const rt = createMemoryRuntime({ root: args.root, mode: "local" }, args.principal);
const ctx = {
  principal: args.principal,
  channel: args.channel,
  trusted_user_event: args.trustedInput ? mintTrustedUserEvent(args.trustedInput) : undefined,
};

const receipt = await rt.run(async () => rt.repository.mutate(args.cmd, args.expectedRevision, args.operationId, ctx));

process.stdout.write(`${JSON.stringify({ ok: true, receipt })}\n`);
process.exit(0);
