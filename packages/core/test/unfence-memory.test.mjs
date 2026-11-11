import { it } from "node:test";
import assert from "node:assert/strict";
import { fenceMemory, unfenceMemory } from "../dist/index.js";

it("unfenceMemory drops the open and close delimiter lines of a fenced render and nothing else", () => {
  const body = "---\nkind: identity-card\nversion: 2\n---\n# Owner\n- terse";
  assert.equal(unfenceMemory(fenceMemory(body)), body);
  assert.equal(unfenceMemory(fenceMemory(body) + "\n"), body); // `ar identity show > card.md` ends with a newline
  assert.equal(unfenceMemory(body), body); // unfenced text is returned unchanged
  assert.equal(unfenceMemory("x\n"), "x\n");
  assert.equal(unfenceMemory(""), "");
  assert.equal(unfenceMemory("⟦agentrecall:memory:0123456789abcdef⟧ instr\nbody"), "body"); // a truncated capture still loses the open line
  assert.equal(unfenceMemory(fenceMemory(body).replace(/⟧$/, "⟧  ") + "\n"), body); // trailing whitespace on the close line (editor save)
});
