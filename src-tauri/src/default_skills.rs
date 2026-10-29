//! Installation automatique des **skills livrés avec l'application**, côté natif.
//!
//! ── Objectif produit ─────────────────────────────────────────────────────────
//! Mira embarque un jeu de compétences par défaut (HyperFrames, media-use,
//! InsForge, copywriting…) que l'utilisateur doit retrouver **disponibles dès le
//! premier lancement**, sans terminal ni manipulation de fichiers. Elles sont
//! néanmoins **désactivables** dans Réglages › Skills : on n'écrase JAMAIS une
//! version déjà présente (un skill désactivé par l'utilisateur doit le rester).
//!
//! ── Modèle de sécurité (le disque et le bundle sont traités comme non fiables) ─
//!   1. **Aucune entrée webview.** Cette installation ne prend aucun paramètre du
//!      webview : la source est le dossier de ressources du bundle, la destination
//!      est `<home>/.mira/skills`. Aucune surface d'injection.
//!   2. **Noms validés.** Chaque nom de dossier est passé par
//!      `extensions_store::validate_name` (pas de `.`/`..`, pas de séparateur de
//!      chemin, `[A-Za-z0-9._-]` uniquement) : impossible d'écrire hors de la
//!      racine.
//!   3. **Confinement.** Chaque destination est re-vérifiée par
//!      `extensions_store::ensure_within` (défense en profondeur).
//!   4. **Idempotence / respect de l'utilisateur.** Un skill déjà présent est
//!      laissé **intact** : on ne réinstalle ni n'écrase (préserve les
//!      modifications et l'état désactivé). Seuls les skills absents sont copiés.
//!   5. **Copie atomique.** On écrit dans un dossier temporaire voisin puis on
//!      `rename` sur la destination finale : pas de skill à moitié copié.
//!
//! ── Résolution du bundle ─────────────────────────────────────────────────────
//! Même stratégie que `sidecar::resolve_sidecar_script` : en **release** on lit le
//! dossier de ressources Tauri (`bundle.resources`), en **dev** on retombe sur
//! `src-tauri/default_skills` (figé via `CARGO_MANIFEST_DIR`).

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};

use crate::extensions_store;

/// Dossier des skills par défaut, embarqué dans le bundle.
const DEFAULT_SKILLS_RESOURCE: &str = "default_skills";

/// Résultat de l'installation (pour log/observabilité côté Rust).
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct DefaultSkillsResult {
    /// Skills effectivement installés (ils n'existaient pas avant).
    pub installed: Vec<String>,
    /// Skills déjà présents, laissés tels quels (respect de l'état utilisateur).
    pub skipped: Vec<String>,
}

/// Résout le dossier `default_skills/` du bundle.
///
/// En release : `<resource_dir>/default_skills`. En dev : repli sur
/// `src-tauri/default_skills` (chemin figé à la compilation). On ne fait jamais
/// confiance à un chemin fourni par le webview.
fn resolve_default_skills_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join(DEFAULT_SKILLS_RESOURCE);
        if bundled.is_dir() {
            return Ok(bundled);
        }
    }

    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(DEFAULT_SKILLS_RESOURCE);
    if dev.is_dir() {
        return Ok(dev);
    }

    Err("dossier des skills par défaut introuvable".to_string())
}

/// Installe les skills par défaut dans `<home>/.mira/skills`, sans écraser ceux
/// qui existent déjà. Best-effort : ne renvoie jamais d'erreur fatale bloquante
/// pour l'appelant (voir `install_default_skills_silent`).
///
/// Sécurité : source = bundle figé, destination = racine confinée `.mira/skills`,
/// noms validés, chemins confinés, copie atomique. Aucune entrée non fiable.
pub fn install_default_skills<R: Runtime>(app: &AppHandle<R>) -> Result<DefaultSkillsResult, String> {
    let source = resolve_default_skills_dir(app)?;

    // Racine d'écriture **globale** : on aligne exactement la racine confinée que
    // l'éditeur manuel et l'import GitHub utilisent (`.mira/skills`).
    let dest_root = extensions_store::skill_write_root("global", None)?;
    std::fs::create_dir_all(&dest_root).map_err(|e| format!("création dossier skills: {e}"))?;

    let mut result = DefaultSkillsResult::default();

    let entries = std::fs::read_dir(&source).map_err(|e| format!("lecture bundle skills: {e}"))?;
    for entry in entries.flatten() {
        let from = entry.path();
        if !from.is_dir() {
            continue;
        }
        // Un skill valide expose un `SKILL.md` à sa racine.
        if !from.join("SKILL.md").is_file() {
            continue;
        }
        let Some(name) = from.file_name().and_then(|s| s.to_str()).map(str::to_string) else {
            continue;
        };

        // Nom non fiable (nom de dossier du bundle) : on le valide strictement.
        if extensions_store::validate_name(&name).is_err() {
            continue;
        }

        let dest = dest_root.join(&name);
        // Défense en profondeur : la destination reste sous la racine confinée.
        if extensions_store::ensure_within(&dest_root, &dest).is_err() {
            continue;
        }

        // Idempotence : un skill déjà installé (ou désactivé par l'utilisateur)
        // n'est jamais écrasé.
        if dest.exists() {
            result.skipped.push(name);
            continue;
        }

        // Copie atomique : dossier temporaire voisin puis `rename`.
        let tmp = dest_root.join(format!(".mira-tmp-{name}"));
        let _ = std::fs::remove_dir_all(&tmp);
        if copy_dir(&from, &tmp).is_err() {
            let _ = std::fs::remove_dir_all(&tmp);
            continue;
        }
        match std::fs::rename(&tmp, &dest) {
            Ok(()) => result.installed.push(name),
            Err(_) => {
                let _ = std::fs::remove_dir_all(&tmp);
            }
        }
    }

    Ok(result)
}

/// Variante **best-effort** : appelée au démarrage, ne doit jamais empêcher le
/// lancement de l'app. Les erreurs sont journalisées, pas remontées.
pub fn install_default_skills_silent<R: Runtime>(app: &AppHandle<R>) {
    match install_default_skills(app) {
        Ok(r) => {
            if !r.installed.is_empty() {
                eprintln!(
                    "[default-skills] installed: {} ({})",
                    r.installed.len(),
                    r.installed.join(", ")
                );
            }
        }
        Err(e) => eprintln!("[default-skills] skipped: {e}"),
    }
}

/// Copie récursive bornée d'une arborescence de skill. Ignore les dossiers
/// cachés et les dossiers volumineux connus (`.git`, `node_modules`) : un skill
/// livré n'en contient pas, mais on ne fait pas confiance au bundle.
fn copy_dir(src: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| format!("création dossier: {e}"))?;
    let entries = std::fs::read_dir(src).map_err(|e| format!("lecture dossier: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(file_name) = path.file_name().and_then(|s| s.to_str()).map(str::to_string) else {
            continue;
        };
        if file_name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            if matches!(file_name.as_str(), "node_modules" | "target" | "dist") {
                continue;
            }
            copy_dir(&path, &dest.join(&file_name))?;
        } else if path.is_file() {
            std::fs::copy(&path, dest.join(&file_name))
                .map_err(|e| format!("copie fichier: {e}"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_dir_ignore_les_dossiers_caches_et_lourds() {
        let base = std::env::temp_dir().join(format!("mira-dsk-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let src = base.join("src");
        let dest = base.join("dest");
        std::fs::create_dir_all(src.join("node_modules")).unwrap();
        std::fs::create_dir_all(src.join(".git")).unwrap();
        std::fs::write(src.join("SKILL.md"), b"# skill").unwrap();
        std::fs::write(src.join("node_modules/x.js"), b"x").unwrap();

        copy_dir(&src, &dest).unwrap();

        assert!(dest.join("SKILL.md").is_file());
        assert!(!dest.join("node_modules").exists());
        assert!(!dest.join(".git").exists());

        let _ = std::fs::remove_dir_all(&base);
    }
}
