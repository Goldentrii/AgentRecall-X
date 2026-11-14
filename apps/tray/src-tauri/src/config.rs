//! Where the app talks to and where it keeps its state. In a release build everything here is a constant;
//! with the `test-hooks` feature the same questions are answered by `hooks`.

use std::path::PathBuf;

pub const HOSTED_BASE: &str = "https://agentrecallx.com";

/// The server origin, without a trailing slash.
pub fn base() -> String {
    #[cfg(feature = "test-hooks")]
    if let Some(b) = &crate::hooks::get().base {
        return b.clone();
    }
    HOSTED_BASE.to_string()
}

/// The MCP endpoint, which is also the OAuth `resource`.
pub fn resource() -> String {
    format!("{}/mcp", base())
}

pub fn health_url() -> String {
    #[cfg(feature = "test-hooks")]
    if let Some(u) = &crate::hooks::get().health_url {
        return u.clone();
    }
    format!("{}/healthz", base())
}

pub fn keyring_service() -> &'static str {
    #[cfg(feature = "test-hooks")]
    return crate::hooks::KEYRING_SERVICE;
    #[cfg(not(feature = "test-hooks"))]
    "AgentRecall Tray"
}

pub fn data_dir(default: PathBuf) -> PathBuf {
    #[cfg(feature = "test-hooks")]
    return crate::hooks::test_dir(default);
    #[cfg(not(feature = "test-hooks"))]
    default
}

#[cfg(all(test, not(feature = "test-hooks")))]
mod tests {
    use super::*;

    #[test]
    fn release_build_is_hosted_only() {
        assert_eq!(base(), "https://agentrecallx.com");
        assert_eq!(resource(), "https://agentrecallx.com/mcp");
        assert_eq!(health_url(), "https://agentrecallx.com/healthz");
        assert_eq!(keyring_service(), "AgentRecall Tray");
        assert_eq!(data_dir(PathBuf::from("a/com.agentrecall.tray")), PathBuf::from("a/com.agentrecall.tray"));
    }
}
