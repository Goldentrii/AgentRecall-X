mod cache;
mod config;
#[cfg(feature = "test-hooks")]
mod hooks;
mod mcp;
mod oauth;
mod redact;

use redact::redact;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State,
};
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const KEYRING_USER: &str = "oauth-tokens";
const MAX_TOOL_BODY: usize = 1024 * 1024;
const MAX_SMALL_BODY: usize = 64 * 1024;
const FALLBACK_CLAUDE: &str = "claude mcp add --scope user --transport http agent-recall https://agentrecallx.com/mcp";
const FALLBACK_CODEX: &str = "codex mcp add agent-recall --url https://agentrecallx.com/mcp\ncodex mcp login agent-recall";
const FALLBACK_CURSOR: &str = "{ \"mcpServers\": { \"agent-recall\": { \"url\": \"https://agentrecallx.com/mcp\" } } }";

// ---------- state ----------

pub struct AppState {
    http: reqwest::Client,
    refresh_lock: tokio::sync::Mutex<()>,
    cancel: tokio::sync::Notify,
    /// Bumped on every sign-out (including forced ones). Held together with the cache lock.
    generation: AtomicU64,
    cache_lock: Mutex<()>,
    data_dir: OnceLock<PathBuf>,
}

impl AppState {
    fn lock_cache(&self) -> std::sync::MutexGuard<'_, ()> {
        self.cache_lock.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn gen(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// Every sign-out path (button, tray, refresh rejected, second 401, failed token save) ends here:
    /// bump the generation, delete the tokens and the cache under one lock.
    fn sign_out_local(&self) {
        let _g = self.lock_cache();
        self.generation.fetch_add(1, Ordering::SeqCst);
        delete_tokens();
        if let Some(d) = self.data_dir.get() {
            cache::clear(d);
        }
    }

    fn cache_read(&self) -> cache::Cache {
        let _g = self.lock_cache();
        match self.data_dir.get() {
            Some(d) => cache::read(d),
            None => cache::Cache::default(),
        }
    }

    /// Write the cache only if no sign-out happened since `started_gen` and tokens still exist.
    fn cache_update(&self, started_gen: u64, f: impl FnOnce(&mut cache::Cache)) {
        let _g = self.lock_cache();
        if !may_write_cache(self.gen(), started_gen, load_tokens().is_some()) {
            return;
        }
        if let Some(d) = self.data_dir.get() {
            let mut c = cache::read(d);
            f(&mut c);
            let _ = cache::write(d, &c);
        }
    }
}

fn may_write_cache(current_gen: u64, started_gen: u64, signed_in: bool) -> bool {
    current_gen == started_gen && signed_in
}

// ---------- token storage (OS credential store only) ----------

#[derive(Serialize, Deserialize, Clone)]
struct Tokens {
    access: String,
    refresh: String,
    /// unix seconds
    exp: u64,
    client_id: String,
}

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(config::keyring_service(), KEYRING_USER).map_err(|e| redact(&e.to_string()))
}

fn load_tokens() -> Option<Tokens> {
    let s = entry().ok()?.get_password().ok()?;
    serde_json::from_str(&s).ok()
}

fn tokens_blob(t: &Tokens) -> Result<String, String> {
    serde_json::to_string(t).map_err(|e| e.to_string())
}

fn save_tokens(t: &Tokens) -> Result<(), String> {
    let s = tokens_blob(t)?;
    entry()?.set_password(&s).map_err(|e| redact(&e.to_string()))
}

/// Save with one retry. Used after refresh-token rotation, where the old refresh token is already dead.
fn save_tokens_retry(t: &Tokens) -> Result<(), String> {
    save_tokens(t).or_else(|_| {
        std::thread::sleep(Duration::from_millis(250));
        save_tokens(t)
    })
}

fn delete_tokens() {
    if let Ok(e) = entry() {
        let _ = e.delete_credential();
    }
}

// ---------- errors ----------

/// Fixed sentences for what a person can do about a failure. Technical detail never reaches the window: it goes
/// to `log_detail` and the person gets one of these (or, for a tool failure, the server's own words once
/// `mcp::person_safe` accepts them).
const MSG_UNREACHABLE: &str = "Could not reach AgentRecall. Check your connection and try again.";
const MSG_TROUBLE: &str = "AgentRecall had a problem. Try again in a moment.";
const MSG_UNREADABLE: &str = "AgentRecall sent a reply this app could not read. Try again in a moment.";
const MSG_SIGN_IN_SETUP: &str = "Could not start sign-in with AgentRecall. Try again in a moment.";

/// Technical detail for whoever debugs this (stderr). Passes through the redactor like everything else.
fn log_detail(what: &str, detail: &str) {
    eprintln!("[agent-recall-tray] {what}: {}", redact(detail));
}

#[derive(Debug)]
enum ApiErr {
    /// could not reach the server (the detail was logged where it happened)
    Network,
    /// not signed in, or the server rejected our access token and refresh
    Auth,
    /// the server answered with an error (retryable, tokens kept). Holds a sentence already fit for a person.
    Server(String),
    /// the token endpoint said invalid_grant
    Rejected,
}

impl ApiErr {
    fn message(&self) -> String {
        match self {
            ApiErr::Network => MSG_UNREACHABLE.into(),
            ApiErr::Server(m) => redact(m),
            ApiErr::Auth => "Signed out. Sign in again.".into(),
            ApiErr::Rejected => "The server rejected the sign-in. Please try again.".into(),
        }
    }

    /// A failure of the server's reply: log the detail, show a fixed sentence.
    fn trouble(what: &str, detail: &str) -> ApiErr {
        log_detail(what, detail);
        ApiErr::Server(MSG_TROUBLE.into())
    }
}

fn net_err(e: reqwest::Error) -> ApiErr {
    // reqwest errors may embed the URL; drop it, and keep the rest in the log only.
    log_detail("network", &e.without_url().to_string());
    ApiErr::Network
}

fn too_large() -> ApiErr {
    ApiErr::Server("The server reply was too large and was ignored.".into())
}

// ---------- bounded bodies ----------

/// Append `chunk` unless that would pass `max`. Returns false when over the cap.
fn append_capped(buf: &mut Vec<u8>, chunk: &[u8], max: usize) -> bool {
    if buf.len().saturating_add(chunk.len()) > max {
        return false;
    }
    buf.extend_from_slice(chunk);
    true
}

async fn read_limited(mut resp: reqwest::Response, max: usize) -> Result<Vec<u8>, ApiErr> {
    if resp.content_length().map_or(false, |l| l > max as u64) {
        return Err(too_large());
    }
    let mut buf = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(net_err)? {
        if !append_capped(&mut buf, &chunk, max) {
            return Err(too_large());
        }
    }
    Ok(buf)
}

fn is_invalid_grant(body: &[u8]) -> bool {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(|e| e == "invalid_grant"))
        .unwrap_or(false)
}

// ---------- URL allowlist ----------

pub fn allowed_url(raw: &str) -> bool {
    #[cfg(feature = "test-hooks")]
    if hooks::is_test_origin(&config::base(), raw) {
        return true;
    }
    match url::Url::parse(raw) {
        Ok(u) => {
            u.scheme() == "https"
                && u.username().is_empty()
                && u.password().is_none()
                && u.port().is_none()
                && matches!(u.host_str(), Some("agentrecallx.com") | Some("github.com"))
        }
        Err(_) => false,
    }
}

fn open_allowed(app: &AppHandle, raw: &str) -> Result<(), String> {
    if !allowed_url(raw) {
        return Err("That address is not on the allowed list.".into());
    }
    #[cfg(feature = "test-hooks")]
    if let Some(log) = &hooks::get().open_log {
        return hooks::append_open(log, raw);
    }
    app.opener().open_url(raw, None::<&str>).map_err(|e| {
        log_detail("open browser", &e.to_string());
        "Could not open your browser. Open agentrecallx.com yourself.".to_string()
    })
}

// ---------- token endpoint ----------

#[derive(Deserialize)]
struct TokenResp {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
}

/// `resource` is sent exactly as the server's provider expects it (oauth-provider.ts compares the URL href
/// to https://agentrecallx.com/mcp). Only an `invalid_grant` body is treated as a rejected grant.
async fn token_request(http: &reqwest::Client, endpoint: &str, form: &[(&str, &str)]) -> Result<TokenResp, ApiErr> {
    let resp = http.post(endpoint).form(form).send().await.map_err(net_err)?;
    let status = resp.status();
    let body = read_limited(resp, MAX_SMALL_BODY).await?;
    if status.is_success() {
        return serde_json::from_slice::<TokenResp>(&body).map_err(|_| {
            log_detail("token reply", "success status but the body is not a token response");
            ApiErr::Server(MSG_UNREADABLE.into())
        });
    }
    if is_invalid_grant(&body) {
        return Err(ApiErr::Rejected);
    }
    Err(ApiErr::trouble("token endpoint", &format!("status {status}")))
}

async fn refresh(state: &AppState, old: &Tokens) -> Result<Tokens, ApiErr> {
    let _g = state.refresh_lock.lock().await;
    // another task may have refreshed while we waited
    if let Some(cur) = load_tokens() {
        if cur.access != old.access && cur.exp > cache::now() + 30 {
            return Ok(cur);
        }
    }
    let r = token_request(
        &state.http,
        &format!("{}/token", config::base()),
        &[("grant_type", "refresh_token"), ("refresh_token", &old.refresh), ("client_id", &old.client_id), ("resource", &config::resource())],
    )
    .await;
    match r {
        Ok(t) => {
            let new = Tokens {
                access: t.access_token,
                refresh: t.refresh_token.unwrap_or_else(|| old.refresh.clone()),
                exp: cache::now() + t.expires_in.unwrap_or(3600),
                client_id: old.client_id.clone(),
            };
            if save_tokens_retry(&new).is_err() {
                // The server already rotated the refresh token; the stored one is dead. Do not limp on.
                state.sign_out_local();
                return Err(ApiErr::Server(
                    "Your sign-in was renewed but could not be saved to Windows Credential Manager, so you have been signed out. Sign in again.".into(),
                ));
            }
            Ok(new)
        }
        Err(ApiErr::Rejected) => {
            state.sign_out_local();
            Err(ApiErr::Auth)
        }
        Err(e) => Err(e), // network / 5xx / other 4xx: keep the tokens, retryable
    }
}

// ---------- MCP call ----------

/// The hosted endpoint is stateless (serve.ts: sessionIdGenerator undefined, enableJsonResponse), so tools/call
/// works without an initialize. SDK 1.29 requires `Accept: application/json, text/event-stream` and treats a
/// missing MCP-Protocol-Version header as the default version.
async fn post_tool(state: &AppState, access: &str, tool: &str, args: serde_json::Value) -> Result<(u16, Vec<u8>), ApiErr> {
    let body = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":tool,"arguments":args}});
    let resp = state
        .http
        .post(config::resource())
        .bearer_auth(access)
        .header("accept", "application/json, text/event-stream")
        .json(&body)
        .send()
        .await
        .map_err(net_err)?;
    let status = resp.status().as_u16();
    let bytes = read_limited(resp, MAX_TOOL_BODY).await?;
    Ok((status, bytes))
}

async fn call_tool(state: &AppState, tool: &str, args: serde_json::Value) -> Result<String, ApiErr> {
    let mut tokens = load_tokens().ok_or(ApiErr::Auth)?;
    if tokens.exp <= cache::now() + 60 {
        tokens = refresh(state, &tokens).await?;
    }
    let (mut status, mut body) = post_tool(state, &tokens.access, tool, args.clone()).await?;
    if status == 401 {
        tokens = refresh(state, &tokens).await?;
        (status, body) = post_tool(state, &tokens.access, tool, args).await?;
        if status == 401 {
            state.sign_out_local();
            return Err(ApiErr::Auth);
        }
    }
    if !(200..300).contains(&status) {
        return Err(ApiErr::trouble("tools/call", &format!("status {status}")));
    }
    let text = String::from_utf8_lossy(&body).to_string();
    let msg = mcp::parse_rpc_body(&text, 1).map_err(|d| {
        log_detail("tools/call reply", &d);
        ApiErr::Server(MSG_UNREADABLE.into())
    })?;
    mcp::tool_text(&msg).map_err(|f| match f {
        mcp::ToolFailure::Protocol(d) => {
            log_detail("tools/call reply", &d);
            ApiErr::Server(MSG_UNREADABLE.into())
        }
        mcp::ToolFailure::Reported(t) => {
            log_detail("tool error", &t);
            ApiErr::Server(mcp::person_safe(&t).unwrap_or_else(|| MSG_TROUBLE.into()))
        }
    })
}

// ---------- commands ----------

#[derive(Serialize)]
struct Status {
    online: bool,
    version: Option<String>,
    signed_in: bool,
    checked_at: u64,
}

#[tauri::command]
async fn status(state: State<'_, AppState>) -> Result<Status, String> {
    let signed_in = load_tokens().is_some();
    let r = state.http.get(config::health_url()).timeout(Duration::from_secs(5)).send().await;
    let (online, version) = match r {
        Ok(resp) if resp.status().is_success() => {
            let body = read_limited(resp, MAX_SMALL_BODY).await.unwrap_or_default();
            let v: Option<serde_json::Value> = serde_json::from_slice(&body).ok();
            let version = v.as_ref().and_then(|v| v.get("version")).and_then(|v| v.as_str()).map(|s| cache::truncate_bytes(s, 32));
            (v.as_ref().and_then(|v| v.get("ok")).and_then(|v| v.as_bool()).unwrap_or(false), version)
        }
        _ => (false, None),
    };
    Ok(Status { online, version, signed_in, checked_at: cache::now() })
}

#[derive(Serialize)]
struct MemoryView {
    signed_in: bool,
    text: Option<String>,
    pending: Option<u32>,
    offline: bool,
    as_of: Option<u64>,
    error: Option<String>,
}

#[tauri::command]
async fn memory(state: State<'_, AppState>) -> Result<MemoryView, String> {
    if load_tokens().is_none() {
        return Ok(MemoryView { signed_in: false, text: None, pending: None, offline: false, as_of: None, error: None });
    }
    let started = state.gen();
    // `project` is omitted: on the hosted server it defaults to "auto", which detectProject() resolves to the
    // tenant's default project ("main", tenant-paths.ts) regardless of what a client sends.
    match call_tool(&state, "session_start", json!({"mode":"cards"})).await {
        Ok(text) => {
            let text = cache::truncate_bytes(&text, cache::MAX_MEMORY_BYTES);
            let pending = mcp::pending_count(&text);
            let now = cache::now();
            let t = text.clone();
            state.cache_update(started, move |c| c.memory = Some(cache::MemoryCache { text: t, pending, saved_at: now }));
            Ok(MemoryView { signed_in: true, text: Some(text), pending, offline: false, as_of: Some(now), error: None })
        }
        Err(ApiErr::Auth) => Ok(MemoryView { signed_in: false, text: None, pending: None, offline: false, as_of: None, error: Some(ApiErr::Auth.message()) }),
        Err(e) => {
            let offline = matches!(e, ApiErr::Network);
            // never show cached text for an account that has since signed out
            let c = if load_tokens().is_some() { state.cache_read().memory } else { None };
            Ok(MemoryView {
                signed_in: load_tokens().is_some(),
                text: c.as_ref().map(|m| m.text.clone()),
                pending: c.as_ref().and_then(|m| m.pending),
                offline,
                as_of: c.as_ref().map(|m| m.saved_at),
                error: Some(e.message()),
            })
        }
    }
}

#[tauri::command]
async fn remember(state: State<'_, AppState>, content: String) -> Result<(), String> {
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err("Write something to remember first.".into());
    }
    if content.chars().count() > 8000 {
        return Err("Too long (8000 characters max).".into());
    }
    // The server's confirmation names an internal storage path; the person is told "Saved" by the window instead.
    call_tool(&state, "remember", json!({"content": content})).await.map_err(|e| e.message())?;
    Ok(())
}

#[derive(Serialize)]
struct RecallView {
    query: String,
    results: Vec<String>,
    offline: bool,
    as_of: Option<u64>,
    error: Option<String>,
}

#[tauri::command]
async fn recall(state: State<'_, AppState>, query: String) -> Result<RecallView, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err("Type something to search for.".into());
    }
    if query.chars().count() > 500 {
        return Err("Query too long (500 characters max).".into());
    }
    let started = state.gen();
    match call_tool(&state, "recall", json!({"query": query, "limit": 10})).await {
        Ok(text) => {
            let results: Vec<String> = mcp::recall_items(&text).into_iter().map(|r| cache::truncate_bytes(&r, cache::MAX_RESULT_BYTES)).collect();
            let now = cache::now();
            let (q, r) = (query.clone(), results.clone());
            state.cache_update(started, move |c| c.recall = Some(cache::RecallCache { query: q, results: r, saved_at: now }));
            Ok(RecallView { query, results, offline: false, as_of: Some(now), error: None })
        }
        Err(ApiErr::Auth) => Err(ApiErr::Auth.message()),
        Err(e) => {
            let offline = matches!(e, ApiErr::Network);
            let cached = if load_tokens().is_some() { state.cache_read().recall } else { None };
            match cached {
                Some(c) => Ok(RecallView { query: c.query, results: c.results, offline, as_of: Some(c.saved_at), error: Some(e.message()) }),
                None => Err(e.message()),
            }
        }
    }
}

#[derive(Serialize, Debug, PartialEq)]
struct ConnectCommands {
    claude: String,
    codex: String,
    cursor: String,
    from_server: bool,
}

/// connect.md is untrusted text that ends up on the clipboard: keep a command only if it passes the strict
/// shape check; otherwise use the built-in one.
fn validated_commands(parsed: (Option<String>, Option<String>, Option<String>)) -> ConnectCommands {
    let (c, x, u) = parsed;
    let c = c.filter(|s| mcp::is_safe_claude(s));
    let x = x.filter(|s| mcp::is_safe_codex(s));
    let u = u.filter(|s| mcp::is_safe_cursor(s));
    let from_server = c.is_some() && x.is_some() && u.is_some();
    ConnectCommands {
        claude: c.unwrap_or_else(|| FALLBACK_CLAUDE.into()),
        codex: x.unwrap_or_else(|| FALLBACK_CODEX.into()),
        cursor: u.unwrap_or_else(|| FALLBACK_CURSOR.into()),
        from_server,
    }
}

#[tauri::command]
async fn connect_commands(state: State<'_, AppState>) -> Result<ConnectCommands, String> {
    let fetched = async {
        let r = state.http.get(format!("{}/connect.md", config::base())).timeout(Duration::from_secs(6)).send().await.ok()?;
        if !r.status().is_success() {
            return None;
        }
        let b = read_limited(r, MAX_SMALL_BODY).await.ok()?;
        String::from_utf8(b).ok()
    }
    .await;
    Ok(validated_commands(fetched.as_deref().map(mcp::parse_connect_md).unwrap_or((None, None, None))))
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    open_allowed(&app, &url)
}

fn do_sign_out(app: &AppHandle) {
    app.state::<AppState>().sign_out_local();
    let _ = app.emit("signed-out", ());
}

#[tauri::command]
fn sign_out(app: AppHandle) {
    do_sign_out(&app);
}

#[tauri::command]
fn cancel_sign_in(state: State<'_, AppState>) {
    state.cancel.notify_one();
}

async fn discover(http: &reqwest::Client) -> Result<(String, String, String), String> {
    let resp = http
        .get(format!("{}/.well-known/oauth-authorization-server", config::base()))
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .map_err(|e| net_err(e).message())?;
    let body = read_limited(resp, MAX_SMALL_BODY).await.map_err(|e| e.message())?;
    let sign_in_setup = |detail: String| {
        log_detail("sign-in discovery", &detail);
        MSG_SIGN_IN_SETUP.to_string()
    };
    let v: serde_json::Value = serde_json::from_slice(&body).map_err(|_| sign_in_setup("server metadata was not understood".into()))?;
    let get = |k: &str| -> Result<String, String> {
        let s = v.get(k).and_then(|x| x.as_str()).ok_or_else(|| sign_in_setup(format!("server metadata lacks {k}")))?;
        if !s.starts_with(&format!("{}/", config::base())) {
            return Err(sign_in_setup(format!("{k} points outside {}", config::base())));
        }
        Ok(s.to_string())
    };
    Ok((get("authorization_endpoint")?, get("token_endpoint")?, get("registration_endpoint")?))
}

fn page(msg: &str) -> String {
    let safe = msg.replace('&', "&amp;").replace('<', "&lt;");
    format!("<!doctype html><meta charset=utf-8><title>AgentRecall</title><body style=\"background:#04060a;color:#eef1f6;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0\"><p>{safe}</p></body>")
}

fn http_reply(status: &str, msg: &str) -> String {
    let p = page(msg);
    format!("HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: {}\r\n\r\n{p}", p.len())
}

/// Wrong path or wrong/missing state: answer and keep listening, so a stray local request cannot abort a
/// sign-in that is in progress. Only the real callback (our state) ends the wait.
async fn wait_for_callback(listener: tokio::net::TcpListener, expected_state: &str) -> Result<String, String> {
    use oauth::CallbackAction as A;
    loop {
        let (mut sock, _) = listener.accept().await.map_err(|e| {
            log_detail("sign-in listener", &e.to_string());
            "Sign-in could not finish on this PC. Try again.".to_string()
        })?;
        let mut buf = vec![0u8; 8192];
        let n = match tokio::time::timeout(Duration::from_secs(5), sock.read(&mut buf)).await {
            Ok(Ok(n)) if n > 0 => n,
            _ => continue, // speculative/empty connection
        };
        let req = String::from_utf8_lossy(&buf[..n]).to_string();
        match oauth::classify_callback(expected_state, &req) {
            A::NotCallback => {
                let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n").await;
            }
            A::WrongState => {
                let _ = sock.write_all(http_reply("400 Bad Request", "This sign-in link does not belong to the current sign-in. Use the tab opened by AgentRecall.").as_bytes()).await;
            }
            A::ProviderError(e) => {
                let _ = sock.write_all(http_reply("200 OK", "Sign-in was not completed. You can close this tab.").as_bytes()).await;
                log_detail("sign-in provider error", &cache::truncate_bytes(&e, 60));
                return Err("Sign-in was not completed.".into());
            }
            A::NoCode => {
                let _ = sock.write_all(http_reply("200 OK", "Sign-in failed: no code returned.").as_bytes()).await;
                return Err("Sign-in failed. Try again.".into());
            }
            A::Code(code) => {
                let _ = sock.write_all(http_reply("200 OK", "Signed in. You can close this tab and return to AgentRecall.").as_bytes()).await;
                let _ = sock.shutdown().await;
                return Ok(code);
            }
        }
    }
}

#[tauri::command]
async fn sign_in(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    // a Cancel click with no sign-in running leaves a permit behind; drop it
    let _ = tokio::time::timeout(Duration::ZERO, state.cancel.notified()).await;

    let (authorize, token_ep, register_ep) = discover(&state.http).await?;
    let local_listener = |e: std::io::Error| {
        log_detail("sign-in listener", &e.to_string());
        "Could not start sign-in on this PC. Try again.".to_string()
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(local_listener)?;
    let port = listener.local_addr().map_err(local_listener)?.port();
    let redirect = format!("http://127.0.0.1:{port}/callback");

    let reg: serde_json::Value = {
        let r = state
            .http
            .post(&register_ep)
            .json(&json!({
                "client_name": "AgentRecall Tray",
                "redirect_uris": [redirect],
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "token_endpoint_auth_method": "none"
            }))
            .send()
            .await
            .map_err(|e| net_err(e).message())?;
        let status = r.status();
        let body = read_limited(r, MAX_SMALL_BODY).await.map_err(|e| e.message())?;
        if !status.is_success() {
            log_detail("client registration", &format!("refused, status {status}"));
            return Err("AgentRecall did not accept this app for sign-in. Try again later.".into());
        }
        serde_json::from_slice(&body).map_err(|_| {
            log_detail("client registration", "reply was not understood");
            MSG_UNREADABLE.to_string()
        })?
    };
    let client_id = reg.get("client_id").and_then(|v| v.as_str()).ok_or_else(|| {
        log_detail("client registration", "reply has no client_id");
        MSG_UNREADABLE.to_string()
    })?.to_string();

    let (verifier, challenge) = oauth::pkce_pair();
    let st = oauth::random_b64url(16);
    let url = oauth::authorize_url(&authorize, &client_id, &redirect, &challenge, &st, &config::resource())?;
    open_allowed(&app, &url)?;

    let code = tokio::select! {
        r = tokio::time::timeout(Duration::from_secs(300), wait_for_callback(listener, &st)) => {
            match r { Ok(inner) => inner?, Err(_) => return Err("Sign-in timed out.".into()) }
        }
        _ = state.cancel.notified() => return Err("Sign-in cancelled.".into()),
    };

    let t = token_request(
        &state.http,
        &token_ep,
        &[
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("redirect_uri", &redirect),
            ("client_id", &client_id),
            ("code_verifier", &verifier),
            ("resource", &config::resource()),
        ],
    )
    .await
    .map_err(|e| match e {
        ApiErr::Rejected | ApiErr::Auth => "Sign-in failed: the server rejected the sign-in code. Please try again.".to_string(),
        other => format!("Sign-in failed: {}", other.message()),
    })?;
    let tokens = Tokens {
        access: t.access_token,
        refresh: t.refresh_token.ok_or_else(|| {
            log_detail("sign-in", "token reply has no refresh token");
            "Sign-in failed. Try again.".to_string()
        })?,
        exp: cache::now() + t.expires_in.unwrap_or(3600),
        client_id,
    };
    save_tokens_retry(&tokens).map_err(|_| "Sign-in failed: could not save your sign-in to Windows Credential Manager.".to_string())?;
    Ok(())
}

// ---------- tray / window ----------

fn toggle(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
            let _ = w.hide();
        } else {
            show(app);
        }
    }
}

fn show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub fn run() {
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("agentrecall-tray/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("http client");
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            http,
            refresh_lock: tokio::sync::Mutex::new(()),
            cancel: tokio::sync::Notify::new(),
            generation: AtomicU64::new(0),
            cache_lock: Mutex::new(()),
            data_dir: OnceLock::new(),
        })
        .invoke_handler(tauri::generate_handler![status, memory, remember, recall, connect_commands, open_url, sign_out, sign_in, cancel_sign_in])
        .setup(|app| {
            let dir = config::data_dir(app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("agentrecall-tray")));
            let _ = app.state::<AppState>().data_dir.set(dir);
            let open = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
            let signout = MenuItem::with_id(app, "signout", "Sign out", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &signout, &quit])?;
            let mut tray = TrayIconBuilder::with_id("main")
                .tooltip("AgentRecall")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, ev| match ev.id.as_ref() {
                    "open" => show(app),
                    "signout" => do_sign_out(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, ev| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                        toggle(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|w, ev| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = ev {
                api.prevent_close();
                let _ = w.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_allowlist() {
        assert!(allowed_url("https://agentrecallx.com/review"));
        assert!(allowed_url("https://github.com/login"));
        assert!(!allowed_url("http://agentrecallx.com/review"));
        assert!(!allowed_url("https://agentrecallx.com.evil.net/"));
        assert!(!allowed_url("https://evil.net/?u=agentrecallx.com"));
        assert!(!allowed_url("https://user@agentrecallx.com/"));
        assert!(!allowed_url("file:///C:/Windows/System32/calc.exe"));
        assert!(!allowed_url("javascript:alert(1)"));
    }

    #[cfg(feature = "test-hooks")]
    #[test]
    fn test_origin_is_not_allowed_unless_configured() {
        // no AGENTRECALL_TRAY_TEST_BASE_URL in the unit test run: loopback stays refused
        assert!(!allowed_url("http://127.0.0.1:8151/authorize"));
        assert!(allowed_url("https://agentrecallx.com/connect"));
    }

    #[test]
    fn api_err_messages_are_redacted() {
        let e = ApiErr::Server("boom aro_SECRET123 here".into());
        assert!(!e.message().contains("SECRET123"));
    }

    #[test]
    fn failures_reach_the_person_as_fixed_plain_sentences() {
        assert_eq!(ApiErr::Network.message(), MSG_UNREACHABLE);
        assert_eq!(ApiErr::trouble("t", "status 502 Bad Gateway").message(), MSG_TROUBLE);
        for m in [MSG_UNREACHABLE, MSG_TROUBLE, MSG_UNREADABLE, MSG_SIGN_IN_SETUP] {
            assert!(!m.contains("server answered") && !m.contains("JSON") && !m.contains("502") && !m.contains("endpoint"), "{m}");
        }
    }

    #[test]
    fn rejected_code_message_does_not_say_signed_out() {
        assert!(!ApiErr::Rejected.message().contains("Signed out"));
    }

    #[test]
    fn callback_page_escapes_html() {
        assert!(!page("<script>").contains("<script>"));
    }

    /// Token shapes from oauth-store.ts: `aro_` / `arr_` + base64url(32 bytes) = 4 + 43 chars (ACCESS_RE /
    /// REFRESH_RE), client_id is a UUID. The Credential Manager blob limit is 2560 bytes (1280 UTF-16 units).
    #[test]
    fn token_blob_fits_credential_manager() {
        let t = Tokens {
            access: format!("aro_{}", "A".repeat(43)),
            refresh: format!("arr_{}", "B".repeat(43)),
            exp: 1_794_617_287,
            client_id: "ded729a0-fb20-4c0c-8d27-34b02a9ab4c6".into(),
        };
        let blob = tokens_blob(&t).unwrap();
        assert!(blob.encode_utf16().count() < 400, "blob is {} units", blob.encode_utf16().count());
        assert!(blob.encode_utf16().count() < 1200);
    }

    #[test]
    fn only_invalid_grant_counts_as_rejected() {
        assert!(is_invalid_grant(br#"{"error":"invalid_grant","error_description":"x"}"#));
        assert!(!is_invalid_grant(br#"{"error":"invalid_target"}"#));
        assert!(!is_invalid_grant(br#"{"error":"temporarily_unavailable"}"#));
        assert!(!is_invalid_grant(b"<html>502 Bad Gateway</html>"));
        assert!(!is_invalid_grant(b""));
    }

    #[test]
    fn body_cap() {
        let mut b = Vec::new();
        assert!(append_capped(&mut b, &[0u8; 60], 100));
        assert!(append_capped(&mut b, &[0u8; 40], 100));
        assert!(!append_capped(&mut b, &[0u8; 1], 100));
        assert_eq!(b.len(), 100);
    }

    #[test]
    fn cache_write_guard() {
        assert!(may_write_cache(3, 3, true));
        assert!(!may_write_cache(4, 3, true)); // signed out meanwhile
        assert!(!may_write_cache(3, 3, false)); // tokens gone
    }

    #[test]
    fn hostile_connect_commands_fall_back() {
        let good = (
            Some("claude mcp add --scope user --transport http agent-recall https://agentrecallx.com/mcp".to_string()),
            Some("codex mcp add agent-recall --url https://agentrecallx.com/mcp\ncodex mcp login agent-recall".to_string()),
            Some(FALLBACK_CURSOR.to_string()),
        );
        assert!(validated_commands(good).from_server);
        let evil = (
            Some("claude mcp add x https://agentrecallx.com/mcp; calc".to_string()),
            Some("powershell -c calc".to_string()),
            Some("{\"mcpServers\":{\"a\":{\"command\":\"calc\"}}}".to_string()),
        );
        let v = validated_commands(evil);
        assert!(!v.from_server);
        assert_eq!(v.claude, FALLBACK_CLAUDE);
        assert_eq!(v.codex, FALLBACK_CODEX);
        assert_eq!(v.cursor, FALLBACK_CURSOR);
        assert!(validated_commands((None, None, None)).codex == FALLBACK_CODEX);
    }
}
