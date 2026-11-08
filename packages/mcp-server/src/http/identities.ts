/**
 * identities.ts — federated account → AgentRecall uid (tenant).
 *
 * Default uid: `gh-<github id>` / `gg-<google sub>`. An operator can link an account to
 * an existing tenant with `agent-recall-server identity link`. File:
 * <dataDir>/_server/identities.json (keys `github:<id>` / `google:<sub>`), written only by
 * the CLI, read per request (mtime-cached) so a link applies at once.
 */
import * as path from "node:path";
import { readJsonCached, readJsonFresh, writeJsonAtomic } from "./jsonfile.js";
import { validateUid } from "./tokens.js";
import type { ProviderName } from "./oauth-config.js";

interface IdentityFile {
  version: 1;
  links: Record<string, string>;
}

const SUBJECT_RE: Record<ProviderName, RegExp> = { github: /^[1-9]\d{0,15}$/, google: /^\d{1,30}$/ };
const UID_PREFIX: Record<ProviderName, string> = { github: "gh-", google: "gg-" };

function filePath(dataDir: string): string {
  return path.join(dataDir, "_server", "identities.json");
}

function parse(raw: unknown): IdentityFile | null {
  const f = raw as IdentityFile;
  if (f?.version !== 1 || typeof f.links !== "object" || f.links === null || Array.isArray(f.links)) return null;
  return f;
}

const empty = (): IdentityFile => ({ version: 1, links: {} });

export function assertSubject(provider: ProviderName, subject: string | number): string {
  const s = String(subject);
  if (!SUBJECT_RE[provider].test(s)) throw new Error(`invalid ${provider} id "${s}"`);
  return s;
}

export function linkIdentity(dataDir: string, provider: ProviderName, subject: string | number, uid: string): void {
  const id = assertSubject(provider, subject);
  validateUid(uid);
  const file = readJsonFresh(filePath(dataDir), parse, empty);
  file.links[`${provider}:${id}`] = uid;
  writeJsonAtomic(filePath(dataDir), file);
}

export function listIdentities(dataDir: string): Array<{ provider: string; subject: string; uid: string }> {
  const file = readJsonFresh(filePath(dataDir), parse, empty);
  return Object.entries(file.links).map(([k, uid]) => {
    const [provider, ...rest] = k.split(":");
    return { provider, subject: rest.join(":"), uid };
  });
}

/** uid for a federated account: operator link, else `gh-<id>` / `gg-<sub>`. Always validated. */
export function resolveUid(dataDir: string, provider: ProviderName, subject: string | number): string {
  const id = assertSubject(provider, subject);
  const linked = readJsonCached(filePath(dataDir), parse, empty).links[`${provider}:${id}`];
  return validateUid(typeof linked === "string" ? linked : `${UID_PREFIX[provider]}${id}`);
}
