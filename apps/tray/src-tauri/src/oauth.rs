//! OAuth 2.1 (PKCE S256, loopback redirect, dynamic client registration) against the hosted server.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use sha2::{Digest, Sha256};

pub const BASE: &str = "https://agentrecallx.com";
pub const RESOURCE: &str = "https://agentrecallx.com/mcp";

pub fn random_b64url(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::rngs::OsRng.fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

/// RFC 7636: verifier of 43..128 unreserved chars; challenge = BASE64URL(SHA256(verifier)).
pub fn pkce_pair() -> (String, String) {
    let verifier = random_b64url(32);
    let challenge = pkce_challenge(&verifier);
    (verifier, challenge)
}

pub fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// Constant-ish equality is unnecessary for a local one-shot state, but we reject empty values.
pub fn state_matches(expected: &str, got: Option<&str>) -> bool {
    !expected.is_empty() && got == Some(expected)
}

#[derive(Debug, PartialEq)]
pub struct Callback {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
}

/// Parse the request line of the loopback callback, e.g. `GET /callback?code=x&state=y HTTP/1.1`.
pub fn parse_callback(request: &str) -> Option<Callback> {
    let line = request.lines().next()?;
    let mut parts = line.split_whitespace();
    if parts.next()? != "GET" {
        return None;
    }
    let target = parts.next()?;
    let url = url::Url::parse(&format!("http://127.0.0.1{target}")).ok()?;
    if url.path() != "/callback" {
        return None;
    }
    let mut cb = Callback { code: None, state: None, error: None };
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "code" => cb.code = Some(v.into_owned()),
            "state" => cb.state = Some(v.into_owned()),
            "error" => cb.error = Some(v.into_owned()),
            _ => {}
        }
    }
    Some(cb)
}

pub fn authorize_url(endpoint: &str, client_id: &str, redirect: &str, challenge: &str, state: &str) -> Result<String, String> {
    let mut u = url::Url::parse(endpoint).map_err(|e| e.to_string())?;
    u.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state)
        .append_pair("scope", "memory")
        .append_pair("resource", RESOURCE);
    Ok(u.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_matches_rfc7636_vector() {
        // RFC 7636 appendix B
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn pkce_verifier_shape_and_uniqueness() {
        let (v1, c1) = pkce_pair();
        let (v2, _) = pkce_pair();
        assert!(v1.len() >= 43 && v1.len() <= 128);
        assert!(v1.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert_ne!(v1, v2);
        assert_eq!(c1, pkce_challenge(&v1));
    }

    #[test]
    fn state_check() {
        assert!(state_matches("abc", Some("abc")));
        assert!(!state_matches("abc", Some("abd")));
        assert!(!state_matches("abc", None));
        assert!(!state_matches("", Some("")));
    }

    #[test]
    fn callback_parsing() {
        let cb = parse_callback("GET /callback?code=C1&state=S1 HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
        assert_eq!(cb.code.as_deref(), Some("C1"));
        assert_eq!(cb.state.as_deref(), Some("S1"));
        let err = parse_callback("GET /callback?error=access_denied&state=S1 HTTP/1.1").unwrap();
        assert_eq!(err.error.as_deref(), Some("access_denied"));
        assert!(parse_callback("GET /other?code=1 HTTP/1.1").is_none());
        assert!(parse_callback("POST /callback HTTP/1.1").is_none());
    }

    #[test]
    fn authorize_url_has_required_params() {
        let u = authorize_url("https://agentrecallx.com/authorize", "cid", "http://127.0.0.1:5555/callback", "CH", "ST").unwrap();
        let url = url::Url::parse(&u).unwrap();
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["redirect_uri"], "http://127.0.0.1:5555/callback");
        assert_eq!(q["resource"], RESOURCE);
        assert_eq!(q["state"], "ST");
    }
}
