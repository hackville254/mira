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

// ── Revert multi-tours (annulation d'un « run » complet) ─────────────────────
//
// Un run d'agent comporte PLUSIEURS tours (boucle d'outils). Reverter un run
// consiste donc à annuler une LISTE de turn_ids, et non un seul. On fusionne les
// entrées de tous ces tours en un **plan de revert** : chaque chemin est classé
// « à supprimer » (créé pendant le run, inexistant avant) ou « à restaurer »
// (modifié pendant le run). Un même chemin touché par plusieurs tours est
// dédupliqué : le PREMIER snapshot (le tour le plus ancien) gagne, car c'est
// l'état d'origine réel.
//
// Le plan est calculé par `collect_revert_plan` — partagé par la prévisualisation
// (dry-run, aucune écriture) et par l'exécution, garantissant que ce que
// l'utilisateur voit est EXACTEMENT ce qui sera appliqué.

/// Action prévue pour un chemin lors d'un revert.
#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum RevertAction {
    /// Le fichier n'existait pas avant le run → il sera supprimé.
    Delete,
    /// Le fichier existait avant le run → il sera restauré.
    Restore,
}

/// Entrée du plan de revert : un chemin + l'action prévue.
#[derive(Serialize, Clone)]
pub struct RevertPlanEntry {
    /// Chemin absolu du fichier concerné.
    pub path: String,
    /// Action qui sera appliquée lors du revert.
    pub action: RevertAction,
    /// Nombre de tours du run ayant touché ce chemin (≥ 1).
    pub turns: usize,
}

/// Applique la garde workspace à un chemin si une racine est fournie.
fn guard(workspace_root: Option<&str>, path: &str) -> Result<(), String> {
    if let Some(root) = workspace_root {
        super::fs::assert_in_workspace_public(path, root)?;
    }
    Ok(())
}

/// Construit le plan de revert pour une liste de turn_ids : fusionne les entrées,
/// déduplique (le premier snapshot gagne), et renvoie pour chaque chemin l'action
/// prévue. Aucune écriture disque — utilisable en prévisualisation.
fn collect_revert_plan(
    root: &Path,
    turn_ids: &[String],
    workspace_root: Option<&str>,
) -> Result<Vec<RevertPlanEntry>, String> {
    // Index par chemin : conserve l'état d'origine (premier tour qui l'a vu) et
    // le compte de tours qui l'ont touché.
    let mut order: Vec<String> = Vec::new();
    let mut actions: HashMap<String, (RevertAction, usize)> = HashMap::new();

    for turn_id in turn_ids {
        assert_safe_turn_id(turn_id)?;
        let manifest = load_manifest(root, turn_id);
        for entry in &manifest.entries {
            guard(workspace_root, &entry.path)?;
            let action = if entry.existed { RevertAction::Restore } else { RevertAction::Delete };
            match actions.get_mut(&entry.path) {
                None => {
                    order.push(entry.path.clone());
                    actions.insert(entry.path.clone(), (action, 1));
                }
                Some(slot) => {
                    slot.1 += 1;
                    // Le premier snapshot gagne : s'il disait « créé » (Delete),
                    // c'est l'état d'origine réel, on ne le dégrade pas en Restore.
                }
            }
        }
    }

    Ok(order
        .into_iter()
        .map(|path| {
            let (action, turns) = actions.remove(&path).expect("path indexed");
            RevertPlanEntry { path, action, turns }
        })
        .collect())
}

/// Remonte les dossiers parents créés par le run et les supprime s'ils sont
/// vides. Ne remonte jamais au-dessus de `workspace_root` (ou de la racine de
/// tout chemin fourni à défaut) et n'essaie jamais de supprimer un dossier non
/// vide : on ne touche qu'aux dossiers que le run a laissés vides.
fn prune_empty_dirs(path: &str, workspace_root: Option<&str>) {
    let Some(root) = workspace_root else { return };
    let norm_root = root.replace('\\', "/");
    let mut current = Path::new(path).parent().map(Path::to_path_buf);
    // On remonte en supprimant les dossiers vides, en s'arrêtant au workspace.
    while let Some(dir) = current {
        let dir_str = dir.to_string_lossy().replace('\\', "/");
        // Stop : on ne supprime jamais le workspace lui-même ni au-dessus.
        if dir_str == norm_root || !dir_str.starts_with(&norm_root) {
            break;
        }
        if dir.is_dir() {
            match std::fs::read_dir(&dir) {
                Ok(mut it) => {
                    if it.next().is_some() {
                        break; // dossier non vide → on s'arrête
                    }
                }
                Err(_) => break,
            }
            if std::fs::remove_dir(&dir).is_err() {
                break;
            }
        } else {
            break;
        }
        current = dir.parent().map(Path::to_path_buf);
    }
}

/// Prévisualisation d'un revert de run : renvoie, sans RIEN écrire, la liste des
/// fichiers qui seront supprimés (créés pendant le run) ou restaurés (modifiés).
/// C'est le contrat affiché à l'utilisateur avant confirmation.
#[tauri::command]
pub fn checkpoint_revert_preview(
    app: tauri::AppHandle,
    turn_ids: Vec<String>,
    workspace_root: Option<String>,
) -> Result<Vec<RevertPlanEntry>, String> {
    let root = checkpoints_root(&app)?;
    collect_revert_plan(&root, &turn_ids, workspace_root.as_deref())
}

/// Annule un run complet (plusieurs tours) : restaure les fichiers modifiés,
/// supprime ceux créés, puis élague les dossiers laissés vides. Purge tous les
/// checkpoints consommés. Renvoie le plan réellement appliqué.
#[tauri::command]
pub fn checkpoint_undo_many(
    app: tauri::AppHandle,
    turn_ids: Vec<String>,
    workspace_root: Option<String>,
) -> Result<Vec<RevertPlanEntry>, String> {
    let root = checkpoints_root(&app)?;
    let ws = workspace_root.as_deref();
    let plan = collect_revert_plan(&root, &turn_ids, ws)?;

    // On applique en s'appuyant sur le PREMIER tour ayant vu chaque chemin (le
    // snapshot d'origine y est stocké, cf. `collect_revert_plan`).
    for entry in &plan {
        let target = Path::new(&entry.path);
        // Retrouve le tour d'origine de ce chemin (premier manifeste qui le cite).
        let mut origin: Option<&String> = None;
        for turn_id in &turn_ids {
            let manifest = load_manifest(&root, turn_id);
            if manifest.entries.iter().any(|e| e.path == entry.path) {
                origin = Some(turn_id);
                break;
            }
        }
        let Some(origin) = origin else { continue };
        let manifest = load_manifest(&root, origin);
        let Some(orig_entry) = manifest.entries.iter().find(|e| e.path == entry.path) else { continue };

        match entry.action {
            RevertAction::Delete => {
                if target.is_file() {
                    std::fs::remove_file(target).map_err(|e| e.to_string())?;
                }
                // Nettoie les dossiers que le run a créés et laissés vides.
                prune_empty_dirs(&entry.path, ws);
            }
            RevertAction::Restore => {
                let backup_name = orig_entry.backup.as_ref().ok_or("missing backup name")?;
                let backup = root.join(origin).join(backup_name);
                if !backup.is_file() {
                    return Err(format!("backup missing for {} — aborting revert", entry.path));
                }
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                std::fs::copy(&backup, target).map_err(|e| e.to_string())?;
            }
        }
    }

    // Purge tous les checkpoints consommés (best-effort : le revert a réussi).
    for turn_id in &turn_ids {
        if assert_safe_turn_id(turn_id).is_ok() {
            let _ = std::fs::remove_dir_all(root.join(turn_id));
        }
    }

    Ok(plan)
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

    /// Crée un tour sur disque avec un manifeste donné et renvoie son id.
    fn write_turn(root: &Path, turn_id: &str, entries: Vec<SnapshotEntry>) {
        // Aligne le manifeste sur le disque (le dossier du tour est créé).
        save_manifest(root, turn_id, &CheckpointManifest { entries }).unwrap();
    }

    fn entry(path: &str, existed: bool) -> SnapshotEntry {
        SnapshotEntry { path: path.to_string(), existed, backup: None }
    }

    #[test]
    fn revert_plan_classifies_created_vs_modified() {
        let dir = std::env::temp_dir().join(format!("ckpt_test_{}", path_hash("plan")));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        write_turn(&dir, "t1", vec![entry("/ws/a.ts", true), entry("/ws/new.ts", false)]);

        let plan = collect_revert_plan(&dir, &[String::from("t1")], None).unwrap();
        let map: std::collections::HashMap<_, _> =
            plan.iter().map(|e| (e.path.clone(), e.action.clone())).collect();
        assert_eq!(map["/ws/a.ts"], RevertAction::Restore);
        assert_eq!(map["/ws/new.ts"], RevertAction::Delete);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn revert_plan_dedupes_and_keeps_first_snapshot() {
        let dir = std::env::temp_dir().join(format!("ckpt_test_{}", path_hash("dedup")));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // t1 voit le fichier nouvellement créé ; t2 le voit comme existant.
        // L'état d'origine (t1) doit gagner : action = Delete.
        write_turn(&dir, "t1", vec![entry("/ws/f.ts", false)]);
        write_turn(&dir, "t2", vec![entry("/ws/f.ts", true)]);

        let plan = collect_revert_plan(
            &dir,
            &[String::from("t1"), String::from("t2")],
            None,
        )
        .unwrap();
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].action, RevertAction::Delete);
        assert_eq!(plan[0].turns, 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn revert_plan_rejects_unsafe_turn_id() {
        let dir = std::env::temp_dir().join(format!("ckpt_test_{}", path_hash("bad")));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let res = collect_revert_plan(&dir, &[String::from("../etc")], None);
        assert!(res.is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_removes_only_empty_dirs_within_workspace() {
        let ws = std::env::temp_dir().join(format!("ws_test_{}", path_hash("prune")));
        let _ = std::fs::remove_dir_all(&ws);
        // Structure : ws/a/b/c.txt (c.txt supprimé → a/b doivent partir).
        let nested = ws.join("a").join("b");
        std::fs::create_dir_all(&nested).unwrap();
        let file = nested.join("c.txt");
        std::fs::write(&file, "x").unwrap();
        let ws_str = ws.to_string_lossy().to_string();

        std::fs::remove_file(&file).unwrap();
        prune_empty_dirs(&file.to_string_lossy(), Some(&ws_str));

        assert!(!nested.exists(), "les dossiers vides créés doivent être supprimés");
        assert!(ws.exists(), "le workspace lui-même ne doit jamais être supprimé");
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn prune_keeps_non_empty_dirs() {
        let ws = std::env::temp_dir().join(format!("ws_test_{}", path_hash("keep")));
        let _ = std::fs::remove_dir_all(&ws);
        let nested = ws.join("a");
        std::fs::create_dir_all(&nested).unwrap();
        let file = nested.join("gone.txt");
        std::fs::write(&file, "x").unwrap();
        std::fs::write(nested.join("keep.txt"), "y").unwrap();
        let ws_str = ws.to_string_lossy().to_string();

        std::fs::remove_file(&file).unwrap();
        prune_empty_dirs(&file.to_string_lossy(), Some(&ws_str));

        assert!(nested.exists(), "un dossier non vide ne doit pas être supprimé");
        let _ = std::fs::remove_dir_all(&ws);
    }
}
