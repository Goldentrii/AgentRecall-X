// End-to-end walk through the whole tray chain, on this PC, with nothing real involved:
//   mock GitHub  <-  local AgentRecall server (the real dist/ build)  <-  the real Windows exe (test-hooks build)
// The exe's webview is driven over DevTools (WebView2 remote debugging); the system browser is played by a
// headless Edge, because the test build writes the sign-in URL to a log file instead of opening a browser.
// Tokens are test tokens of the local server and are never printed. See README.md in this folder.

import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { startMock, GH } from "../../../packages/mcp-server/test/lib/mock-providers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const trayDir = path.join(here, "..");
const serverCli = path.join(trayDir, "..", "..", "packages", "mcp-server", "dist", "http", "cli.js");
const preload = pathToFileURL(path.join(trayDir, "..", "..", "packages", "mcp-server", "test", "lib", "provider-mock-preload.mjs")).href;
const exe = process.env.AR_CHAIN_EXE ?? path.join(trayDir, "release", "agent-recall-tray-testhooks.exe");
const shotsDir = process.env.AR_CHAIN_SHOTS ?? path.join(trayDir, "docs", "chain");
const work = path.join(here, ".work");

const firstPort = Number(process.env.AR_CHAIN_PORT ?? 8150);
const [cdpPort, serverPort, mockPort] = [firstPort, firstPort + 1, firstPort + 2];
const base = `http://127.0.0.1:${serverPort}`;

const TEST_CREDENTIAL = "AgentRecall Tray (test)";
const testCacheDir = path.join(process.env.APPDATA ?? "", "com.agentrecall.tray.test");
const MAX_SHOT_BYTES = 250 * 1024;
const SENTENCE = "The harbour ferry leaves at 07:45 on weekdays.";

// ---------- harness plumbing ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, probe, { timeout = 30_000, every = 150 } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const v = await probe();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

let stepNo = 0;
async function step(title, fn) {
  stepNo += 1;
  await fn();
  console.log(`PASS ${String(stepNo).padStart(2, "0")} ${title}`);
}

async function shot(page, name) {
  fs.mkdirSync(shotsDir, { recursive: true });
  const file = path.join(shotsDir, `${name}.png`);
  await page.screenshot({ path: file });
  assert.ok(fs.statSync(file).size < MAX_SHOT_BYTES, `${name}.png is over 250 KB`);
}

/** Credential Manager targets of the TEST build only (a target with spaces must be quoted verbatim for cmdkey). The real entry has a different service name. */
function testCredentialTargets() {
  const out = execFileSync("cmdkey", ["/list"], { encoding: "utf-8" });
  return [...out.matchAll(/Target:\s*(?:LegacyGeneric:target=)?(.+)/g)].map((m) => m[1].trim()).filter((t) => t.endsWith(`.${TEST_CREDENTIAL}`));
}

function wipeTestState() {
  for (const target of testCredentialTargets()) execFileSync("cmdkey", [`/delete:"${target}"`], { stdio: "ignore", windowsVerbatimArguments: true });
  fs.rmSync(testCacheDir, { recursive: true, force: true });
  assert.equal(testCredentialTargets().length, 0, "the test credential entry could not be deleted");
}

function startServer(mock, dataDir) {
  const proc = spawn(process.execPath, ["--import", preload, serverCli, "serve", "--port", String(serverPort)], {
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      AR_SERVER_DATA: dataDir,
      AR_PUBLIC_URL: base,
      AR_OAUTH_SIGNUP: "open",
      AR_TEST_PROVIDER_MOCK: mock.url,
      AR_OAUTH_GITHUB_CLIENT_ID: GH.id,
      AR_OAUTH_GITHUB_CLIENT_SECRET: GH.secret,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const log = [];
  proc.stderr.on("data", (d) => log.push(String(d)));
  const ready = new Promise((resolve, reject) => {
    proc.on("exit", (c) => reject(new Error(`server exited ${c}:\n${log.join("")}`)));
    proc.stderr.on("data", () => log.join("").includes("listening on") && resolve());
  });
  return { proc, ready };
}

function startApp(openLog) {
  return spawn(exe, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
      AGENTRECALL_TRAY_TEST_BASE_URL: base,
      AGENTRECALL_TRAY_TEST_OPEN_LOG: openLog,
    },
    stdio: "ignore",
  });
}

async function connectToApp() {
  return until("the app's webview on DevTools", async () => {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith("http://tauri.localhost"));
    if (!page) {
      await browser.close();
      return null;
    }
    return { browser, page };
  }, { timeout: 60_000, every: 500 });
}

const statusText = (page) => page.locator("#status-text").innerText();
const openedUrls = (openLog) => (fs.existsSync(openLog) ? fs.readFileSync(openLog, "utf-8").split("\n").filter(Boolean) : []);

// ---------- the chain ----------

async function walk({ page, openLog, mock }) {
  await step("start: status header says Connected with the server version, and the sign-in screen shows", async () => {
    await until("Connected in the header", async () => /^Connected · v\d/.test(await statusText(page)));
    assert.ok(!(await statusText(page)).includes("Signed in"));
    await page.getByRole("button", { name: "Sign in with GitHub" }).waitFor();
    assert.equal(await page.evaluate(() => typeof window.__TAURI__), "undefined", "the webview must not expose the Tauri API globally");
    await shot(page, "01-start-signed-out");
  });

  let authorizeUrl;
  await step("sign in: the app hands the sign-in URL to the browser (here: the open log)", async () => {
    await page.getByRole("button", { name: "Sign in with GitHub" }).click();
    authorizeUrl = await until("the sign-in URL in the open log", () => openedUrls(openLog)[0]);
    const u = new URL(authorizeUrl);
    assert.equal(u.origin, base);
    assert.equal(u.pathname, "/authorize");
    assert.equal(u.searchParams.get("code_challenge_method"), "S256");
    assert.equal(u.searchParams.get("resource"), `${base}/mcp`);
    assert.match(u.searchParams.get("redirect_uri"), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    await page.getByText("Finish signing in in your browser").waitFor();
    await shot(page, "02-waiting-for-browser");
  });

  const edge = await chromium.launch({ channel: "msedge", headless: true });
  try {
    // Nothing leaves this PC. The browser only ever talks to 127.0.0.1; the one hop to GitHub is not followed:
    // the server's redirect is read from the form post (maxRedirects 0) and answered by the mock instead.
    const context = await edge.newContext({ viewport: { width: 760, height: 520 } });
    const leaked = [];
    await context.route((u) => u.hostname !== "127.0.0.1", (route) => {
      leaked.push(route.request().url());
      return route.abort();
    });
    const browser = await context.newPage();
    await step("browser: the server's own sign-in page offers GitHub", async () => {
      await browser.goto(authorizeUrl);
      await browser.getByRole("button", { name: "Continue with GitHub" }).waitFor();
      await shot(browser, "03-server-sign-in-page");
    });

    await step("browser: GitHub (mock) approves, the server redirects to the app's loopback, the app answers", async () => {
      const post = await context.request.post(`${base}/authorize/start`, {
        form: { request_id: await browser.locator("input[name=request_id]").inputValue(), provider: "github" },
        maxRedirects: 0,
      });
      assert.equal(post.status(), 302);
      const up = new URL(post.headers().location);
      assert.equal(up.origin + up.pathname, "https://github.com/login/oauth/authorize");
      const code = mock.issue("github", { profile: { id: 424242 }, challenge: up.searchParams.get("code_challenge"), nonce: up.searchParams.get("nonce") });
      await browser.goto(`${base}/authorize/callback/github?${new URLSearchParams({ code, state: up.searchParams.get("state") })}`);
      assert.match(browser.url(), /^http:\/\/127\.0\.0\.1:\d+\/callback\?/);
      await browser.getByText("Signed in. You can close this tab").waitFor();
      await shot(browser, "04-browser-signed-in");
      assert.deepEqual(leaked, [], "the browser tried to reach a host outside 127.0.0.1");
    });
  } finally {
    await edge.close();
  }

  await step("signed in: header shows Signed in, tokens sit in Credential Manager, Memory loads", async () => {
    await until("Signed in in the header", async () => /Connected · v\d.* · Signed in$/.test(await statusText(page)));
    assert.equal(testCredentialTargets().length, 1, "exactly one test credential entry");
    await page.locator(".panel .scroll pre").waitFor();
    assert.match(await page.locator(".badge").innerText(), /^Updated /);
    assert.ok((await page.locator(".panel .scroll pre").innerText()).length > 0);
    await until("the cache file", () => fs.existsSync(path.join(testCacheDir, "cache.json")));
    assert.doesNotMatch(fs.readFileSync(path.join(testCacheDir, "cache.json"), "utf-8"), /aro_|arr_/, "no token in the cache");
    await shot(page, "05-memory");
  });

  await step("remember: a sentence is saved through the remember tool", async () => {
    await page.locator("#tab-remember").click();
    await page.locator("#rem").fill(SENTENCE);
    await page.getByRole("button", { name: "Remember" }).click();
    const note = page.locator(".note.ok");
    await note.waitFor();
    assert.ok((await note.innerText()).trim().length > 0, "the server's confirmation line is shown");
    assert.equal(await page.locator("#rem").inputValue(), "");
    await shot(page, "06-remember");
  });

  await step("recall: the sentence is found again", async () => {
    await page.locator("#tab-recall").click();
    await page.locator("#q").fill("harbour ferry");
    await page.getByRole("button", { name: "Search" }).click();
    await page.locator(".item").first().waitFor();
    const found = await page.locator(".item").allInnerTexts();
    assert.ok(found.some((t) => t.includes("07:45")), `a result holds the sentence; got ${found.length} result(s)`);
    await shot(page, "07-recall");
  });

  await step("connect: three commands, and the dashboard goes to the browser (the log), not a real one", async () => {
    await page.locator("#tab-connect").click();
    for (const name of ["Claude Code", "Codex", "Cursor"]) await page.getByRole("button", { name: `Copy ${name} command` }).waitFor();
    assert.match(await page.locator(".cmd code").first().innerText(), /^claude mcp add /);
    await page.getByRole("button", { name: "Open my dashboard" }).click();
    await until("the dashboard URL in the open log", () => openedUrls(openLog).includes("https://agentrecallx.com/connect"));
    const layout = await page.evaluate(() => {
      const box = (sel) => document.querySelector(sel).getBoundingClientRect();
      return { signOut: box("#signout"), panel: box(".panel"), viewport: window.innerHeight, pageScrolled: document.scrollingElement.scrollTop };
    });
    assert.ok(layout.signOut.bottom <= layout.viewport, "Sign out is inside the window");
    assert.ok(layout.panel.bottom <= layout.signOut.top, "the Connect panel does not run over Sign out");
    assert.equal(layout.pageScrolled, 0, "the window itself does not scroll; the panel does");
    await shot(page, "08-connect");
  });

  await step("sign out: the sign-in screen is back, credential entry and cache are gone", async () => {
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("button", { name: "Sign in with GitHub" }).waitFor();
    await until("the header without Signed in", async () => !(await statusText(page)).includes("Signed in"));
    assert.equal(testCredentialTargets().length, 0, "test credential entry deleted");
    assert.ok(!fs.existsSync(path.join(testCacheDir, "cache.json")), "cache file deleted");
    await shot(page, "09-signed-out");
  });
}

// ---------- run ----------

async function main() {
  assert.ok(fs.existsSync(exe), `test-hooks exe not found: ${exe}`);
  assert.ok(fs.existsSync(serverCli), "build the server first: npm ci at the repo root, then npm run build in packages/core and packages/mcp-server");
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  wipeTestState();

  const mock = await startMock({ port: mockPort });
  mock.state.base = base;
  const server = startServer(mock, path.join(work, "server-data"));
  let app;
  let cdp;
  try {
    await server.ready;
    const openLog = path.join(work, "open.log");
    app = startApp(openLog);
    cdp = await connectToApp();
    await walk({ page: cdp.page, openLog, mock });
    console.log("CHAIN OK");
  } finally {
    await cdp?.browser.close().catch(() => undefined);
    if (app?.pid) try { execFileSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* already gone */ }
    server.proc.removeAllListeners("exit");
    server.proc.kill();
    await mock.close();
    wipeTestState();
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(`CHAIN FAILED at step ${stepNo + 1}: ${e.stack ?? e}`);
  process.exit(1);
});
