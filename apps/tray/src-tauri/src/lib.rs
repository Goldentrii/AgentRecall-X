mod cache;
mod mcp;
mod oauth;
mod redact;

use redact::redact;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State,
};
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const KEYRING_SERVICE: &str = "AgentRecall Tray";
const KEYRING_USER: &str = "oauth-tokens";
const CONNECT_MD_FALLBACK: (&str, &str, &str) = (
    "claude mcp add --scope user --transport http agent-recall https://agentrecallx.com/mcp",
    "codex mcp add agent-recall --url https://agentrecallx.com/mcp\ncodex mcp login agent-recall",
    "{ \"mcpServers\": { \"agent-recall\": { \"url\": \"https://agentrecallx.com/mcp\" } } }",
);

// ---------- state ----------

pub struct AppState {
    http: reqwest::Client,
    refresh_lock: tokio::sync::Mutex<()>,
    cancel: tokio::sync::Notify,
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
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| redact(&e.to_string()))
}

fn load_tokens() -> Option<Tokens> {
    let s = entry().ok()?.get_password().ok()?;
    serde_json::from_str(&s).ok()
}

fn save_tokens(t: &Tokens) -> Result<(), String> {
    let s = serde_json::to_string(t).map_err(|e| e.to_string())?;
    entry()?.set_password(&s).map_err(|e| redact(&e.to_string()))
}

fn delete_tokens() {
    if let Ok(e) = entry() {
        let _ = e.delete_credential();
    }
}

// ---------- errors ----------

#[derive(Debug)]
enum ApiErr {
    /// could not reach the server
    Network(String),
    /// not signed in, or the server rejected our tokens
    Auth,
    /// the server answered with an error
    Server(String),
}

impl ApiErr {
    fn message(&self) -> String {
        match self {
            ApiErr::Network(m) | ApiErr::Server(m) => redact(m),
            ApiErr::Auth => "Signed out. Sign in again.".into(),
        }
    }
}

fn net_err(e: reqwest::Error) -> ApiErr {
    // reqwest errors may embed the URL; redact defensively and drop the URL.
    ApiErr::Network(redact(&e.without_url().to_string()))
}

fn data_dir(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("agentrecall-tray"))
}

// ---------- URL allowlist ----------

pub fn allowed_url(raw: &str) -> bool {
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
    app.opener().open_url(raw, None::<&str>).map_err(|e| redact(&e.to_string()))
}

// ---------- token endpoint ----------

#[derive(Deserialize)]
struct TokenResp {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
}

async fn token_request(http: &reqwest::Client, endpoint: &str, form: &[(&str, &str)]) -> Result<TokenResp, ApiErr> {
    let resp = http.post(endpoint).form(form).send().await.map_err(net_err)?;
    let status = resp.status();
    if status.is_success() {
        return resp.json::<TokenResp>().await.map_err(|e| ApiErr::Server(format!("bad token reply: {}", e.without_url())));
    }
    if status.as_u16() == 400 || status.as_u16() == 401 {
        return Err(ApiErr::Auth);
    }
    Err(ApiErr::Server(format!("token endpoint answered {status}")))
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
        &format!("{}/token", oauth::BASE),
        &[("grant_type", "refresh_token"), ("refresh_token", &old.refresh), ("client_id", &old.client_id), ("resource", oauth::RESOURCE)],
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
            save_tokens(&new).map_err(ApiErr::Server)?;
            Ok(new)
        }
        Err(ApiErr::Auth) => {
            delete_tokens();
            Err(ApiErr::Auth)
        }
        Err(e) => Err(e),
    }
}

// ---------- MCP call ----------

async fn post_tool(state: &AppState, access: &str, tool: &str, args: serde_json::Value) -> Result<(u16, String), ApiErr> {
    let body = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":tool,"arguments":args}});
    let resp = state
        .http
        .post(oauth::RESOURCE)
        .bearer_auth(access)
        .header("accept", "application/json, text/event-stream")
        .json(&body)
        .send()
        .await
        .map_err(net_err)?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(net_err)?;
    Ok((status, text))
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
            delete_tokens();
            return Err(ApiErr::Auth);
        }
    }
    if !(200..300).contains(&status) {
        return Err(ApiErr::Server(format!("server answered {status}")));
    }
    let msg = mcp::parse_rpc_body(&body, 1).map_err(ApiErr::Server)?;
    mcp::tool_text(&msg).map_err(ApiErr::Server)
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
    let r = state.http.get(format!("{}/healthz", oauth::BASE)).timeout(Duration::from_secs(5)).send().await;
    let (online, version) = match r {
        Ok(resp) if resp.status().is_success() => {
            let v: Option<serde_json::Value> = resp.json().await.ok();
            let version = v.as_ref().and_then(|v| v.get("version")).and_then(|v| v.as_str()).map(str::to_string);
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
async fn memory(app: AppHandle, state: State<'_, AppState>) -> Result<MemoryView, String> {
    if load_tokens().is_none() {
        return Ok(MemoryView { signed_in: false, text: None, pending: None, offline: false, as_of: None, error: None });
    }
    let dir = data_dir(&app);
    match call_tool(&state, "session_start", json!({"project":"auto","mode":"cards"})).await {
        Ok(text) => {
            let pending = mcp::pending_count(&text);
            let mut c = cache::read(&dir);
            let now = cache::now();
            c.memory = Some(cache::MemoryCache { text: text.clone(), pending, saved_at: now });
            let _ = cache::write(&dir, &c);
            Ok(MemoryView { signed_in: true, text: Some(text), pending, offline: false, as_of: Some(now), error: None })
        }
        Err(ApiErr::Auth) => Ok(MemoryView { signed_in: false, text: None, pending: None, offline: false, as_of: None, error: Some(ApiErr::Auth.message()) }),
        Err(e) => {
            let offline = matches!(e, ApiErr::Network(_));
            let c = cache::read(&dir).memory;
            Ok(MemoryView {
                signed_in: true,
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
async fn remember(state: State<'_, AppState>, content: String) -> Result<String, String> {
    let content = content.trim().to_string();
    if content.is_empty() {
        return Err("Write something to remember first.".into());
    }
    if content.chars().count() > 8000 {
        return Err("Too long (8000 characters max).".into());
    }
    let text = call_tool(&state, "remember", json!({"content": content, "project": "auto"})).await.map_err(|e| e.message())?;
    Ok(text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("Saved.").to_string())
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
async fn recall(app: AppHandle, state: State<'_, AppState>, query: String) -> Result<RecallView, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err("Type something to search for.".into());
    }
    if query.chars().count() > 500 {
        return Err("Query too long (500 characters max).".into());
    }
    let dir = data_dir(&app);
    match call_tool(&state, "recall", json!({"query": query, "project": "auto", "limit": 10})).await {
        Ok(text) => {
            let results = mcp::recall_items(&text);
            let now = cache::now();
            let mut c = cache::read(&dir);
            c.recall = Some(cache::RecallCache { query: query.clone(), results: results.clone(), saved_at: now });
            let _ = cache::write(&dir, &c);
            Ok(RecallView { query, results, offline: false, as_of: Some(now), error: None })
        }
        Err(ApiErr::Auth) => Err(ApiErr::Auth.message()),
        Err(e) => {
            let offline = matches!(e, ApiErr::Network(_));
            match cache::read(&dir).recall {
                Some(c) => Ok(RecallView { query: c.query, results: c.results, offline, as_of: Some(c.saved_at), error: Some(e.message()) }),
                None => Err(e.message()),
            }
        }
    }
}

#[derive(Serialize)]
struct ConnectCommands {
    claude: String,
    codex: String,
    cursor: String,
    from_server: bool,
}

#[tauri::command]
async fn connect_commands(state: State<'_, AppState>) -> Result<ConnectCommands, String> {
    let fetched = async {
        let r = state.http.get(format!("{}/connect.md", oauth::BASE)).timeout(Duration::from_secs(6)).send().await.ok()?;
        if !r.status().is_success() {
            return None;
        }
        r.text().await.ok()
    }
    .await;
    let (c, x, u) = fetched.as_deref().map(mcp::parse_connect_md).unwrap_or((None, None, None));
    let from_server = c.is_some() && x.is_some() && u.is_some();
    Ok(ConnectCommands {
        claude: c.unwrap_or_else(|| CONNECT_MD_FALLBACK.0.into()),
        codex: x.unwrap_or_else(|| CONNECT_MD_FALLBACK.1.into()),
        cursor: u.unwrap_or_else(|| CONNECT_MD_FALLBACK.2.into()),
        from_server,
    })
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    open_allowed(&app, &url)
}

fn do_sign_out(app: &AppHandle) {
    delete_tokens();
    cache::clear(&data_dir(app));
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
    let v: serde_json::Value = http
        .get(format!("{}/.well-known/oauth-authorization-server", oauth::BASE))
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .map_err(|e| redact(&e.without_url().to_string()))?
        .json()
        .await
        .map_err(|e| redact(&e.without_url().to_string()))?;
    let get = |k: &str| -> Result<String, String> {
        let s = v.get(k).and_then(|x| x.as_str()).ok_or_else(|| format!("server metadata lacks {k}"))?;
        if !s.starts_with(&format!("{}/", oauth::BASE)) {
            return Err(format!("{k} points outside {}", oauth::BASE));
        }
        Ok(s.to_string())
    };
    Ok((get("authorization_endpoint")?, get("token_endpoint")?, get("registration_endpoint")?))
}

async fn wait_for_callback(listener: tokio::net::TcpListener, expected_state: &str) -> Result<String, String> {
    loop {
        let (mut sock, _) = listener.accept().await.map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 8192];
        let n = match tokio::time::timeout(Duration::from_secs(5), sock.read(&mut buf)).await {
            Ok(Ok(n)) if n > 0 => n,
            _ => continue, // speculative/empty connection
        };
        let req = String::from_utf8_lossy(&buf[..n]).to_string();
        let Some(cb) = oauth::parse_callback(&req) else {
            let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n").await;
            continue;
        };
        let reply = |msg: &str| {
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: {}\r\n\r\n{}",
                page(msg).len(),
                page(msg)
            )
        };
        if !oauth::state_matches(expected_state, cb.state.as_deref()) {
            let _ = sock.write_all(reply("Sign-in failed: state mismatch. Close this tab and try again.").as_bytes()).await;
            return Err("sign-in aborted: state did not match".into());
        }
        if let Some(e) = cb.error {
            let _ = sock.write_all(reply("Sign-in was not completed. You can close this tab.").as_bytes()).await;
            return Err(format!("sign-in refused: {}", redact(&e)));
        }
        match cb.code {
            Some(code) => {
                let _ = sock.write_all(reply("Signed in. You can close this tab and return to AgentRecall.").as_bytes()).await;
                let _ = sock.shutdown().await;
                return Ok(code);
            }
            None => {
                let _ = sock.write_all(reply("Sign-in failed: no code returned.").as_bytes()).await;
                return Err("sign-in returned no code".into());
            }
        }
    }
}

fn page(msg: &str) -> String {
    let safe = msg.replace('&', "&amp;").replace('<', "&lt;");
    format!("<!doctype html><meta charset=utf-8><title>AgentRecall</title><body style=\"background:#04060a;color:#eef1f6;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0\"><p>{safe}</p></body>")
}

#[tauri::command]
async fn sign_in(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let (authorize, token_ep, register_ep) = discover(&state.http).await.map_err(|e| format!("Cannot reach the server: {e}"))?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
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
            .map_err(|e| redact(&e.without_url().to_string()))?;
        if !r.status().is_success() {
            return Err(format!("Registration refused ({}).", r.status()));
        }
        r.json().await.map_err(|e| redact(&e.without_url().to_string()))?
    };
    let client_id = reg.get("client_id").and_then(|v| v.as_str()).ok_or("registration returned no client_id")?.to_string();

    let (verifier, challenge) = oauth::pkce_pair();
    let st = oauth::random_b64url(16);
    let url = oauth::authorize_url(&authorize, &client_id, &redirect, &challenge, &st)?;
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
            ("resource", oauth::RESOURCE),
        ],
    )
    .await
    .map_err(|e| e.message())?;
    let tokens = Tokens {
        access: t.access_token,
        refresh: t.refresh_token.ok_or("server issued no refresh token")?,
        exp: cache::now() + t.expires_in.unwrap_or(3600),
        client_id,
    };
    save_tokens(&tokens)?;
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
        .manage(AppState { http, refresh_lock: tokio::sync::Mutex::new(()), cancel: tokio::sync::Notify::new() })
        .invoke_handler(tauri::generate_handler![status, memory, remember, recall, connect_commands, open_url, sign_out, sign_in, cancel_sign_in])
        .setup(|app| {
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

    #[test]
    fn api_err_messages_are_redacted() {
        let e = ApiErr::Network("boom aro_SECRET123 here".into());
        assert!(!e.message().contains("SECRET123"));
    }

    #[test]
    fn callback_page_escapes_html() {
        assert!(!page("<script>").contains("<script>"));
    }
}
