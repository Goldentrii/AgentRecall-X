//! Token redaction. Every string that may reach a log, an error or the webview passes through here.

const PREFIXES: [&str; 3] = ["aro_", "arr_", "ar_"];

fn is_tok(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

/// Replace AgentRecall tokens (`aro_`, `arr_`, `ar_`), `Bearer <x>` values and `code=`/`code_verifier=`
/// style secrets with `[redacted]`.
pub fn redact(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let chars: Vec<char> = input.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let rest: String = chars[i..chars.len().min(i + 16)].iter().collect();
        let at_boundary = i == 0 || !is_tok(chars[i - 1]);
        if at_boundary && rest.to_ascii_lowercase().starts_with("bearer ") {
            out.push_str("Bearer [redacted]");
            i += 7;
            while i < chars.len() && !chars[i].is_whitespace() && chars[i] != '"' && chars[i] != '\'' {
                i += 1;
            }
            continue;
        }
        let mut matched_key = false;
        for key in ["code_verifier=", "code=", "refresh_token=", "access_token=", "client_secret="] {
            if at_boundary && rest.starts_with(key) {
                out.push_str(key);
                out.push_str("[redacted]");
                i += key.len();
                while i < chars.len() && !matches!(chars[i], '&' | ' ' | '"' | '\'' | '\n') {
                    i += 1;
                }
                matched_key = true;
                break;
            }
        }
        if matched_key {
            continue;
        }
        if at_boundary && PREFIXES.iter().any(|p| rest.starts_with(p)) {
            out.push_str("[redacted]");
            while i < chars.len() && is_tok(chars[i]) {
                i += 1;
            }
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_bare_tokens() {
        let s = redact("failed with aro_AbC123-xyz and arr_QQ99 end");
        assert!(!s.contains("AbC123") && !s.contains("QQ99"));
        assert!(s.contains("[redacted] and [redacted] end"));
    }

    #[test]
    fn redacts_bearer_and_url_secrets() {
        let s = redact("Authorization: Bearer abcdef.ghi\nGET /cb?code=SECRETCODE&state=s1");
        assert!(!s.contains("abcdef") && !s.contains("SECRETCODE"));
        assert!(s.contains("state=s1"));
        let t = redact("code_verifier=VERIFIER123&client_id=x");
        assert!(!t.contains("VERIFIER123") && t.contains("client_id=x"));
    }

    #[test]
    fn leaves_ordinary_text_alone() {
        assert_eq!(redact("server unreachable: timed out"), "server unreachable: timed out");
        assert_eq!(redact("grace_period and bar_x"), "grace_period and bar_x");
    }
}
