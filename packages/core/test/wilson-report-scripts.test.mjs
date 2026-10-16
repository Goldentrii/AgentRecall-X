/**
 * wilson-report-scripts.test.mjs — regression guard for the Wilson 95% CI
 * helpers inlined in scripts/eval/rmr-report.mjs and scripts/eval/ab-report.mjs.
 *
 * Both scripts call main() at import, so the helper is extracted from source
 * and evaluated in isolation. Both used `z2n / 4` (= z²/(4n)) under the root
 * instead of the standard z²/(4n²), which inflated every interval — e.g. 0/4
 * gave [0, 0.73] instead of [0, 0.49]. Vectors match bench-artifact.mjs's
 * WILSON_TEST_VECTORS (the canonical wilson95).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const EVAL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/eval");

const VECTORS = [
  { k: 0, n: 8, lo: 0.0, hi: 0.3244 },
  { k: 8, n: 8, lo: 0.6756, hi: 1.0 },
  { k: 0, n: 40, lo: 0.0, hi: 0.0876 },
  { k: 0, n: 4, lo: 0.0, hi: 0.4899 },
];

function loadWilson(file) {
  const src = fs.readFileSync(path.join(EVAL_DIR, file), "utf-8");
  const m = src.match(/function wilsonCI\(k, n\) \{[\s\S]*?\n\}/);
  assert.ok(m, `wilsonCI not found in ${file}`);
  return new Function(`${m[0]}; return wilsonCI;`)();
}

for (const file of ["rmr-report.mjs", "ab-report.mjs"]) {
  describe(`${file} wilsonCI`, () => {
    const wilsonCI = loadWilson(file);
    for (const v of VECTORS) {
      it(`Wilson(${v.k}/${v.n}) = [${v.lo}, ${v.hi}]`, () => {
        const [lo, hi] = wilsonCI(v.k, v.n);
        assert.ok(Math.abs(lo - v.lo) < 1e-4, `lo ${lo} != ${v.lo}`);
        assert.ok(Math.abs(hi - v.hi) < 1e-4, `hi ${hi} != ${v.hi}`);
      });
    }
    it("n = 0 returns the uninformative [0, 1]", () => {
      assert.deepEqual(wilsonCI(0, 0), [0, 1]);
    });
  });
}
