// Child process used by repo-local-wal-recovery.test.mjs to exercise
// AR_FAILPOINT crash points inside LocalRepository.commitRecord(). Reads its
// work order from AR_CHILD_ARGS (JSON: {root, id, operationId, content}),
// performs exactly one create mutate() call, and (if AR_FAILPOINT is unset)
// exits 0 normally. When AR_FAILPOINT is "after_wal" or "before_receipt",
// commitRecord() itself calls process.exit(137) at the matching point —
// this script never gets to report success in that case, which is the point.
import { createMemoryRuntime } from "../../dist/repository/runtime.js";

const args = JSON.parse(process.env.AR_CHILD_ARGS);
const principal = { principal_id: "local:test", owner_id: "local:test", kind: "user", auth: "local" };
const rt = createMemoryRuntime({ root: args.root, mode: "local" }, principal);

await rt.run(async () => {
  await rt.repository.mutate(
    {
      op: "create", id: args.id, workspace_id: args.workspaceId, project_id: null,
      kind: "fact", visibility: "private", content: args.content, authority: "agent_inference",
    },
    null, args.operationId, { principal, channel: "sdk" },
  );
});

process.stdout.write("CHILD_OK\n");
process.exit(0);
