/**
 * hosted-stats.test.mjs — first-party usage statistics (stats.ts) as a unit:
 * counts only, one snapshot per UTC day, rollover at midnight, restart without
 * double-counting users, failed writes keep the data, bounded retention, and no
 * uid / token / path parameter / query / content can reach a snapshot.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const S = await import(pathToFileURL(path.join(here, "..", "dist", "http", "stats.js")).href);
const { UsageStats, routeClass, referrerHost, toolNamesOf, percentile, readSnapshots, formatStats, parseSnapshot, LATENCY_BOUNDS_MS } = S;
const root = fs.mkdtempSync(path.join(tmpdir(), "ar-stats-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const T0 = Date.parse("2026-11-14T10:00:00Z");
const freshDir = () => fs.mkdtempSync(path.join(root, "d-"));
const make = (dataDir, clock, opts = {}) => new UsageStats(dataDir, { flushMs: 3_600_000, now: () => clock.t, log: () => {}, ...opts });
const fileOf = (dataDir, day) => path.join(dataDir, "_server", "stats", `${day}.json`);
const readDay = (dataDir, day) => JSON.parse(fs.readFileSync(fileOf(dataDir, day), "utf-8"));
const req = (over = {}) => ({ route: "mcp", method: "POST", path: "/mcp", status: 200, ms: 12, referer: undefined, ownHost: "agentrecallx.com", ...over });

describe("usage stats — counting", () => {
  it("counts requests, tools, users, sign-ups, agents, errors, latency and page views per day", () => {
    const dataDir = freshDir();
    const clock = { t: T0 };
    const s = make(dataDir, clock);
    s.request(req());
    s.request(req({ ms: 400 }));
    s.request(req({ status: 401 }));
    s.request(req({ route: "site", method: "GET", path: "/nope", status: 404 }));
    s.request(req({ route: "oauth", method: "POST", path: "/token", status: 500 }));
    s.toolCalls(["recall", "recall", "session_start", "other"]);
    s.activeUser("alice");
    s.activeUser("alice");
    s.activeUser("bob-1");
    s.signup();
    s.newAgent();
    s.newAgent();
    s.internalError("mcp_internal");
    s.request(req({ route: "site", method: "GET", path: "/", status: 200, referer: "https://github.com/Goldentrii/AgentRecall-X?tab=readme#x" }));
    s.request(req({ route: "site", method: "GET", path: "/privacy/", status: 200 }));
    s.flush();
    const d = readDay(dataDir, "2026-11-14");
    assert.equal(d.version, 1);
    assert.equal(d.day, "2026-11-14");
    assert.equal(d.mcp_requests, 3);
    assert.deepEqual(d.tool_calls, { recall: 2, session_start: 1, other: 1 });
    assert.equal(d.active_users, 2);
    assert.equal(d.signups, 1);
    assert.equal(d.new_agents, 2);
    assert.deepEqual(d.http_errors, { mcp: { 401: 1 }, site: { 404: 1 }, oauth: { 500: 1 } });
    assert.deepEqual(d.internal_errors, { mcp_internal: 1 });
    assert.equal(d.latency_ms.counts.reduce((a, b) => a + b, 0), 2, "only successful MCP requests are timed");
    assert.deepEqual(d.page_views, { "/": 1, "/privacy": 1 });
    assert.deepEqual(d.referrers, { "github.com": 1 });
  });

  it("a snapshot holds no uid, token, query, path parameter or content", () => {
    const dataDir = freshDir();
    const clock = { t: T0 };
    const s = make(dataDir, clock);
    const uid = "secret-uid-4242";
    s.activeUser(uid);
    s.toolCalls(toolNamesOf([{ jsonrpc: "2.0", method: "tools/call", params: { name: "remember", arguments: { content: "my-private-memory-text" } } }]));
    s.request(req({ status: 401 }));
    s.request(req({ route: "connect", method: "GET", path: "/connect/download/secret-uid-4242", status: 200 }));
    s.request(req({ route: "other", method: "GET", path: "/secret-uid-4242", status: 404 }));
    s.request(req({ route: "site", method: "GET", path: "/", status: 200, referer: "https://evil.example.org/path/secret-uid-4242?token=ar_abcdef" }));
    s.request(req({ route: "site", method: "GET", path: "/", status: 200, referer: "http://192.168.1.20:3000/me" }));
    s.request(req({ route: "site", method: "GET", path: "/", status: 200, referer: "http://tongs-laptop/x" }));
    s.flush();
    const raw = fs.readFileSync(fileOf(dataDir, "2026-11-14"), "utf-8");
    for (const needle of [uid, "my-private-memory-text", "ar_abcdef", "token=", "/path", "192.168", "tongs-laptop", "/connect/download", "evil.example.org"]) {
      assert.ok(!raw.includes(needle), `snapshot must not contain ${needle}`);
    }
    const d = JSON.parse(raw);
    assert.deepEqual(d.referrers, { "(other)": 3 }, "a site outside the known list is only (other)");
    assert.deepEqual(d.page_views, { "/": 3 }, "only allowlisted page paths are counted");
  });

  it("referrers: known sites by name (subdomains folded), every other site only as (other)", () => {
    const dataDir = freshDir();
    const s = make(dataDir, { t: T0 });
    const refs = ["https://gist.github.com/x", "https://github.com/a/b", "https://alice.substack.com/p/1", "https://www.google.de/", "https://www.google.com/search?q=x",
      "https://alice-smith.github.io/", "http://10-0-0-5.nip.io/", "https://acme-corp.slack.com/", ...Array.from({ length: 130 }, (_, i) => `https://site${i}.example.net/`)];
    for (const referer of refs) s.request(req({ route: "site", method: "GET", path: "/", status: 200, referer }));
    s.flush();
    const d = readDay(dataDir, "2026-11-14");
    assert.deepEqual(d.referrers, { "github.com": 2, "substack.com": 1, google: 2, "(other)": 133 });
  });

  it("http errors only for 400-599, page views only for GET 200", () => {
    const dataDir = freshDir();
    const s = make(dataDir, { t: T0 });
    s.request(req({ route: "site", method: "HEAD", path: "/", status: 200 }));
    s.request(req({ route: "site", method: "GET", path: "/", status: 304 }));
    s.request(req({ route: "mcp", status: 202 }));
    s.request(req({ route: "mcp", status: 999 }));
    s.flush();
    const d = readDay(dataDir, "2026-11-14");
    assert.deepEqual(d.page_views, {});
    assert.deepEqual(d.http_errors, {});
    assert.equal(d.mcp_requests, 2);
  });

  it("unknown internal error kinds and invalid uids are ignored", () => {
    const dataDir = freshDir();
    const s = make(dataDir, { t: T0 });
    s.internalError("made_up_kind");
    s.activeUser("Not A Uid!");
    s.activeUser("../../etc");
    s.flush();
    assert.ok(!fs.existsSync(fileOf(dataDir, "2026-11-14")), "nothing counted, nothing written");
  });
});

describe("usage stats — days, restarts, failures, retention", () => {
  it("rolls over at midnight UTC: the old day is written final, the new day starts empty", () => {
    const dataDir = freshDir();
    const clock = { t: Date.parse("2026-11-14T23:59:59.900Z") };
    const s = make(dataDir, clock);
    s.activeUser("alice");
    s.request(req());
    clock.t = Date.parse("2026-11-15T00:00:00.100Z");
    s.activeUser("alice");
    s.request(req());
    s.request(req());
    s.flush();
    const a = readDay(dataDir, "2026-11-14");
    const b = readDay(dataDir, "2026-11-15");
    assert.equal(a.mcp_requests, 1);
    assert.equal(a.active_users, 1);
    assert.equal(b.mcp_requests, 2);
    assert.equal(b.active_users, 1, "alice is active on both days");
  });

  it("the clock going backwards across midnight keeps counting into the current day", () => {
    const dataDir = freshDir();
    const clock = { t: Date.parse("2026-11-15T00:00:01Z") };
    const s = make(dataDir, clock);
    s.request(req());
    clock.t = Date.parse("2026-11-14T23:59:59Z");
    s.request(req());
    s.flush();
    assert.equal(readDay(dataDir, "2026-11-15").mcp_requests, 2);
    assert.ok(!fs.existsSync(fileOf(dataDir, "2026-11-14")));
  });

  it("a restart the same day continues the counts and does not count a user twice", () => {
    const dataDir = freshDir();
    const clock = { t: T0 };
    const s1 = make(dataDir, clock);
    s1.activeUser("alice");
    s1.activeUser("bob-1");
    s1.request(req());
    s1.flush();
    // The activity store has recorded both users today (the server flushes it on the same shutdown path).
    const act = path.join(dataDir, "_server", "activity");
    fs.mkdirSync(act, { recursive: true });
    for (const uid of ["alice", "bob-1"]) {
      fs.writeFileSync(path.join(act, `${uid}.json`), JSON.stringify({ version: 1, entries: { "token:aaaaaaaaaaaa": { client: "x", first_seen: "2026-11-01T00:00:00.000Z", last_seen: "2026-11-14T09:59:00.000Z", calls: 1 } } }));
    }
    fs.writeFileSync(path.join(act, "carol.json"), JSON.stringify({ version: 1, entries: { "token:bbbbbbbbbbbb": { client: "x", first_seen: "2026-11-01T00:00:00.000Z", last_seen: "2026-11-13T09:59:00.000Z", calls: 1 } } }));
    clock.t += 60_000;
    const s2 = make(dataDir, clock);
    s2.activeUser("alice"); // already counted before the restart
    s2.activeUser("carol"); // new today
    s2.request(req());
    s2.flush();
    const d = readDay(dataDir, "2026-11-14");
    assert.equal(d.mcp_requests, 2);
    assert.equal(d.active_users, 3);
  });

  it("a restart keeps the snapshot's user count when activity files are missing (never goes down)", () => {
    const dataDir = freshDir();
    const clock = { t: T0 };
    const s1 = make(dataDir, clock);
    for (const u of ["aaa", "bbb", "ccc"]) s1.activeUser(u);
    s1.flush();
    const s2 = make(dataDir, clock);
    s2.request(req());
    s2.flush();
    assert.equal(readDay(dataDir, "2026-11-14").active_users, 3);
  });

  it("a failed write (disk full) keeps the data, reports it, and a later write succeeds", () => {
    const dataDir = freshDir();
    const clock = { t: T0 };
    let fail = true;
    const errors = [];
    const s = make(dataDir, clock, {
      write: (f, d) => { if (fail) { const e = new Error("ENOSPC: no space left on device"); e.code = "ENOSPC"; throw e; } fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(d)); },
      onWriteError: (e) => errors.push(e),
    });
    s.request(req());
    s.flush();
    assert.equal(errors.length, 1);
    assert.ok(!fs.existsSync(fileOf(dataDir, "2026-11-14")));
    s.request(req());
    fail = false;
    s.flush();
    assert.equal(readDay(dataDir, "2026-11-14").mcp_requests, 2);
  });

  it("a failed write at midnight keeps the closed day and writes it later", () => {
    const dataDir = freshDir();
    const clock = { t: Date.parse("2026-11-14T23:59:00Z") };
    let fail = true;
    const s = make(dataDir, clock, {
      write: (f, d) => { if (fail) throw new Error("EIO"); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(d)); },
      onWriteError: () => {},
    });
    s.request(req());
    clock.t = Date.parse("2026-11-15T00:01:00Z");
    s.request(req()); // rollover: the final write of the 14th fails
    fail = false;
    s.flush();
    assert.equal(readDay(dataDir, "2026-11-14").mcp_requests, 1);
    assert.equal(readDay(dataDir, "2026-11-15").mcp_requests, 1);
  });

  it("days that cannot be written for a week are dropped with a log line and a report, never silently", () => {
    const dataDir = freshDir();
    const clock = { t: Date.parse("2026-11-01T12:00:00Z") };
    const logs = [];
    let reports = 0;
    const s = make(dataDir, clock, { write: () => { throw new Error("EROFS"); }, onWriteError: () => { reports++; }, log: (l) => logs.push(l) });
    for (let i = 0; i < 9; i++) {
      s.request(req());
      clock.t += 86_400_000;
    }
    s.request(req());
    assert.ok(logs.some((l) => /usage stats for 2026-11-01 dropped/.test(l)), logs.join("\n"));
    assert.ok(reports > 0);
    assert.ok(logs.every((l) => !/alice/.test(l)));
  });

  it("flush says whether everything is saved; a recovery is logged and later failures are logged again", () => {
    const dataDir = freshDir();
    let fail = true;
    const logs = [];
    const s = make(dataDir, { t: T0 }, {
      write: (f, d) => { if (fail) throw Object.assign(new Error("x"), { code: "ENOSPC" }); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(d)); },
      log: (l) => logs.push(l),
    });
    s.request(req());
    assert.equal(s.flush(), false);
    fail = false;
    assert.equal(s.flush(), true);
    assert.ok(logs.some((l) => /saved again/.test(l)));
    fail = true;
    s.request(req());
    assert.equal(s.flush(), false);
    assert.equal(logs.filter((l) => /not saved/.test(l)).length, 2, "the second failure period is logged too");
  });

  it("a closed day keeps only its count of users, not the uids", () => {
    const dataDir = freshDir();
    const clock = { t: Date.parse("2026-11-14T23:00:00Z") };
    let fail = true;
    const s = make(dataDir, clock, { write: (f, d) => { if (fail) throw new Error("EIO"); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(d)); } });
    s.activeUser("alice");
    s.activeUser("bob-1");
    clock.t = Date.parse("2026-11-15T01:00:00Z");
    s.activeUser("alice");
    fail = false;
    s.flush();
    assert.equal(readDay(dataDir, "2026-11-14").active_users, 2);
    assert.equal(readDay(dataDir, "2026-11-15").active_users, 1);
  });

  it("never throws, even when the stats directory cannot be created", () => {
    const dataDir = freshDir();
    fs.mkdirSync(path.join(dataDir, "_server"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "_server", "stats"), "a file where the directory should be");
    const s = make(dataDir, { t: T0 }, { onWriteError: () => {} });
    s.request(req());
    assert.doesNotThrow(() => s.flush());
  });

  it("a corrupt snapshot is replaced, not fatal", () => {
    const dataDir = freshDir();
    fs.mkdirSync(path.dirname(fileOf(dataDir, "2026-11-14")), { recursive: true });
    fs.writeFileSync(fileOf(dataDir, "2026-11-14"), "{not json");
    const s = make(dataDir, { t: T0 });
    s.request(req());
    s.flush();
    assert.equal(readDay(dataDir, "2026-11-14").mcp_requests, 1);
  });

  it("deletes snapshots older than the retention window and nothing else", () => {
    const dataDir = freshDir();
    const dir = path.dirname(fileOf(dataDir, "x"));
    fs.mkdirSync(dir, { recursive: true });
    for (const n of ["2025-10-09.json", "2025-10-10.json", "2025-10-11.json", "2026-11-13.json", "notes.txt", "2025-01-01.json.bak", "2026-11-13.json.tmp.123.abcd", "2026-11-14.json.tmp.9.ffff"]) fs.writeFileSync(path.join(dir, n), "{}");
    make(dataDir, { t: T0 }); // 2026-11-14 minus 400 days = 2025-10-10
    assert.deepEqual(fs.readdirSync(dir).sort(), ["2025-01-01.json.bak", "2025-10-10.json", "2025-10-11.json", "2026-11-13.json", "2026-11-14.json.tmp.9.ffff", "notes.txt"]);
  });

  it("the timer writes a dirty day on its own", async () => {
    const dataDir = freshDir();
    const s = new UsageStats(dataDir, { flushMs: 20, log: () => {} });
    s.request(req());
    await new Promise((r) => setTimeout(r, 120));
    const day = new Date().toISOString().slice(0, 10);
    assert.equal(readDay(dataDir, day).mcp_requests, 1);
  });
});

describe("usage stats — helpers", () => {
  it("routeClass", () => {
    const cases = { "/mcp": "mcp", "/healthz": "health", "/connect": "connect", "/connect/download": "connect", "/connect.md": "site",
      "/review": "review", "/review/approve": "review", "/token": "oauth", "/authorize/callback/github": "oauth", "/.well-known/oauth-authorization-server": "oauth",
      "/register": "oauth", "/": "site", "/privacy": "site", "/llms.txt": "site", "/wp-admin": "other", "/mcpx": "other" };
    for (const [p, want] of Object.entries(cases)) assert.equal(routeClass(p), want, p);
  });

  it("referrerHost keeps a known site name or (other), never a host or a URL", () => {
    assert.equal(referrerHost("https://www.Google.com/search?q=agent+memory", "agentrecallx.com"), "google");
    assert.equal(referrerHost("https://news.ycombinator.com/item?id=1", "agentrecallx.com"), "news.ycombinator.com");
    assert.equal(referrerHost("https://user:pw@github.com/x", "agentrecallx.com"), "github.com");
    assert.equal(referrerHost("https://notgithub.com/", "agentrecallx.com"), "(other)", "a look-alike domain is not the site");
    assert.equal(referrerHost("https://github.com.evil.net/", "agentrecallx.com"), "(other)");
    for (const r of ["http://localhost:3000/", "http://127.0.0.1/", "http://[::1]/", "http://intranet/", "https://box.local/", "https://xn--80ak6aa92e.com/"]) {
      assert.equal(referrerHost(r, "agentrecallx.com"), "(other)", r);
    }
    assert.equal(referrerHost("https://agentrecallx.com/privacy", "agentrecallx.com"), null, "own host: internal navigation");
    for (const r of ["android-app://com.google.android.gm/", "data:text/html,x", "not a url", "", undefined, "https://" + "a".repeat(3000) + ".com/"]) {
      assert.equal(referrerHost(r, "agentrecallx.com"), null, String(r).slice(0, 40));
    }
  });

  it("toolNamesOf maps unknown names to other and reads batches", () => {
    assert.deepEqual(toolNamesOf({ method: "tools/call", params: { name: "recall" } }), ["recall"]);
    assert.deepEqual(toolNamesOf([{ method: "tools/call", params: { name: "recall" } }, { method: "tools/list" }, { method: "tools/call", params: { name: "<script>" } }]), ["recall", "other"]);
    assert.deepEqual(toolNamesOf({ method: "initialize" }), []);
    assert.deepEqual(toolNamesOf(null), []);
  });

  it("percentile reads the bucket upper bound", () => {
    const counts = new Array(LATENCY_BOUNDS_MS.length + 1).fill(0);
    const at = (ms) => LATENCY_BOUNDS_MS.findIndex((b) => ms <= b);
    counts[at(10)] = 90;
    counts[at(500)] = 10;
    assert.equal(percentile(counts, 0.5), 10);
    assert.equal(percentile(counts, 0.95), 500);
    assert.equal(percentile(new Array(counts.length).fill(0), 0.5), null);
    const slow = new Array(counts.length).fill(0);
    slow[LATENCY_BOUNDS_MS.length - 1] = 1; // exactly the slowest bound
    assert.equal(percentile(slow, 0.5), 60000);
    const over = new Array(counts.length).fill(0);
    over[LATENCY_BOUNDS_MS.length] = 1; // slower than every bound
    assert.equal(percentile(over, 0.5), 60001);
  });

  it("parseSnapshot drops unknown keys and bad numbers", () => {
    const p = parseSnapshot({ version: 1, day: "2026-11-14", updated_at: "x", server_version: "1", mcp_requests: 5, tool_calls: { recall: 2, "evil key": 9, other: -1 },
      active_users: 1.5, signups: 1, new_agents: 0, http_errors: { mcp: { 401: 2, 200: 4, abc: 1 }, bogus: { 404: 1 } }, internal_errors: { mcp_internal: 1, made_up: 2 },
      latency_ms: { bounds: [1, 2], counts: [1, 2, 3] }, page_views: { "/": 3, "/secret-uid": 1 }, referrers: { "github.com": 2, "bad host!": 1 }, uid: "alice" });
    assert.equal(p.mcp_requests, 5);
    assert.deepEqual(p.tool_calls, { recall: 2 });
    assert.equal(p.active_users, 0);
    assert.deepEqual(p.http_errors, { mcp: { 401: 2 } });
    assert.deepEqual(p.internal_errors, { mcp_internal: 1 });
    assert.equal(p.latency_ms.counts.reduce((a, b) => a + b, 0), 0, "a histogram with other bounds is dropped");
    assert.deepEqual(p.page_views, { "/": 3 });
    assert.deepEqual(p.referrers, { "github.com": 2 });
    assert.equal("uid" in p, false);
    assert.equal(p.updated_at, "", "not an ISO time");
    assert.equal(p.server_version, "1");
    assert.equal(parseSnapshot({ version: 1, day: "2026-11-14", updated_at: "2026-11-14T10:00:00.000Z", server_version: "3.5.3\u001b[31m" }).server_version, "");
    assert.equal(parseSnapshot({ version: 1, day: "2026-11-14", updated_at: "2026-11-14T10:00:00.000Z" }).updated_at, "2026-11-14T10:00:00.000Z");
    assert.equal(parseSnapshot({ version: 2 }), null);
    assert.equal(parseSnapshot({ version: 1, day: "../../x" }), null);
  });

  it("readSnapshots + formatStats: today live, missing days, totals", () => {
    const dataDir = freshDir();
    const clock = { t: Date.parse("2026-11-13T12:00:00Z") };
    const s = make(dataDir, clock);
    s.request(req());
    s.toolCalls(["recall"]);
    s.activeUser("alice");
    clock.t = Date.parse("2026-11-14T08:00:00Z");
    s.request(req());
    s.request(req({ route: "site", method: "GET", path: "/", status: 200, referer: "https://news.ycombinator.com/item?id=1" }));
    s.flush();
    const rows = readSnapshots(dataDir, 3, Date.parse("2026-11-14T09:00:00Z"));
    assert.deepEqual(rows.map((r) => r.day), ["2026-11-14", "2026-11-13", "2026-11-12"]);
    assert.equal(rows[2].snapshot, null);
    const text = formatStats(rows, Date.parse("2026-11-14T09:00:00Z"));
    assert.match(text, /2026-11-14\*/);
    assert.match(text, /today, live/);
    assert.match(text, /recall 1/);
    assert.match(text, /news\.ycombinator\.com 1/);
    assert.match(text, /2026-11-12 +-/);
    assert.ok(!text.includes("alice"));
  });
});
