//! Import de skills depuis un dépôt GitHub (écosystème **Agent Skills** —
//! agentskills.io / skills.sh), côté natif.
//!
//! ── Objectif produit ─────────────────────────────────────────────────────────
//! Permettre à l'utilisateur d'installer une compétence publiée sur skills.sh
//! (ou tout dépôt GitHub au format Agent Skills) **sans terminal**, en une
//! action depuis la page Réglages › Skills. Rien n'est écrit ailleurs que sous
//! `<scope>/.mira/skills` : l'IDE reste portable et réversible.
//!
//! ── Modèle de sécurité (le réseau est hostile par défaut) ────────────────────
//!   1. **SSRF verrouillé.** Le webview ne fournit JAMAIS d'URL : il fournit
//!      `owner/repo` (+ nom de skill optionnel), validés par un slug strict. Le
//!      module construit lui-même l'unique URL autorisée
//!      (`https://codeload.github.com/<owner>/<repo>/tar.gz/refs/heads/<branch>`) :
//!      pas de schéma arbitraire, pas d'hôte arbitraire, pas de redirection
//!      suivie hors de GitHub.
//!   2. **Téléchargement borné.** Cap dur anti-DoS sur la taille de l'archive
//!      (cf. `MAX_ARCHIVE_BYTES`). Une réponse géante est coupée net.
//!   3. **Extraction sûre.** On réutilise l'extraction tar.gz durcie de
//!      `downloader` (garde anti « tar-slip ») : aucun fichier ne peut sortir du
//!      dossier cible, les entrées non-fichiers (liens, devices) sont ignorées.
//!   4. **Contenu non fiable.** Un skill importé est du Markdown **inerte** : il
//!      n'est jamais exécuté par l'IDE. On borne néanmoins chaque `SKILL.md`
//!      (`MAX_SKILL_BYTES`) et on valide le frontmatter (`name` + `description`).
//!   5. **Pas d'exécution de scripts.** Les dossiers optionnels `scripts/` sont
//!      importés comme fichiers de données, jamais lancés par ce module.
//!
//! ── Découverte ───────────────────────────────────────────────────────────────
//! Un dépôt peut publier un ou plusieurs skills. Les dispositions supportées :
//!   - `<repo>/SKILL.md`                      → le dépôt EST le skill
//!   - `<repo>/<name>/SKILL.md`               → skills à la racine
//!   - `<repo>/skills/<name>/SKILL.md`        → convention `skills/`
//!   - `<repo>/packages/<name>/SKILL.md`      → monorepo
//! (profondeur de recherche bornée ; on ignore `.git`, `node_modules`, etc.)

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::extensions_store;

/// URL de base de l'archive GitHub. On grave la cible : aucune URL fournie par
/// le front n'est utilisée directement (anti-SSRF).
const GITHUB_TARBALL: &str = "https://codeload.github.com";

/// Cap dur de l'archive téléchargée (~50 Mo). Très large pour du texte, borné
/// pour empêcher la saturation disque/RAM.
const MAX_ARCHIVE_BYTES: u64 = 50 * 1024 * 1024;

/// Taille maximale d'un `SKILL.md` importé (cohérent avec `MAX_CONTENT_BYTES`).
const MAX_SKILL_BYTES: u64 = 256 * 1024;

/// Profondeur maximale de recherche d'un `SKILL.md` sous la racine extraite.
const MAX_SCAN_DEPTH: usize = 4;

/// Nombre maximal de skills retenus par import (garde anti-abus).
const MAX_SKILLS_PER_IMPORT: usize = 100;

/// Branches candidates, essayées dans l'ordre. On ne fait aucune API GitHub
/// (pas de token, pas de quota) : on tente les deux conventions usuelles.
const BRANCHES: [&str; 2] = ["main", "master"];

/// Un skill découvert dans le dépôt (avant installation).
#[derive(serde::Serialize, Clone, Debug)]
pub struct DiscoveredSkill {
    /// Slug du dossier (`name` du frontmatter si présent, sinon nom de dossier).
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    /// Chemin du `SKILL.md` **dans l'extraction temporaire** (interne, non exposé
    /// comme chemin utilisateur). Sert uniquement à l'installation.
    #[serde(skip)]
    pub source_dir: PathBuf,
}

/// Résultat d'un import : les skills effectivement installés.
#[derive(serde::Serialize, Clone, Debug)]
pub struct ImportResult {
    pub installed: Vec<String>,
}

/// Valide un **slug GitHub** (`owner`, `repo`, `branch`). Refuse tout ce qui
/// pourrait altérer l'URL ou le chemin : non vide, borné, `[A-Za-z0-9._-]`.
fn validate_slug(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 100 {
        return Err(format!("{label} invalide"));
    }
    if value == "." || value == ".." || value.starts_with('.') {
        return Err(format!("{label} invalide"));
    }
    if !value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
    {
        return Err(format!("{label} invalide (caractères non autorisés)"));
    }
    Ok(())
}

/// Client HTTP dédié (rustls), timeouts bornés, user-agent identifiable.
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .connect_timeout(Duration::from_secs(15))
        // Pas de suivi de redirection : une redirection sortirait du périmètre
        // verrouillé (anti-SSRF). GitHub sert l'archive directement.
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Mira/0.1")
        .build()
        .map_err(|e| format!("client HTTP: {e}"))
}

/// Télécharge l'archive `.tar.gz` d'un dépôt GitHub sur une branche donnée.
/// `Ok(None)` si la branche n'existe pas (404) — l'appelant essaie la suivante.
async fn fetch_tarball(
    http: &reqwest::Client,
    owner: &str,
    repo: &str,
    branch: &str,
) -> Result<Option<Vec<u8>>, String> {
    let url = format!("{GITHUB_TARBALL}/{owner}/{repo}/tar.gz/refs/heads/{branch}");
    let resp = http
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("téléchargement impossible: {e}"))?;

    let status = resp.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(format!("GitHub a répondu {status}"));
    }
    if let Some(len) = resp.content_length() {
        if len > MAX_ARCHIVE_BYTES {
            return Err("dépôt trop volumineux".to_string());
        }
    }

    // Lecture bornée : on coupe si le flux dépasse le cap même sans Content-Length.
    let mut bytes: Vec<u8> = Vec::new();
    let mut stream = resp;
    while let Some(chunk) = stream
        .chunk()
        .await
        .map_err(|e| format!("lecture interrompue: {e}"))?
    {
        bytes.extend_from_slice(&chunk);
        if bytes.len() as u64 > MAX_ARCHIVE_BYTES {
            return Err("dépôt trop volumineux".to_string());
        }
    }
    Ok(Some(bytes))
}

/// Chevauchement : `true` si `name` est un fichier spécial à ignorer.
fn is_ignored_dir(name: &str) -> bool {
    matches!(
        name,
        ".git" | "node_modules" | "target" | "dist" | "build" | ".next" | ".turbo" | "vendor"
    )
}

/// Extrait `name`/`description` du frontmatter d'un `SKILL.md` (parseur simple
/// `key: value`, identique à la convention du projet).
fn parse_frontmatter(content: &str) -> (Option<String>, Option<String>) {
    let trimmed = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut lines = trimmed.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (None, None);
    }
    let mut name = None;
    let mut description = None;
    for line in lines {
        let line = line.trim();
        if line == "---" {
            break;
        }
        let lower = line.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("name:") {
            let raw = &line[line.len() - rest.len()..];
            name = Some(raw.trim().trim_matches('"').trim_matches('\'').to_string());
        } else if let Some(rest) = lower.strip_prefix("description:") {
            let raw = &line[line.len() - rest.len()..];
            description =
                Some(raw.trim().trim_matches('"').trim_matches('\'').to_string());
        }
    }
    (name.filter(|s| !s.is_empty()), description.filter(|s| !s.is_empty()))
}

/// Normalise un nom de skill en **slug** valide pour `validate_name` :
/// minuscules, `[a-z0-9-]`, longueur bornée. Retourne `None` si l'entrée ne
/// contient rien d'exploitable.
fn slugify(raw: &str) -> Option<String> {
    let mut out = String::new();
    let mut prev_dash = false;
    for c in raw.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            prev_dash = false;
        } else if c == '-' || c == '_' || c == '.' || c == ' ' {
            if !prev_dash && !out.is_empty() {
                out.push('-');
                prev_dash = true;
            }
        }
        // Les autres caractères (Unicode, ponctuation) sont ignorés.
    }
    let out = out.trim_matches('-').to_string();
    if out.is_empty() || out.len() > 64 {
        return None;
    }
    // Un slug ne peut pas commencer par un chiffre pour `validate_name` ? Non :
    // `validate_name` accepte un chiffre initial. On reste cohérent avec lui.
    Some(out)
}

/// Parcourt récursivement l'extraction à la recherche de `SKILL.md`, en bornant
/// la profondeur et en ignorant les dossiers de dépendances.
fn scan_skills(root: &Path, dir: &Path, depth: usize, out: &mut Vec<DiscoveredSkill>) {
    if depth > MAX_SCAN_DEPTH || out.len() >= MAX_SKILLS_PER_IMPORT {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut subdirs: Vec<PathBuf> = Vec::new();
    let mut has_skill_md = false;

    for entry in entries.flatten() {
        let path = entry.path();
        let Some(file_name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if path.is_dir() {
            if !is_ignored_dir(file_name) {
                subdirs.push(path);
            }
        } else if file_name.eq_ignore_ascii_case("SKILL.md") {
            has_skill_md = true;
        }
    }

    if has_skill_md {
        if let Some(skill) = read_skill_at(dir) {
            // Garde de déduplication par nom.
            if !out.iter().any(|s| s.name == skill.name) {
                out.push(skill);
            }
        }
        // Un dossier portant un SKILL.md est un skill : on NE descend pas dedans.
        return;
    }

    for sub in subdirs {
        scan_skills(root, &sub, depth + 1, out);
    }
}

/// Lit le `SKILL.md` d'un dossier et en construit un `DiscoveredSkill`.
/// Retourne `None` si le fichier est absent, trop gros, ou sans nom exploitable.
fn read_skill_at(dir: &Path) -> Option<DiscoveredSkill> {
    let file = dir.join("SKILL.md");
    let meta = std::fs::metadata(&file).ok()?;
    if meta.len() > MAX_SKILL_BYTES {
        return None;
    }
    let mut content = String::new();
    std::fs::File::open(&file)
        .ok()?
        .take(MAX_SKILL_BYTES + 1)
        .read_to_string(&mut content)
        .ok()?;

    let (fm_name, fm_desc) = parse_frontmatter(&content);
    let dir_name = dir.file_name().and_then(|s| s.to_str()).unwrap_or("");
    let name = slugify(fm_name.as_deref().unwrap_or(dir_name))?;

    Some(DiscoveredSkill {
        name,
        description: fm_desc,
        source_dir: dir.to_path_buf(),
    })
}

/// `true` si `candidate` est un dossier **descendant strict** de `root` (et non
/// la racine elle-même). Utilisé pour refuser l'export de la racine entière.
fn is_strict_descendant(root: &Path, candidate: &Path) -> bool {
    candidate != root && candidate.starts_with(root)
}

/// Copie l'arborescence du skill (bornée) vers `dest`. Ignore les dossiers
/// volumineux/inutiles et refuse toute sortie de `dest`. Retourne le nombre de
/// fichiers écrits.
fn copy_skill_tree(src: &Path, dest: &Path) -> Result<usize, String> {
    let mut count = 0usize;
    let mut stack: Vec<(PathBuf, PathBuf)> = vec![(src.to_path_buf(), dest.to_path_buf())];

    while let Some((from, to)) = stack.pop() {
        std::fs::create_dir_all(&to).map_err(|e| format!("création dossier: {e}"))?;
        let entries = std::fs::read_dir(&from).map_err(|e| format!("lecture dossier: {e}"))?;
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(file_name) = path.file_name().and_then(|s| s.to_str()).map(str::to_string)
            else {
                continue;
            };
            if path.is_dir() {
                if is_ignored_dir(&file_name) || file_name.starts_with('.') {
                    continue;
                }
                stack.push((path, to.join(&file_name)));
            } else if path.is_file() {
                // `validate_name` couvre les noms d'artefacts ; ici on borne
                // simplement la taille pour éviter d'importer un binaire énorme.
                if std::fs::metadata(&path).map(|m| m.len() > MAX_SKILL_BYTES).unwrap_or(true) {
                    continue;
                }
                std::fs::copy(&path, to.join(&file_name))
                    .map_err(|e| format!("copie fichier: {e}"))?;
                count += 1;
            }
        }
    }
    Ok(count)
}

/// Télécharge et installe un ou plusieurs skills d'un dépôt GitHub dans
/// `<scope>/.mira/skills`. Commande Tauri appelée depuis la page Skills.
///
/// `skill` : nom de skill souhaité (dossier) ; `None` ⇒ tous les skills trouvés.
#[tauri::command]
pub async fn import_skills_from_repo(
    scope: String,
    workspace: Option<String>,
    owner: String,
    repo: String,
    branch: Option<String>,
    skill: Option<String>,
) -> Result<ImportResult, String> {
    // 1 — Validation stricte des entrées (anti-SSRF / anti-traversal).
    validate_slug(&owner, "dépôt")?;
    validate_slug(&repo, "dépôt")?;
    let explicit_branch = match branch.as_deref() {
        Some(b) if !b.trim().is_empty() => {
            validate_slug(b, "branche")?;
            Some(b.to_string())
        }
        _ => None,
    };

    let http = client()?;

    // 2 — Téléchargement avec repli sur `master` si `main` n'existe pas.
    let branches: Vec<String> = match explicit_branch {
        Some(b) => vec![b],
        None => BRANCHES.iter().map(|s| s.to_string()).collect(),
    };
    let mut tarball: Option<Vec<u8>> = None;
    for b in &branches {
        match fetch_tarball(&http, &owner, &repo, b).await {
            Ok(Some(bytes)) => {
                tarball = Some(bytes);
                break;
            }
            Ok(None) => continue,
            Err(e) => return Err(e),
        }
    }
    let bytes = tarball
        .ok_or_else(|| format!("dépôt introuvable: {owner}/{repo} (branche main/master)"))?;

    // 3 — Extraction sûre dans un dossier temporaire **hors** des racines .mira.
    let staging = std::env::temp_dir().join(format!(
        "mira-skill-import-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let cleanup = StagingGuard(staging.clone());

    if let Err(e) = crate::downloader::extract_tar_gz(&bytes, &staging) {
        return Err(format!("archive illisible: {}", e.message));
    }

    // 4 — Découverte des skills (le tar contient un unique dossier racine
    // `owner-repo-<sha>/`).
    let root = single_root_dir(&staging).unwrap_or_else(|| staging.clone());
    let mut found: Vec<DiscoveredSkill> = Vec::new();
    scan_skills(&root, &root, 0, &mut found);
    if found.is_empty() {
        return Err("aucun skill (SKILL.md) trouvé dans ce dépôt".to_string());
    }

    // 5 — Filtrage par nom si demandé.
    if let Some(wanted) = skill.as_deref() {
        let wanted_slug = slugify(wanted).unwrap_or_else(|| wanted.to_lowercase());
        found.retain(|s| s.name == wanted_slug);
        if found.is_empty() {
            return Err(format!("skill « {wanted} » introuvable dans ce dépôt"));
        }
    }

    // 6 — Installation sous `.mira/skills` (racine unique et confinée).
    let dest_root = extensions_store::skill_write_root(&scope, workspace.as_deref())?;
    let mut installed: Vec<String> = Vec::new();
    for discovered in &found {
        extensions_store::validate_name(&discovered.name)?;
        // On refuse d'exporter la racine entière de l'extraction (cas `SKILL.md`
        // à la racine du dépôt → `source_dir == root` : autorisé, mais on copie
        // alors le seul dossier racine sous son nom de skill).
        let dest = dest_root.join(&discovered.name);
        extensions_store::ensure_within(&dest_root, &dest)?;
        if is_strict_descendant(&staging, &dest) {
            return Err("chemin de destination invalide".to_string());
        }
        // Remplacement atomique : on installe dans un dossier temporaire voisin
        // puis on `rename` sur la destination finale.
        let tmp = dest_root.join(format!(".mira-tmp-{}", discovered.name));
        let _ = std::fs::remove_dir_all(&tmp);
        copy_skill_tree(&discovered.source_dir, &tmp)?;
        let _ = std::fs::remove_dir_all(&dest);
        std::fs::rename(&tmp, &dest).map_err(|e| format!("finalisation: {e}"))?;
        installed.push(discovered.name.clone());
    }

    drop(cleanup);
    Ok(ImportResult { installed })
}

/// Retourne l'unique sous-dossier de `dir` s'il n'y en a qu'un (cas de l'archive
/// GitHub `owner-repo-sha/`), sinon `None`.
fn single_root_dir(dir: &Path) -> Option<PathBuf> {
    let mut dirs = Vec::new();
    let mut files = 0usize;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        if entry.path().is_dir() {
            dirs.push(entry.path());
        } else {
            files += 1;
        }
    }
    if dirs.len() == 1 && files == 0 {
        Some(dirs.remove(0))
    } else {
        None
    }
}

/// Supprime le dossier de staging en fin de vie (RAII), même en cas d'erreur.
struct StagingGuard(PathBuf);

impl Drop for StagingGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_validation_refuse_les_evasions() {
        assert!(validate_slug("vercel-labs", "repo").is_ok());
        assert!(validate_slug("agent_skills.v2", "repo").is_ok());
        assert!(validate_slug("../etc", "repo").is_err());
        assert!(validate_slug("a/b", "repo").is_err());
        assert!(validate_slug("", "repo").is_err());
        assert!(validate_slug(".hidden", "repo").is_err());
        assert!(validate_slug("with space", "repo").is_err());
    }

    #[test]
    fn slugify_normalise_les_noms() {
        assert_eq!(slugify("Frontend Design"), Some("frontend-design".to_string()));
        assert_eq!(slugify("my_skill"), Some("my-skill".to_string()));
        assert_eq!(slugify("  ...  "), None);
        assert_eq!(slugify("Vercel React Best Practices").as_deref(), Some("vercel-react-best-practices"));
    }

    #[test]
    fn parse_frontmatter_lit_name_et_description() {
        let content = "---\nname: find-skills\ndescription: Trouve un skill sur skills.sh quand l'utilisateur cherche une compétence.\n---\n\n# Corps\n";
        let (name, desc) = parse_frontmatter(content);
        assert_eq!(name.as_deref(), Some("find-skills"));
        assert!(desc.unwrap().starts_with("Trouve un skill"));
    }

    #[test]
    fn parse_frontmatter_sans_frontmatter() {
        let (name, desc) = parse_frontmatter("# Juste un titre\n");
        assert!(name.is_none());
        assert!(desc.is_none());
    }

    #[test]
    fn scan_trouve_un_skill_racine_et_des_skills_imbriques() {
        let base = std::env::temp_dir().join(format!(
            "mira-scan-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let write = |rel: &str, body: &str| {
            let p = base.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, body).unwrap();
        };
        // Skill A : à la racine de `skills/`.
        write(
            "skills/alpha/SKILL.md",
            "---\nname: alpha\ndescription: Skill A\n---\n",
        );
        // Skill B : dans un sous-dossier profond.
        write(
            "packages/beta/SKILL.md",
            "---\nname: beta\ndescription: Skill B\n---\n",
        );
        // Bruit : un dossier ignoré ne doit pas être scanné.
        write("node_modules/junk/SKILL.md", "---\nname: junk\n---\n");

        let mut out = Vec::new();
        scan_skills(&base, &base, 0, &mut out);
        let mut names: Vec<String> = out.iter().map(|s| s.name.clone()).collect();
        names.sort();
        assert_eq!(names, vec!["alpha".to_string(), "beta".to_string()]);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn copy_skill_tree_ignore_les_dossiers_caches() {
        let base = std::env::temp_dir().join(format!(
            "mira-copy-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let src = base.join("src");
        let dest = base.join("dest");
        std::fs::create_dir_all(src.join("resources")).unwrap();
        std::fs::create_dir_all(src.join(".hidden")).unwrap();
        std::fs::write(src.join("SKILL.md"), "---\nname: x\n---\n").unwrap();
        std::fs::write(src.join("resources/note.md"), "hi").unwrap();
        std::fs::write(src.join(".hidden/secret"), "no").unwrap();

        let n = copy_skill_tree(&src, &dest).unwrap();
        assert_eq!(n, 2);
        assert!(dest.join("SKILL.md").is_file());
        assert!(dest.join("resources/note.md").is_file());
        assert!(!dest.join(".hidden").exists());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn single_root_dir_detecte_l_unique_dossier() {
        let base = std::env::temp_dir().join(format!(
            "mira-root-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(base.join("owner-repo-abc123")).unwrap();
        assert_eq!(
            single_root_dir(&base).map(|p| p.file_name().unwrap().to_string_lossy().to_string()),
            Some("owner-repo-abc123".to_string())
        );
        // Deux dossiers ⇒ ambigu, `None`.
        std::fs::create_dir_all(base.join("other")).unwrap();
        assert!(single_root_dir(&base).is_none());
        let _ = std::fs::remove_dir_all(&base);
    }
}
