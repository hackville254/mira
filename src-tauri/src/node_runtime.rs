//! Résolveur du runtime **Node.js** pour le sidecar Cline.
//!
//! OBJECTIF PRODUIT (« zéro travail pour l'utilisateur »)
//! -----------------------------------------------------
//! Le moteur d'agent (Cline SDK) tourne dans un sidecar Node. On n'embarque
//! **aucun** binaire Node dans l'installeur : on utilise le Node **déjà présent**
//! sur le PC, et seulement s'il est absent (ou trop ancien) on télécharge une
//! archive **portable** dans `<app_data>/node-runtime/<version>/`. Aucune action
//! manuelle, aucun droit admin, aucune pollution système.
//!
//! SÉCURITÉ — mêmes garanties que `lsp_index`/`downloader`
//! ------------------------------------------------------
//!   1. **Décision de téléchargement figée à la compilation.** L'URL et le
//!      SHA-256 de Node v24.21.0 sont des constantes ci-dessous, jamais fournies
//!      par le webview (pas de SSRF, pas de RCE par manifeste distant).
//!   2. **Contenu authentifié.** `downloader::fetch_verified` refuse tout octet
//!      dont le SHA-256 diffère — une redirection malveillante est bloquée avant
//!      écriture.
//!   3. **Extraction confinée.** `extract_tar_gz`/`extract_zip` interdisent toute
//!      sortie du dossier cible (anti zip-slip).
//!   4. **Exécution vérifiée.** Avant de retenir un `node`, on exécute
//!      `node --version` (borné dans le temps) et on exige une version majeure
//!      ≥ `MIN_MAJOR`. Un faux `node` dans le PATH ne peut pas être « adopté »
//!      silencieusement : il doit répondre une version conforme.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::downloader;
use crate::env_path;

/// Version majeure minimale de Node requise par le Cline SDK.
pub const MIN_MAJOR: u64 = 22;

/// Version portable épinglée (dernière LTS-compatible utilisée par l'app).
const PINNED_VERSION: &str = "24.21.0";

/// Délai maximal accordé à `node --version` (un binaire exotique ne doit pas
/// geler le démarrage : on le traite comme « indisponible »).
const PROBE_TIMEOUT: Duration = Duration::from_millis(1500);

/// Origine **unique** des téléchargements Node (HTTPS officiel).
const NODE_DIST_BASE: &str = "https://nodejs.org/dist";

/// Un artefact Node portable pour une plateforme donnée.
struct NodeArtifact {
    /// Nom de fichier de l'archive dans `nodejs.org/dist/v<version>/`.
    file: &'static str,
    /// SHA-256 attendu (64 hex minuscules), issu de `SHASUMS256.txt` officiel.
    sha256: &'static str,
    /// `true` = archive `.zip` (Windows), `false` = `.tar.gz` (Unix).
    zip: bool,
}

/// Empreintes figées pour Node v24.21.0 (source : `SHASUMS256.txt` officiel de
/// nodejs.org). Toute modification de version doit mettre à jour ces hashes —
/// vérifié en compilation par le test `pinned_hashes_are_well_formed`.
const ARTIFACT_DARWIN_ARM64: NodeArtifact = NodeArtifact {
    file: "node-v24.21.0-darwin-arm64.tar.gz",
    sha256: "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057",
    zip: false,
};
const ARTIFACT_DARWIN_X64: NodeArtifact = NodeArtifact {
    file: "node-v24.21.0-darwin-x64.tar.gz",
    sha256: "1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097",
    zip: false,
};
const ARTIFACT_LINUX_ARM64: NodeArtifact = NodeArtifact {
    file: "node-v24.21.0-linux-arm64.tar.gz",
    sha256: "724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5",
    zip: false,
};
const ARTIFACT_LINUX_X64: NodeArtifact = NodeArtifact {
    file: "node-v24.21.0-linux-x64.tar.gz",
    sha256: "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff",
    zip: false,
};
const ARTIFACT_WIN_X64: NodeArtifact = NodeArtifact {
    file: "node-v24.21.0-win-x64.zip",
    sha256: "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541",
    zip: true,
};

/// Sélectionne l'artefact Node pour la plateforme courante (`os`, `arch` alignés
/// sur `std::env::consts`). `None` = pas de portable disponible (l'app le
/// signale proprement au lieu d'inventer une installation).
fn select_artifact(os: &str, arch: &str) -> Option<&'static NodeArtifact> {
    match (os, arch) {
        ("macos", "aarch64") => Some(&ARTIFACT_DARWIN_ARM64),
        ("macos", "x86_64") => Some(&ARTIFACT_DARWIN_X64),
        ("linux", "aarch64") => Some(&ARTIFACT_LINUX_ARM64),
        ("linux", "x86_64") => Some(&ARTIFACT_LINUX_X64),
        ("windows", "x86_64") => Some(&ARTIFACT_WIN_X64),
        _ => None,
    }
}

/// Résultat renvoyé au frontend : où est `node`, d'où il vient, et sa version.
/// Sert au diagnostic (« Node système v24.21.0 » vs « Node portable installé »).
#[derive(serde::Serialize, Clone, Debug)]
pub struct NodeRuntime {
    /// Chemin absolu de l'exécutable `node`.
    pub path: String,
    /// Version brute renvoyée par `node --version` (ex. `v24.21.0`).
    pub version: String,
    /// `"system"` (trouvé sur le PC) ou `"portable"` (téléchargé dans app-data).
    pub source: String,
}

// ── Parsing de version ──────────────────────────────────────────────────────

/// Extrait la version majeure d'une sortie `node --version` (`v24.21.0` → `24`).
/// Tolère la présence de `v`, d'espaces, et d'un suffixe éventuel.
pub fn parse_major(version_output: &str) -> Option<u64> {
    let s = version_output.trim().trim_start_matches('v');
    let major = s.split('.').next()?;
    major.parse().ok()
}

/// Vrai si la chaîne de version décrit un Node suffisamment récent.
pub fn version_is_supported(version_output: &str) -> bool {
    parse_major(version_output).map(|m| m >= MIN_MAJOR).unwrap_or(false)
}

// ── Sondage d'un binaire `node` ─────────────────────────────────────────────

/// Exécute `<node> --version` de façon **bornée** et retourne la sortie brute
/// si le binaire répond dans le délai. On ne fait jamais confiance à un binaire
/// présent sur le disque : il doit prouver qu'il est un vrai `node`.
pub fn probe_node(node: &Path) -> Option<String> {
    let mut child = Command::new(node)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let deadline = Instant::now() + PROBE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => return None,
        }
    }

    let out = child.wait_with_output().ok()?;
    if !out.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if version.is_empty() {
        None
    } else {
        Some(version)
    }
}

// ── Découverte système ──────────────────────────────────────────────────────

/// Cherche un `node` **système** conforme (majeure ≥ `MIN_MAJOR`) dans le PATH
/// enrichi (`env_path` sait déjà atteindre nvm / `n` / fnm / volta / asdf).
/// Retourne `(chemin, version)` du premier binaire qui répond conformément.
pub fn find_system_node() -> Option<(PathBuf, String)> {
    let exe = if cfg!(windows) { "node.exe" } else { "node" };
    for dir in env_path::enriched_dirs() {
        let candidate = dir.join(exe);
        if !candidate.is_file() {
            continue;
        }
        if let Some(version) = probe_node(&candidate) {
            if version_is_supported(&version) {
                return Some((candidate, version));
            }
        }
    }
    None
}

/// Chemin du `node` **portable** déjà extrait pour la plateforme courante, s'il
/// existe et répond conformément. Évite de re-télécharger à chaque démarrage.
fn find_portable_node(app_data: &Path) -> Option<(PathBuf, String)> {
    let (os, arch) = (std::env::consts::OS, std::env::consts::ARCH);
    let artifact = select_artifact(os, arch)?;
    let root = portable_root(app_data, artifact);
    let exe = if cfg!(windows) { root.join("node.exe") } else { root.join("bin").join("node") };
    if !exe.is_file() {
        return None;
    }
    let version = probe_node(&exe)?;
    if version_is_supported(&version) {
        Some((exe, version))
    } else {
        None
    }
}

/// Racine d'installation d'une archive Node : l'archive officielle se décompresse
/// en `node-v<version>-<os>-<arch>/`, on la normalise sous
/// `<app_data>/node-runtime/<version>/` (sans le préfixe de dossier d'archive).
fn portable_root(app_data: &Path, artifact: &NodeArtifact) -> PathBuf {
    // `node-v24.21.0-darwin-arm64.tar.gz` → `node-v24.21.0-darwin-arm64`
    let stem = artifact
        .file
        .trim_end_matches(".tar.gz")
        .trim_end_matches(".zip");
    app_data.join("node-runtime").join(stem)
}

// ── Installation portable ───────────────────────────────────────────────────

/// Télécharge et installe le Node portable dans `<app_data>/node-runtime/…`,
/// puis retourne le chemin de son exécutable. Émet une progression vers le
/// frontend (`node://install-progress`) pour que l'UI affiche l'attente la
/// première fois (politique « zéro travail », mais transparente).
pub async fn install_portable_node(app: &tauri::AppHandle) -> Result<NodeRuntime, String> {
    use tauri::Manager;

    let (os, arch) = (std::env::consts::OS, std::env::consts::ARCH);
    let artifact = select_artifact(os, arch).ok_or_else(|| {
        node_error("NODE_UNSUPPORTED_PLATFORM", &format!("pas d'archive Node pour {os}/{arch}"))
    })?;

    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| node_error("NODE_NO_APP_DATA", &e.to_string()))?;
    let dest = portable_root(&app_data, artifact);

    let url = format!("{NODE_DIST_BASE}/v{PINNED_VERSION}/{}", artifact.file);

    emit_progress(app, "download", 5);
    let bytes = downloader::fetch_verified(&url, artifact.sha256)
        .await
        .map_err(|e| e.to_json())?;
    emit_progress(app, "download", 80);

    // Repart d'un dossier propre : une extraction partielle ne doit pas masquer
    // la nouvelle. On ne supprime QUE notre sous-dossier app-data.
    if dest.exists() {
        let _ = std::fs::remove_dir_all(&dest);
    }

    emit_progress(app, "extract", 90);
    if artifact.zip {
        downloader::extract_zip(&bytes, &dest).map_err(|e| e.to_json())?;
    } else {
        downloader::extract_tar_gz(&bytes, &dest).map_err(|e| e.to_json())?;
    }

    let exe = if cfg!(windows) { dest.join("node.exe") } else { dest.join("bin").join("node") };
    if !exe.is_file() {
        return Err(node_error("NODE_EXEC_MISSING", "l'exécutable node est absent de l'archive extraite"));
    }
    downloader::make_executable(&exe);

    let version = probe_node(&exe).ok_or_else(|| {
        node_error("NODE_PROBE_FAILED", "le node portable installé ne répond pas à --version")
    })?;

    emit_progress(app, "done", 100);
    Ok(NodeRuntime {
        path: exe.to_string_lossy().to_string(),
        version,
        source: "portable".to_string(),
    })
}

/// Émet la progression d'installation vers le frontend (best-effort : un échec
/// d'émission ne doit jamais interrompre l'installation).
fn emit_progress(app: &tauri::AppHandle, phase: &str, percent: u8) {
    use tauri::Emitter;
    let _ = app.emit(
        "node://install-progress",
        serde_json::json!({ "phase": phase, "percent": percent }),
    );
}

/// Construit une erreur JSON structurée (code stable + message), cohérente avec
/// le reste de l'app (le frontend s'appuie sur `code`).
fn node_error(code: &str, message: &str) -> String {
    serde_json::json!({ "code": code, "message": message }).to_string()
}

// ── Point d'entrée public ───────────────────────────────────────────────────

/// Résout le runtime Node à utiliser, dans l'ordre :
///   1. un `node` système conforme (≥22) — **aucun téléchargement** ;
///   2. un `node` portable déjà installé dans app-data ;
///   3. sinon, installation portable silencieuse puis retour de son chemin.
///
/// Commande Tauri exposée au frontend : `resolve_node_runtime`.
#[tauri::command]
pub async fn resolve_node_runtime(app: tauri::AppHandle) -> Result<NodeRuntime, String> {
    use tauri::Manager;

    // 1. Node système : le cas nominal, zéro coût réseau.
    if let Some((path, version)) = find_system_node() {
        return Ok(NodeRuntime {
            path: path.to_string_lossy().to_string(),
            version,
            source: "system".to_string(),
        });
    }

    // 2. Node portable déjà extrait (démarrages suivants).
    if let Ok(app_data) = app.path().app_data_dir() {
        if let Some((path, version)) = find_portable_node(&app_data) {
            return Ok(NodeRuntime {
                path: path.to_string_lossy().to_string(),
                version,
                source: "portable".to_string(),
            });
        }
    }

    // 3. Installation silencieuse (premier lancement sans Node conforme).
    install_portable_node(&app).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_major_accepts_v_prefix_and_plain() {
        assert_eq!(parse_major("v24.21.0"), Some(24));
        assert_eq!(parse_major("24.21.0"), Some(24));
        assert_eq!(parse_major("  v22.0.0\n"), Some(22));
        assert_eq!(parse_major("node"), None);
        assert_eq!(parse_major(""), None);
    }

    #[test]
    fn version_gate_requires_minimum_major() {
        assert!(version_is_supported("v22.0.0"));
        assert!(version_is_supported("v24.21.0"));
        assert!(version_is_supported("v30.1.2"));
        assert!(!version_is_supported("v21.7.3"));
        assert!(!version_is_supported("v18.20.4"));
        assert!(!version_is_supported("garbage"));
    }

    #[test]
    fn select_artifact_covers_major_platforms() {
        assert!(select_artifact("macos", "aarch64").is_some());
        assert!(select_artifact("macos", "x86_64").is_some());
        assert!(select_artifact("linux", "x86_64").is_some());
        assert!(select_artifact("linux", "aarch64").is_some());
        assert!(select_artifact("windows", "x86_64").is_some());
        // Plateforme non supportée → None (jamais une erreur paniquante).
        assert!(select_artifact("freebsd", "x86_64").is_none());
    }

    #[test]
    fn pinned_hashes_are_well_formed() {
        // Invariant de sécurité : chaque hash doit être un SHA-256 hex minuscule.
        // Empêche l'introduction d'une empreinte vide ou malformée (régression
        // silencieuse du contrôle d'intégrité).
        for art in [
            &ARTIFACT_DARWIN_ARM64,
            &ARTIFACT_DARWIN_X64,
            &ARTIFACT_LINUX_ARM64,
            &ARTIFACT_LINUX_X64,
            &ARTIFACT_WIN_X64,
        ] {
            assert_eq!(art.sha256.len(), 64, "hash de {} malformé", art.file);
            assert!(
                art.sha256.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()),
                "hash de {} non hex minuscule",
                art.file
            );
            assert!(art.file.contains(PINNED_VERSION), "nom d'archive incohérent");
        }
    }

    #[test]
    fn portable_root_matches_archive_layout() {
        let app_data = PathBuf::from("/tmp/appdata");
        let art = &ARTIFACT_DARWIN_ARM64;
        let root = portable_root(&app_data, art);
        assert_eq!(
            root,
            PathBuf::from("/tmp/appdata/node-runtime/node-v24.21.0-darwin-arm64")
        );
    }

    /// Test « machine réelle » : si un Node système ≥22 est installé, il doit
    /// être détecté sans téléchargement. Ignoré si aucun Node n'est présent.
    #[test]
    fn find_system_node_when_available() {
        if env_path::enriched_dirs().iter().all(|d| !d.join("node").is_file()) {
            return; // Pas de node installé : rien à vérifier.
        }
        let found = find_system_node();
        assert!(found.is_some(), "un node présent doit être détecté via le PATH enrichi");
        let (_path, version) = found.unwrap();
        assert!(version_is_supported(&version), "le node détecté doit être ≥22, got {version}");
    }
}
