//! Open VSX marketplace client — Level 1 (passive assets).
//!
//! Provides search + metadata + download of VS Code extensions from the public
//! Open VSX registry (https://open-vsx.org), then hands the downloaded `.vsix`
//! bytes to [`crate::extensions::install_from_bytes`].
//!
//! SECURITY MODEL
//! ---------------
//! * The webview never supplies a URL. It supplies a *namespace* and *name*,
//!   which we validate against a strict character allowlist and then interpolate
//!   into a URL whose host is hard-coded to `open-vsx.org`. This removes the
//!   SSRF surface a raw "fetch this URL" command would create.
//! * Downloads are capped in size (anti-DoS) and must actually be a zip (the
//!   installer re-validates the manifest and guards against zip-slip).
//! * No extension code is executed — only assets are extracted.

use std::time::Duration;

/// Hard-coded registry host. Never derived from user input.
const REGISTRY: &str = "https://open-vsx.org";
/// Refuse downloads larger than this (defensive cap, ~64 MB).
const MAX_VSIX_BYTES: u64 = 64 * 1024 * 1024;

/// A single search result, trimmed to what the UI needs.
#[derive(serde::Serialize, Clone, Debug)]
pub struct MarketExtension {
    pub namespace: String,
    pub name: String,
    /// `namespace.name` — stable identifier.
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub version: String,
    pub download_count: u64,
    pub average_rating: f64,
    pub verified: bool,
    /// Icon URL (remote, opened by the webview `<img>` — display only).
    pub icon_url: Option<String>,
    /// HTTPS page for the extension, for "learn more".
    pub url: String,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct MarketSearchResult {
    pub total: u64,
    pub offset: u64,
    pub extensions: Vec<MarketExtension>,
}

/// Validate a registry path segment (namespace or extension name). VS Code ids
/// use `[a-z0-9-]`; reject anything that could alter the URL structure.
fn valid_segment(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// Shared HTTP client. `rustls`-backed, with sane timeouts so a hung registry
/// cannot pin a task forever.
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("Origin-IDE/0.1 (+https://open-vsx.org)")
        .build()
        .map_err(|e| format!("cannot build http client: {e}"))
}

/// Search the registry. `query` is URL-encoded by reqwest's `query` builder (no
/// manual string interpolation), avoiding query-injection.
#[tauri::command]
pub async fn market_search(query: String, size: Option<u32>, offset: Option<u32>) -> Result<MarketSearchResult, String> {
    let size = size.unwrap_or(30).min(100);
    let offset = offset.unwrap_or(0);

    let resp = client()?
        .get(format!("{REGISTRY}/api/-/search"))
        .query(&[("query", query.as_str()), ("size", &size.to_string()), ("offset", &offset.to_string())])
        .send()
        .await
        .map_err(|e| format!("search request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("registry returned {}", resp.status()));
    }

    let body: serde_json::Value = resp.json().await.map_err(|e| format!("invalid registry response: {e}"))?;
    Ok(parse_search(&body, offset as u64))
}

/// Extract the fields we care about from a `/api/-/search` payload. Pulled out
/// of the command so it can be unit-tested without a network call.
fn parse_search(body: &serde_json::Value, offset: u64) -> MarketSearchResult {
    let total = body.get("totalSize").and_then(|v| v.as_u64()).unwrap_or(0);
    let mut extensions = Vec::new();
    if let Some(arr) = body.get("extensions").and_then(|v| v.as_array()) {
        for e in arr {
            let namespace = e.get("namespace").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let name = e.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let display_name = e
                .get("displayName")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or(&name)
                .to_string();
            extensions.push(MarketExtension {
                id: format!("{namespace}.{name}"),
                description: e.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                display_name,
                version: e.get("version").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                download_count: e.get("downloadCount").and_then(|v| v.as_u64()).unwrap_or(0),
                average_rating: e.get("averageRating").and_then(|v| v.as_f64()).unwrap_or(0.0),
                verified: e.get("verified").and_then(|v| v.as_bool()).unwrap_or(false),
                icon_url: e
                    .get("files")
                    .and_then(|f| f.get("icon"))
                    .and_then(|v| v.as_str())
                    .map(String::from),
                url: format!("{REGISTRY}/extension/{namespace}/{name}"),
                namespace,
                name,
            });
        }
    }
    MarketSearchResult { total, offset, extensions }
}

/// Build the direct `.vsix` download URL for a specific version. The host is
/// fixed; only validated segments are interpolated.
fn vsix_url(namespace: &str, name: &str, version: &str) -> String {
    format!("{REGISTRY}/api/{namespace}/{name}/{version}/file/{namespace}.{name}-{version}.vsix")
}

/// Download a `.vsix` for `namespace.name@version` and install it, returning the
/// installed extension metadata. The bytes are size-capped and validated by the
/// shared installer (zip-slip guard + manifest parse).
#[tauri::command]
pub async fn market_install(app: tauri::AppHandle, namespace: String, name: String, version: String) -> Result<crate::extensions::ExtensionInfo, String> {
    if !valid_segment(&namespace) || !valid_segment(&name) || !valid_segment(&version) {
        return Err("invalid extension coordinates".into());
    }
    let url = vsix_url(&namespace, &name, &version);

    let resp = client()?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("download failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("download failed: registry returned {}", resp.status()));
    }
    if let Some(len) = resp.content_length() {
        if len > MAX_VSIX_BYTES {
            return Err(format!("vsix too large ({len} bytes)"));
        }
    }

    let bytes = resp.bytes().await.map_err(|e| format!("cannot read download: {e}"))?;
    if bytes.len() as u64 > MAX_VSIX_BYTES {
        return Err("vsix too large".into());
    }

    crate::extensions::install_from_bytes(&app, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_segment_enforces_allowlist() {
        assert!(valid_segment("rust-lang"));
        assert!(valid_segment("rust_analyzer"));
        assert!(valid_segment("Python"));
        assert!(!valid_segment(""));
        assert!(!valid_segment("../etc"));
        assert!(!valid_segment("a/b"));
        assert!(!valid_segment("a?b=c"));
        assert!(!valid_segment("a b"));
        assert!(!valid_segment(&"x".repeat(129)));
    }

    #[test]
    fn vsix_url_is_host_locked() {
        let u = vsix_url("rust-lang", "rust-analyzer", "0.4.3079");
        assert!(u.starts_with("https://open-vsx.org/api/"));
        assert!(u.ends_with("rust-lang.rust-analyzer-0.4.3079.vsix"));
    }

    #[test]
    fn parses_search_payload() {
        let body: serde_json::Value = serde_json::from_str(
            r#"{
                "offset": 0,
                "totalSize": 323,
                "extensions": [
                    {
                        "namespace": "rust-lang",
                        "name": "rust-analyzer",
                        "displayName": "rust-analyzer",
                        "description": "Rust language support",
                        "version": "0.4.3079",
                        "downloadCount": 7241297,
                        "averageRating": 4.5,
                        "verified": true,
                        "files": { "icon": "https://open-vsx.org/api/rust-lang/rust-analyzer/0.4.3079/file/icon.png" }
                    }
                ]
            }"#,
        )
        .unwrap();
        let res = parse_search(&body, 0);
        assert_eq!(res.total, 323);
        assert_eq!(res.extensions.len(), 1);
        let e = &res.extensions[0];
        assert_eq!(e.id, "rust-lang.rust-analyzer");
        assert_eq!(e.display_name, "rust-analyzer");
        assert_eq!(e.download_count, 7241297);
        assert!(e.verified);
        assert!(e.icon_url.is_some());
    }

    #[test]
    fn parse_search_tolerates_missing_fields() {
        let body: serde_json::Value = serde_json::from_str(r#"{"extensions":[{"name":"x"}]}"#).unwrap();
        let res = parse_search(&body, 5);
        assert_eq!(res.total, 0);
        assert_eq!(res.offset, 5);
        assert_eq!(res.extensions[0].display_name, "x");
        assert!(!res.extensions[0].verified);
    }
}
