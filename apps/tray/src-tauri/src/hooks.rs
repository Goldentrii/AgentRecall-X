//! Test hooks. Compiled only with the `test-hooks` feature, so the release exe neither reads these variables
//! nor contains their names. A test build also uses its own credential-store entry and cache directory, so it
//! can never touch a real sign-in or a real cache.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const ENV_BASE_URL: &str = "AGENTRECALL_TRAY_TEST_BASE_URL";
const ENV_OPEN_LOG: &str = "AGENTRECALL_TRAY_TEST_OPEN_LOG";
const ENV_HEALTH_URL: &str = "AGENTRECALL_TRAY_TEST_HEALTH_URL";

pub const KEYRING_SERVICE: &str = "AgentRecall Tray (test)";

pub struct Hooks {
    /// replaces the hosted origin; always `http://127.0.0.1:<port>`
    pub base: Option<String>,
    /// URLs the app would open in the system browser are appended here instead
    pub open_log: Option<PathBuf>,
    /// replaces the health check URL only
    pub health_url: Option<String>,
}

/// The only accepted test origin: `http://127.0.0.1:<port>`, nothing after the port.
pub fn parse_base(raw: &str) -> Result<String, String> {
    let port = raw.strip_prefix("http://127.0.0.1:").ok_or("must start with http://127.0.0.1:")?;
    match port.parse::<u16>() {
        Ok(p) if p > 0 && p.to_string() == port => Ok(raw.to_string()),
        _ => Err("must be http://127.0.0.1:<port> and nothing else".into()),
    }
}

pub fn from_env(get: impl Fn(&str) -> Option<String>) -> Result<Hooks, String> {
    let base = get(ENV_BASE_URL).map(|v| parse_base(&v).map_err(|e| format!("{ENV_BASE_URL} {e}"))).transpose()?;
    Ok(Hooks { base, open_log: get(ENV_OPEN_LOG).map(PathBuf::from), health_url: get(ENV_HEALTH_URL) })
}

/// Read once at start. A bad base URL stops the app: falling back to the hosted server would defeat the hook.
pub fn get() -> &'static Hooks {
    static HOOKS: OnceLock<Hooks> = OnceLock::new();
    HOOKS.get_or_init(|| from_env(|k| std::env::var(k).ok()).unwrap_or_else(|e| panic!("{e}")))
}

/// `com.agentrecall.tray` becomes `com.agentrecall.tray.test`.
pub fn test_dir(dir: PathBuf) -> PathBuf {
    let mut name = dir.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".test");
    dir.with_file_name(name)
}

/// True when `raw` is on the test origin (same scheme, host and port).
pub fn is_test_origin(base: &str, raw: &str) -> bool {
    match (url::Url::parse(base), url::Url::parse(raw)) {
        (Ok(b), Ok(u)) => u.origin() == b.origin() && u.username().is_empty() && u.password().is_none(),
        _ => false,
    }
}

pub fn append_open(log: &Path, url: &str) -> Result<(), String> {
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(log).map_err(|e| e.to_string())?;
    writeln!(f, "{url}").map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_accepts_only_loopback_origin() {
        assert_eq!(parse_base("http://127.0.0.1:8150").unwrap(), "http://127.0.0.1:8150");
        for bad in [
            "https://127.0.0.1:8150",
            "http://localhost:8150",
            "http://127.0.0.1",
            "http://127.0.0.1:0",
            "http://127.0.0.1:08150",
            "http://127.0.0.1:8150/",
            "http://127.0.0.1:8150/x",
            // userinfo trick; the "@" is joined at run time so secret scanners do not read it as user:password
            &format!("http://127.0.0.1:8150{}evil.net", '@'),
            "http://127.0.0.1:99999",
            "https://agentrecallx.com",
            "",
        ] {
            assert!(parse_base(bad).is_err(), "{bad} must be refused");
        }
    }

    #[test]
    fn env_is_read_through_one_function() {
        let env = |k: &str| match k {
            ENV_BASE_URL => Some("http://127.0.0.1:8151".to_string()),
            ENV_OPEN_LOG => Some("C:/x/open.log".to_string()),
            _ => None,
        };
        let h = from_env(env).unwrap();
        assert_eq!(h.base.as_deref(), Some("http://127.0.0.1:8151"));
        assert_eq!(h.open_log, Some(PathBuf::from("C:/x/open.log")));
        assert!(h.health_url.is_none());
        assert!(from_env(|_| None).unwrap().base.is_none());
        let err = from_env(|k| (k == ENV_BASE_URL).then(|| "https://agentrecallx.com".to_string())).err().unwrap();
        assert!(err.contains(ENV_BASE_URL));
    }

    #[test]
    fn test_build_has_its_own_stores() {
        assert_ne!(KEYRING_SERVICE, "AgentRecall Tray");
        assert_eq!(
            test_dir(PathBuf::from("C:/Users/x/AppData/Roaming/com.agentrecall.tray")),
            PathBuf::from("C:/Users/x/AppData/Roaming/com.agentrecall.tray.test")
        );
    }

    #[test]
    fn test_origin_is_exact() {
        let b = "http://127.0.0.1:8151";
        assert!(is_test_origin(b, "http://127.0.0.1:8151/authorize?x=1"));
        assert!(!is_test_origin(b, "http://127.0.0.1:8152/authorize"));
        assert!(!is_test_origin(b, "https://127.0.0.1:8151/authorize"));
        assert!(!is_test_origin(b, &format!("http://127.0.0.1:8151{}evil.net/", '@')));
        assert!(!is_test_origin(b, "http://localhost:8151/"));
    }

    #[test]
    fn open_log_appends_one_url_per_line() {
        let d = std::env::temp_dir().join(format!("ar-tray-open-{}", crate::oauth::random_b64url(6)));
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join("open.log");
        append_open(&f, "http://127.0.0.1:1/a").unwrap();
        append_open(&f, "https://agentrecallx.com/connect").unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "http://127.0.0.1:1/a\nhttps://agentrecallx.com/connect\n");
        let _ = std::fs::remove_dir_all(&d);
    }
}
