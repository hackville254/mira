//! Stockage des extensions utilisateur de Mira — Skills, Commands, Rules, Hooks
//! et serveurs MCP.
//!
//! ── Pourquoi ce module existe ────────────────────────────────────────────────
//! Le moteur d'agent (SDK, côté sidecar) sait déjà LIRE ces artefacts, mais :
//!   - il ne les expose au front qu'au démarrage d'une session (`start`), jamais
//!     au `resume` — les pages Settings seraient donc vides tant qu'aucun agent
//!     n'a tourné ;
//!   - il ne connaît PAS la notion de « command » de Trae (fichiers `.md` dans un
//!     dossier `commands/`) : les commands du SDK sont DÉRIVÉES des skills et
//!     workflows, il n'y a pas de dossier `commands/`.
//!
//! Ce module donne au front un accès **disque direct** pour lister / créer /
//! modifier / supprimer ces artefacts, indépendamment d'une session agent.
//!
//! ── Convention de marque (règle produit) ─────────────────────────────────────
//! Le client ne doit JAMAIS voir `.cline`. Toutes les racines exposées sont sous
//! `.mira` :
//!   - global :  `~/.mira/{skills,commands,rules,hooks}`, `~/.mira/mcp.json`
//!   - projet :  `<workspace>/.mira/{skills,commands,rules,hooks}`
//!
//! Deux exceptions assumées, invisibles côté UI :
//!   - **Hooks** : le SDK ne lit QUE `.cline/hooks` (projet) et `~/.cline/hooks`
//!     (global). On écrit donc un **alias** : `~/.mira/hooks` est l'emplacement
//!     logique affiché à l'utilisateur, mais le SDK lit `~/.cline/hooks`. Pour
//!     que ce que l'utilisateur voit soit ce que le SDK lit, la page Hooks est
//!     en lecture seule et pointe le dossier réellement lu (cf. `list_hooks`).
//!   - **MCP** : le fichier de réglages est au format du SDK, dans son `CLINE_DIR`
//!     confiné. On conserve ce fichier (source de vérité unique) plutôt que d'en
//!     créer un doublon qui divergerait.
//!
//! ── Compatibilité des skills ─────────────────────────────────────────────────
//! Au-delà de `.mira/skills`, la LECTURE des skills couvre les conventions
//! d'écosystèmes tiers, les mêmes fichiers `SKILL.md` :
//!   - **Agent Skills** (agentskills.io) : `.agents/skills`
//!   - **Claude Code** : `.claude/skills`
//! (global : `~/.agents/skills`, `~/.claude/skills`). Ces entrées sont marquées
//! `source: "external"` et restent **lecture seule** : leurs fichiers sont gérés
//! par l'outil qui les a installés, pas par Mira. L'écriture continue de cibler
//! exclusivement `.mira/skills`.
//!
//! ── Modèle de sécurité ───────────────────────────────────────────────────────
//!   1. **Confinement strict.** Toute écriture est vérifiée : le chemin résolu
//!      doit rester SOUS une racine autorisée (`~/.mira` ou `<ws>/.mira`). On
//!      refuse `..`, les chemins absolus, les séparateurs Windows, les nuls et
//!      les composants cachés/dangereux dans un nom d'artefact.
//!   2. **Noms d'artefact validés.** Un slug (`[A-Za-z0-9._-]`, longueur bornée)
//!      sert de nom de dossier/fichier — jamais un chemin arbitraire.
//!   3. **Taille bornée.** Un contenu écrit est plafonné (`MAX_CONTENT_BYTES`) :
//!      une écriture hostile ne peut pas saturer le disque via l'UI.
//!   4. **Aucune exécution.** Ce module lit/écrit des fichiers texte. Il n'exécute
//!      jamais un script ni un binaire (les hooks ne sont pas lancés ici).
//!   5. **Écriture atomique.** Écrire via un fichier temporaire puis `rename`,
//!      pour ne jamais laisser un fichier à moitié écrit.

use std::fs;
use std::path::{Component, Path, PathBuf};

/// Taille maximale d'un artefact texte (SKILL.md, commande, règle…). 256 Kio :
/// largement suffisant pour des instructions, et borné pour éviter tout abus.
const MAX_CONTENT_BYTES: usize = 256 * 1024;

/// Longueur maximale d'un nom d'artefact (dossier ou slug de commande).
const MAX_NAME_LEN: usize = 64;

// ─────────────────────────────────────────────────────────────────────────────
// Racines
// ─────────────────────────────────────────────────────────────────────────────

/// Home de l'utilisateur (`HOME`, puis `USERPROFILE` sous Windows).
fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| "home directory not found".to_string())
}

/// Racine **globale** : `~/.mira`.
fn global_root() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".mira"))
}

/// Racine **projet** : `<workspace>/.mira`. Le workspace doit être un dossier
/// absolu existant, sinon on refuse (pas d'écriture dans un chemin arbitraire).
fn project_root(workspace: &str) -> Result<PathBuf, String> {
    let p = Path::new(workspace);
    if !p.is_absolute() {
        return Err("workspace path must be absolute".to_string());
    }
    Ok(p.join(".mira"))
}

/// Une racine de découverte : le dossier `.mira` (ou `.mira/<kind>`) pour un
/// scope donné.
fn root_for(scope: &str, workspace: Option<&str>, kind: &str) -> Result<PathBuf, String> {
    match scope {
        "global" => Ok(global_root()?.join(kind)),
        "project" => {
            let ws = workspace.ok_or_else(|| "workspace required for project scope".to_string())?;
            Ok(project_root(ws)?.join(kind))
        }
        other => Err(format!("unknown scope: {other}")),
    }
}

/// Racine **d'écriture** des skills pour un scope (`.mira/skills`). Exposée à
/// `skills_import` pour garantir que l'installation vise exactement la même
/// racine confinée que l'éditeur manuel.
pub(crate) fn skill_write_root(scope: &str, workspace: Option<&str>) -> Result<PathBuf, String> {
    root_for(scope, workspace, "skills")
}

/// Racine du dossier **projet** (`.mira`) pour lister les répertoires
/// écosystémiques (`.agents/skills`, `.claude/skills`) au même niveau que
/// `.mira`. Contrairement à `root_for`, il n'y a PAS de suffixe de `kind` : ces
/// conventions imposent des noms de dossiers fixes.
fn workspace_dot_mira(scope: &str, workspace: Option<&str>) -> Result<PathBuf, String> {
    match scope {
        "global" => global_root(),
        "project" => {
            let ws = workspace.ok_or_else(|| "workspace required for project scope".to_string())?;
            project_root(ws)
        }
        other => Err(format!("unknown scope: {other}")),
    }
}

/// Découvertes **hors `.mira`** : répertoires de skills d'écosystèmes tiers que
/// Mira sait lire pour rester compatible (le client n'en voit ni le nom ni le
/// chemin : seule une provenance générique « externe » est exposée à l'UI).
///
/// Ordre = priorité : Mira d'abord, puis la convention **Agent Skills**
/// (`.agents/skills`, portée par agentskills.io), puis **Claude Code**
/// (`.claude/skills`). En cas de même nom, la première source gagne (l'UI
/// ignore les doublons suivants).
fn external_skill_roots(scope: &str, workspace: Option<&str>) -> Result<Vec<PathBuf>, String> {
    let base = workspace_dot_mira(scope, workspace)?;
    Ok(vec![
        base.join(".agents").join("skills"),
        base.join(".claude").join("skills"),
    ])
}

/// Tous les répertoires susceptibles de contenir des skills, dans l'ordre de
/// priorité (Mira d'abord). Sert à la fois au listing et à la lecture.
fn skill_roots(scope: &str, workspace: Option<&str>) -> Result<Vec<PathBuf>, String> {
    let mut roots = vec![root_for(scope, workspace, "skills")?];
    roots.extend(external_skill_roots(scope, workspace)?);
    Ok(roots)
}

/// Cherche le `SKILL.md` d'un skill nommé `name` dans l'un des `roots` (ordre de
/// priorité). Renvoie le premier trouvé, ou `None`. Aucune écriture : un skill
/// externe reste géré par son outil d'origine.
fn find_skill_file(roots: &[PathBuf], name: &str) -> Result<Option<PathBuf>, String> {
    for root in roots {
        let file = root.join(name).join("SKILL.md");
        // Le nom est validé par l'appelant ; on revérifie tout de même que le
        // chemin reste sous la racine (défense en profondeur).
        ensure_within(root, &file)?;
        if file.is_file() {
            return Ok(Some(file));
        }
    }
    Ok(None)
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation de noms
// ─────────────────────────────────────────────────────────────────────────────

/// Valide un **nom d'artefact** (dossier de skill, règle, ou slug de commande).
///
/// Règles : non vide, longueur bornée, et uniquement `[A-Za-z0-9._-]`. On refuse
/// explicitement `.` et `..`, un `-` initial (ambiguïté d'option), les caractères
/// de contrôle, et tout séparateur de chemin. Résultat : le nom ne peut PAS être
/// un chemin, donc aucune évasion de répertoire n'est possible.
pub(crate) fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("name cannot be empty".to_string());
    }
    if name.len() > MAX_NAME_LEN {
        return Err(format!("name too long (max {MAX_NAME_LEN})"));
    }
    if name == "." || name == ".." {
        return Err("invalid name".to_string());
    }
    if name.starts_with('-') || name.starts_with('.') {
        return Err(format!("name cannot start with '.' or '-': {name}"));
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
    {
        return Err(format!(
            "name may only contain letters, digits, '.', '_' and '-': {name}"
        ));
    }
    Ok(())
}

/// Vérifie que `candidate` (déjà résolu) reste **sous** `base`. Défense en
/// profondeur : même si un nom passait la validation, on refuse tout chemin qui
/// sortirait de la racine autorisée.
pub(crate) fn ensure_within(base: &Path, candidate: &Path) -> Result<(), String> {
    // On compare les chemins normalisés sans exiger qu'ils existent.
    let base = normalize_lexical(base);
    let candidate = normalize_lexical(candidate);
    if candidate.starts_with(&base) {
        Ok(())
    } else {
        Err("path escapes the allowed root".to_string())
    }
}

/// Normalisation **lexicale** (sans toucher au disque) : retire `.`, résout les
/// `..` par pop, conserve la racine. Sert à la vérification de confinement.
fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Longueur du contenu bornée.
fn validate_content(content: &str) -> Result<(), String> {
    if content.len() > MAX_CONTENT_BYTES {
        return Err(format!(
            "content too large (max {} KiB)",
            MAX_CONTENT_BYTES / 1024
        ));
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Écriture atomique
// ─────────────────────────────────────────────────────────────────────────────

/// Écrit `content` dans `path` de façon atomique (tmp + rename). Crée les parents.
/// Le fichier temporaire est dans le MÊME dossier que la cible pour que le
/// `rename` soit atomique (même volume).
fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "invalid target path".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("cannot create directory: {e}"))?;
    let tmp = parent.join(format!(
        ".mira-tmp-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    fs::write(&tmp, content).map_err(|e| format!("cannot write file: {e}"))?;
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("cannot finalize file: {e}"));
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Frontmatter minimal (parse/écriture de type `name`/`description`)
// ─────────────────────────────────────────────────────────────────────────────

/// Extrait une clé scalaire d'un frontmatter YAML simple (première occurrence).
/// On ne fait PAS un parseur YAML complet : on lit `key: value` sur une ligne,
/// ce qui couvre `name`/`description`/`enabled`/`disabled` de nos artefacts.
fn frontmatter_get(frontmatter: &str, key: &str) -> Option<String> {
    for line in frontmatter.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix(key) {
            let rest = rest.trim_start();
            if let Some(value) = rest.strip_prefix(':') {
                let value = value.trim().trim_matches('"').trim_matches('\'').trim();
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
    }
    None
}

/// Découpe un contenu markdown en `(frontmatter, body)`. Si aucun frontmatter
/// (`---` en tête), le frontmatter est vide et tout le contenu est le corps.
fn split_frontmatter(content: &str) -> (String, String) {
    let trimmed = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut lines = trimmed.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (String::new(), trimmed.to_string());
    }
    let mut fm = String::new();
    let mut body = String::new();
    let mut in_fm = true;
    let mut rest = String::new();
    for (i, line) in trimmed.lines().enumerate() {
        if i == 0 {
            continue;
        }
        if in_fm {
            if line.trim() == "---" {
                in_fm = false;
                continue;
            }
            fm.push_str(line);
            fm.push('\n');
        } else {
            rest.push_str(line);
            rest.push('\n');
        }
    }
    if in_fm {
        // Pas de fermeture : le contenu n'était pas un frontmatter valide.
        return (String::new(), trimmed.to_string());
    }
    body.push_str(rest.trim_start_matches('\n'));
    (fm, body)
}

// ─────────────────────────────────────────────────────────────────────────────
// Types renvoyés au front
// ─────────────────────────────────────────────────────────────────────────────

/// Un artefact fichier générique exposé à l'UI (skill, command, rule).
#[derive(serde::Serialize, Clone, Debug)]
pub struct ArtifactInfo {
    /// Nom court (dossier ou slug de fichier).
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    /// `true` si l'artefact est désactivé (frontmatter `enabled: false`).
    pub disabled: bool,
    /// Chemin absolu du fichier (pour édition).
    pub path: String,
    /// `"global"` ou `"project"`.
    pub scope: String,
    /// Provenance : `"mira"` (géré par Mira, éditable) ou `"external"` (dossier
    /// compatible d'un écosystème tiers — lecture seule). Absent ⇒ `"mira"`.
    #[serde(default)]
    pub source: Option<String>,
}

/// Un fichier de hook exposé à l'UI.
#[derive(serde::Serialize, Clone, Debug)]
pub struct HookInfo {
    /// Nom du fichier = nom d'événement (`TaskStart`, `PreToolUse`, …).
    pub name: String,
    pub path: String,
    pub scope: String,
    /// `true` si le fichier a une extension reconnue par le moteur (`.js`,
    /// `.mjs`, `.cjs`, `.sh`). Un fichier sans extension n'est PAS exécutable par
    /// le moteur : on l'ignore volontairement pour ne pas afficher un artefact
    /// inerte comme s'il était actif.
    pub executable: bool,
}

/// Un serveur MCP tel qu'exposé à l'UI (format SDK aplati).
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct McpServerInfo {
    /// Nom (clé dans `mcpServers`).
    pub name: String,
    /// `"stdio"` | `"sse"` | `"streamableHttp"`.
    #[serde(rename = "type")]
    pub transport_type: String,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub headers: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub disabled: bool,
}

// ─────────────────────────────────────────────────────────────────────────────
// Skills
// ─────────────────────────────────────────────────────────────────────────────

/// Liste les skills d'un scope. Un skill = dossier `<root>/<name>/` contenant un
/// `SKILL.md` (convention du SDK). On tolère aussi `<root>/<name>.md`.
///
/// **Compatibilité.** Au-delà de `.mira/skills`, on lit aussi les répertoires
/// d'écosystèmes tiers (`.agents/skills`, `.claude/skills`) pour que les skills
/// déjà installés ailleurs restent utilisables sans duplication. Les entrées de
/// ces dossiers sont marquées `source: "external"` et restent en lecture seule.
/// En cas de même nom, `.mira/skills` (source `mira`) gagne.
#[tauri::command]
pub fn list_skills(scope: String, workspace: Option<String>) -> Result<Vec<ArtifactInfo>, String> {
    let roots = skill_roots(&scope, workspace.as_deref())?;
    let mut out: Vec<ArtifactInfo> = Vec::new();
    for (i, root) in roots.iter().enumerate() {
        let source = if i == 0 { "mira" } else { "external" };
        let mut items = list_artifact_dirs(root, "SKILL.md", &scope)?;
        for item in &mut items {
            item.source = Some(source.to_string());
        }
        out.extend(items);
    }
    // Déduplication par nom : la première source (Mira) est prioritaire.
    out.sort_by(|a, b| {
        a.name
            .cmp(&b.name)
            .then_with(|| priority(a.source.as_deref()).cmp(&priority(b.source.as_deref())))
    });
    out.dedup_by(|a, b| a.name == b.name);
    Ok(out)
}

/// Priorité de tri d'une provenance (Mira d'abord). Sert à la déduplication.
fn priority(source: Option<&str>) -> u8 {
    match source {
        Some("external") => 1,
        _ => 0,
    }
}

/// Lecture du contenu brut d'un skill (son `SKILL.md`). Cherche dans `.mira`
/// puis dans les répertoires compatibles.
#[tauri::command]
pub fn read_skill(scope: String, workspace: Option<String>, name: String) -> Result<String, String> {
    validate_name(&name)?;
    let roots = skill_roots(&scope, workspace.as_deref())?;
    let path = find_skill_file(&roots, &name)?
        .ok_or_else(|| format!("skill not found: {name}"))?;
    fs::read_to_string(&path).map_err(|e| format!("cannot read skill: {e}"))
}

/// Crée (ou remplace) un skill : écrit `<root>/<name>/SKILL.md`.
#[tauri::command]
pub fn write_skill(
    scope: String,
    workspace: Option<String>,
    name: String,
    content: String,
) -> Result<String, String> {
    validate_name(&name)?;
    validate_content(&content)?;
    let root = root_for(&scope, workspace.as_deref(), "skills")?;
    let path = root.join(&name).join("SKILL.md");
    ensure_within(&root, &path)?;
    write_atomic(&path, &content)?;
    Ok(path.to_string_lossy().to_string())
}

/// Supprime un skill (son dossier entier).
#[tauri::command]
pub fn delete_skill(scope: String, workspace: Option<String>, name: String) -> Result<(), String> {
    validate_name(&name)?;
    let root = root_for(&scope, workspace.as_deref(), "skills")?;
    let path = root.join(&name);
    ensure_within(&root, &path)?;
    if path.is_dir() {
        fs::remove_dir_all(&path).map_err(|e| format!("cannot delete skill: {e}"))?;
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands (slash-commands de Trae — `.mira/commands/*.md`)
// ─────────────────────────────────────────────────────────────────────────────

/// Liste les commands d'un scope. Un command = fichier `<root>/<name>.md`.
/// On scanne de façon récursive et plafonnée (Trae autorise jusqu'à 3 niveaux).
#[tauri::command]
pub fn list_commands(scope: String, workspace: Option<String>) -> Result<Vec<ArtifactInfo>, String> {
    let root = root_for(&scope, workspace.as_deref(), "commands")?;
    list_artifact_files(&root, &scope, 3)
}

/// Lecture du contenu d'un command (chemin relatif sous `commands/`).
#[tauri::command]
pub fn read_command(
    scope: String,
    workspace: Option<String>,
    rel_path: String,
) -> Result<String, String> {
    let root = root_for(&scope, workspace.as_deref(), "commands")?;
    let path = safe_rel_under(&root, &rel_path)?;
    fs::read_to_string(&path).map_err(|e| format!("cannot read command: {e}"))
}

/// Crée (ou remplace) un command : `<root>/<rel_path>.md`.
#[tauri::command]
pub fn write_command(
    scope: String,
    workspace: Option<String>,
    rel_path: String,
    content: String,
) -> Result<String, String> {
    validate_content(&content)?;
    let root = root_for(&scope, workspace.as_deref(), "commands")?;
    let mut rel = rel_path;
    if !rel.ends_with(".md") {
        rel.push_str(".md");
    }
    let path = safe_rel_under(&root, &rel)?;
    write_atomic(&path, &content)?;
    Ok(path.to_string_lossy().to_string())
}

/// Supprime un command.
#[tauri::command]
pub fn delete_command(
    scope: String,
    workspace: Option<String>,
    rel_path: String,
) -> Result<(), String> {
    let root = root_for(&scope, workspace.as_deref(), "commands")?;
    let path = safe_rel_under(&root, &rel_path)?;
    if path.is_file() {
        fs::remove_file(&path).map_err(|e| format!("cannot delete command: {e}"))?;
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Rules
// ─────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_rules(scope: String, workspace: Option<String>) -> Result<Vec<ArtifactInfo>, String> {
    let root = root_for(&scope, workspace.as_deref(), "rules")?;
    // Rules : fichiers `.md` (et `.mdc`) à plat.
    let mut items = list_artifact_files(&root, &scope, 1)?;
    items.retain(|i| i.path.ends_with(".md") || i.path.ends_with(".mdc"));
    Ok(items)
}

#[tauri::command]
pub fn read_rule(
    scope: String,
    workspace: Option<String>,
    rel_path: String,
) -> Result<String, String> {
    let root = root_for(&scope, workspace.as_deref(), "rules")?;
    let path = safe_rel_under(&root, &rel_path)?;
    fs::read_to_string(&path).map_err(|e| format!("cannot read rule: {e}"))
}

#[tauri::command]
pub fn write_rule(
    scope: String,
    workspace: Option<String>,
    rel_path: String,
    content: String,
) -> Result<String, String> {
    validate_content(&content)?;
    let root = root_for(&scope, workspace.as_deref(), "rules")?;
    let mut rel = rel_path;
    if !rel.ends_with(".md") && !rel.ends_with(".mdc") {
        rel.push_str(".md");
    }
    let path = safe_rel_under(&root, &rel)?;
    write_atomic(&path, &content)?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn delete_rule(
    scope: String,
    workspace: Option<String>,
    rel_path: String,
) -> Result<(), String> {
    let root = root_for(&scope, workspace.as_deref(), "rules")?;
    let path = safe_rel_under(&root, &rel_path)?;
    if path.is_file() {
        fs::remove_file(&path).map_err(|e| format!("cannot delete rule: {e}"))?;
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Memories (fichier unique `memories.md` sous `.mira`)
// ─────────────────────────────────────────────────────────────────────────────
//
// Une « memory » est une note durable que l'agent relit à chaque session : un
// fichier Markdown unique, `<root>/memories.md`. Contrairement aux règles
// (plusieurs fichiers `.md`), la mémoire du projet est un seul document — c'est
// la convention de Trae. On garde donc des commandes dédiées plutôt que de
// réutiliser le CRUD générique des rules.

/// Chemin du fichier de mémoire pour un scope : `<.mira>/memories.md`.
fn memories_path(scope: &str, workspace: Option<&str>) -> Result<PathBuf, String> {
    let root = workspace_dot_mira(scope, workspace)?;
    let path = root.join("memories.md");
    ensure_within(&root, &path)?;
    Ok(path)
}

/// Lit la mémoire d'un scope. Absente ⇒ chaîne vide (pas d'erreur : un projet
/// sans mémoire est un état normal).
#[tauri::command]
pub fn read_memories(scope: String, workspace: Option<String>) -> Result<String, String> {
    let path = memories_path(&scope, workspace.as_deref())?;
    match fs::read_to_string(&path) {
        Ok(content) => Ok(content),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("cannot read memories: {e}")),
    }
}

/// Écrit (ou remplace) la mémoire d'un scope. Un contenu vide EFFACE le
/// fichier : on ne laisse pas traîner un `memories.md` vide qui ferait croire à
/// une mémoire existante.
#[tauri::command]
pub fn write_memories(
    scope: String,
    workspace: Option<String>,
    content: String,
) -> Result<(), String> {
    let path = memories_path(&scope, workspace.as_deref())?;
    if content.trim().is_empty() {
        if path.is_file() {
            fs::remove_file(&path).map_err(|e| format!("cannot clear memories: {e}"))?;
        }
        return Ok(());
    }
    validate_content(&content)?;
    write_atomic(&path, &content)
}

// ─────────────────────────────────────────────────────────────────────────────
// Hooks
// ─────────────────────────────────────────────────────────────────────────────
//
// Un hook est un SCRIPT exécuté automatiquement par le moteur à un moment précis
// (début de tâche, avant un outil, …). C'est la surface la plus sensible de tout
// l'IDE : on la traite donc avec un soin particulier.
//
// ⚠️ Emplacement RÉELLEMENT lu par le moteur. Le SDK ne lit QUE
// `~/.cline/hooks` (global) et `<ws>/.cline/hooks` (projet) — il n'accepte PAS
// de dossier personnalisé. `.mira/hooks` ne serait donc jamais lu. Pour que ce
// que l'utilisateur crée depuis Mira soit EFFECTIVEMENT actif, on écrit dans ces
// dossiers réels, tout en masquant la convention côté UI (le client ne voit
// jamais `.cline`).
//
// Modèle de sécurité propre aux hooks (en plus du confinement commun) :
//   1. **Nom d'événement en liste blanche.** Seuls les 10 événements connus du
//      moteur sont acceptés — sinon le fichier ne serait jamais déclenché (au
//      mieux inerte, au pire source de confusion).
//   2. **Extension forcée.** On écrit dans un fichier à extension reconnue
//      (`.js` par défaut) : un fichier sans extension ne serait pas exécuté.
//   3. **Confinement.** Le chemin reste strictement sous `.cline/hooks`.
//   4. **Aucune exécution ici.** Ce module écrit le script ; il ne le lance
//      jamais. L'exécution (et donc le risque) reste déclenchée par le moteur.

/// Les 10 événements de hook reconnus par le moteur. Liste blanche stricte :
/// elle est le SEUL ensemble de noms de fichiers acceptés en écriture.
pub(crate) const HOOK_EVENTS: [&str; 10] = [
    "TaskStart",
    "TaskResume",
    "TaskCancel",
    "TaskComplete",
    "TaskError",
    "PreToolUse",
    "PostToolUse",
    "UserPromptSubmit",
    "PreCompact",
    "SessionShutdown",
];

/// Vérifie qu'un nom d'événement appartient à la liste blanche. Empêche toute
/// écriture sous un nom arbitraire (donc tout chemin détourné).
fn validate_hook_event(event: &str) -> Result<(), String> {
    if HOOK_EVENTS.contains(&event) {
        Ok(())
    } else {
        Err(format!("unknown hook event: {event}"))
    }
}

/// Extensions qu'un script de hook peut porter. Le moteur exécute le script
/// selon son extension ; on n'écrit que dans ces formats connus.
fn validate_hook_extension(ext: &str) -> Result<(), String> {
    match ext {
        "js" | "mjs" | "cjs" | "sh" => Ok(()),
        other => Err(format!("unsupported hook extension: .{other}")),
    }
}

/// Dossier **réellement lu par le moteur** pour un scope (`.cline/hooks`).
/// C'est aussi la racine d'écriture : écrire ailleurs rendrait le hook inerte.
fn hooks_dir(scope: &str, workspace: Option<&str>) -> Result<PathBuf, String> {
    match scope {
        "global" => Ok(home_dir()?.join(".cline").join("hooks")),
        "project" => {
            let ws = workspace.ok_or_else(|| "workspace required for project scope".to_string())?;
            if !Path::new(ws).is_absolute() {
                return Err("workspace path must be absolute".to_string());
            }
            Ok(Path::new(ws).join(".cline").join("hooks"))
        }
        other => Err(format!("unknown scope: {other}")),
    }
}

/// Chemin du fichier de hook pour `(event, ext)`, confiné sous `hooks_dir`.
fn hook_path(
    scope: &str,
    workspace: Option<&str>,
    event: &str,
    ext: &str,
) -> Result<PathBuf, String> {
    validate_hook_event(event)?;
    validate_hook_extension(ext)?;
    let root = hooks_dir(scope, workspace)?;
    let path = root.join(format!("{event}.{ext}"));
    ensure_within(&root, &path)?;
    Ok(path)
}

/// Liste les hooks RÉELLEMENT lus par le moteur (`~/.cline/hooks` et
/// `<ws>/.cline/hooks`). Seuls les fichiers à extension exécutable sont
/// retenus : un fichier sans extension reconnue ne serait jamais lancé.
#[tauri::command]
pub fn list_hooks(scope: String, workspace: Option<String>) -> Result<Vec<HookInfo>, String> {
    let root = hooks_dir(&scope, workspace.as_deref())?;
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(&root) else {
        return Ok(out);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        out.push(HookInfo {
            name: stem.to_string(),
            path: path.to_string_lossy().to_string(),
            scope: scope.clone(),
            executable: validate_hook_extension(&ext).is_ok(),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Lit le contenu d'un hook pour l'éditeur. La cible est résolue à partir du
/// couple `(event, ext)` validé — jamais d'un chemin fourni par le front — donc
/// aucune évasion de répertoire n'est possible.
#[tauri::command]
pub fn read_hook(
    scope: String,
    workspace: Option<String>,
    event: String,
    ext: String,
) -> Result<String, String> {
    let path = hook_path(&scope, workspace.as_deref(), &event, &ext)?;
    match fs::read_to_string(&path) {
        Ok(content) => Ok(content),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("cannot read hook: {e}")),
    }
}

/// Crée ou remplace le script d'un événement. Un contenu vide EFFACE le hook
/// (même logique que les memories : on ne laisse pas un script vide qui ferait
/// croire à un hook actif).
#[tauri::command]
pub fn write_hook(
    scope: String,
    workspace: Option<String>,
    event: String,
    ext: String,
    content: String,
) -> Result<(), String> {
    let path = hook_path(&scope, workspace.as_deref(), &event, &ext)?;
    if content.trim().is_empty() {
        if path.is_file() {
            fs::remove_file(&path).map_err(|e| format!("cannot clear hook: {e}"))?;
        }
        return Ok(());
    }
    validate_content(&content)?;
    write_atomic(&path, &content)
}

/// Supprime le(s) fichier(s) d'un événement, toutes extensions confondues. On
/// balaie les extensions connues plutôt que d'en exiger une seule : la
/// suppression doit fonctionner quel que soit le format du hook présent.
#[tauri::command]
pub fn delete_hook(
    scope: String,
    workspace: Option<String>,
    event: String,
) -> Result<(), String> {
    validate_hook_event(&event)?;
    let root = hooks_dir(&scope, workspace.as_deref())?;
    for ext in ["js", "mjs", "cjs", "sh"] {
        let path = root.join(format!("{event}.{ext}"));
        ensure_within(&root, &path)?;
        if path.is_file() {
            fs::remove_file(&path).map_err(|e| format!("cannot delete hook: {e}"))?;
        }
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP — fichier de réglages du SDK
// ─────────────────────────────────────────────────────────────────────────────

/// Chemin du fichier de réglages MCP, identique à celui résolu par le SDK :
/// `<CLINE_DATA_DIR>/settings/cline_mcp_settings.json`. Le nom de fichier vient
/// du SDK ; il n'est PAS affiché à l'utilisateur (URL/chemin technique).
fn mcp_settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve app data dir: {e}"))?;
    Ok(base
        .join("mira")
        .join("settings")
        .join("cline_mcp_settings.json"))
}

/// Crée le fichier de réglages MCP par défaut s'il est absent, avec un contenu
/// vide valide (`{"mcpServers":{}}`).
///
/// POURQUOI : le SDK lit ce fichier de façon NON tolérante au démarrage d'une
/// session (`registerMcpServersFromSettingsFile` → `ENOENT`). Sur une
/// installation neuve où aucun serveur MCP n'a été ajouté, ni le dossier
/// `settings/` ni le fichier n'existent → l'agent échoue au lancement
/// (« erreur du moteur d'agent »). On provisionne donc un fichier vide au
/// démarrage pour que le SDK lise une configuration valide.
///
/// IDEMPOTENT : si le fichier existe déjà (même vide/partiel), on ne le touche
/// JAMAIS — aucune perte de la configuration de l'utilisateur. Best-effort :
/// toute erreur d'E/S est journalisée mais ne bloque pas le démarrage.
pub fn ensure_mcp_settings_file(app: &tauri::AppHandle) {
    let path = match mcp_settings_path(app) {
        Ok(p) => p,
        Err(e) => {
            crate::log::log_line("warn", "extensions_store", &format!("ensure_mcp_settings: {e}"));
            return;
        }
    };
    if path.exists() {
        return;
    }
    if let Some(parent) = path.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            crate::log::log_line(
                "warn",
                "extensions_store",
                &format!("ensure_mcp_settings: create_dir {e}"),
            );
            return;
        }
    }
    match write_atomic_json(&path, &serde_json::json!({ "mcpServers": {} })) {
        Ok(()) => crate::log::log_line(
            "info",
            "extensions_store",
            "MCP settings file provisioned (empty)",
        ),
        Err(e) => crate::log::log_line(
            "warn",
            "extensions_store",
            &format!("ensure_mcp_settings: write {e}"),
        ),
    }
}

/// Lit la liste des serveurs MCP depuis le fichier de réglages du SDK.
#[tauri::command]
pub fn list_mcp_servers(app: tauri::AppHandle) -> Result<Vec<McpServerInfo>, String> {
    let path = mcp_settings_path(&app)?;
    let Ok(raw) = fs::read_to_string(&path) else {
        return Ok(Vec::new());
    };
    let parsed: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("invalid MCP settings file: {e}"))?;
    let Some(servers) = parsed.get("mcpServers").and_then(|v| v.as_object()) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for (name, value) in servers {
        out.push(parse_mcp_entry(name, value));
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Convertit une entrée JSON du fichier MCP en `McpServerInfo` (tolérant : une
/// entrée malformée ne casse pas les autres).
fn parse_mcp_entry(name: &str, value: &serde_json::Value) -> McpServerInfo {
    let obj = value.as_object();
    let get_str = |k: &str| obj.and_then(|o| o.get(k)).and_then(|v| v.as_str());
    let get_map = |k: &str| -> std::collections::BTreeMap<String, String> {
        obj.and_then(|o| o.get(k))
            .and_then(|v| v.as_object())
            .map(|m| {
                m.iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                    .collect()
            })
            .unwrap_or_default()
    };
    McpServerInfo {
        name: name.to_string(),
        transport_type: get_str("type").unwrap_or("stdio").to_string(),
        command: get_str("command").map(str::to_string),
        args: obj
            .and_then(|o| o.get("args"))
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        url: get_str("url").map(str::to_string),
        env: get_map("env"),
        headers: get_map("headers"),
        disabled: obj
            .and_then(|o| o.get("disabled"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
    }
}

/// Écrit (crée ou remplace) un serveur MCP dans le fichier de réglages.
#[tauri::command]
pub fn write_mcp_server(app: tauri::AppHandle, server: McpServerInfo) -> Result<(), String> {
    validate_name(&server.name)?;
    let path = mcp_settings_path(&app)?;
    let mut root = read_mcp_json(&path)?;
    let servers = root
        .as_object_mut()
        .unwrap()
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}));
    let entry = mcp_entry_to_json(&server);
    servers
        .as_object_mut()
        .ok_or_else(|| "mcpServers is not an object".to_string())?
        .insert(server.name.clone(), entry);
    write_atomic_json(&path, &root)
}

/// Active / désactive un serveur MCP (champ `disabled`).
#[tauri::command]
pub fn set_mcp_server_disabled(
    app: tauri::AppHandle,
    name: String,
    disabled: bool,
) -> Result<(), String> {
    validate_name(&name)?;
    let path = mcp_settings_path(&app)?;
    let mut root = read_mcp_json(&path)?;
    if let Some(entry) = root
        .get_mut("mcpServers")
        .and_then(|s| s.as_object_mut())
        .and_then(|s| s.get_mut(&name))
        .and_then(|e| e.as_object_mut())
    {
        entry.insert("disabled".to_string(), serde_json::Value::Bool(disabled));
    }
    write_atomic_json(&path, &root)
}

/// Supprime un serveur MCP du fichier de réglages.
#[tauri::command]
pub fn delete_mcp_server(app: tauri::AppHandle, name: String) -> Result<(), String> {
    validate_name(&name)?;
    let path = mcp_settings_path(&app)?;
    let mut root = read_mcp_json(&path)?;
    if let Some(servers) = root.get_mut("mcpServers").and_then(|s| s.as_object_mut()) {
        servers.remove(&name);
    }
    write_atomic_json(&path, &root)
}

/// Lit le fichier de réglages MCP, ou un objet vide `{ "mcpServers": {} }`.
fn read_mcp_json(path: &Path) -> Result<serde_json::Value, String> {
    match fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw)
            .map_err(|e| format!("invalid MCP settings file: {e}")),
        Err(_) => Ok(serde_json::json!({ "mcpServers": {} })),
    }
}

/// Sérialise et écrit le fichier MCP (atomique, JSON indenté).
fn write_atomic_json(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    let pretty = serde_json::to_string_pretty(value)
        .map_err(|e| format!("cannot serialize MCP settings: {e}"))?;
    write_atomic(path, &pretty)
}

/// Convertit un `McpServerInfo` en entrée JSON au format SDK.
fn mcp_entry_to_json(server: &McpServerInfo) -> serde_json::Value {
    let mut obj = serde_json::Map::new();
    obj.insert(
        "type".to_string(),
        serde_json::Value::String(server.transport_type.clone()),
    );
    match server.transport_type.as_str() {
        "sse" | "streamableHttp" => {
            if let Some(url) = &server.url {
                obj.insert("url".to_string(), serde_json::Value::String(url.clone()));
            }
            if !server.headers.is_empty() {
                obj.insert(
                    "headers".to_string(),
                    serde_json::to_value(&server.headers).unwrap_or_default(),
                );
            }
        }
        _ => {
            if let Some(cmd) = &server.command {
                obj.insert("command".to_string(), serde_json::Value::String(cmd.clone()));
            }
            if !server.args.is_empty() {
                obj.insert(
                    "args".to_string(),
                    serde_json::to_value(&server.args).unwrap_or_default(),
                );
            }
            if !server.env.is_empty() {
                obj.insert(
                    "env".to_string(),
                    serde_json::to_value(&server.env).unwrap_or_default(),
                );
            }
        }
    }
    if server.disabled {
        obj.insert("disabled".to_string(), serde_json::Value::Bool(true));
    }
    serde_json::Value::Object(obj)
}

// ─────────────────────────────────────────────────────────────────────────────
// Agents personnalisés — `~/.mira/agents/<slug>.json`
// ─────────────────────────────────────────────────────────────────────────────

/// Un **agent personnalisé** créé par l'utilisateur.
///
/// Un agent = un prompt de rôle + une sélection d'outils + une sélection de
/// serveurs MCP. Il est **persisté globalement** dans `~/.mira/agents` : il
/// reste disponible pour toutes les conversations et tous les projets, comme le
/// demande la spécification produit.
///
/// Sécurité : `prompt` est du texte **inerte** injecté dans le prompt système
/// (jamais exécuté) ; `tools`/`mcp` sont des **listes d'identifiants** que le
/// front ré-interprète — un identifiant inconnu est simplement ignoré, jamais
/// résolu comme chemin ou commande.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct AgentInfo {
    /// Identifiant stable = nom de fichier (slug `[A-Za-z0-9._-]`). Sert de clé
    /// pour l'édition et la suppression.
    pub id: String,
    /// Nom affiché dans le sélecteur de l'input (ex. « Project Analyzer »).
    pub name: String,
    /// Prompt de rôle : injecté tel quel dans le prompt système de l'agent.
    #[serde(default)]
    pub prompt: String,
    /// Identifiants des outils activés (ex. `read_files`, `editor`, `browser`).
    /// Interprétés côté front selon le catalogue `agentToolPrefs`. Toute valeur
    /// inconnue est ignorée.
    #[serde(default)]
    pub tools: Vec<String>,
    /// Noms des serveurs MCP activés pour cet agent (clés de `mcpServers`).
    /// Valeurs inconnues ignorées : jamais résolues en commande.
    #[serde(default)]
    pub mcp: Vec<String>,
    /// Emoji ou initiale utilisée comme avatar dans l'UI (optionnel).
    #[serde(default)]
    pub avatar: Option<String>,
    /// Ordre de création (ms epoch) : tri stable du plus ancien au plus récent.
    #[serde(default)]
    pub created_at: u64,
}

/// Racine d'écriture/lecture des agents (`~/.mira/agents`).
fn agents_root() -> Result<PathBuf, String> {
    let root = global_root()?.join("agents");
    Ok(root)
}

/// Valide qu'un identifiant d'agent est sûr (réutilise la règle des noms).
fn validate_agent_id(id: &str) -> Result<(), String> {
    validate_name(id)
}

/// Chemin du fichier d'un agent, garanti sous la racine confinée.
fn agent_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    validate_agent_id(id)?;
    let path = root.join(format!("{id}.json"));
    ensure_within(root, &path)?;
    Ok(path)
}

/// Liste les agents personnalisés, triés du plus ancien au plus récent.
#[tauri::command]
pub fn list_agents() -> Result<Vec<AgentInfo>, String> {
    let root = agents_root()?;
    let Ok(entries) = fs::read_dir(&root) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        // Un fichier illisible ou malformé est ignoré (ne casse pas le listing).
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        if let Ok(agent) = serde_json::from_str::<AgentInfo>(&raw) {
            out.push(agent);
        }
    }
    out.sort_by(|a, b| a.created_at.cmp(&b.created_at).then_with(|| a.id.cmp(&b.id)));
    Ok(out)
}

/// Lit un agent par son identifiant.
#[tauri::command]
pub fn read_agent(id: String) -> Result<AgentInfo, String> {
    let root = agents_root()?;
    let path = agent_path(&root, &id)?;
    let raw = fs::read_to_string(&path).map_err(|e| format!("cannot read agent: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("invalid agent file: {e}"))
}

/// Crée ou remplace un agent (écriture atomique). Le contenu est borné, l'id est
/// validé et confiné. `created_at` est fixé au premier enregistrement pour
/// conserver un ordre stable.
#[tauri::command]
pub fn write_agent(agent: AgentInfo) -> Result<AgentInfo, String> {
    validate_agent_id(&agent.id)?;
    if agent.name.trim().is_empty() {
        return Err("agent name cannot be empty".to_string());
    }
    let prompt_len = agent.prompt.len();
    if prompt_len > MAX_CONTENT_BYTES {
        return Err(format!(
            "prompt too large (max {} KiB)",
            MAX_CONTENT_BYTES / 1024
        ));
    }
    let root = agents_root()?;
    let path = agent_path(&root, &agent.id)?;

    // `created_at` : conservé si l'agent existe déjà, sinon horodaté maintenant.
    let mut to_write = agent;
    if let Ok(existing) = fs::read_to_string(&path) {
        if let Ok(prev) = serde_json::from_str::<AgentInfo>(&existing) {
            if to_write.created_at == 0 {
                to_write.created_at = prev.created_at;
            }
        }
    }
    if to_write.created_at == 0 {
        to_write.created_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
    }

    let json = serde_json::to_string_pretty(&to_write)
        .map_err(|e| format!("cannot serialize agent: {e}"))?;
    write_atomic(&path, &json)?;
    Ok(to_write)
}

/// Supprime un agent.
#[tauri::command]
pub fn delete_agent(id: String) -> Result<(), String> {
    let root = agents_root()?;
    let path = agent_path(&root, &id)?;
    if path.is_file() {
        fs::remove_file(&path).map_err(|e| format!("cannot delete agent: {e}"))?;
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de listing
// ─────────────────────────────────────────────────────────────────────────────

/// Liste les sous-dossiers de `root` contenant `file_name` (ex. `SKILL.md`).
fn list_artifact_dirs(
    root: &Path,
    file_name: &str,
    scope: &str,
) -> Result<Vec<ArtifactInfo>, String> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return Ok(out);
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let file = dir.join(file_name);
        if !file.is_file() {
            continue;
        }
        let Some(name) = dir.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        out.push(artifact_info(name, &file, scope));
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Liste récursivement les fichiers `.md` sous `root`, jusqu'à `max_depth`.
/// Le `name` renvoyé est le chemin relatif sans extension (ex. `module-a/cmd`).
fn list_artifact_files(
    root: &Path,
    scope: &str,
    max_depth: usize,
) -> Result<Vec<ArtifactInfo>, String> {
    let mut out = Vec::new();
    walk_md(root, root, scope, max_depth, &mut out);
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn walk_md(root: &Path, dir: &Path, scope: &str, depth: usize, out: &mut Vec<ArtifactInfo>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            if depth > 0 {
                walk_md(root, &path, scope, depth - 1, out);
            }
        } else if path.extension().and_then(|s| s.to_str()) == Some("md") {
            let rel = path.strip_prefix(root).unwrap_or(&path);
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            let label = rel_str.trim_end_matches(".md").to_string();
            out.push(artifact_info(&label, &path, scope));
        }
    }
}

/// Construit un `ArtifactInfo` en lisant le frontmatter (name/description/état).
fn artifact_info(name: &str, path: &Path, scope: &str) -> ArtifactInfo {
    let raw = fs::read_to_string(path).unwrap_or_default();
    let (fm, _) = split_frontmatter(&raw);
    let description = frontmatter_get(&fm, "description");
    // Désactivé si `enabled: false` OU `disabled: true` selon la convention.
    let enabled_false = frontmatter_get(&fm, "enabled")
        .map(|v| v.eq_ignore_ascii_case("false"))
        .unwrap_or(false);
    let disabled_true = frontmatter_get(&fm, "disabled")
        .map(|v| v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    ArtifactInfo {
        name: name.to_string(),
        description,
        disabled: enabled_false || disabled_true,
        path: path.to_string_lossy().to_string(),
        scope: scope.to_string(),
        source: None,
    }
}

/// Résout un chemin relatif sous `root`, en refusant toute évasion. Chaque
/// composant doit être un nom valide (pas de `..`, pas d'absolu).
fn safe_rel_under(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.is_empty() {
        return Err("path cannot be empty".to_string());
    }
    let cleaned = rel.replace('\\', "/");
    let mut path = root.to_path_buf();
    for part in cleaned.split('/') {
        if part.is_empty() {
            continue;
        }
        if part == "." || part == ".." {
            return Err(format!("invalid path segment: {part}"));
        }
        if part.contains('\0') {
            return Err("path contains illegal characters".to_string());
        }
        path.push(part);
    }
    ensure_within(root, &path)?;
    Ok(path)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nom_valide_accepte_les_slugs_simples() {
        assert!(validate_name("chrome-devtools").is_ok());
        assert!(validate_name("my_skill.v2").is_ok());
    }

    #[test]
    fn nom_refuse_les_traversals() {
        assert!(validate_name("..").is_err());
        assert!(validate_name("../etc").is_err());
        assert!(validate_name("/abs").is_err());
        assert!(validate_name("a/b").is_err());
        assert!(validate_name("a\\b").is_err());
        assert!(validate_name(".hidden").is_err());
        assert!(validate_name("").is_err());
        assert!(validate_name("-flag").is_err());
    }

    #[test]
    fn confinemet_refuse_sortie_de_racine() {
        let root = PathBuf::from("/tmp/mira-root");
        assert!(ensure_within(&root, &root.join("ok/child")).is_ok());
        assert!(ensure_within(&root, &PathBuf::from("/tmp/elsewhere")).is_err());
        assert!(ensure_within(&root, &PathBuf::from("/tmp/mira-root/../escape")).is_err());
    }

    #[test]
    fn split_frontmatter_extrait_et_separe() {
        let content = "---\nname: demo\ndescription: fait X\n---\n# Titre\ncorps\n";
        let (fm, body) = split_frontmatter(content);
        assert_eq!(frontmatter_get(&fm, "name").as_deref(), Some("demo"));
        assert_eq!(frontmatter_get(&fm, "description").as_deref(), Some("fait X"));
        assert!(body.contains("# Titre"));
    }

    #[test]
    fn split_frontmatter_sans_entete_renvoie_tout_en_corps() {
        let content = "# Juste un titre\ncorps";
        let (fm, body) = split_frontmatter(content);
        assert!(fm.is_empty());
        assert_eq!(body, content);
    }

    #[test]
    fn safe_rel_refuse_les_remontees() {
        let root = PathBuf::from("/tmp/mira-cmds");
        assert!(safe_rel_under(&root, "module-a/cmd").is_ok());
        assert!(safe_rel_under(&root, "../escape").is_err());
        assert!(safe_rel_under(&root, "a/../../escape").is_err());
    }

    #[test]
    fn mcp_entry_serialise_stdio_et_http() {
        let stdio = McpServerInfo {
            name: "fs".into(),
            transport_type: "stdio".into(),
            command: Some("npx".into()),
            args: vec!["-y".into(), "@modelcontextprotocol/server-filesystem".into()],
            url: None,
            env: Default::default(),
            headers: Default::default(),
            disabled: false,
        };
        let json = mcp_entry_to_json(&stdio);
        assert_eq!(json.get("type").unwrap(), "stdio");
        assert_eq!(json.get("command").unwrap(), "npx");
        assert!(json.get("url").is_none());

        let http = McpServerInfo {
            name: "remote".into(),
            transport_type: "streamableHttp".into(),
            command: None,
            args: vec![],
            url: Some("https://example.com/mcp".into()),
            env: Default::default(),
            headers: Default::default(),
            disabled: true,
        };
        let json = mcp_entry_to_json(&http);
        assert_eq!(json.get("type").unwrap(), "streamableHttp");
        assert_eq!(json.get("url").unwrap(), "https://example.com/mcp");
        assert!(json.get("command").is_none());
        assert_eq!(json.get("disabled").unwrap(), true);
    }

    #[test]
    fn parse_mcp_entry_tolere_une_entree_incomplete() {
        let value = serde_json::json!({ "type": "stdio", "command": "node" });
        let info = parse_mcp_entry("demo", &value);
        assert_eq!(info.name, "demo");
        assert_eq!(info.transport_type, "stdio");
        assert_eq!(info.command.as_deref(), Some("node"));
        assert!(info.args.is_empty());
        assert!(!info.disabled);
    }

    #[test]
    fn find_skill_file_priorise_la_premiere_racine() {
        let dir = std::env::temp_dir().join(format!(
            "mira-skill-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let mira = dir.join("mira");
        let ext = dir.join("agents");
        fs::create_dir_all(mira.join("alpha")).unwrap();
        fs::create_dir_all(ext.join("alpha")).unwrap();
        fs::create_dir_all(ext.join("beta")).unwrap();
        fs::write(mira.join("alpha").join("SKILL.md"), "mira alpha").unwrap();
        fs::write(ext.join("alpha").join("SKILL.md"), "ext alpha").unwrap();
        fs::write(ext.join("beta").join("SKILL.md"), "ext beta").unwrap();

        let roots = vec![mira.clone(), ext.clone()];
        // `alpha` existe dans les deux : la racine Mira gagne.
        let found = find_skill_file(&roots, "alpha").unwrap().unwrap();
        assert_eq!(found, mira.join("alpha").join("SKILL.md"));
        // `beta` n'existe que dans l'externe : on la trouve quand même.
        let found = find_skill_file(&roots, "beta").unwrap().unwrap();
        assert_eq!(found, ext.join("beta").join("SKILL.md"));
        // `gamma` n'existe nulle part.
        assert!(find_skill_file(&roots, "gamma").unwrap().is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_skill_file_refuse_une_nomination_dangereuse() {
        let root = PathBuf::from("/tmp/mira-skill-root");
        let roots = vec![root.clone()];
        // Toute tentative de remontée hors racine doit être refusée.
        assert!(find_skill_file(&roots, "..").is_err());
        assert!(find_skill_file(&roots, "../escape").is_err());
    }

    #[test]
    fn priority_place_mira_avant_externe() {
        assert!(priority(Some("mira")) < priority(Some("external")));
        assert!(priority(None) < priority(Some("external")));
    }
}
