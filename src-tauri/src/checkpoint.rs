//! Checkpoints par tour — support d'« Undo all / Keep all ».
//!
//! ## Modèle
//! Avant qu'un tour d'agent n'écrive quoi que ce soit, il ouvre un **checkpoint**
//! identifié par un `turn_id` (UUID côté front). Chaque fichier sur le point
//! d'être écrit y est **snapshoté une fois** (copie du contenu original) dans un
//! répertoire de données applicatif — jamais dans le workspace de l'utilisateur.
//!
//! - « **Keep all** » → on oublie le checkpoint (les écritures restent).
//! - « **Undo all** » → on réécrit chaque fichier snapshoté dans son état
//!   d'origine ; les fichiers **créés** pendant le tour (absents au moment du
//!   snapshot) sont **supprimés**.
//!
//! ## Pourquoi des copies plutôt que git
//! Le workspace de l'utilisateur n'est pas nécessairement un dépôt git, et même
//! s'il l'est, on refuse de manipuler son index/HEAD (risque de perte de travail
//! non commité). Une copie ciblée des seuls fichiers touchés est plus simple,
//! prévisible, et sans effet de bord sur l'état git de l'utilisateur.
//!
//! ## Sécurité
//! - Le chemin de restauration passe par `assert_in_workspace` : impossible
//!   d'écrire hors du workspace même si le manifeste a été altéré.
//! - Le nom de fichier snapshoté est dérivé d'un **hash** du chemin absolu
//!   (jamais du chemin lui-même) → pas de traversée par `../` via un nom.
//! - Un `turn_id` est validé (alphanumérique + `-`/`_`) avant tout accès disque.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Entrée du manifeste : un fichier tel qu'il était AVANT le tour.
#[derive(Serialize, Deserialize, Clone)]
pub struct SnapshotEntry {
    /// Chemin absolu du fichier au moment du snapshot.
    pub path: String,
    /// `true` si le fichier existait déjà (restauration = réécriture du contenu).
    /// `false` s'il a été **créé** pendant le tour (restauration = suppression).
    pub existed: bool,
    /// Nom du fichier de sauvegarde dans le dossier du checkpoint (si `existed`).
    pub backup: Option<String>,
}

/// Manifeste d'un checkpoint de tour.
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct CheckpointManifest {
    pub entries: Vec<SnapshotEntry>,
}

/// Racine des checkpoints : `<app_data_dir>/checkpoints`.
fn checkpoints_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("checkpoints");
    Ok(base)
}

/// Valide un `turn_id` (UUID ou identifiant alphanumérique simple). Empêche
/// toute traversée de chemin via un identifiant forgé.
fn assert_safe_turn_id(turn_id: &str) -> Result<(), String> {
    if turn_id.is_empty() || turn_id.len() > 128 {
        return Err("invalid turn id length".into());
    }
    if !turn_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("invalid turn id characters".into());
    }
    Ok(())
}

/// Hash stable (FNV-1a 64 bits) d'un chemin → nom de backup sûr, sans slash.
fn path_hash(path: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in path.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn manifest_path(root: &Path, turn_id: &str) -> PathBuf {
    root.join(turn_id).join("manifest.json")
}

/// Charge le manifeste d'un tour s'il existe.
fn load_manifest(root: &Path, turn_id: &str) -> CheckpointManifest {
    std::fs::read_to_string(manifest_path(root, turn_id))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_manifest(root: &Path, turn_id: &str, manifest: &CheckpointManifest) -> Result<(), String> {
    let dir = root.join(turn_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string(manifest).map_err(|e| e.to_string())?;
    // Écriture atomique : tmp + rename, pour ne jamais laisser un manifeste
    // partiel si le process meurt en plein milieu.
    let tmp = dir.join("manifest.json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, manifest_path(root, turn_id)).map_err(|e| e.to_string())
}

/// Ouvre un checkpoint de tour : crée le dossier et un manifeste vide.
#[tauri::command]
pub fn checkpoint_begin(app: tauri::AppHandle, turn_id: String) -> Result<(), String> {
    assert_safe_turn_id(&turn_id)?;
    let root = checkpoints_root(&app)?;
    let dir = root.join(&turn_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    save_manifest(&root, &turn_id, &CheckpointManifest::default())
}

/// Snapshot d'un fichier AVANT écriture. Idempotent : si le fichier est déjà
/// snapshoté pour ce tour, on ne fait rien (le premier état gagne — c'est celui
/// qu'« Undo all » doit restaurer, même si plusieurs écritures le modifient).
///
/// `workspace_root` borne le chemin : on refuse de snapshoter hors workspace.
#[tauri::command]
pub fn checkpoint_touch_file(
    app: tauri::AppHandle,
    turn_id: String,
    path: String,
    workspace_root: Option<String>,
) -> Result<(), String> {
    assert_safe_turn_id(&turn_id)?;
    if let Some(root) = workspace_root.as_deref() {
        super::fs::assert_in_workspace_public(&path, root)?;
    }
    let root = checkpoints_root(&app)?;
    let mut manifest = load_manifest(&root, &turn_id);

    if manifest.entries.iter().any(|e| e.path == path) {
        return Ok(()); // déjà capturé pour ce tour
    }

    let src = Path::new(&path);
    let existed = src.is_file();
    let mut backup = None;
    if existed {
        let name = path_hash(&path);
        let dir = root.join(&turn_id);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::copy(src, dir.join(&name)).map_err(|e| e.to_string())?;
        backup = Some(name);
    }

    manifest.entries.push(SnapshotEntry { path, existed, backup });
    save_manifest(&root, &turn_id, &manifest)
}

/// Restaure le tour : chaque fichier snapshoté revient à son état d'origine ;
/// ceux qui n'existaient pas sont supprimés. Puis le checkpoint est purgé.
///
/// Renvoie la liste des chemins restaurés/supprimés, pour information à l'UI.
#[tauri::command]
pub fn checkpoint_undo(
    app: tauri::AppHandle,
    turn_id: String,
    workspace_root: Option<String>,
) -> Result<Vec<String>, String> {
    assert_safe_turn_id(&turn_id)?;
    let root = checkpoints_root(&app)?;
    let manifest = load_manifest(&root, &turn_id);
    let mut touched = Vec::new();

    for entry in &manifest.entries {
        if let Some(ws) = workspace_root.as_deref() {
            // Garde-fou : un manifeste altéré ne peut pas écrire hors workspace.
            super::fs::assert_in_workspace_public(&entry.path, ws)?;
        }
        let target = Path::new(&entry.path);
        if entry.existed {
            let backup_name = entry.backup.as_ref().ok_or("missing backup name")?;
            let backup = root.join(&turn_id).join(backup_name);
            if !backup.is_file() {
                return Err(format!("backup missing for {} — aborting undo", entry.path));
            }
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::copy(&backup, target).map_err(|e| e.to_string())?;
        } else if target.is_file() {
            std::fs::remove_file(target).map_err(|e| e.to_string())?;
        }
        touched.push(entry.path.clone());
    }

    let _ = std::fs::remove_dir_all(root.join(&turn_id));
    Ok(touched)
}

/// Purge le checkpoint (action « Keep all » ou fin de vie).
#[tauri::command]
pub fn checkpoint_discard(app: tauri::AppHandle, turn_id: String) -> Result<(), String> {
    assert_safe_turn_id(&turn_id)?;
    let root = checkpoints_root(&app)?;
    let _ = std::fs::remove_dir_all(root.join(&turn_id));
    Ok(())
}

/// Nombre de fichiers capturés pour un tour (0 si le checkpoint n'existe pas).
#[tauri::command]
pub fn checkpoint_count(app: tauri::AppHandle, turn_id: String) -> Result<usize, String> {
    assert_safe_turn_id(&turn_id)?;
    let root = checkpoints_root(&app)?;
    Ok(load_manifest(&root, &turn_id).entries.len())
}

/// Résumé d'un fichier modifié pendant le tour, pour la bannière
/// « N files to review » (une ligne par fichier avec son delta).
#[derive(Serialize, Clone)]
pub struct FileDelta {
    /// Chemin (absolu) tel que consigné dans le manifeste.
    pub path: String,
    /// Lignes ajoutées (approximation par différence d'ensembles).
    pub added: usize,
    /// Lignes supprimées (approximation par différence d'ensembles).
    pub removed: usize,
    /// `true` si le fichier a été créé pendant le tour.
    pub created: bool,
}

/// Compte les lignes d'un contenu (une ligne vide finale n'est pas comptée).
fn line_counts(text: &str) -> HashMap<String, usize> {
    let mut counts = HashMap::new();
    for line in text.lines() {
        *counts.entry(line.to_string()).or_insert(0) += 1;
    }
    counts
}

/// Delta de lignes entre l'état d'origine (backup) et l'état courant.
/// Approche par multi-ensembles : robuste et linéaire, suffisante pour un
/// indicateur visuel `+N/-N`. (Un LCS exact serait plus précis sur les
/// déplacements, mais coûteux et sans intérêt ici.)
fn diff_counts(before: &str, after: &str) -> (usize, usize) {
    let b = line_counts(before);
    let a = line_counts(after);
    let mut added = 0usize;
    let mut removed = 0usize;
    let mut keys: std::collections::HashSet<&String> = std::collections::HashSet::new();
    keys.extend(a.keys());
    keys.extend(b.keys());
    for k in keys {
        let ca = a.get(k).copied().unwrap_or(0);
        let cb = b.get(k).copied().unwrap_or(0);
        if ca > cb {
            added += ca - cb;
        } else {
            removed += cb - ca;
        }
    }
    (added, removed)
}

/// Résumé des fichiers modifiés d'un tour : chemins + deltas `+N/-N`.
/// Sert à peupler la liste cliquable de la bannière de checkpoint.
#[tauri::command]
pub fn checkpoint_summary(app: tauri::AppHandle, turn_id: String) -> Result<Vec<FileDelta>, String> {
    assert_safe_turn_id(&turn_id)?;
    let root = checkpoints_root(&app)?;
    let manifest = load_manifest(&root, &turn_id);
    let mut out = Vec::with_capacity(manifest.entries.len());

    for entry in &manifest.entries {
        let after = std::fs::read_to_string(&entry.path).unwrap_or_default();
        let (added, removed) = if entry.existed {
            let before = entry
                .backup
                .as_ref()
                .and_then(|name| std::fs::read_to_string(root.join(&turn_id).join(name)).ok())
                .unwrap_or_default();
            diff_counts(&before, &after)
        } else {
            // Fichier créé : toutes ses lignes sont des ajouts.
            (after.lines().count(), 0)
        };
        out.push(FileDelta {
            path: entry.path.clone(),
            added,
            removed,
            created: !entry.existed,
        });
    }
    Ok(out)
}

/// Contenu d'origine (avant le tour) d'un fichier snapshoté, pour afficher un
/// diff en lecture seule. Renvoie une chaîne vide si le fichier a été créé
/// pendant le tour (il n'avait pas d'état antérieur).
#[tauri::command]
pub fn checkpoint_file_before(
    app: tauri::AppHandle,
    turn_id: String,
    path: String,
) -> Result<String, String> {
    assert_safe_turn_id(&turn_id)?;
    let root = checkpoints_root(&app)?;
    let manifest = load_manifest(&root, &turn_id);
    let entry = manifest
        .entries
        .iter()
        .find(|e| e.path == path)
        .ok_or("file not part of this checkpoint")?;
    if !entry.existed {
        return Ok(String::new());
    }
    let name = entry.backup.as_ref().ok_or("missing backup name")?;
    std::fs::read_to_string(root.join(&turn_id).join(name)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_hash_is_stable_and_slash_free() {
        let a = path_hash("/Users/me/proj/src/foo.ts");
        let b = path_hash("/Users/me/proj/src/foo.ts");
        assert_eq!(a, b);
        assert!(!a.contains('/'));
        assert_eq!(a.len(), 16);
        assert_ne!(a, path_hash("/Users/me/proj/src/bar.ts"));
    }

    #[test]
    fn turn_id_validation_rejects_traversal() {
        assert!(assert_safe_turn_id("abc-123_DEF").is_ok());
        assert!(assert_safe_turn_id("../../etc").is_err());
        assert!(assert_safe_turn_id("a/b").is_err());
        assert!(assert_safe_turn_id("").is_err());
        assert!(assert_safe_turn_id(&"x".repeat(200)).is_err());
    }

    #[test]
    fn diff_counts_reports_added_and_removed_lines() {
        // Une ligne remplacée → 1 ajout, 1 suppression.
        assert_eq!(diff_counts("a\nb\nc\n", "a\nB\nc\n"), (1, 1));
        // Deux lignes ajoutées, aucune suppression.
        assert_eq!(diff_counts("a\n", "a\nb\nc\n"), (2, 0));
        // Contenu identique → aucun delta.
        assert_eq!(diff_counts("x\ny\n", "x\ny\n"), (0, 0));
        // Ajout depuis un fichier vide.
        assert_eq!(diff_counts("", "a\nb\n"), (2, 0));
    }
}
