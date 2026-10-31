/** Cards v1 (G1) — one session-id resolver for every CLI hook. Core getSessionId() is unchanged. */
import type { Readable } from "node:stream";

const ENV_KEYS = ["CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "SESSION_ID"] as const;
const clean = (v: unknown): string | undefined =>
  typeof v === "number" && Number.isFinite(v) ? String(v) : typeof v === "string" && v.trim() ? v.trim() : undefined;

export function resolveHookSessionId(stdinPayload: Record<string, unknown> | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const v of [stdinPayload?.["session_id"], ...ENV_KEYS.map((k) => env[k])]) {
    const s = clean(v);
    if (s) return s;
  }
  return undefined;
}

export function hookLockKey(sid: string | undefined, now: Date = new Date()): string {
  return sid ?? `nosid-${now.toISOString().slice(0, 13)}`;
}

/** TTY → {} at once; a stream that never ends → {} after timeoutMs (stream destroyed). Invalid/non-object JSON → {}. */
export function readHookStdin(stream: Readable & { isTTY?: boolean } = process.stdin, timeoutMs = 2000): Promise<Record<string, unknown>> {
  if (stream.isTTY) return Promise.resolve({});
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let timer: NodeJS.Timeout | undefined;
    let done = false;
    const onData = (c: Buffer | string) => { chunks.push(typeof c === "string" ? Buffer.from(c, "utf-8") : c); };
    const finish = (timedOut: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.off("data", onData);
      if (timedOut) { try { stream.destroy(); } catch { /* best effort */ } }
      try {
        const v: unknown = JSON.parse(Buffer.concat(chunks).toString("utf-8").trim() || "{}");
        resolve(v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
      } catch { resolve({}); }
    };
    stream.on("data", onData);
    stream.once("end", () => finish(false));
    stream.once("error", () => finish(false));
    timer = setTimeout(() => finish(true), timeoutMs);
  });
}
