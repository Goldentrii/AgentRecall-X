/**
 * tenant-paths.ts — where a hosted tenant's memory lives, and its owner scope.
 * Shared by serve.ts (MCP), review.ts (the owner's review page) and cli.ts (operator).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { withTenant } from "agent-recall-core";
import { UID_RE } from "./tokens.js";

/** The project slug a hosted tool call uses when the agent passes "auto". */
export const HOSTED_DEFAULT_PROJECT = "main";

export const PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function tenantRoot(dataDir: string, uid: string): string {
  if (!UID_RE.test(uid)) throw new Error("invalid uid");
  const tenantsDir = path.resolve(dataDir, "tenants");
  const root = path.resolve(tenantsDir, uid);
  // Defence in depth: UID_RE already forbids separators and dots.
  if (path.dirname(root) !== tenantsDir) throw new Error("tenant root escapes data dir");
  return root;
}

/** Project slugs that exist on disk for a tenant (none when the tenant has no data yet). */
export function tenantProjects(root: string): string[] {
  const projectsDir = path.join(root, "projects");
  if (!fs.existsSync(projectsDir)) return [];
  return fs.readdirSync(projectsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && PROJECT_RE.test(e.name))
    .map((e) => e.name)
    .sort();
}

/**
 * Run `fn` as the OWNER of tenant `uid`: a tenant scope WITHOUT
 * stageAgentCorrections, which is what lets confirmPendingCorrection activate.
 * Only the operator CLI and the owner's signed-in review page may call this;
 * never an MCP request.
 */
export function asOwner<T>(dataDir: string, uid: string, fn: () => Promise<T>): Promise<T> {
  return withTenant({ root: tenantRoot(dataDir, uid), sid: randomUUID(), defaultProject: HOSTED_DEFAULT_PROJECT }, fn);
}
