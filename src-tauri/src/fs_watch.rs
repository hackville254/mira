//! Surveillance du système de fichiers pour rafraîchir l'EXPLORATEUR.
//!
//! POURQUOI CE MODULE
//! ------------------
//! L'explorateur ne se rafraîchissait que sur les écritures qu'il déclenchait
//! lui-même (bus `refreshBus`). Une modification produite AILLEURS — agent, git
//! (checkout/pull), outil externe, terminal — restait invisible jusqu'au
//! prochain `reloadAll`. On ajoute donc une surveillance OS (`notify`, donc
//! FSEvents sur macOS, inotify sur Linux, ReadDirectoryChangesW sur Windows)
//! qui pousse un événement Tauri borné vers le front.
//!
//! PÉRIMÈTRE & SÉCURITÉ
//! --------------------
//! - Une SEULE racine surveillée à la fois (le workspace courant) : le front
//!   appelle `watch_workspace` à chaque changement de dossier et
//!   `unwatch_workspace` au démontage. On ne peut donc pas empiler des
//!   surveillances et faire grossir la consommation mémoire sans limite.
//! - Le chemin est CANONICALISÉ et doit être un dossier existant : on refuse
//!   tout ce qui n'est pas un répertoire réel (pas de surveillance d'un chemin
//!   fantôme ou d'un fichier unique).
//! - Les dossiers BRUYANTS connus (`node_modules`, `target`, `.git`, …) sont
//!   ignorés AVANT le parcours : sans ce filtre, un `npm install` génère des
//!   dizaines de milliers d'événements et noie le front.
//! - Le payload transmis au front est la liste des DOSSIERS PARENTS touchés
//!   (dédupliquée, bornée) — jamais des chemins de fichiers unitaires : le
//!   front recharge un dossier via `read_dir`, il n'a pas besoin du détail.
//!
//! Le watcher vit dans un thread dédié (créé par `notify`) : les callbacks ne
//! bloquent donc jamais le thread principal de Tauri. Les événements sont
//! coalescés côté front (debounce) : ce module émet au fil de l'eau.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

use crate::search::SEARCH_IGNORE;

/// Nom du canal d'événements consommé par le front (`listen("fs://changed")`).
pub const EVENT_FS_CHANGED: &str = "fs://changed";

/// Plafond de dossiers distincts par lots d'événements. Au-delà, on tronque :
/// le front recharge de toute façon par dossier et un lot énorme (dépôt de
/// milliers de fichiers) n'a pas besoin d'être exhaustif pour que l'arbre soit
/// correct — seul le dernier état compte.
const MAX_DIRS_PER_EVENT: usize = 64;

/// État géré par Tauri : le watcher courant et la racine qu'il surveille.
///
/// Le watcher est CONSERVÉ dans l'état : s'il était déplacé dans un thread
/// détaché, il serait droppé (et la surveillance s'arrêterait) dès la fin de la
/// commande. On le remplace à chaque `watch_workspace`, ce qui libère l'ancienne
/// surveillance automatiquement.
#[derive(Default)]
pub struct WatchState {
    inner: Mutex<Option<ActiveWatch>>,
}

struct ActiveWatch {
    root: PathBuf,
    /// Conservé pour la durée de vie de la surveillance (voir commentaire).
    _watcher: RecommendedWatcher,
}

/// Vrai si un composant du chemin est un dossier ignoré connu. On se base sur le
/// nom du composant, comme `SEARCH_IGNORE` le fait pour la recherche.
fn is_ignored(path: &Path) -> bool {
    path.components().any(|c| {
        c.as_os_str()
            .to_str()
            .map(|s| SEARCH_IGNORE.contains(&s))
            .unwrap_or(false)
    })
}

/// Installe (ou remplace) la surveillance du dossier `root`.
///
/// Renvoie `Ok(())` même si le dossier ne contient rien : un workspace vide est
/// un cas légitime. En revanche, un chemin inexistant ou non-dossier est refusé
/// explicitement (le front reçoit l'erreur et n'attend pas d'événements).
#[tauri::command]
pub fn watch_workspace(
    app: AppHandle,
    state: tauri::State<'_, WatchState>,
    root: String,
) -> Result<(), String> {
    let canonical = std::fs::canonicalize(&root).map_err(|e| format!("invalid watch root: {e}"))?;
    if !canonical.is_dir() {
        return Err(format!("watch root is not a directory: {root}"));
    }

    let handle = app.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        // On ne pousse QUE des dossiers PARENTS distincts : c'est l'unité de
        // rechargement du front (`read_dir` d'un dossier).
        let mut dirs: HashSet<String> = HashSet::new();
        for path in &event.paths {
            let dir = if path.is_dir() {
                path.clone()
            } else {
                match path.parent() {
                    Some(p) => p.to_path_buf(),
                    None => continue,
                }
            };
            if is_ignored(&dir) {
                continue;
            }
            dirs.insert(dir.to_string_lossy().into_owned());
            if dirs.len() >= MAX_DIRS_PER_EVENT {
                break;
            }
        }
        if dirs.is_empty() {
            return;
        }
        let payload: Vec<String> = dirs.into_iter().collect();
        // Émission best-effort : une fenêtre fermée ne doit pas faire paniquer
        // le thread du watcher.
        let _ = handle.emit(EVENT_FS_CHANGED, payload);
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(&canonical, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    *guard = Some(ActiveWatch {
        root: canonical,
        _watcher: watcher,
    });
    Ok(())
}

/// Arrête la surveillance en cours (no-op s'il n'y en a pas).
#[tauri::command]
pub fn unwatch_workspace(state: tauri::State<'_, WatchState>) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    *guard = None;
    Ok(())
}

/// Racine actuellement surveillée, pour diagnostic (et pour que le front puisse
/// vérifier qu'un changement de workspace a bien été pris en compte).
#[tauri::command]
pub fn watch_status(state: tauri::State<'_, WatchState>) -> Result<Option<String>, String> {
    let guard = state.inner.lock().map_err(|e| e.to_string())?;
    Ok(guard.as_ref().map(|w| w.root.to_string_lossy().into_owned()))
}
