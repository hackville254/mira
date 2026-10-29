// Migration de marque — Origin → Mira.
//
// ── Pourquoi ──────────────────────────────────────────────────────────────────
// L'application s'appelait « Origin » et écrivait son état utilisateur dans
// `~/.origin`. Elle s'appelle désormais « Mira » et écrit dans `~/.mira`. Sans
// migration, un utilisateur existant « perdrait » ses logs, réglages et caches :
// ils seraient toujours sur disque mais dans un dossier que la nouvelle version
// ne lit plus.
//
// ── Stratégie ─────────────────────────────────────────────────────────────────
// Un DÉPLACEMENT (rename), pas une copie :
//   - atomique pour l'utilisateur (pas d'état dupliqué) ;
//   - idempotent : si `~/.mira` existe déjà, on ne touche à RIEN (on suppose la
//     migration déjà faite ou un utilisateur neuf). On ne FUSIONNE jamais, pour
//     ne pas écraser un état récent par un état ancien.
//
// ── Sécurité ──────────────────────────────────────────────────────────────────
//   - Best-effort : une erreur d'I/O n'empêche JAMAIS le démarrage de l'app.
//   - On n'écrit rien hors du home, jamais dans le projet.
//   - Aucun secret n'est concerné : le keychain OS garde ses propres entrées
//     (le service renommé `mira-ide` a son propre cycle de vie, cf. keychain.rs).
//
// Ce module est appelé UNE fois, au setup, avant toute lecture d'état.

use std::path::{Path, PathBuf};

/// Ancien dossier de données (marque historique).
const LEGACY_DIR_NAME: &str = ".origin";
/// Nouveau dossier de données (marque courante).
const CURRENT_DIR_NAME: &str = ".mira";

/// Point d'entrée : migre `~/.origin` vers `~/.mira` si nécessaire.
///
/// No-op silencieux si :
///   - le home est introuvable ;
///   - `~/.mira` existe déjà (migration faite, ou utilisateur neuf) ;
///   - `~/.origin` n'existe pas (utilisateur neuf).
pub fn migrate_legacy_data_dir() {
    let Some(home) = home_dir() else { return };
    let legacy = home.join(LEGACY_DIR_NAME);
    let current = home.join(CURRENT_DIR_NAME);

    // Rien à migrer si l'ancien dossier n'existe pas.
    if !legacy.is_dir() {
        return;
    }
    // Ne jamais écraser un état courant : on s'arrête si `~/.mira` existe.
    if current.exists() {
        return;
    }

    match std::fs::rename(&legacy, &current) {
        Ok(()) => {
            crate::log::log_line(
                "info",
                "migration",
                &format!("{LEGACY_DIR_NAME} déplacé vers {CURRENT_DIR_NAME} (marque Mira)"),
            );
        }
        Err(error) => {
            // Best-effort : on ne bloque pas le démarrage. `rename` peut échouer
            // si l'ancien et le nouveau dossier sont sur des volumes différents
            // (rare sous le même home) ; on le signale sans plus.
            crate::log::log_line(
                "warn",
                "migration",
                &format!("déplacement {LEGACY_DIR_NAME} → {CURRENT_DIR_NAME} ignoré: {error}"),
            );
        }
    }
}

/// Résout le home de l'utilisateur (`HOME` puis `USERPROFILE`).
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

/// Variante testable : migre depuis des chemins explicites.
///
/// Séparée de [`migrate_legacy_data_dir`] pour permettre un test sans toucher au
/// vrai home. Renvoie `true` si un déplacement a effectivement eu lieu.
#[allow(dead_code)]
pub(crate) fn migrate_dirs(legacy: &Path, current: &Path) -> bool {
    if !legacy.is_dir() || current.exists() {
        return false;
    }
    std::fs::rename(legacy, current).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("mira_migration_{}_{}", tag, std::process::id()))
    }

    #[test]
    fn deplace_quand_nouveau_absent() {
        let legacy = tmp("legacy");
        let current = tmp("current");
        let _ = std::fs::remove_dir_all(&legacy);
        let _ = std::fs::remove_dir_all(&current);
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("marker.txt"), b"x").unwrap();

        assert!(migrate_dirs(&legacy, &current));
        assert!(current.join("marker.txt").is_file());
        assert!(!legacy.exists());

        let _ = std::fs::remove_dir_all(&current);
    }

    #[test]
    fn ne_touche_pas_si_cible_existe() {
        let legacy = tmp("legacy2");
        let current = tmp("current2");
        let _ = std::fs::remove_dir_all(&legacy);
        let _ = std::fs::remove_dir_all(&current);
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::create_dir_all(&current).unwrap();
        std::fs::write(current.join("keep.txt"), b"y").unwrap();

        assert!(!migrate_dirs(&legacy, &current));
        // La cible n'a PAS été écrasée, l'ancienne source reste.
        assert!(current.join("keep.txt").is_file());
        assert!(legacy.exists());

        let _ = std::fs::remove_dir_all(&legacy);
        let _ = std::fs::remove_dir_all(&current);
    }

    #[test]
    fn noop_si_source_absente() {
        let legacy = tmp("absent");
        let current = tmp("absent_current");
        let _ = std::fs::remove_dir_all(&legacy);
        let _ = std::fs::remove_dir_all(&current);
        assert!(!migrate_dirs(&legacy, &current));
    }
}
