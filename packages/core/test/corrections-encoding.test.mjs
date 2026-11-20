// 3.5.4 PR-C — rule and lesson files saved with a UTF-8 BOM or as UTF-16 are read.
//
// Found by the 2026-11-19 black-box test of 3.5.3 (round 2, g7 S4): a rule file
// re-saved by stock Windows PowerShell 5.1 (`Set-Content -Encoding UTF8` writes a
// BOM, `Out-File` writes UTF-16 LE with a BOM) failed JSON.parse and was skipped
// silently: gone from HARD RULES, check(action) and the export, 8/8. The same
// re-save of a lesson file read as "no lessons", and the next save wrote the
// empty index back over it.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import * as core from "../dist/index.js";
import { decodeTextFile } from "../dist/storage/fs-utils.js";

const PROJECT = "encoding-proj";
let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(tmpdir(), "ar-encoding-"));
  process.env.AGENT_RECALL_ROOT = root;
});
afterEach(() => {
  delete process.env.AGENT_RECALL_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
});

/** Encode text the ways Windows tools save it. */
function encode(text, kind) {
  switch (kind) {
    case "utf8": return Buffer.from(text, "utf8");
    case "utf8bom": return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]);
    case "utf16le": return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    case "utf16be": {
      const le = Buffer.from(text, "utf16le");
      const be = Buffer.alloc(le.length);
      for (let i = 0; i + 1 < le.length; i += 2) { be[i] = le[i + 1]; be[i + 1] = le[i]; }
      return Buffer.concat([Buffer.from([0xfe, 0xff]), be]);
    }
    default: throw new Error(kind);
  }
}
const KINDS = ["utf8", "utf8bom", "utf16le", "utf16be"];

describe("decodeTextFile", () => {
  for (const kind of KINDS) {
    it(`decodes ${kind}`, () => {
      const t = '{"a":"Größe 名前"}';
      assert.equal(decodeTextFile(encode(t, kind)), t);
    });
  }
  it("does not throw on an odd-length UTF-16 buffer", () => {
    const b = encode('{"a":1}', "utf16le");
    assert.doesNotThrow(() => decodeTextFile(b.subarray(0, b.length - 1)));
  });
});

const RULE = "Never deploy the billing service on a Friday afternoon.";

async function seedRule() {
  const res = await core.check({
    goal: "record what the owner said",
    confidence: "high",
    project: PROJECT,
    human_correction: { rule: RULE, why: "Two Friday deploys broke billing.", applies_when: ["deploy", "billing"] },
  });
  assert.ok(!res.correction_gate_rejected, res.correction_gate_rejected);
  const dir = path.join(root, "projects", PROJECT, "corrections");
  const file = fs.readdirSync(dir).find((f) => f.endsWith(".json") && !f.startsWith("_"));
  return path.join(dir, file);
}

describe("correction files in every Windows encoding", () => {
  for (const kind of KINDS) {
    for (const crlf of [false, true]) {
      it(`${kind}${crlf ? " + CRLF" : ""}: listed, enforced, exported, then rewritten as plain UTF-8`, async () => {
        const file = await seedRule();
        let json = JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8")), null, 2);
        if (crlf) json = json.replace(/\n/g, "\r\n");
        fs.writeFileSync(file, encode(json, kind));

        assert.equal(core.readP0Corrections(PROJECT).filter((c) => c.rule === RULE).length, 1, "readP0Corrections");
        const text = core.renderSessionStart(await core.sessionStart({ project: PROJECT }));
        assert.ok(text.includes(RULE), "HARD RULES lists it");
        const act = await core.checkAction({ project: PROJECT, action_description: "deploy the billing service this Friday afternoon" });
        assert.ok((act.matching_corrections ?? []).some((m) => (m.rule ?? "").includes("billing")), "check(action) matches it");
        const exp = core.exportCorrections({ project: PROJECT });
        assert.ok(JSON.stringify(exp).includes("billing service"), "export carries it");

        const id = core.readCorrections(PROJECT)[0].id;
        await core.recordOutcome({ correction_id: id, project: PROJECT, kind: "retrieved" });
        const bytes = fs.readFileSync(file);
        assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "no BOM after the rewrite");
        assert.notEqual(bytes[0], 0xff);
        assert.notEqual(bytes[0], 0xfe);
        assert.equal(JSON.parse(bytes.toString("utf8")).rule, RULE);
      });
    }
  }
});

describe("lesson files in every Windows encoding", () => {
  for (const kind of ["utf8bom", "utf16le"]) {
    it(`insights-index.json and awareness files saved as ${kind} are read, not treated as empty`, async () => {
      await core.awarenessUpdate({
        project: PROJECT,
        insights: [{
          title: "Run the database migration before deploying the API service",
          evidence: "Deploying first broke the API twice in October.",
          applies_when: ["deploy", "database"],
          source: "test",
        }],
      });
      const before = core.readInsightsIndex();
      assert.ok(before.insights.length >= 1);
      const stateBefore = core.readAwarenessState();
      const files = ["insights-index.json", "awareness-state.json"].map((f) => path.join(root, f)).filter((f) => fs.existsSync(f));
      assert.ok(files.length >= 1, "lesson files exist");
      for (const f of files) fs.writeFileSync(f, encode(fs.readFileSync(f, "utf8"), kind));

      assert.deepEqual(core.readInsightsIndex().insights.map((i) => i.title), before.insights.map((i) => i.title));
      if (stateBefore) assert.deepEqual(core.readAwarenessState()?.topInsights?.map((i) => i.title), stateBefore.topInsights?.map((i) => i.title));
    });
  }
});
