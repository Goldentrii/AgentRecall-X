// Captures REAL tool output from a local AgentRecall server into test/fixtures/, so the tray's parsers are tested
// against what the server really sends (not against what we think it sends). Local only: 127.0.0.1, throwaway data dir.
//   node e2e/capture-fixtures.mjs        (needs the server built, see README "End-to-end chain test")

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPkg = path.join(here, "..", "..", "..", "packages", "mcp-server");
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const cli = path.join(serverPkg, "dist", "http", "cli.js");
const out = path.join(here, "..", "test", "fixtures");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ar-fixtures-"));
const home = path.join(root, "home");
fs.mkdirSync(home, { recursive: true });
const dataDir = path.join(root, "data");
const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home };

const run = (...args) => {
  const r = spawnSync(process.execPath, [cli, ...args, "--data", dataDir], { env, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`cli ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const text = (r) => (r.content ?? []).map((c) => c.text ?? "").join("\n");
const save = (name, body) => { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, name), body); console.log("wrote", name, body.length, "bytes"); };

const token = run("token", "create", "--uid", "alice").match(/\b(ar_[A-Za-z0-9_-]{43})\b/)[1];
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const proc = spawn(process.execPath, [cli, "serve", "--port", String(port)], { env: { ...env, AR_SERVER_DATA: dataDir, AR_PUBLIC_URL: base, AR_OAUTH_GITHUB_CLIENT_ID: "capture-only", AR_OAUTH_GITHUB_CLIENT_SECRET: "capture-only" }, stdio: ["ignore", "ignore", "pipe"] });
const log = [];
proc.stderr.on("data", (d) => log.push(String(d)));
try {
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start:\n" + log.join(""))), 30_000);
    proc.stderr.on("data", () => log.join("").includes("listening on") && (clearTimeout(t), resolve()));
    proc.on("exit", (c) => reject(new Error(`server exited ${c}:
${log.join("")}`)));
  });
  const client = new Client({ name: "capture", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { Authorization: `Bearer ${token}`, Connection: "close" } } }));
  const call = async (name, args = {}) => text(await client.callTool({ name, arguments: args }));
  const start = () => call("session_start");

  save("session-start-empty.txt", await start());

  const propose = (rule) => call("check", { goal: "record what the owner said", human_correction: { rule, why: "The owner said so in chat.", applies_when: ["deploy"] } });
  await propose("Never deploy on a Friday without asking the owner.");
  save("session-start-pending.txt", await start());

  const waiting = run("corrections", "list", "--uid", "alice");
  const id = waiting.match(/^(.+?)  uid=/m)?.[1];
  if (!id) throw new Error("could not read the proposal id from:\n" + waiting);
  run("corrections", "approve", id, "--uid", "alice");
  save("session-start-rule.txt", await start());

  await call("session_end", {
    summary: "Shipped the harbour ferry timetable page.",
    insights: [{ title: "Ferry times change on bank holidays", evidence: "Checked the operator site.", applies_when: ["ferry"] }],
    trajectory: "Check the bank holiday timetable.",
    state: { goal: "Ship the ferry timetable page", blockers: ["Waiting for the operator holiday list"], next: "Check the bank holiday timetable", open_decisions: ["Show times in 24-hour or 12-hour format"] },
  });
  await propose("Always answer in the language the owner wrote in.");
  save("session-start-full.txt", await start());

  await call("remember", { content: "The harbour ferry leaves at 07:45 on weekdays." });
  save("recall.txt", await call("recall", { query: "harbour ferry" }));
  save("recall-none.txt", await call("recall", { query: "zzzxqj nothing" }));
  await client.close();
} finally {
  proc.removeAllListeners("exit");
  proc.kill();
  fs.rmSync(root, { recursive: true, force: true });
}
