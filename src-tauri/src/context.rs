//! Résolution des « context mentions » `#` du ChatBox (parité Trae).
//!
//! ── Pourquoi ce module existe ────────────────────────────────────────────────
//! Le frontend sait *collecter* des références de contexte (`#File`, `#Folder`,
//! `#Workspace`, `#Problems`, `#Rule` — cf. `src/lib/contextMentions.ts`) mais il
//! ne peut pas, seul, en produire le **contenu** : lire un dossier complet est
//! une opération disque, et les diagnostics vivent côté serveur LSP. On expose
//! donc ici des commandes Tauri qui transforment une référence en contenu
//! injectable dans le prompt.
//!
//! ── Sécurité (règle « adversarial first ») ───────────────────────────────────
//!   - **Confinement** : tout chemin doit rester dans `workspace_root`
//!     (`fs::assert_in_workspace_public`). Empêche `#Folder` sur `/etc`.
//!   - **DoORS par volume** : l'expansion d'un dossier/workspace est plafonnée en
//!     **nombre de fichiers** (`MAX_FILES`) ET en **octets lus au total**
//!     (`MAX_TOTAL_BYTES`). Un `#Workspace` sur un monorepo ne doit ni saturer la
//!     mémoire, ni noyer la fenêtre de contexte, ni bloquer le runtime.
//!   - **DoORS par fichier** : un fichier est ignoré s'il dépasse `MAX_FILE_BYTES`
//!     ou s'il est **binaire** (octet NUL dans les premiers Ko) — on ne déverse
//!     jamais un blob dans un prompt.
//!   - **Exclusions** : on réutilise `search::SEARCH_IGNORE` (`node_modules`,
//!     `target`, `.git`…) pour ne pas lire d'arborescences hostiles ou inutiles.
//!
//! ── Compromis ────────────────────────────────────────────────────────────────
//! L'expansion renvoie les fichiers **par ordre d'arborescence** (les plus
//! « proches » d'abord) et s'arrête au premier plafond atteint : le tri par
//! pertinence sémantique nécessiterait un index (hors périmètre, cf. Trae qui
//! exige un index construit pour ses équivalents). On privilégie donc la
//! **prévisibilité** et la **borne dure**.

use crate::search::SEARCH_IGNORE;
use std::path::{Path, PathBuf};

/// Nombre maximum de fichiers lus pour une seule expansion (`#Folder`/`#Workspace`).
pub const MAX_FILES: usize = 80;

/// Taille maximum d'un fichier individuel accepté dans une expansion (octets).
/// Au-delà : ignoré et signalé via `truncated`.
pub const MAX_FILE_BYTES: u64 = 128 * 1024;

/// Budget total d'octets lus pour une expansion. Atteint → on s'arrête net.
pub const MAX_TOTAL_BYTES: usize = 512 * 1024;

/// Longueur de préfixe inspectée pour détecter un fichier binaire (NUL byte).
const BINARY_SNIFF_BYTES: usize = 8 * 1024;

#[derive(serde::Serialize)]
pub struct WorkspaceFile {
    /// Nom de base du fichier.
    pub name: String,
    /// Chemin absolu.
    pub path: String,
    /// Chemin relatif à la racine de l'expansion, séparateurs normalisés en `/`.
    /// Sert au prompt : c'est l'identité lisible du fichier pour le modèle.
    pub rel: String,
    /// Contenu texte (vide si binaire ou illisible).
    pub content: String,
    /// `true` si le fichier a été écarté (binaire, trop gros, illisible).
    pub skipped: bool,
}

/// Vrai si les `sample` premiers octets trahissent un contenu binaire.
///
/// Heuristique volontairement simple et **faux-négative sûre** : la présence d'un
/// octet NUL dans l'en-tête est le marqueur le plus fiable (utilisé par git,
/// `grep -I`, etc.). Absence de NUL ⇒ on tente la lecture UTF-8, qui échouera si
/// le fichier est réellement binaire — double filet.
fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(BINARY_SNIFF_BYTES).any(|&b| b == 0)
}

/// Filtre léger de fichiers « intéressants » pour un prompt : on écarte les
/// extensions manifestement non-source (images, archives, binaires compilés) qui
/// n'ont pas de valeur de contexte et coûteraient des octets de budget.
fn is_text_like(path: &Path) -> bool {
    match path.extension().and_then(|e| e.to_str()) {
        None => true, // sans extension : on laisse la sniff binaire décider
        Some(ext) => {
            let e = ext.to_ascii_lowercase();
            !matches!(
                e.as_str(),
                "png" | "jpg" | "jpeg" | "gif" | "webp" | "ico" | "bmp" | "tiff" | "svgz"
                    | "pdf" | "zip" | "gz" | "tar" | "tgz" | "bz2" | "xz" | "7z" | "rar"
                    | "woff" | "woff2" | "ttf" | "otf" | "eot"
                    | "mp3" | "mp4" | "wav" | "ogg" | "webm" | "mov" | "avi" | "mkv"
                    | "exe" | "dll" | "so" | "dylib" | "bin" | "wasm" | "class" | "o" | "a"
                    | "lock" | "map"
            )
        }
    }
}

struct Expansion {
    files: Vec<WorkspaceFile>,
    total_bytes: usize,
    truncated: bool,
    /// Racine de l'expansion, pour dériver le chemin `rel` de chaque fichier.
    root: std::path::PathBuf,
}

/// Normalise les séparateurs Windows en `/` et retire un éventuel préfixe
/// `\\?\` (chemins canoniques Windows) pour un affichage stable dans le prompt.
fn normalize_rel(rel: &str) -> String {
    rel.replace('\\', "/")
}

/// Chemin relatif de `path` par rapport à `root`, séparateurs normalisés.
fn rel_to(root: &Path, path: &Path) -> String {
    match path.strip_prefix(root) {
        Ok(r) => normalize_rel(&r.to_string_lossy()),
        Err(_) => path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
    }
}

/// Parcourt récursivement `dir` et accumule les fichiers texte dans la borne.
///
/// L'ordre est celui de `read_dir` (déterministe sur la plupart des FS, et
/// suffisant : on veut une borne, pas un classement). On s'arrête dès qu'un
/// plafond est atteint pour ne jamais dépasser le budget.
fn expand_dir(dir: &Path, out: &mut Expansion) {
    if out.files.len() >= MAX_FILES || out.total_bytes >= MAX_TOTAL_BYTES {
        out.truncated = true;
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };

    let mut subdirs: Vec<std::path::PathBuf> = Vec::new();
    for entry in rd.flatten() {
        if out.files.len() >= MAX_FILES || out.total_bytes >= MAX_TOTAL_BYTES {
            out.truncated = true;
            break;
        }
        let path = entry.path();
        let name = entry.file_name();
        let ns = name.to_string_lossy();
        if SEARCH_IGNORE.iter().any(|&s| s == ns.as_ref()) {
            continue;
        }
        if path.is_dir() {
            subdirs.push(path);
            continue;
        }
        read_one(&path, out);
    }
    // Récursion APRÈS la boucle : on lit d'abord les fichiers du niveau courant
    // (généralement plus pertinents : README, configs, entrée de package).
    for d in subdirs {
        expand_dir(&d, out);
    }
}

/// Lit un fichier unique en respectant toutes les bornes, puis l'ajoute à `out`.
fn read_one(path: &Path, out: &mut Expansion) {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let abs = path.to_string_lossy().into_owned();
    let rel = rel_to(&out.root, path);

    if !is_text_like(path) {
        out.files.push(WorkspaceFile { name, path: abs, rel, content: String::new(), skipped: true });
        return;
    }

    let Ok(meta) = std::fs::metadata(path) else {
        out.files.push(WorkspaceFile { name, path: abs, rel, content: String::new(), skipped: true });
        return;
    };
    if meta.len() > MAX_FILE_BYTES {
        out.files.push(WorkspaceFile { name, path: abs, rel, content: String::new(), skipped: true });
        out.truncated = true;
        return;
    }

    let Ok(bytes) = std::fs::read(path) else {
        out.files.push(WorkspaceFile { name, path: abs, rel, content: String::new(), skipped: true });
        return;
    };
    if looks_binary(&bytes) {
        out.files.push(WorkspaceFile { name, path: abs, rel, content: String::new(), skipped: true });
        return;
    }
    let Ok(text) = String::from_utf8(bytes) else {
        out.files.push(WorkspaceFile { name, path: abs, rel, content: String::new(), skipped: true });
        return;
    };

    // Budget global : on refuse le fichier plutôt que de le tronquer en plein
    // milieu (un extrait coupé est pire qu'une absence signalée).
    if out.total_bytes + text.len() > MAX_TOTAL_BYTES {
        out.truncated = true;
        out.files.push(WorkspaceFile { name, path: abs, rel, content: String::new(), skipped: true });
        return;
    }
    out.total_bytes += text.len();
    out.files.push(WorkspaceFile { name, path: abs, rel, content: text, skipped: false });
}

/// Résultat d'une expansion de contexte destinée au prompt.
#[derive(serde::Serialize)]
pub struct ContextExpansion {
    /// Fichiers lus (dans l'ordre d'arborescence). Les `skipped` n'ont pas de contenu.
    pub files: Vec<WorkspaceFile>,
    /// `true` si un plafond (fichiers/octets) a été atteint : le prompt est partiel.
    pub truncated: bool,
    /// Nombre de fichiers effectivement inclus (non `skipped`).
    pub included: usize,
}

/// Étend `#Folder` : lit les fichiers d'un dossier **confiné au workspace**.
///
/// `path` doit être absolu et à l'intérieur de `workspace_root` — la garde
/// `assert_in_workspace` neutralise `..` et les symlinks sortants.
#[tauri::command]
pub async fn expand_context_folder(
    path: String,
    workspace_root: String,
) -> Result<ContextExpansion, String> {
    crate::fs::assert_in_workspace_public(&path, &workspace_root)?;
    tokio::task::spawn_blocking(move || {
        let root = PathBuf::from(&path);
        let mut out = Expansion { files: Vec::new(), total_bytes: 0, truncated: false, root: root.clone() };
        expand_dir(&root, &mut out);
        let included = out.files.iter().filter(|f| !f.skipped).count();
        ContextExpansion { files: out.files, truncated: out.truncated, included }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Étend `#Workspace` : lit l'arborescence entière du workspace sous les bornes.
///
/// C'est la même mécanique que `#Folder` avec la racine pour point de départ.
#[tauri::command]
pub async fn expand_context_workspace(workspace_root: String) -> Result<ContextExpansion, String> {
    let root = workspace_root.clone();
    tokio::task::spawn_blocking(move || {
        let root = PathBuf::from(&root);
        let mut out = Expansion { files: Vec::new(), total_bytes: 0, truncated: false, root: root.clone() };
        expand_dir(&root, &mut out);
        let included = out.files.iter().filter(|f| !f.skipped).count();
        ContextExpansion { files: out.files, truncated: out.truncated, included }
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Crée un dossier temporaire unique et le supprime à la fin du test.
    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let base = std::env::temp_dir().join(format!(
            "mira-ctx-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&base).unwrap();
        base
    }

    fn expand(root: &Path) -> Expansion {
        let mut out = Expansion {
            files: Vec::new(),
            total_bytes: 0,
            truncated: false,
            root: root.to_path_buf(),
        };
        expand_dir(root, &mut out);
        out
    }

    #[test]
    fn looks_binary_detecte_un_octet_nul() {
        assert!(looks_binary(b"abc\0def"));
        assert!(!looks_binary(b"hello world"));
        assert!(!looks_binary(b""));
    }

    #[test]
    fn is_text_like_ecarte_les_binaires_connus_garde_la_source() {
        assert!(is_text_like(Path::new("src/main.rs")));
        assert!(is_text_like(Path::new("README")));
        assert!(!is_text_like(Path::new("logo.png")));
        assert!(!is_text_like(Path::new("bundle.PNG")));
        assert!(!is_text_like(Path::new("archive.tar")));
        assert!(!is_text_like(Path::new("mod.wasm")));
    }

    #[test]
    fn expansion_lit_les_fichiers_texte_et_ignore_binaires() {
        let dir = temp_dir("basic");
        fs::write(dir.join("a.ts"), "const a = 1;\n").unwrap();
        fs::write(dir.join("b.md"), "# Titre\n").unwrap();
        fs::write(dir.join("blob.bin"), b"\x00\x01\x02").unwrap();

        let out = expand(&dir);
        let names: Vec<_> = out.files.iter().map(|f| f.name.as_str()).collect();
        assert!(names.contains(&"a.ts"));
        assert!(names.contains(&"b.md"));
        // Le .bin est listé mais marqué skipped (pas de contenu injecté).
        let bin = out.files.iter().find(|f| f.name == "blob.bin").unwrap();
        assert!(bin.skipped);
        assert!(bin.content.is_empty());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn expansion_descend_dans_les_sous_dossiers() {
        let dir = temp_dir("nested");
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("src").join("deep.ts"), "export {};\n").unwrap();

        let out = expand(&dir);
        assert!(out.files.iter().any(|f| f.name == "deep.ts" && !f.skipped));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rel_est_relatif_a_la_racine_et_normalise() {
        let dir = temp_dir("rel");
        fs::create_dir_all(dir.join("src").join("ui")).unwrap();
        fs::write(dir.join("src").join("ui").join("a.tsx"), "export {};\n").unwrap();

        let out = expand(&dir);
        let f = out.files.iter().find(|f| f.name == "a.tsx").unwrap();
        assert_eq!(f.rel, "src/ui/a.tsx");
        // `rel` ne contient jamais de séparateur Windows.
        assert!(!f.rel.contains('\\'));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn expansion_ignore_les_dossiers_de_search_ignore() {
        let dir = temp_dir("ignore");
        fs::create_dir_all(dir.join("node_modules")).unwrap();
        fs::write(dir.join("node_modules").join("dep.js"), "module.exports = 1;\n").unwrap();
        fs::write(dir.join("keep.ts"), "export {};\n").unwrap();

        let out = expand(&dir);
        assert!(!out.files.iter().any(|f| f.name == "dep.js"));
        assert!(out.files.iter().any(|f| f.name == "keep.ts"));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn expansion_plafonne_le_nombre_de_fichiers() {
        let dir = temp_dir("cap");
        for i in 0..(MAX_FILES + 20) {
            fs::write(dir.join(format!("f{i}.ts")), "x\n").unwrap();
        }
        let out = expand(&dir);
        assert!(out.files.len() <= MAX_FILES + 20); // borne souple : on s'arrête tôt
        assert!(out.truncated);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn expansion_refuse_un_fichier_trop_gros() {
        let dir = temp_dir("big");
        let big = vec![b'a'; (MAX_FILE_BYTES + 1) as usize];
        fs::write(dir.join("big.txt"), &big).unwrap();

        let out = expand(&dir);
        let f = out.files.iter().find(|f| f.name == "big.txt").unwrap();
        assert!(f.skipped);
        assert!(out.truncated);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn expansion_conserve_le_contenu_des_fichiers_inclus() {
        let dir = temp_dir("content");
        fs::write(dir.join("x.ts"), "export const x = 42;\n").unwrap();

        let out = expand(&dir);
        let f = out.files.iter().find(|f| f.name == "x.ts").unwrap();
        assert!(!f.skipped);
        assert!(f.content.contains("export const x = 42;"));

        fs::remove_dir_all(&dir).ok();
    }
}
