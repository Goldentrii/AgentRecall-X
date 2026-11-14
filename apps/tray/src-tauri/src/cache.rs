//! Offline cache in the app data dir. Holds memory text (see README).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct MemoryCache {
    pub text: String,
    pub pending: Option<u32>,
    pub saved_at: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct RecallCache {
    pub query: String,
    pub results: Vec<String>,
    pub saved_at: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Cache {
    pub memory: Option<MemoryCache>,
    pub recall: Option<RecallCache>,
}

pub fn file(dir: &Path) -> PathBuf {
    dir.join("cache.json")
}

pub fn read(dir: &Path) -> Cache {
    std::fs::read_to_string(file(dir)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

pub fn write(dir: &Path, cache: &Cache) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join("cache.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(cache).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, file(dir)).map_err(|e| e.to_string())
}

pub fn clear(dir: &Path) {
    let _ = std::fs::remove_file(file(dir));
}

pub fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ar-tray-test-{tag}-{}", crate::oauth::random_b64url(6)));
        d
    }

    #[test]
    fn roundtrip_and_clear() {
        let d = tmpdir("rt");
        assert_eq!(read(&d), Cache::default());
        let c = Cache {
            memory: Some(MemoryCache { text: "owner card".into(), pending: Some(2), saved_at: 10 }),
            recall: Some(RecallCache { query: "q".into(), results: vec!["a".into()], saved_at: 11 }),
        };
        write(&d, &c).unwrap();
        assert_eq!(read(&d), c);
        clear(&d);
        assert_eq!(read(&d), Cache::default());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn corrupt_file_reads_as_empty() {
        let d = tmpdir("bad");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(file(&d), "{{{ not json").unwrap();
        assert_eq!(read(&d), Cache::default());
        let _ = std::fs::remove_dir_all(&d);
    }
}
