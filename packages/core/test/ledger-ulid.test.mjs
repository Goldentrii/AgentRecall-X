// packages/core/test/ledger-ulid.test.mjs — ledger spec SW-2: hand-rolled ULID (D3).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { ulid, ulidTime, isUlid } = await import("../dist/index.js");

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

describe("ledger ulid", () => {
  it("is 26 chars of Crockford base32", () => {
    const id = ulid();
    assert.equal(id.length, 26);
    for (const c of id) assert.ok(CROCKFORD.includes(c), `bad char ${c}`);
  });

  it("time prefix decodes back to the ms used", () => {
    for (const t of [0, 1700000000000, 2 ** 48 - 1]) {
      assert.equal(ulidTime(ulid(t)), t);
    }
  });

  it("1000 ids in the same ms are strictly increasing", () => {
    const ids = Array.from({ length: 1000 }, () => ulid(1700000000123));
    for (let i = 1; i < ids.length; i++) {
      assert.ok(ids[i] > ids[i - 1], `ids[${i}] not > ids[${i - 1}]`);
    }
  });

  it("10k ids are unique", () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => ulid()));
    assert.equal(ids.size, 10_000);
  });

  it("isUlid accepts a real id and rejects malformed ones", () => {
    const id = ulid();
    assert.equal(isUlid(id), true);
    assert.equal(isUlid(id.slice(0, 25)), false);
    assert.equal(isUlid(id.toLowerCase()), false);
    for (const bad of ["U", "I", "L", "O"]) {
      assert.equal(isUlid(bad + id.slice(1)), false, `accepted ${bad}`);
    }
    assert.equal(isUlid(123), false);
  });
});
