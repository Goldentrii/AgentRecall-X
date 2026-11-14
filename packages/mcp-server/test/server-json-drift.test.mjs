// server.json is what the official MCP Registry publishes. It went stale twice
// (3.4.31 live, 3.4.48 in the repo, while npm was 3.5.2), so pin it here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => JSON.parse(readFileSync(join(here, "..", name), "utf8"));
const pkg = read("package.json");
const server = read("server.json");

test("server.json version matches package.json", () => {
  assert.equal(server.version, pkg.version);
});

test("server.json name matches package.json mcpName", () => {
  assert.equal(server.name, pkg.mcpName);
});

test("server.json npm package entry matches the published package", () => {
  const npm = server.packages.filter((p) => p.registryType === "npm");
  assert.equal(npm.length, 1);
  assert.equal(npm[0].identifier, pkg.name);
  assert.equal(npm[0].version, pkg.version);
  assert.equal(npm[0].transport.type, "stdio");
});

test("server.json declares the hosted endpoint", () => {
  assert.deepEqual(server.remotes, [
    { type: "streamable-http", url: "https://agentrecallx.com/mcp" },
  ]);
});

test("server.json description fits the registry limit and is not local-only", () => {
  assert.ok(server.description.length > 0);
  assert.ok(server.description.length <= 100, `${server.description.length} chars`);
  assert.doesNotMatch(server.description, /local-only/i);
});

test("server.json points at the current repository", () => {
  assert.equal(server.repository.url, pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, ""));
  assert.equal(server.repository.subfolder, pkg.repository.directory);
});
