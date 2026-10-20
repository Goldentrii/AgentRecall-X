import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_ROOT = path.join(os.tmpdir(), "ar-mcp-journal-search-test-" + Date.now());

describe("journal_search MCP tool", () => {
  let handler;

  before(async () => {
    process.env.AGENT_RECALL_ROOT = TEST_ROOT;
    const { register } = await import("../dist/tools/journal-search.js");
    const fakeServer = {
      registerTool(name, config, registeredHandler) {
        assert.equal(name, "journal_search");
        assert.ok(config.inputSchema.limit);
        assert.ok(config.inputSchema.since);
        handler = registeredHandler;
      },
    };
    register(fakeServer);
  });

  after(() => {
    delete process.env.AGENT_RECALL_ROOT;
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it("forwards limit and since to core journal search", async () => {
    const journalDir = path.join(TEST_ROOT, "projects", "search-proj", "journal");
    fs.mkdirSync(journalDir, { recursive: true });
    fs.writeFileSync(path.join(journalDir, "2026-05-30.md"), "## Brief\nneedle old\n", "utf-8");
    fs.writeFileSync(path.join(journalDir, "2026-05-31.md"), "## Brief\nneedle first\n", "utf-8");
    fs.writeFileSync(path.join(journalDir, "2026-06-01.md"), "## Brief\nneedle second\n", "utf-8");

    const response = await handler({
      query: "needle",
      project: "search-proj",
      include_palace: false,
      limit: 1,
      since: "2026-06-01",
    });
    const payload = JSON.parse(response.content[0].text);

    assert.equal(payload.results.length, 1);
    assert.equal(payload.results[0].date, "2026-06-01");
  });
});
