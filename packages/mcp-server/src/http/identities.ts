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

/** `gh-`/`gg-` uids belong to exactly one federated account. */
export const RESERVED_UID_RE = /^g[hg]-/;

/** A stored link the server refuses to follow (operator must fix it; retrying cannot help). */
export class IdentityLinkError extends Error {}

/** The tenant an account gets when it is not linked elsewhere: `gh-<id>` / `gg-<sub>`. */
export function defaultUid(provider: ProviderName, subject: string | number): string {
  return `${UID_PREFIX[provider]}${assertSubject(provider, subject)}`;
}

/**
 * Link (and so, in invite mode, invite) an account. `uid` omitted → the account's own
 * `gh-<id>` / `gg-<sub>`. A reserved `gh-`/`gg-` uid can only be the account's own: linking
 * GitHub 5 onto `gh-9` would hand GitHub user 9's memory to user 5.
 */
export function linkIdentity(dataDir: string, provider: ProviderName, subject: string | number, uid?: string): string {
  const id = assertSubject(provider, subject);
  const own = defaultUid(provider, id);
  const target = uid ?? own;
  validateUid(target);
  if (RESERVED_UID_RE.test(target) && target !== own) {
    throw new Error(`uid "${target}" belongs to another ${target.startsWith("gh-") ? "GitHub" : "Google"} account; link ${provider} ${id} to "${own}" or to a plain uid`);
  }
  const file = readJsonFresh(filePath(dataDir), parse, empty);
  file.links[`${provider}:${id}`] = target;
  writeJsonAtomic(filePath(dataDir), file);
  return target;
}

/** Remove an account's link (in invite mode: un-invite it). Returns the uid it pointed to, or null if there was none. */
export function unlinkIdentity(dataDir: string, provider: ProviderName, subject: string | number): string | null {
  const id = assertSubject(provider, subject);
  const file = readJsonFresh(filePath(dataDir), parse, empty);
  const key = `${provider}:${id}`;
  const uid = file.links[key];
  if (typeof uid !== "string") return null;
  delete file.links[key];
  writeJsonAtomic(filePath(dataDir), file);
  return uid;
}

export function listIdentities(dataDir: string): Array<{ provider: string; subject: string; uid: string }> {
  const file = readJsonFresh(filePath(dataDir), parse, empty);
  return Object.entries(file.links).map(([k, uid]) => {
    const [provider, ...rest] = k.split(":");
    return { provider, subject: rest.join(":"), uid };
  });
}

/** uid for a federated account (operator link, else `gh-<id>` / `gg-<sub>`, always validated), and whether the operator linked it. */
export function resolveIdentity(dataDir: string, provider: ProviderName, subject: string | number): { uid: string; linked: boolean } {
  const id = assertSubject(provider, subject);
  const linked = readJsonCached(filePath(dataDir), parse, empty).links[`${provider}:${id}`];
  if (typeof linked === "string") {
    // A hand-edited or pre-rule link onto someone else's gh-/gg- uid is refused, never followed.
    if (RESERVED_UID_RE.test(linked) && linked !== defaultUid(provider, id)) throw new IdentityLinkError(`identity ${provider}:${id} is linked to reserved uid "${linked}"`);
    return { uid: validateUid(linked), linked: true };
  }
  return { uid: validateUid(defaultUid(provider, id)), linked: false };
}

export function resolveUid(dataDir: string, provider: ProviderName, subject: string | number): string {
  return resolveIdentity(dataDir, provider, subject).uid;
}
