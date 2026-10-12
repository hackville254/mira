//! VS Code extension support — Level 1 (passive assets) + Level 2 (API shim).
//!
//! This module only handles the *installation* and *inventory* of `.vsix`
//! packages. A `.vsix` is a zip archive whose root contains an
//! `extension/` folder holding `package.json` (the manifest) plus assets.
//!
//! SECURITY MODEL
//! ---------------
//! Installing an extension is a *data* operation: we extract a zip and read a
//! JSON manifest. No third-party code is executed here. Executing an
//! extension's `main.js` (Level 2) is a separate, sandboxed concern handled on
//! the frontend host — this module never runs extension code.
//!
//! All write operations are confined to a dedicated extensions directory:
//!   <app_data_dir>/extensions/<publisher>.<name>-<version>/
//! Extension files can never be written outside that root.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

/// Root directory that holds every installed extension, one folder per
/// `<publisher>.<name>-<version>`.
fn extensions_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve app data dir: {e}"))?;
    Ok(base.join("extensions"))
}

/// A single contribution entry extracted from the manifest. Kept generic so we
/// can surface grammars, snippets and themes with one shape.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct Contribution {
    /// Contribution kind: "grammar" | "snippet" | "theme" | "icon-theme" |
    /// "product-icon-theme".
    pub kind: String,
    /// Language id this contribution applies to (grammars/snippets).
    #[serde(default)]
    pub language: Option<String>,
    /// Path of the asset, relative to the extension folder.
    pub path: String,
    /// Human-readable label (theme name, grammar scope name, ...).
    #[serde(default)]
    pub label: Option<String>,
    /// File extensions (no dot) this contribution claims, when declared.
    #[serde(default)]
    pub file_extensions: Vec<String>,
    /// Exact file names (e.g. `Dockerfile`) this contribution claims.
    #[serde(default)]
    pub file_names: Vec<String>,
}

/// A command declared by an extension (`contributes.commands`). Level 2 uses
/// this to populate the command palette; the handler is registered at runtime.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct DeclaredCommand {
    pub command: String,
    pub title: String,
    #[serde(default)]
    pub category: Option<String>,
}

/// Full description of an installed extension, safe to send to the frontend.
#[derive(serde::Serialize, Clone, Debug)]
pub struct ExtensionInfo {
    pub id: String,             // "<publisher>.<name>"
    pub name: String,
    pub publisher: String,
    pub version: String,
    pub display_name: String,
    pub description: String,
    /// Absolute path of the installed extension folder.
    pub path: String,
    pub contributions: Vec<Contribution>,
    /// Whether the manifest declares an executable entrypoint (main.js).
    pub has_main: bool,
    /// Relative path of the entrypoint, when declared (e.g. "./out/extension.js").
    #[serde(default)]
    pub main: Option<String>,
    /// Commands declared in `contributes.commands`.
    #[serde(default)]
    pub commands: Vec<DeclaredCommand>,
    /// Raw `activationEvents` strings (e.g. `onCommand:foo.bar`).
    #[serde(default)]
    pub activation_events: Vec<String>,
    /// Ids of extensions this one *requires* (`extensionDependencies`). The
    /// extension must not be activated until every id here is installed.
    #[serde(default)]
    pub extension_dependencies: Vec<String>,
    /// Ids this one *bundles* (`extensionPack`). Informational: installing the
    /// pack does not auto-install members here, but the UI can surface them.
    #[serde(default)]
    pub extension_pack: Vec<String>,
    /// Third-party executables the extension ships or runs (declared under the
    /// non-standard `origin.binaries` key). Every entry is a path relative to
    /// the extension folder. The host requires the user's explicit consent at
    /// first use — never silently runs a third-party binary.
    #[serde(default)]
    pub binaries: Vec<String>,
}

/// Subset of the VS Code `package.json` manifest we care about.
#[derive(serde::Deserialize)]
struct Manifest {
    name: String,
    #[serde(default)]
    publisher: String,
    version: String,
    #[serde(default, rename = "displayName")]
    display_name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    main: Option<String>,
    #[serde(default, rename = "activationEvents")]
    activation_events: Vec<String>,
    #[serde(default, rename = "extensionDependencies")]
    extension_dependencies: Vec<String>,
    #[serde(default, rename = "extensionPack")]
    extension_pack: Vec<String>,
    #[serde(default)]
    origin: OriginSection,
    #[serde(default)]
    contributes: Contributes,
}

/// Origin-specific (non-standard) manifest section. Kept separate from the VS
/// Code `contributes` block so an Origin field can never be mistaken for a
/// standard one.
#[derive(serde::Deserialize, Default)]
struct OriginSection {
    /// Executables the extension ships/runs, relative to its folder.
    #[serde(default)]
    binaries: Vec<String>,
}

#[derive(serde::Deserialize, Default)]
struct Contributes {
    #[serde(default)]
    grammars: Vec<GrammarContribution>,
    #[serde(default)]
    snippets: Vec<SnippetContribution>,
    #[serde(default)]
    themes: Vec<ThemeContribution>,
    #[serde(default, rename = "iconThemes")]
    icon_themes: Vec<IconThemeContribution>,
    #[serde(default, rename = "productIconThemes")]
    product_icon_themes: Vec<IconThemeContribution>,
    #[serde(default)]
    commands: Vec<CommandContribution>,
}

/// A command declared in `contributes.commands`. Metadata only — the actual
/// handler is registered at runtime by the extension's `activate()`.
#[derive(serde::Deserialize)]
struct CommandContribution {
    command: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    category: Option<String>,
}

#[derive(serde::Deserialize)]
struct GrammarContribution {
    #[serde(default)]
    language: Option<String>,
    path: String,
    #[serde(default, rename = "scopeName")]
    scope_name: Option<String>,
    /// File extensions this grammar claims (without the leading dot), e.g.
    /// `["rs"]`. Declared per-grammar in the manifest.
    #[serde(default)]
    extensions: Vec<String>,
    /// File *names* this grammar claims, e.g. `["Dockerfile"]`. Used for
    /// languages whose files have no extension.
    #[serde(default)]
    filenames: Vec<String>,
}

#[derive(serde::Deserialize)]
struct SnippetContribution {
    #[serde(default)]
    language: Option<String>,
    path: String,
}

#[derive(serde::Deserialize)]
struct ThemeContribution {
    #[serde(default)]
    label: Option<String>,
    path: String,
}

/// A file-icon or product-icon theme (`contributes.iconThemes` /
/// `contributes.productIconThemes`). Same shape: an `id`, a display `label`
/// and a `path` to the icon-definition JSON.
#[derive(serde::Deserialize)]
struct IconThemeContribution {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    label: Option<String>,
    path: String,
}

/// Build the declared-commands list from a manifest.
fn collect_commands(manifest: &Manifest) -> Vec<DeclaredCommand> {
    manifest
        .contributes
        .commands
        .iter()
        .map(|c| DeclaredCommand {
            command: c.command.clone(),
            title: c.title.clone(),
            category: c.category.clone(),
        })
        .collect()
}

/// Extract only the manifest (`extension/package.json`) from a vsix buffer,
/// without writing anything to disk. Used to preview an install.
fn read_manifest_from_vsix(bytes: &[u8]) -> Result<Manifest, String> {
    let reader = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(reader).map_err(|e| format!("invalid vsix (not a zip): {e}"))?;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = file.name().to_string();
        // The manifest always lives under `extension/package.json`, but some
        // builders emit it at the archive root. Accept both.
        if name == "extension/package.json" || name == "package.json" {
            let mut buf = String::new();
            file.read_to_string(&mut buf)
                .map_err(|e| format!("cannot read manifest: {e}"))?;
            let manifest: Manifest = serde_json::from_str(&buf)
                .map_err(|e| format!("invalid package.json in vsix: {e}"))?;
            return Ok(manifest);
        }
    }
    Err("vsix does not contain extension/package.json".into())
}

/// Guard against zip-slip: reject any archive entry whose path escapes the
/// destination root (absolute paths, `..` traversal).
fn safe_join(root: &Path, entry_name: &str) -> Result<PathBuf, String> {
    let mut out = root.to_path_buf();
    for comp in Path::new(entry_name).components() {
        match comp {
            std::path::Component::Normal(c) => out.push(c),
            std::path::Component::CurDir => {}
            _ => return Err(format!("unsafe path in vsix: {entry_name}")),
        }
    }
    Ok(out)
}

/// Build the contribution list from a manifest, resolving each asset path
/// relative to the extension folder.
fn collect_contributions(manifest: &Manifest) -> Vec<Contribution> {
    let mut out = Vec::new();
    for g in &manifest.contributes.grammars {
        out.push(Contribution {
            kind: "grammar".into(),
            language: g.language.clone(),
            path: g.path.clone(),
            label: g.scope_name.clone(),
            file_extensions: g.extensions.clone(),
            file_names: g.filenames.clone(),
        });
    }
    for s in &manifest.contributes.snippets {
        out.push(Contribution {
            kind: "snippet".into(),
            language: s.language.clone(),
            path: s.path.clone(),
            label: s.language.clone(),
            file_extensions: Vec::new(),
            file_names: Vec::new(),
        });
    }
    for t in &manifest.contributes.themes {
        out.push(Contribution {
            kind: "theme".into(),
            language: None,
            path: t.path.clone(),
            label: t.label.clone(),
            file_extensions: Vec::new(),
            file_names: Vec::new(),
        });
    }
    for it in &manifest.contributes.icon_themes {
        out.push(Contribution {
            kind: "icon-theme".into(),
            language: None,
            path: it.path.clone(),
            label: it.label.clone().or_else(|| it.id.clone()),
            file_extensions: Vec::new(),
            file_names: Vec::new(),
        });
    }
    for it in &manifest.contributes.product_icon_themes {
        out.push(Contribution {
            kind: "product-icon-theme".into(),
            language: None,
            path: it.path.clone(),
            label: it.label.clone().or_else(|| it.id.clone()),
            file_extensions: Vec::new(),
            file_names: Vec::new(),
        });
    }
    out
}

#[tauri::command]
pub fn extensions_root_path(app: tauri::AppHandle) -> Result<String, String> {
    Ok(extensions_root(&app)?.to_string_lossy().to_string())
}

/// List every installed extension, parsed from disk. Never executes anything.
#[tauri::command]
pub fn list_extensions(app: tauri::AppHandle) -> Result<Vec<ExtensionInfo>, String> {
    let root = extensions_root(&app)?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.path().is_dir() {
            continue;
        }
        if let Ok(info) = read_installed_extension(&entry.path()) {
            out.push(info);
        }
    }
    out.sort_by(|a, b| a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase()));
    Ok(out)
}

/// Parse an already-extracted extension folder back into an `ExtensionInfo`.
fn read_installed_extension(dir: &Path) -> Result<ExtensionInfo, String> {
    let manifest_path = dir.join("package.json");
    let raw = fs::read_to_string(&manifest_path).map_err(|e| e.to_string())?;
    let manifest: Manifest = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let id = if manifest.publisher.is_empty() {
        manifest.name.clone()
    } else {
        format!("{}.{}", manifest.publisher, manifest.name)
    };
    let display_name = if manifest.display_name.is_empty() {
        manifest.name.clone()
    } else {
        manifest.display_name.clone()
    };
    Ok(ExtensionInfo {
        id,
        name: manifest.name.clone(),
        publisher: manifest.publisher.clone(),
        version: manifest.version.clone(),
        display_name,
        description: manifest.description.clone(),
        path: dir.to_string_lossy().to_string(),
        contributions: collect_contributions(&manifest),
        has_main: manifest.main.is_some(),
        main: manifest.main.clone(),
        commands: collect_commands(&manifest),
        activation_events: manifest.activation_events.clone(),
        extension_dependencies: manifest.extension_dependencies.clone(),
        extension_pack: manifest.extension_pack.clone(),
        binaries: manifest.origin.binaries.clone(),
    })
}

/// Install a `.vsix` from a local file path. Idempotent: an existing install of
/// the same id is replaced.
///
/// `source_path` must point to a real `.vsix` file chosen by the user via the
/// native dialog — we never fetch remote URLs (no network / no SSRF surface).
#[tauri::command]
pub fn install_extension(app: tauri::AppHandle, source_path: String) -> Result<ExtensionInfo, String> {
    let src = PathBuf::from(&source_path);
    if !src.is_file() {
        return Err(format!("not a file: {source_path}"));
    }
    if src.extension().and_then(|e| e.to_str()) != Some("vsix") {
        return Err("only .vsix files are supported".into());
    }
    let bytes = fs::read(&src).map_err(|e| format!("cannot read vsix: {e}"))?;
    install_from_bytes(&app, &bytes)
}

/// Install a `.vsix` already loaded in memory. Shared by the local-file path and
/// the marketplace download path so extraction/validation logic lives once.
pub fn install_from_bytes(app: &tauri::AppHandle, bytes: &[u8]) -> Result<ExtensionInfo, String> {
    // Parse the manifest first so we can compute the destination folder and
    // reject malformed packages before touching disk.
    let manifest = read_manifest_from_vsix(bytes)?;

    let folder_name = if manifest.publisher.is_empty() {
        format!("{}-{}", manifest.name, manifest.version)
    } else {
        format!("{}.{}-{}", manifest.publisher, manifest.name, manifest.version)
    };

    let root = extensions_root(app)?;
    let dest = root.join(&folder_name);

    // Extract into a temporary sibling folder, then atomically swap it in. This
    // avoids leaving a half-extracted install if the archive is malformed.
    let tmp = root.join(format!(".tmp-{}", folder_name));
    if tmp.exists() {
        fs::remove_dir_all(&tmp).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;

    if let Err(e) = extract_vsix(bytes, &tmp) {
        let _ = fs::remove_dir_all(&tmp);
        return Err(e);
    }

    if dest.exists() {
        fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, &dest).map_err(|e| format!("cannot finalise install: {e}"))?;

    read_installed_extension(&dest)
}

/// Extract a vsix into `dest`. The archive root is `extension/`, so we strip
/// that prefix. Every entry is validated with `safe_join` (anti zip-slip).
fn extract_vsix(bytes: &[u8], dest: &Path) -> Result<(), String> {
    let reader = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(reader).map_err(|e| e.to_string())?;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let raw_name = file.name().to_string();

        // Only keep the `extension/` subtree; ignore the rest (icon metadata,
        // [Content_Types].xml, ...).
        let rel = match raw_name.strip_prefix("extension/") {
            Some(r) => r,
            None => continue,
        };
        if rel.is_empty() || rel.ends_with('/') {
            continue;
        }

        let out_path = safe_join(dest, rel)?;
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut buf = Vec::new();
        file.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        fs::write(&out_path, &buf).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Remove an installed extension by id. Confined to the extensions root.
#[tauri::command]
pub fn uninstall_extension(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let root = extensions_root(&app)?;
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.path().is_dir() {
            continue;
        }
        if let Ok(info) = read_installed_extension(&entry.path()) {
            if info.id == id {
                fs::remove_dir_all(entry.path()).map_err(|e| e.to_string())?;
                return Ok(());
            }
        }
    }
    Err(format!("extension not installed: {id}"))
}

/// Read a contribution asset (grammar/snippet/theme JSON) from an installed
/// extension. Path traversal outside the extension folder is rejected.
#[tauri::command]
pub fn read_extension_asset(app: tauri::AppHandle, id: String, rel_path: String) -> Result<String, String> {
    let root = extensions_root(&app)?;
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.path().is_dir() {
            continue;
        }
        if let Ok(info) = read_installed_extension(&entry.path()) {
            if info.id == id {
                let target = safe_join(&entry.path(), &rel_path)?;
                // Re-check containment after resolution.
                if !target.starts_with(entry.path()) {
                    return Err("asset path escapes extension folder".into());
                }
                return fs::read_to_string(&target).map_err(|e| e.to_string());
            }
        }
    }
    Err(format!("extension not installed: {id}"))
}

/// Inspect an uninstalled vsix (from a local path) without installing it, so the
/// UI can show permissions/contributions before the user confirms.
#[tauri::command]
pub fn inspect_extension(source_path: String) -> Result<ExtensionInfo, String> {
    let src = PathBuf::from(&source_path);
    let bytes = fs::read(&src).map_err(|e| format!("cannot read vsix: {e}"))?;
    let manifest = read_manifest_from_vsix(&bytes)?;
    let id = if manifest.publisher.is_empty() {
        manifest.name.clone()
    } else {
        format!("{}.{}", manifest.publisher, manifest.name)
    };
    let display_name = if manifest.display_name.is_empty() {
        manifest.name.clone()
    } else {
        manifest.display_name.clone()
    };
    Ok(ExtensionInfo {
        id,
        name: manifest.name.clone(),
        publisher: manifest.publisher.clone(),
        version: manifest.version.clone(),
        display_name,
        description: manifest.description.clone(),
        path: String::new(),
        contributions: collect_contributions(&manifest),
        has_main: manifest.main.is_some(),
        main: manifest.main.clone(),
        commands: collect_commands(&manifest),
        activation_events: manifest.activation_events.clone(),
        extension_dependencies: manifest.extension_dependencies.clone(),
        extension_pack: manifest.extension_pack.clone(),
        binaries: manifest.origin.binaries.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn safe_join_rejects_traversal() {
        let root = Path::new("/tmp/ext");
        assert!(safe_join(root, "../evil").is_err());
        assert!(safe_join(root, "/etc/passwd").is_err());
        assert!(safe_join(root, "syntaxes/rust.json").is_ok());
    }

    /// Build an in-memory vsix with a given manifest + extra files under
    /// `extension/`.
    fn build_vsix(manifest_json: &str, extra: &[(&str, &str)]) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let cursor = std::io::Cursor::new(&mut buf);
            let mut zip = zip::ZipWriter::new(cursor);
            let opts: zip::write::FileOptions<'_, ()> =
                zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            zip.start_file("extension/package.json", opts).unwrap();
            zip.write_all(manifest_json.as_bytes()).unwrap();
            for (name, content) in extra {
                zip.start_file(format!("extension/{name}"), opts).unwrap();
                zip.write_all(content.as_bytes()).unwrap();
            }
            zip.finish().unwrap();
        }
        buf
    }

    #[test]
    fn parses_manifest_and_contributions() {
        let manifest = r#"{
            "name": "rust",
            "publisher": "rust-lang",
            "version": "1.0.0",
            "displayName": "Rust",
            "description": "Rust language support",
            "contributes": {
                "grammars": [{ "language": "rust", "path": "./syntaxes/rust.tmLanguage.json", "scopeName": "source.rust" }],
                "snippets": [{ "language": "rust", "path": "./snippets/rust.json" }],
                "themes": [{ "label": "Rust Dark", "path": "./themes/dark.json" }],
                "iconThemes": [{ "id": "material-icon-theme", "label": "Material Icon Theme", "path": "./dist/material-icons.json" }],
                "productIconThemes": [{ "id": "my-product-icons", "label": "My Product Icons", "path": "./dist/product-icons.json" }]
            }
        }"#;
        let vsix = build_vsix(manifest, &[("syntaxes/rust.tmLanguage.json", "{}")]);
        let m = read_manifest_from_vsix(&vsix).expect("manifest parses");
        assert_eq!(m.name, "rust");
        assert_eq!(m.publisher, "rust-lang");
        let contribs = collect_contributions(&m);
        assert_eq!(contribs.len(), 5);
        assert!(contribs.iter().any(|c| c.kind == "grammar" && c.language.as_deref() == Some("rust")));
        assert!(contribs.iter().any(|c| c.kind == "snippet"));
        assert!(contribs.iter().any(|c| c.kind == "theme"));
        assert!(contribs.iter().any(|c| c.kind == "icon-theme"
            && c.label.as_deref() == Some("Material Icon Theme")
            && c.path == "./dist/material-icons.json"));
        assert!(contribs.iter().any(|c| c.kind == "product-icon-theme"
            && c.label.as_deref() == Some("My Product Icons")));
    }

    #[test]
    fn parses_commands_and_activation_events() {
        let manifest = r#"{
            "name": "hello",
            "publisher": "acme",
            "version": "1.0.0",
            "main": "./out/extension.js",
            "activationEvents": ["onCommand:acme.hello", "onStartupFinished"],
            "contributes": {
                "commands": [
                    { "command": "acme.hello", "title": "Say Hello", "category": "Demo" },
                    { "command": "acme.bye", "title": "Say Bye" }
                ]
            }
        }"#;
        let vsix = build_vsix(manifest, &[("out/extension.js", "exports.activate=()=>{}")]);
        let m = read_manifest_from_vsix(&vsix).expect("manifest parses");
        assert_eq!(m.main.as_deref(), Some("./out/extension.js"));
        assert_eq!(m.activation_events.len(), 2);
        let cmds = collect_commands(&m);
        assert_eq!(cmds.len(), 2);
        assert_eq!(cmds[0].command, "acme.hello");
        assert_eq!(cmds[0].title, "Say Hello");
        assert_eq!(cmds[0].category.as_deref(), Some("Demo"));
        assert_eq!(cmds[1].category, None);
    }

    #[test]
    fn extracts_and_rereads_extension() {
        let manifest = r#"{"name":"demo","publisher":"acme","version":"0.2.0","displayName":"Demo"}"#;
        let vsix = build_vsix(manifest, &[("readme.md", "# demo")]);

        let base = std::env::temp_dir().join(format!("origin-ext-test-{}", std::process::id()));
        let dest = base.join("acme.demo-0.2.0");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&dest).unwrap();

        extract_vsix(&vsix, &dest).expect("extracts");
        let info = read_installed_extension(&dest).expect("re-reads");
        assert_eq!(info.id, "acme.demo");
        assert_eq!(info.version, "0.2.0");
        // The readme was extracted under the destination, not the extension root.
        assert!(dest.join("readme.md").is_file());

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn rejects_non_zip() {
        assert!(read_manifest_from_vsix(b"not a zip").is_err());
    }

    #[test]
    fn parses_extension_dependencies_and_pack() {
        let manifest = r#"{
            "name": "pylance-like",
            "publisher": "acme",
            "version": "1.0.0",
            "extensionDependencies": ["acme.core", "acme.langpack"],
            "extensionPack": ["acme.extra-a", "acme.extra-b"]
        }"#;
        let vsix = build_vsix(manifest, &[]);
        let m = read_manifest_from_vsix(&vsix).expect("manifest parses");
        assert_eq!(m.extension_dependencies, vec!["acme.core", "acme.langpack"]);
        assert_eq!(m.extension_pack, vec!["acme.extra-a", "acme.extra-b"]);
    }

    #[test]
    fn extension_dependencies_default_to_empty() {
        let manifest = r#"{"name":"bare","version":"1.0.0"}"#;
        let vsix = build_vsix(manifest, &[]);
        let m = read_manifest_from_vsix(&vsix).expect("manifest parses");
        assert!(m.extension_dependencies.is_empty());
        assert!(m.extension_pack.is_empty());
        assert!(m.origin.binaries.is_empty());
    }

    #[test]
    fn parses_origin_declared_binaries() {
        let manifest = r#"{
            "name": "tool-shipper",
            "publisher": "acme",
            "version": "1.0.0",
            "origin": { "binaries": ["bin/mytool", "bin/helper"] }
        }"#;
        let vsix = build_vsix(manifest, &[]);
        let m = read_manifest_from_vsix(&vsix).expect("manifest parses");
        assert_eq!(m.origin.binaries, vec!["bin/mytool", "bin/helper"]);
    }
}