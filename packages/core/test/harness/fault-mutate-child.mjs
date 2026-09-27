// Child process spawned by local-harness.mjs's fault-armed mutate() path.
// Performs exactly ONE repository.mutate() call with AR_FAILPOINT set, so
// LocalRepository.commitRecord() self-terminates (process.exit(137)) at the
// requested commit-protocol point instead of the parent test process dying.
import { createMemoryRuntime } from "../../dist/repository/runtime.js";
import { mintTrustedUserEvent } from "../../dist/repository/trust.js";

const args = JSON.parse(process.env.AR_HARNESS_CHILD_ARGS);
const rt = createMemoryRuntime({ root: args.root, mode: "local" }, args.principal);

const ctx = {
  principal: args.principal,
  channel: args.channel,
  session_id: args.sessionId,
  trusted_user_event: args.trustedInput ? mintTrustedUserEvent(args.trustedInput) : undefined,
};

const receipt = await rt.run(async () => rt.repository.mutate(args.cmd, args.expectedRevision, args.operationId, ctx));

// Only reached if AR_FAILPOINT did NOT fire (e.g. armed but the mutate op
// itself was rejected/conflicted before ever reaching a commit point) —
// relay the real receipt back to the parent harness via stdout.
process.stdout.write(`${JSON.stringify({ ok: true, receipt })}\n`);
process.exit(0);
