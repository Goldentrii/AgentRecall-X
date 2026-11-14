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

/// "⏳ 3 proposed corrections await ..." -> Some(3)
pub fn pending_count(text: &str) -> Option<u32> {
    for line in text.lines() {
        if let Some(idx) = line.find("proposed correction") {
            let before = line[..idx].trim_end();
            let num: String = before.chars().rev().take_while(|c| c.is_ascii_digit()).collect::<Vec<_>>().into_iter().rev().collect();
            if let Ok(n) = num.parse::<u32>() {
                return Some(n);
            }
        }
        if let Some(idx) = line.find("pending correction") {
            let before = line[..idx].trim_end();
            let num: String = before.chars().rev().take_while(|c| c.is_ascii_digit()).collect::<Vec<_>>().into_iter().rev().collect();
            if let Ok(n) = num.parse::<u32>() {
                return Some(n);
            }
        }
    }
    None
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
        assert_eq!(pending_count("x\n⏳ 3 proposed corrections await the owner's confirmation"), Some(3));
        assert_eq!(pending_count("⏳ 1 proposed correction awaits"), Some(1));
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
}
