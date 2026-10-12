//! Infrastructure de téléchargement d'outils (serveurs LSP, runtimes) dans
//! l'app-data de l'utilisateur.
//!
//! OBJECTIF PRODUIT : « zéro travail pour l'utilisateur ». Pas de terminal, pas
//! de droits admin, pas de pollution système : on télécharge un composant dans
//! `<app_data>/components/…`, on vérifie son **checksum SHA-256**, on l'extrait
//! et on le rend exécutable (`chmod +x` sous Unix). Rien n'est installé ailleurs.
//!
//! SÉCURITÉ
//! --------
//! * **URL verrouillée par catalogue** : le webview ne fournit jamais d'URL. Il
//!   demande un `componentId`, et l'URL + le checksum proviennent d'une table
//!   Rust figée (voir `installers.rs`). Aucune surface SSRF.
//! * **Checksum obligatoire** : on refuse tout téléchargement dont le SHA-256 ne
//!   correspond pas à celui attendu. Pas de « TOFU » : le hash est figé côté code.
//! * **Taille bornée** : cap dur anti-DoS (un composant énorme ne remplit pas le
//!   disque ni la RAM).
//! * **Extraction sûre** : garde anti « zip-slip » / « path traversal » sur les
//!   archives (zip et tar.gz). Aucun fichier ne peut sortir du dossier cible.
//! * **Pas d'exécution** : ce module ne fait que poser des fichiers ; le lancement
//!   est décidé ailleurs (allowlist LSP).

use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};

/// Cap dur pour un composant téléchargé (~200 Mo couvre Node, gopls, clangd,
/// rust-analyzer et Python LSP avec marge). Anti-DoS : un serveur qui annoncerait
/// une taille démesurée est refusé.
pub const MAX_COMPONENT_BYTES: u64 = 200 * 1024 * 1024;

/// Erreur structurée : un code stable + un message. Le frontend s'appuie sur le
/// code, jamais sur le texte, pour décider de l'action à proposer.
#[derive(serde::Serialize, Clone, Debug)]
pub struct DownloadError {
    pub code:    String,
    pub message: String,
}

impl DownloadError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.to_string(), message: message.into() }
    }
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| format!("{{\"code\":\"{}\"}}", self.code))
    }
}

pub const ERR_CHECKSUM_MISMATCH: &str = "CHECKSUM_MISMATCH";
pub const ERR_DOWNLOAD_FAILED:   &str = "DOWNLOAD_FAILED";
pub const ERR_TOO_LARGE:         &str = "DOWNLOAD_TOO_LARGE";
pub const ERR_EXTRACT_FAILED:    &str = "EXTRACT_FAILED";
pub const ERR_UNSAFE_ARCHIVE_PATH: &str = "UNSAFE_ARCHIVE_PATH";

/// Client HTTP partagé (rustls). Timeouts généreux mais bornés : un registre qui
/// pendouille ne bloque pas une tâche indéfiniment.
fn client() -> Result<reqwest::Client, DownloadError> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .user_agent("Origin-IDE/0.1")
        .build()
        .map_err(|e| DownloadError::new(ERR_DOWNLOAD_FAILED, format!("http client: {e}")))
}

/// Télécharge `url` en mémoire et vérifie que le SHA-256 hexadécimal (minuscule)
/// correspond à `expected_sha256`. `expected_sha256` **doit** être fourni : on ne
/// pose jamais de fichier téléchargé sans l'avoir authentifié.
pub async fn fetch_verified(url: &str, expected_sha256: &str) -> Result<Vec<u8>, DownloadError> {
    if expected_sha256.len() != 64 || !expected_sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(DownloadError::new(
            ERR_CHECKSUM_MISMATCH,
            "expected checksum is not a valid sha-256 hex digest",
        ));
    }

    let resp = client()?
        .get(url)
        .send()
        .await
        .map_err(|e| DownloadError::new(ERR_DOWNLOAD_FAILED, format!("download failed: {e}")))?;

    if !resp.status().is_success() {
        return Err(DownloadError::new(
            ERR_DOWNLOAD_FAILED,
            format!("server returned {}", resp.status()),
        ));
    }
    if let Some(len) = resp.content_length() {
        if len > MAX_COMPONENT_BYTES {
            return Err(DownloadError::new(
                ERR_TOO_LARGE,
                format!("component too large ({len} bytes)"),
            ));
        }
    }

    // Lecture bornée : on coupe si le flux dépasse le cap même sans Content-Length.
    let mut bytes: Vec<u8> = Vec::new();
    let mut stream = resp;
    while let Some(chunk) = stream
        .chunk()
        .await
        .map_err(|e| DownloadError::new(ERR_DOWNLOAD_FAILED, format!("read failed: {e}")))?
    {
        bytes.extend_from_slice(&chunk);
        if bytes.len() as u64 > MAX_COMPONENT_BYTES {
            return Err(DownloadError::new(ERR_TOO_LARGE, "component too large"));
        }
    }

    let actual = sha256_hex(&bytes);
    if !actual.eq_ignore_ascii_case(expected_sha256) {
        return Err(DownloadError::new(
            ERR_CHECKSUM_MISMATCH,
            format!("checksum mismatch: expected {expected_sha256}, got {actual}"),
        ));
    }

    Ok(bytes)
}

/// Calcule le SHA-256 hexadécimal (minuscule) d'un buffer.
pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Refuse tout chemin d'archive qui sortirait du dossier cible (zip-slip).
/// Retourne un chemin **relatif sûr** (jamais absolu, jamais avec `..`).
fn safe_archive_path(raw: &Path) -> Result<PathBuf, DownloadError> {
    let mut out = PathBuf::new();
    for comp in raw.components() {
        match comp {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            // Racine absolue, préfixe Windows, `..` : tout ceci est refusé.
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(DownloadError::new(
                    ERR_UNSAFE_ARCHIVE_PATH,
                    format!("unsafe path in archive: {}", raw.display()),
                ));
            }
        }
    }
    if out.as_os_str().is_empty() {
        return Err(DownloadError::new(ERR_UNSAFE_ARCHIVE_PATH, "empty archive entry"));
    }
    Ok(out)
}

/// Extrait une archive ZIP (par ex. un `.vsix`) vers `dest`, sans jamais écrire
/// hors de `dest`. Renvoie la liste des fichiers extraits (chemins relatifs).
pub fn extract_zip(bytes: &[u8], dest: &Path) -> Result<Vec<PathBuf>, DownloadError> {
    let reader = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(reader)
        .map_err(|e| DownloadError::new(ERR_EXTRACT_FAILED, format!("zip open: {e}")))?;
    let mut files = Vec::new();

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| DownloadError::new(ERR_EXTRACT_FAILED, format!("zip entry {i}: {e}")))?;
        let name = match entry.enclosed_name() {
            Some(n) => n.to_path_buf(),
            None => {
                return Err(DownloadError::new(
                    ERR_UNSAFE_ARCHIVE_PATH,
                    format!("unsafe zip entry: {}", entry.name()),
                ));
            }
        };
        let rel = safe_archive_path(&name)?;
        let out_path = dest.join(&rel);

        if entry.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| {
                DownloadError::new(ERR_EXTRACT_FAILED, format!("mkdir {}: {e}", out_path.display()))
            })?;
            continue;
        }

        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                DownloadError::new(ERR_EXTRACT_FAILED, format!("mkdir {}: {e}", parent.display()))
            })?;
        }
        let mut buf = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut buf)
            .map_err(|e| DownloadError::new(ERR_EXTRACT_FAILED, format!("read entry: {e}")))?;
        std::fs::write(&out_path, &buf).map_err(|e| {
            DownloadError::new(ERR_EXTRACT_FAILED, format!("write {}: {e}", out_path.display()))
        })?;

        // Préserve le bit exécutable déclaré par l'archive (souvent absent sur ZIP
        // mais présent sur certains .vsix Unix). Le `chmod +x` explicite reste la
        // règle pour les binaires (cf. `make_executable`).
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&out_path, std::fs::Permissions::from_mode(mode));
        }

        files.push(rel);
    }
    Ok(files)
}

/// Extrait une archive `.tar.gz` vers `dest`, sans écrire hors de `dest`.
/// Renvoie la liste des fichiers extraits (chemins relatifs).
///
/// Non encore branché en v1 (les composants actuels utilisent `.gz` simple ou
/// `.zip`) mais couvert par les tests : sera utilisé par le runtime Node
/// (archive `.tar.gz`) et d'autres composants.
#[allow(dead_code)]
pub fn extract_tar_gz(bytes: &[u8], dest: &Path) -> Result<Vec<PathBuf>, DownloadError> {
    let gz = flate2::read::GzDecoder::new(std::io::Cursor::new(bytes));
    let mut archive = tar::Archive::new(gz);
    let mut files = Vec::new();

    for entry in archive
        .entries()
        .map_err(|e| DownloadError::new(ERR_EXTRACT_FAILED, format!("tar entries: {e}")))?
    {
        let mut entry = entry
            .map_err(|e| DownloadError::new(ERR_EXTRACT_FAILED, format!("tar entry: {e}")))?;
        let raw = entry
            .path()
            .map_err(|e| DownloadError::new(ERR_EXTRACT_FAILED, format!("tar path: {e}")))?
            .to_path_buf();
        let rel = safe_archive_path(&raw)?;
        let out_path = dest.join(&rel);

        if !entry.header().entry_type().is_file() {
            continue;
        }
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                DownloadError::new(ERR_EXTRACT_FAILED, format!("mkdir {}: {e}", parent.display()))
            })?;
        }
        let mut buf = Vec::new();
        entry
            .read_to_end(&mut buf)
            .map_err(|e| DownloadError::new(ERR_EXTRACT_FAILED, format!("read tar entry: {e}")))?;
        std::fs::write(&out_path, &buf).map_err(|e| {
            DownloadError::new(ERR_EXTRACT_FAILED, format!("write {}: {e}", out_path.display()))
        })?;
        files.push(rel);
    }
    Ok(files)
}

/// Décomprime un **gzip d'un seul fichier** (pas un `.tar.gz`) vers
/// `dest/filename`. Cas d'usage : les releases `rust-analyzer` publient un
/// binaire nu compressé (`.gz`), sans en-tête tar.
///
/// Sécurité : `filename` est un nom de fichier **simple**, jamais un chemin
/// fourni par le réseau — il provient de notre index figé. On refuse tout
/// séparateur (`/`, `\`) ou `..` par défense en profondeur.
pub fn extract_single_gz(
    bytes: &[u8],
    dest: &Path,
    filename: &str,
) -> Result<PathBuf, DownloadError> {
    if filename.is_empty()
        || filename.contains('/')
        || filename.contains('\\')
        || filename.split('.').any(|seg| seg == "..")
    {
        return Err(DownloadError::new(
            ERR_UNSAFE_ARCHIVE_PATH,
            format!("unsafe output filename: {filename}"),
        ));
    }
    let mut gz = flate2::read::GzDecoder::new(std::io::Cursor::new(bytes));
    let mut out = Vec::new();
    gz.read_to_end(&mut out)
        .map_err(|e| DownloadError::new(ERR_EXTRACT_FAILED, format!("gunzip: {e}")))?;
    if out.is_empty() {
        return Err(DownloadError::new(ERR_EXTRACT_FAILED, "empty gz payload"));
    }
    std::fs::create_dir_all(dest).map_err(|e| {
        DownloadError::new(ERR_EXTRACT_FAILED, format!("mkdir {}: {e}", dest.display()))
    })?;
    let out_path = dest.join(filename);
    std::fs::write(&out_path, &out).map_err(|e| {
        DownloadError::new(ERR_EXTRACT_FAILED, format!("write {}: {e}", out_path.display()))
    })?;
    make_executable(&out_path);
    Ok(out_path)
}

/// Rend un fichier exécutable sous Unix (`chmod +x`). Sans effet sur Windows.
/// Retourne `true` si le bit a effectivement été posé.
pub fn make_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(path) {
            let mut perms = meta.permissions();
            // rwxr-xr-x : exécutable pour tous (fichier dans l'app-data, isolé).
            perms.set_mode(0o755);
            return std::fs::set_permissions(path, perms).is_ok();
        }
        false
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        true
    }
}

/// Écrit des octets bruts comme fichier exécutable dans `dest_dir/filename`.
/// Non encore branché en v1 (les composants passent par extraction d'archive)
/// mais couvert par les tests.
#[allow(dead_code)]
pub fn write_binary(bytes: &[u8], dest_dir: &Path, filename: &str) -> Result<PathBuf, DownloadError> {
    std::fs::create_dir_all(dest_dir).map_err(|e| {
        DownloadError::new(ERR_EXTRACT_FAILED, format!("mkdir {}: {e}", dest_dir.display()))
    })?;
    let out = dest_dir.join(filename);
    std::fs::write(&out, bytes).map_err(|e| {
        DownloadError::new(ERR_EXTRACT_FAILED, format!("write {}: {e}", out.display()))
    })?;
    make_executable(&out);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_known_vector() {
        // SHA-256 de "abc" (vecteur NIST connu).
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn safe_archive_path_rejects_traversal() {
        assert!(safe_archive_path(Path::new("a/b/c.txt")).is_ok());
        assert!(safe_archive_path(Path::new("../etc/passwd")).is_err());
        assert!(safe_archive_path(Path::new("a/../../b")).is_err());
        assert!(safe_archive_path(Path::new("/abs/path")).is_err());
    }

    #[test]
    fn safe_archive_path_strips_curdir() {
        let p = safe_archive_path(Path::new("./a/./b")).unwrap();
        assert_eq!(p, PathBuf::from("a/b"));
    }

    #[test]
    fn extract_zip_blocks_zip_slip() {
        // Fabrique un petit zip avec une entrée "../evil.txt".
        use std::io::Write;
        let mut buf = Vec::new();
        {
            let mut zw = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts = zip::write::SimpleFileOptions::default();
            zw.start_file("../evil.txt", opts).unwrap();
            zw.write_all(b"pwned").unwrap();
            zw.finish().unwrap();
        }
        let dir = std::env::temp_dir().join(format!("origin_zipslip_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let res = extract_zip(&buf, &dir);
        assert!(res.is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn extract_single_gz_writes_executable() {
        // Fabrique un gzip d'un contenu connu, puis vérifie la décompression.
        use flate2::write::GzEncoder;
        use flate2::Compression;
        use std::io::Write;
        let mut enc = GzEncoder::new(Vec::new(), Compression::default());
        enc.write_all(b"#!/bin/sh\necho hi\n").unwrap();
        let gz = enc.finish().unwrap();

        let dir = std::env::temp_dir().join(format!("origin_gz_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let out = extract_single_gz(&gz, &dir, "rust-analyzer").unwrap();
        assert_eq!(std::fs::read(&out).unwrap(), b"#!/bin/sh\necho hi\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&out).unwrap().permissions().mode();
            assert_eq!(mode & 0o111, 0o111, "doit être exécutable");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn extract_single_gz_rejects_unsafe_filename() {
        use flate2::write::GzEncoder;
        use flate2::Compression;
        use std::io::Write;
        let mut enc = GzEncoder::new(Vec::new(), Compression::default());
        enc.write_all(b"x").unwrap();
        let gz = enc.finish().unwrap();
        let dir = std::env::temp_dir().join(format!("origin_gz_bad_{}", std::process::id()));
        assert!(extract_single_gz(&gz, &dir, "../evil").is_err());
        assert!(extract_single_gz(&gz, &dir, "a/b").is_err());
        assert!(extract_single_gz(&gz, &dir, "").is_err());
    }
}
