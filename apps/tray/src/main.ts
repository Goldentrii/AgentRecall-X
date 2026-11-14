// AgentRecall tray UI. No framework. All server text is rendered with textContent, never innerHTML.
// The webview never sees a token: every network call is a Rust command.

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const inApp = "__TAURI_INTERNALS__" in window;

interface Status { online: boolean; version: string | null; signed_in: boolean; checked_at: number }
interface MemoryView { signed_in: boolean; text: string | null; pending: number | null; offline: boolean; as_of: number | null; error: string | null }
interface RecallView { query: string; results: string[]; offline: boolean; as_of: number | null; error: string | null }
interface ConnectCommands { claude: string; codex: string; cursor: string; from_server: boolean }

const BASE = "https://agentrecallx.com";

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!inApp) return Promise.reject("Not running inside the app.");
  return tauriInvoke<T>(cmd, args).catch((e: unknown) => Promise.reject(typeof e === "string" ? e : "Something went wrong."));
}

type Child = Node | string | null | undefined;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const k of kids) if (k !== null && k !== undefined) el.append(k);
  return el;
}
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function fmt(ts: number | null): string {
  return ts ? new Date(ts * 1000).toLocaleString() : "unknown time";
}

const app = $("app");
let state = { status: null as Status | null, tab: "memory" as "memory" | "remember" | "recall" | "connect" };

function setStatus(s: Status | null, label?: string): void {
  const box = $("status");
  const online = !!s && s.online;
  box.classList.toggle("online", online);
  let text = "Checking";
  if (label) text = label;
  else if (s) {
    if (!s.online) text = "Offline";
    else text = `Connected${s.version ? " · v" + s.version : ""}${s.signed_in ? " · Signed in" : ""}`;
  }
  $("status-text").textContent = text;
}

async function refreshStatus(): Promise<Status | null> {
  try {
    state.status = await invoke<Status>("status");
  } catch {
    state.status = null;
  }
  setStatus(state.status);
  return state.status;
}

function render(): void {
  app.replaceChildren();
  if (!state.status || !state.status.signed_in) renderSignedOut();
  else renderSignedIn();
}

// ---------- signed out ----------

function renderSignedOut(): void {
  const note = h("p", { class: "note", id: "so-note", role: "status" });
  const btn = h("button", { class: "primary", id: "signin" }, "Sign in with GitHub");
  const cancel = h("button", { class: "link", id: "cancel", hidden: "" }, "Cancel");
  const offline = state.status && !state.status.online;
  if (offline) {
    note.textContent = "Offline. Sign-in needs a connection to agentrecallx.com.";
    (btn as HTMLButtonElement).disabled = true;
  }
  btn.addEventListener("click", async () => {
    (btn as HTMLButtonElement).disabled = true;
    cancel.hidden = false;
    note.className = "note";
    note.textContent = "Finish signing in in your browser. Waiting";
    try {
      await invoke<void>("sign_in");
      await refreshStatus();
      render();
      void loadMemory();
    } catch (e) {
      note.className = "note err";
      note.textContent = String(e);
      (btn as HTMLButtonElement).disabled = false;
      cancel.hidden = true;
    }
  });
  cancel.addEventListener("click", () => void invoke("cancel_sign_in").catch(() => undefined));
  app.append(
    h("div", { class: "center" },
      h("h1", {}, "Your memory, one step away."),
      h("p", { class: "muted" }, "AgentRecall keeps one memory for every agent you use. Sign in to see it here, add to it and search it."),
      btn, cancel, note,
    ),
  );
}

// ---------- signed in ----------

function renderSignedIn(): void {
  const tabs: Array<[typeof state.tab, string]> = [["memory", "Memory"], ["remember", "Remember"], ["recall", "Recall"], ["connect", "Connect"]];
  const bar = h("div", { class: "tabs", role: "tablist" });
  for (const [id, label] of tabs) {
    const t = h("button", { class: "tab", role: "tab", id: "tab-" + id, "aria-selected": String(state.tab === id), tabindex: state.tab === id ? "0" : "-1" }, label);
    t.addEventListener("click", () => { state.tab = id; render(); });
    t.addEventListener("keydown", (ev) => {
      const i = tabs.findIndex(([k]) => k === state.tab);
      let n = i;
      if (ev.key === "ArrowRight") n = (i + 1) % tabs.length;
      else if (ev.key === "ArrowLeft") n = (i + tabs.length - 1) % tabs.length;
      else return;
      ev.preventDefault();
      state.tab = tabs[n][0];
      render();
      $("tab-" + state.tab).focus();
    });
    bar.append(t);
  }
  const panel = h("section", { class: "panel", role: "tabpanel", "aria-labelledby": "tab-" + state.tab });
  app.append(bar, panel);
  if (state.tab === "memory") panelMemory(panel);
  else if (state.tab === "remember") panelRemember(panel);
  else if (state.tab === "recall") panelRecall(panel);
  else panelConnect(panel);
}

let lastMemory: MemoryView | null = null;

async function loadMemory(): Promise<void> {
  try {
    lastMemory = await invoke<MemoryView>("memory");
  } catch (e) {
    lastMemory = { signed_in: true, text: null, pending: null, offline: true, as_of: null, error: String(e) };
  }
  if (!lastMemory.signed_in) {
    await refreshStatus();
    render();
    return;
  }
  if (state.tab === "memory") render();
}

function panelMemory(panel: HTMLElement): void {
  const m = lastMemory;
  if (!m) {
    panel.append(h("p", { class: "muted" }, "Loading your memory"));
    void loadMemory();
    return;
  }
  const head = h("div", { class: "row", style: "align-items:center;justify-content:space-between" });
  const label = m.offline
    ? `Offline, as of ${fmt(m.as_of)}`
    : m.error && m.text ? `Showing saved copy from ${fmt(m.as_of)}` : `Updated ${fmt(m.as_of)}`;
  head.append(h("span", { class: "badge" }, label));
  const refreshBtn = h("button", { class: "link" }, "Refresh");
  refreshBtn.addEventListener("click", () => { lastMemory = null; render(); });
  head.append(refreshBtn);
  panel.append(head);
  if (m.error) panel.append(h("p", { class: "note err" }, m.error));
  panel.append(h("div", { class: "scroll", tabindex: "0", "aria-label": "Your memory now" }, h("pre", {}, m.text ?? "Nothing to show yet.")));
  if (m.pending && m.pending > 0) {
    const b = h("button", {}, `Review ${m.pending} proposed rule${m.pending === 1 ? "" : "s"}`);
    b.addEventListener("click", () => void invoke("open_url", { url: BASE + "/review" }).catch(() => undefined));
    panel.append(b);
  }
}

function panelRemember(panel: HTMLElement): void {
  const ta = h("textarea", { id: "rem", "aria-label": "What should AgentRecall remember?", placeholder: "A fact, a decision, a preference" });
  const out = h("p", { class: "note", role: "status" });
  const btn = h("button", { class: "primary" }, "Remember");
  btn.addEventListener("click", async () => {
    (btn as HTMLButtonElement).disabled = true;
    out.className = "note";
    out.textContent = "Saving";
    try {
      const line = await invoke<string>("remember", { content: (ta as HTMLTextAreaElement).value });
      out.className = "note ok";
      out.textContent = line;
      (ta as HTMLTextAreaElement).value = "";
    } catch (e) {
      out.className = "note err";
      out.textContent = String(e);
    }
    (btn as HTMLButtonElement).disabled = false;
  });
  panel.append(ta, h("div", { class: "row" }, btn), out);
}

let lastRecall: RecallView | null = null;

function panelRecall(panel: HTMLElement): void {
  const input = h("input", { type: "search", id: "q", "aria-label": "Search your memory", placeholder: "Search your memory" });
  const btn = h("button", { class: "primary" }, "Search");
  const out = h("p", { class: "note", role: "status" });
  const list = h("div", { class: "scroll", tabindex: "0", "aria-label": "Recall results" });
  const show = (v: RecallView): void => {
    list.replaceChildren();
    for (const r of v.results) list.append(h("div", { class: "item" }, r));
    out.className = v.error ? "note err" : "note";
    out.textContent = v.offline ? `Offline, as of ${fmt(v.as_of)}. Showing "${v.query}" from the last search.` : v.error ?? "";
  };
  if (lastRecall) show(lastRecall);
  const go = async (): Promise<void> => {
    (btn as HTMLButtonElement).disabled = true;
    out.className = "note";
    out.textContent = "Searching";
    try {
      lastRecall = await invoke<RecallView>("recall", { query: (input as HTMLInputElement).value });
      show(lastRecall);
    } catch (e) {
      out.className = "note err";
      out.textContent = String(e);
    }
    (btn as HTMLButtonElement).disabled = false;
  };
  btn.addEventListener("click", () => void go());
  input.addEventListener("keydown", (ev) => { if ((ev as KeyboardEvent).key === "Enter") void go(); });
  panel.append(h("div", { class: "row" }, input, btn), out, list);
}

let commands: ConnectCommands | null = null;

function panelConnect(panel: HTMLElement): void {
  const out = h("p", { class: "note", role: "status" });
  const build = (c: ConnectCommands): void => {
    const rows: Array<[string, string]> = [["Claude Code", c.claude], ["Codex", c.codex], ["Cursor", c.cursor]];
    for (const [name, cmd] of rows) {
      const b = h("button", {}, `Copy ${name} command`);
      b.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(cmd);
          out.className = "note ok";
          out.textContent = `${name} command copied.`;
        } catch {
          out.className = "note err";
          out.textContent = "Could not copy. Select the text below instead.";
        }
      });
      panel.insertBefore(h("div", { class: "cmd" }, b, h("code", {}, cmd)), out);
    }
  };
  panel.append(h("p", { class: "muted small" }, "Run one of these in the agent you want to connect, then sign in when it asks."));
  panel.append(out);
  const dash = h("button", { class: "link" }, "Open my dashboard");
  dash.addEventListener("click", () => void invoke("open_url", { url: BASE + "/connect" }).catch(() => undefined));
  panel.append(dash);
  if (commands) build(commands);
  else {
    out.textContent = "Loading commands";
    invoke<ConnectCommands>("connect_commands").then((c) => {
      commands = c;
      out.textContent = c.from_server ? "" : "Offline: showing built-in commands.";
      build(c);
    }).catch((e) => { out.className = "note err"; out.textContent = String(e); });
  }
}

// ---------- boot ----------

async function boot(): Promise<void> {
  await refreshStatus();
  render();
  if (state.status?.signed_in) void loadMemory();
  if (inApp) void listen("signed-out", () => { lastMemory = null; lastRecall = null; void refreshStatus().then(render); });
}

void boot();
window.setInterval(() => { void refreshStatus(); }, 60000);
