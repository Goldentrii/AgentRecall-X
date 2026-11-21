//! Offline cache in the app data dir. Holds memory text (see README). Size-capped.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const MAX_MEMORY_BYTES: usize = 64 * 1024;
pub const MAX_RESULT_BYTES: usize = 2 * 1024;
pub const MAX_RESULTS: usize = 20;
pub const MAX_QUERY_BYTES: usize = 500;
pub const MAX_FILE_BYTES: u64 = 256 * 1024;

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

pub fn truncate_bytes(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

/// Cap every cached text. Applied on every write, so the file cannot grow past a fixed bound.
pub fn sanitize(cache: &mut Cache) {
    if let Some(m) = cache.memory.as_mut() {
        m.text = truncate_bytes(&m.text, MAX_MEMORY_BYTES);
    }
    if let Some(r) = cache.recall.as_mut() {
        r.query = truncate_bytes(&r.query, MAX_QUERY_BYTES);
        r.results.truncate(MAX_RESULTS);
        for x in r.results.iter_mut() {
            *x = truncate_bytes(x, MAX_RESULT_BYTES);
        }
    }
}

pub fn file(dir: &Path) -> PathBuf {
    dir.join("cache.json")
}

pub fn read(dir: &Path) -> Cache {
    let f = file(dir);
    match std::fs::metadata(&f) {
        Ok(m) if m.len() <= MAX_FILE_BYTES => {}
        _ => return Cache::default(),
    }
    let mut c: Cache = std::fs::read_to_string(&f).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    sanitize(&mut c);
    c
}

pub fn write(dir: &Path, cache: &Cache) -> Result<(), String> {
    let mut c = cache.clone();
    sanitize(&mut c);
    let bytes = serde_json::to_vec(&c).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("cache too large".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join("cache.json.tmp");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, file(dir)).map_err(|e| e.to_string())
}

pub fn clear(dir: &Path) {
    let _ = std::fs::remove_file(file(dir));
    let _ = std::fs::remove_file(dir.join("cache.json.tmp"));
}

pub fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("ar-tray-test-{tag}-{}", crate::oauth::random_b64url(6)))
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

    #[test]
    fn texts_and_file_are_capped() {
        let d = tmpdir("cap");
        let big = "é".repeat(200_000);
        let c = Cache {
            memory: Some(MemoryCache { text: big.clone(), pending: None, saved_at: 1 }),
            recall: Some(RecallCache { query: big.clone(), results: vec![big.clone(); 50], saved_at: 1 }),
        };
        write(&d, &c).unwrap();
        assert!(std::fs::metadata(file(&d)).unwrap().len() <= MAX_FILE_BYTES);
        let r = read(&d);
        assert!(r.memory.unwrap().text.len() <= MAX_MEMORY_BYTES);
        let rc = r.recall.unwrap();
        assert!(rc.results.len() <= MAX_RESULTS && rc.results.iter().all(|x| x.len() <= MAX_RESULT_BYTES));
        assert!(rc.query.len() <= MAX_QUERY_BYTES);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn oversized_file_is_ignored() {
        let d = tmpdir("huge");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(file(&d), vec![b' '; (MAX_FILE_BYTES + 1) as usize]).unwrap();
        assert_eq!(read(&d), Cache::default());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn truncate_respects_char_boundary() {
        assert_eq!(truncate_bytes("aé", 2), "a");
        assert_eq!(truncate_bytes("abc", 10), "abc");
    }
}
