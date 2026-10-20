pub(crate) fn git_cmd() -> std::process::Command {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new("git");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Rejette toute entrée pouvant être interprétée comme une option git (commence
/// par `-`) ou contenant des métacaractères. Les arguments sont de toute façon
/// passés via `Command::args` (jamais un shell), donc il n'y a pas d'injection
/// shell possible ; ce filtre empêche uniquement l'injection d'options git
/// (ex: `--upload-pack=...`) via un nom de branche ou un chemin.
fn reject_unsafe_arg(value: &str, kind: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("{kind} cannot be empty"));
    }
    if value.starts_with('-') {
        return Err(format!("{kind} cannot start with '-': {value}"));
    }
    if value.contains('\0') || value.contains('\n') || value.contains('\r') {
        return Err(format!("{kind} contains illegal characters"));
    }
    Ok(())
}

/// Valide un nom de branche en s'appuyant sur `git check-ref-format --branch`,
/// qui est la référence officielle des noms de branche valides.
fn validate_branch_name(path: &str, name: &str) -> Result<(), String> {
    reject_unsafe_arg(name, "branch name")?;
    let out = git_cmd()
        .args(["check-ref-format", "--branch", name])
        .current_dir(path)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("invalid branch name: {name}"));
    }
    Ok(())
}

/// Valide qu'un chemin de fichier relatif reste confiné à la racine du dépôt.
/// Refuse les chemins absolus, les remontées (`..`) hors racine et les options.
fn validate_rel_path(rel: &str) -> Result<(), String> {
    reject_unsafe_arg(rel, "path")?;
    let p = std::path::Path::new(rel);
    if p.is_absolute() {
        return Err(format!("path must be relative: {rel}"));
    }
    // Normalise les composants et vérifie qu'on ne remonte jamais au-dessus de la racine.
    let mut depth: i32 = 0;
    for comp in p.components() {
        match comp {
            std::path::Component::ParentDir => {
                depth -= 1;
                if depth < 0 {
                    return Err(format!("path escapes repository: {rel}"));
                }
            }
            std::path::Component::Normal(_) => depth += 1,
            _ => {}
        }
    }
    Ok(())
}

#[tauri::command]
pub fn git_branch(path: String) -> Option<String> {
    let out = git_cmd()
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&path)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let branch = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if branch.is_empty() {
        return None;
    }
    if branch == "HEAD" {
        let hash = git_cmd()
            .args(["rev-parse", "--short", "HEAD"])
            .current_dir(&path)
            .output()
            .ok()?;
        if hash.status.success() {
            return Some(format!(
                "HEAD:{}",
                String::from_utf8_lossy(&hash.stdout).trim()
            ));
        }
        return Some("HEAD".to_string());
    }
    Some(branch)
}

#[derive(serde::Serialize)]
pub struct CommitEntry {
    hash: String,
    msg:  String,
}

#[derive(serde::Serialize)]
pub struct GitChanges {
    files:         usize,
    commits_ahead: usize,
    log:           Vec<CommitEntry>,
}

#[tauri::command]
pub fn git_changes(path: String) -> Option<GitChanges> {
    let status = git_cmd()
        .args(["status", "--porcelain"])
        .current_dir(&path)
        .output()
        .ok()?;
    if !status.status.success() {
        return None;
    }
    let files = String::from_utf8_lossy(&status.stdout)
        .lines()
        .filter(|l| !l.is_empty())
        .count();

    let commits_ahead = git_cmd()
        .args(["rev-list", "--count", "@{u}..HEAD"])
        .current_dir(&path)
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.trim().parse::<usize>().ok())
        .unwrap_or(0);

    let log = git_cmd()
        .args(["log", "--max-count=5", "--pretty=format:%h\x01%s"])
        .current_dir(&path)
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| {
            let mut p = l.splitn(2, '\x01');
            CommitEntry {
                hash: p.next().unwrap_or("").to_string(),
                msg:  p.next().unwrap_or("").to_string(),
            }
        })
        .collect();

    Some(GitChanges { files, commits_ahead, log })
}

#[derive(serde::Serialize)]
pub struct StatusFile {
    status: String,
    path:   String,
}

#[derive(serde::Serialize)]
pub struct FullCommitEntry {
    hash:    String,
    subject: String,
    author:  String,
    date:    String,
}

#[tauri::command]
pub fn git_status_files(path: String) -> Vec<StatusFile> {
    let Ok(out) = git_cmd()
        .args(["status", "--porcelain"])
        .current_dir(&path)
        .output()
    else { return vec![] };
    if !out.status.success() { return vec![]; }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| l.len() > 3)
        .map(|l| StatusFile {
            status: l[..2].trim().to_string(),
            path:   l[3..].to_string(),
        })
        .collect()
}

#[tauri::command]
pub fn git_log_full(path: String) -> Vec<FullCommitEntry> {
    let Ok(out) = git_cmd()
        .args(["log", "--max-count=100", "--pretty=format:%h\x01%s\x01%an\x01%ar"])
        .current_dir(&path)
        .output()
    else { return vec![] };
    if !out.status.success() { return vec![]; }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| {
            let mut p = l.splitn(4, '\x01');
            FullCommitEntry {
                hash:    p.next().unwrap_or("").to_string(),
                subject: p.next().unwrap_or("").to_string(),
                author:  p.next().unwrap_or("").to_string(),
                date:    p.next().unwrap_or("").to_string(),
            }
        })
        .collect()
}

#[tauri::command]
pub fn git_commit(path: String, title: String, description: String) -> Result<String, String> {
    let stage = git_cmd()
        .args(["add", "-A"])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;
    if !stage.status.success() {
        return Err(String::from_utf8_lossy(&stage.stderr).into_owned());
    }
    let mut cmd = git_cmd();
    cmd.args(["commit", "-m", &title]).current_dir(&path);
    if !description.is_empty() {
        cmd.args(["-m", &description]);
    }
    let out = cmd.output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[tauri::command]
pub fn git_commit_push(path: String, title: String, description: String) -> Result<String, String> {
    git_commit(path.clone(), title, description)?;
    let push = git_cmd()
        .args(["push"])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;
    if !push.status.success() {
        return Err(String::from_utf8_lossy(&push.stderr).into_owned());
    }
    Ok(String::from_utf8_lossy(&push.stdout).into_owned())
}

// ── Staging ───────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn git_stage(path: String, file: String) -> Result<String, String> {
    validate_rel_path(&file)?;
    let out = git_cmd()
        .args(["add", "--", &file])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[tauri::command]
pub fn git_stage_all(path: String) -> Result<String, String> {
    let out = git_cmd()
        .args(["add", "-A"])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[tauri::command]
pub fn git_unstage(path: String, file: String) -> Result<String, String> {
    validate_rel_path(&file)?;
    let out = git_cmd()
        .args(["reset", "-q", "HEAD", "--", &file])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Restaure un fichier à son état HEAD. Si le fichier est non suivi (untracked),
/// `git checkout` échoue : on le supprime alors du disque côté Rust.
#[tauri::command]
pub fn git_discard(path: String, file: String) -> Result<String, String> {
    validate_rel_path(&file)?;
    let out = git_cmd()
        .args(["checkout", "--", &file])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
    // Fichier probablement untracked : on le supprime s'il est bien confiné.
    let target = std::path::Path::new(&path).join(&file);
    let canon_root = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
    let canon_target = std::fs::canonicalize(&target).map_err(|e| e.to_string())?;
    if !canon_target.starts_with(&canon_root) {
        return Err("refusing to delete path outside repository".to_string());
    }
    if canon_target.is_dir() {
        std::fs::remove_dir_all(&canon_target).map_err(|e| e.to_string())?;
    } else {
        std::fs::remove_file(&canon_target).map_err(|e| e.to_string())?;
    }
    Ok("discarded".to_string())
}

// ── Remote operations ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn git_pull(path: String) -> Result<String, String> {
    let out = git_cmd()
        .args(["pull"])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[tauri::command]
pub fn git_push(path: String) -> Result<String, String> {
    let out = git_cmd()
        .args(["push"])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[tauri::command]
pub fn git_fetch(path: String) -> Result<String, String> {
    let out = git_cmd()
        .args(["fetch", "--all", "--prune"])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

// ── Clone ─────────────────────────────────────────────────────────────────────

/// Refuse les URL de dépôt qui pourraient être interprétées comme des options
/// git (commencent par `-`) ou qui exploitent les transports `ext::` / `file::`
/// (exécution de commande locale via le remote helper). N'autorise que des
/// transports réseau explicites : https, http, ssh, git, git+ssh, ou les
/// notations raccourcies `user@host:path` (scp-like).
fn validate_clone_url(url: &str) -> Result<(), String> {
    reject_unsafe_arg(url, "repository URL")?;
    if url.len() > 2048 {
        return Err("repository URL too long".to_string());
    }
    // Les espaces autorisent le découpage en arguments supplémentaires côté git.
    if url.contains(' ') || url.contains('\t') {
        return Err("repository URL cannot contain whitespace".to_string());
    }
    // Transports explicites : on impose une allowlist stricte.
    let explicit_ok = ["https://", "http://", "ssh://", "git://", "git+ssh://"]
        .iter()
        .any(|p| url.starts_with(p));
    // Notation scp-like `user@host:path` (pas de schéma). On exige un `@` et
    // un `:` séparateur, sans `://` pour ne pas confondre avec un schéma.
    let scp_like = !url.contains("://")
        && url.contains('@')
        && url.contains(':')
        && !url.contains('\\');
    if !explicit_ok && !scp_like {
        return Err("unsupported repository URL (use https, ssh or git)".to_string());
    }
    // On refuse explicitement les schémas à exécution locale.
    let lowered = url.to_ascii_lowercase();
    for bad in ["ext::", "file://", "fd::", "transport::"] {
        if lowered.contains(bad) {
            return Err(format!("unsupported repository URL scheme: {bad}"));
        }
    }
    Ok(())
}

/// Valide le dossier de destination : chemin absolu, sans composant `..`, et
/// qui n'écrase pas un dossier existant non vide (protection anti-destruction).
fn validate_clone_dest(dest: &str) -> Result<std::path::PathBuf, String> {
    reject_unsafe_arg(dest, "destination")?;
    let p = std::path::PathBuf::from(dest);
    if !p.is_absolute() {
        return Err("destination must be an absolute path".to_string());
    }
    if p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err("destination cannot contain '..'".to_string());
    }
    // Refuse d'écraser : si le dossier existe et contient des entrées, on rejette.
    if let Ok(mut rd) = std::fs::read_dir(&p) {
        if rd.next().is_some() {
            return Err("destination folder already exists and is not empty".to_string());
        }
    }
    Ok(p)
}

/// Clone un dépôt distant dans `dest`. Le clone se fait dans un dossier
/// temporaire voisin (suffixe aléatoire) puis est déplacé vers `dest`, afin de
/// ne jamais laisser un clone partiel dans le dossier cible si git échoue.
#[tauri::command]
pub fn git_clone(url: String, dest: String) -> Result<String, String> {
    validate_clone_url(&url)?;
    let dest_path = validate_clone_dest(&dest)?;

    if let Some(parent) = dest_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    // Dossier de travail temporaire dans le même parent (déplacement atomique).
    let tmp_name = format!(
        ".mira-clone-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let tmp = dest_path
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join(&tmp_name);

    let out = git_cmd()
        .args(["clone", "--", &url])
        .arg(&tmp)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }

    // Déplace le clone vers la destination finale. `rename` échoue si `dest`
    // existe déjà (dossier vide autorisé) : on tente alors de retirer un dossier
    // vide puis de rejouer le déplacement.
    if let Err(_e) = std::fs::rename(&tmp, &dest_path) {
        if dest_path.exists() {
            let _ = std::fs::remove_dir(&dest_path); // ne réussit que si vide
        }
        if let Err(e) = std::fs::rename(&tmp, &dest_path) {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(format!("failed to move clone into place: {e}"));
        }
    }
    Ok(dest_path.to_string_lossy().into_owned())
}

// ── Branches ──────────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct BranchEntry {
    name:    String,
    current: bool,
    remote:  bool,
}

#[tauri::command]
pub fn git_list_branches(path: String) -> Vec<BranchEntry> {
    let Ok(out) = git_cmd()
        .args(["branch", "-a", "--no-color", "--format=%(refname:short)\t%(HEAD)"])
        .current_dir(&path)
        .output()
    else { return vec![] };
    if !out.status.success() { return vec![]; }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let mut p = l.splitn(2, '\t');
            let raw = p.next().unwrap_or("").trim().to_string();
            let head = p.next().unwrap_or("").trim();
            let remote = raw.starts_with("remotes/") || raw.starts_with("origin/");
            let name = raw.strip_prefix("remotes/").unwrap_or(&raw).to_string();
            BranchEntry { name, current: head == "*", remote }
        })
        .collect()
}

#[tauri::command]
pub fn git_checkout(path: String, branch: String) -> Result<String, String> {
    // Une branche distante `origin/x` doit être suivie localement.
    let is_remote = branch.starts_with("origin/") || branch.starts_with("remotes/");
    validate_branch_name(&path, branch.strip_prefix("remotes/").unwrap_or(&branch))?;
    let out = if is_remote {
        let local = branch.rsplit('/').next().unwrap_or(&branch);
        git_cmd()
            .args(["checkout", "-B", local, "--track", &branch])
            .current_dir(&path)
            .output()
    } else {
        git_cmd()
            .args(["checkout", &branch])
            .current_dir(&path)
            .output()
    }
    .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[tauri::command]
pub fn git_create_branch(path: String, branch: String) -> Result<String, String> {
    validate_branch_name(&path, &branch)?;
    let out = git_cmd()
        .args(["checkout", "-b", &branch])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

// ── Amend / Sync ──────────────────────────────────────────────────────────────

#[tauri::command]
pub fn git_commit_amend(path: String, title: String, description: String) -> Result<String, String> {
    let stage = git_cmd()
        .args(["add", "-A"])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;
    if !stage.status.success() {
        return Err(String::from_utf8_lossy(&stage.stderr).into_owned());
    }
    let mut cmd = git_cmd();
    cmd.args(["commit", "--amend", "-m", &title]).current_dir(&path);
    if !description.is_empty() {
        cmd.args(["-m", &description]);
    }
    let out = cmd.output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Commit & Sync : commit, puis pull (rebase pour éviter un merge commit), puis push.
#[tauri::command]
pub fn git_commit_sync(path: String, title: String, description: String) -> Result<String, String> {
    git_commit(path.clone(), title, description)?;
    let pull = git_cmd()
        .args(["pull", "--rebase"])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;
    if !pull.status.success() {
        return Err(format!("pull failed: {}", String::from_utf8_lossy(&pull.stderr)));
    }
    let push = git_cmd()
        .args(["push"])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;
    if !push.status.success() {
        return Err(String::from_utf8_lossy(&push.stderr).into_owned());
    }
    Ok(String::from_utf8_lossy(&push.stdout).into_owned())
}

// ── Diff (pour la génération IA du message de commit) ─────────────────────────

/// Retourne le diff complet des changements (staged + unstaged) par rapport à
/// HEAD, tronqué à `max_bytes` pour ne pas saturer le contexte du modèle.
#[tauri::command]
pub fn git_diff(path: String, max_bytes: Option<usize>) -> String {
    let cap = max_bytes.unwrap_or(12_000);
    let staged = git_cmd()
        .args(["diff", "--cached", "--no-color"])
        .current_dir(&path)
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    let unstaged = git_cmd()
        .args(["diff", "--no-color"])
        .current_dir(&path)
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    let mut combined = format!("{staged}{unstaged}");
    if combined.len() > cap {
        combined.truncate(cap);
        combined.push_str("\n… [diff truncated]");
    }
    combined
}

// ── Diff d'un fichier non suivi, façon `git diff` ─────────────────────────────

/// Produit un diff unifié pour un fichier NON SUIVI (nouveau fichier), en
/// utilisant `git diff --no-index /dev/null <file>`. Sans cette étape, un
/// nouveau fichier n'apparaît dans aucun `git diff` : c'est précisément la cause
/// d'un diff vide lors de la génération d'un message de commit.
///
/// `git diff --no-index` sort avec le code 1 quand il y a des différences
/// (comportement documenté), ce n'est donc PAS une erreur à traiter comme telle.
fn diff_untracked_file(repo: &str, file: &str) -> String {
    let out = git_cmd()
        .args(["diff", "--no-color", "--no-index", "--", "/dev/null", file])
        .current_dir(repo)
        .output();
    match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout).into_owned(),
        Err(_) => String::new(),
    }
}

/// Résultat de [`git_commit_diff`]. Typé pour que l'UI distingue précisément
/// « pas un dépôt » / « dépôt propre » / « diff disponible » — l'ancien contrat
/// renvoyait une chaîne vide dans les deux premiers cas, ce qui affichait
/// « no changes » même quand le dossier n'était pas un dépôt.
#[derive(serde::Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum CommitDiffResult {
    /// Un diff existe (éventuellement tronqué).
    Diff(String),
    /// Dépôt git valide mais aucun changement par rapport à HEAD.
    NoChanges,
    /// Le dossier fourni n'est pas un dépôt git.
    NotARepo,
}

/// Diff destiné à la génération d'un message de commit : contrairement à
/// [`git_diff`] (utilisé par l'éditeur, focalisé sur le suivi), il inclut AUSSI
/// les fichiers non suivis. On assemble :
///   1. `git diff --cached`  → index vs HEAD (ce qui sera committé) ;
///   2. `git diff`           → working tree vs index (modifications non stagées) ;
///   3. `git diff --no-index /dev/null` pour chaque fichier non suivi.
/// Le tout est plafonné à `max_bytes` pour borner le coût du prompt.
#[tauri::command]
pub fn git_commit_diff(path: String, max_bytes: Option<usize>) -> CommitDiffResult {
    let cap = max_bytes.unwrap_or(12_000);

    // On distingue explicitement « pas un dépôt » de « dépôt propre » : sinon
    // l'appelant affiche « no changes » alors que la véritable cause est un
    // dossier qui n'est pas (encore) un dépôt git. C'est la source de vérité,
    // donc c'est ici qu'on tranche — pas en devinant côté UI.
    let inside = git_cmd()
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(&path)
        .output();
    match inside {
        Ok(o) if o.status.success() => {} // dépôt valide, on continue
        _ => return CommitDiffResult::NotARepo,
    }

    let run = |args: &[&str]| -> String {
        git_cmd()
            .args(args)
            .current_dir(&path)
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default()
    };

    let staged = run(&["diff", "--cached", "--no-color"]);
    let unstaged = run(&["diff", "--no-color"]);

    // Fichiers non suivis (exclut ce qui est ignoré via `.gitignore`).
    let untracked_list = run(&["ls-files", "--others", "--exclude-standard"]);
    let mut untracked = String::new();
    for file in untracked_list.lines().filter(|l| !l.trim().is_empty()) {
        // Borne le nombre de fichiers pour éviter un prompt démesuré quand un
        // dépôt contient beaucoup de nouveaux fichiers (ex. dépendances).
        if untracked.len() >= cap {
            break;
        }
        untracked.push_str(&diff_untracked_file(&path, file));
    }

    let mut combined = format!("{staged}{unstaged}{untracked}");
    if combined.trim().is_empty() {
        return CommitDiffResult::NoChanges;
    }
    if combined.len() > cap {
        combined.truncate(cap);
        combined.push_str("\n… [diff truncated]");
    }
    CommitDiffResult::Diff(combined)
}

// ── Contenu d'un fichier à HEAD (base du gutter « inline diff » de l'éditeur) ─

/// Résultat de [`git_file_head`] :
/// - `Ok(Some(content))` : le fichier existe dans HEAD → contenu du blob ;
/// - `Ok(None)`          : le dépôt existe mais le fichier n'est pas dans HEAD
///   (fichier non suivi / nouvellement créé) → tout est « ajouté » ;
/// - `Err(msg)`          : `path` n'est pas un dépôt git (ou git indisponible)
///   → l'éditeur n'affiche aucun marqueur.
///
/// `file` doit être un chemin relatif à `path` (le workspace). `HEAD:./<file>`
/// résout le chemin relativement au répertoire courant, ce qui reste correct
/// même si `path` est un sous-dossier du dépôt.
#[tauri::command]
pub fn git_file_head(path: String, file: String) -> Result<Option<String>, String> {
    validate_rel_path(&file)?;

    let inside = git_cmd()
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;
    if !inside.status.success()
        || String::from_utf8_lossy(&inside.stdout).trim() != "true"
    {
        return Err("not a git repository".to_string());
    }

    let spec = format!("HEAD:./{}", file.replace('\\', "/"));
    let out = git_cmd()
        .args(["show", &spec])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        // Fichier absent de HEAD, ou dépôt sans aucun commit.
        return Ok(None);
    }
    Ok(Some(String::from_utf8_lossy(&out.stdout).into_owned()))
}

// ── Stash ─────────────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct StashEntry {
    /// Index dans la pile de stashes (0 = le plus récent). Sert à `stash@{N}`.
    index:   usize,
    /// Nom de la branche sur laquelle le stash a été créé.
    branch:  String,
    /// Message du stash (ou le sujet du commit HEAD à sa création par défaut).
    message: String,
}

/// Construit la référence `stash@{N}` à partir d'un index numérique. L'index
/// étant un `usize`, aucune injection n'est possible (la chaîne est formée côté
/// Rust, jamais depuis une entrée utilisateur brute).
fn stash_ref(index: usize) -> String {
    format!("stash@{{{index}}}")
}

/// Enregistre les modifications courantes dans un stash. Par défaut les fichiers
/// non suivis ne sont pas inclus (comportement git standard) ; `include_untracked`
/// les ajoute via `-u`. Le message est optionnel.
#[tauri::command]
pub fn git_stash_save(
    path: String,
    message: Option<String>,
    include_untracked: Option<bool>,
) -> Result<String, String> {
    // Le message est consommé comme valeur de `-m`, jamais comme option : on se
    // contente de le borner pour éviter des entrées absurdes.
    let msg = message.unwrap_or_default();
    if msg.len() > 4096 {
        return Err("stash message too long".to_string());
    }

    let mut cmd = git_cmd();
    cmd.args(["stash", "push"]).current_dir(&path);
    if include_untracked.unwrap_or(false) {
        cmd.arg("-u");
    }
    if !msg.is_empty() {
        cmd.args(["-m", &msg]);
    }
    let out = cmd.output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Liste les stashes du dépôt, du plus récent au plus ancien.
#[tauri::command]
pub fn git_stash_list(path: String) -> Vec<StashEntry> {
    // Format : stash@{N}\x01<branche>\x01<message>
    let Ok(out) = git_cmd()
        .args(["stash", "list", "--format=%gd\x01%gs"])
        .current_dir(&path)
        .output()
    else { return vec![] };
    if !out.status.success() { return vec![]; }

    // `%gs` (reflog subject) a la forme « WIP on <branche>: <sujet> » ou
    // « On <branche>: <message> ». On en extrait branche et message.
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| !l.is_empty())
        .enumerate()
        .map(|(i, l)| {
            let mut p = l.splitn(2, '\x01');
            let _ref = p.next().unwrap_or(""); // ex. stash@{0}
            let subject = p.next().unwrap_or("").to_string();
            let (branch, message) = parse_stash_subject(&subject);
            StashEntry { index: i, branch, message }
        })
        .collect()
}

/// Parse le sujet reflog d'un stash : « WIP on main: 1a2b3c titre » ou
/// « On main: mon message » → (branche, message).
fn parse_stash_subject(subject: &str) -> (String, String) {
    // Retire le préfixe « WIP on » / « On ».
    let rest = subject
        .strip_prefix("WIP on ")
        .or_else(|| subject.strip_prefix("On "))
        .unwrap_or(subject);
    match rest.split_once(": ") {
        Some((branch, msg)) => (branch.to_string(), msg.to_string()),
        None => (rest.to_string(), String::new()),
    }
}

/// Applique un stash puis le retire de la pile (`stash pop`).
#[tauri::command]
pub fn git_stash_pop(path: String, index: usize) -> Result<String, String> {
    let out = git_cmd()
        .args(["stash", "pop", &stash_ref(index)])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Applique un stash sans le retirer de la pile (`stash apply`).
#[tauri::command]
pub fn git_stash_apply(path: String, index: usize) -> Result<String, String> {
    let out = git_cmd()
        .args(["stash", "apply", &stash_ref(index)])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Supprime un stash de la pile (`stash drop`).
#[tauri::command]
pub fn git_stash_drop(path: String, index: usize) -> Result<String, String> {
    let out = git_cmd()
        .args(["stash", "drop", &stash_ref(index)])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

// ── Blame ─────────────────────────────────────────────────────────────────────

/// Annotation d'une ligne : commit, auteur, date (epoch) et résumé.
#[derive(serde::Serialize)]
pub struct BlameLine {
    line:    u32,
    hash:    String,
    author:  String,
    /// Timestamp Unix (secondes) du commit, 0 si inconnu.
    time:    i64,
    summary: String,
}

/// Retourne l'annotation blame pour un fichier (une entrée par ligne).
/// `Ok(vec![])` si le fichier n'est pas suivi ou si le dépôt n'a pas de commits.
/// `Err` uniquement si `path` n'est pas un dépôt git valide.
#[tauri::command]
pub fn git_blame(path: String, file: String) -> Result<Vec<BlameLine>, String> {
    validate_rel_path(&file)?;

    let inside = git_cmd()
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;
    if !inside.status.success()
        || String::from_utf8_lossy(&inside.stdout).trim() != "true"
    {
        return Err("not a git repository".to_string());
    }

    // `--line-porcelain` répète les métadonnées pour chaque ligne, ce qui
    // simplifie le parsing au prix d'une sortie plus verbeuse (~acceptable pour
    // un fichier source). On n'anote jamais plus de 20k lignes (gros fichiers).
    let out = git_cmd()
        .args(["blame", "--line-porcelain", "--", &file.replace('\\', "/")])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        // Fichier non suivi, ou pas encore commité : pas d'annotation.
        return Ok(vec![]);
    }

    Ok(parse_blame(&String::from_utf8_lossy(&out.stdout)))
}

/// Parse la sortie de `git blame --line-porcelain`. Chaque groupe commence par
/// une ligne d'en-tête `<hash> <orig-line> <final-line> <count>` suivie de
/// métadonnées `key value`, jusqu'à la ligne de contenu préfixée par `\t`.
fn parse_blame(text: &str) -> Vec<BlameLine> {
    const MAX_BLAME_LINES: usize = 20_000;
    let mut out: Vec<BlameLine> = Vec::new();
    let mut hash   = String::new();
    let mut final_line: u32 = 0;
    let mut author = String::new();
    let mut time: i64 = 0;
    let mut summary = String::new();

    for raw in text.lines() {
        if out.len() >= MAX_BLAME_LINES { break; }
        if let Some(content) = raw.strip_prefix('\t') {
            // Ligne de contenu : clôt le groupe courant.
            let _ = content;
            out.push(BlameLine {
                line: final_line,
                hash: hash.clone(),
                author: author.clone(),
                time,
                summary: summary.clone(),
            });
            continue;
        }
        // En-tête de groupe : commence par 40 hexadécimaux. Les autres lignes
        // sont des métadonnées `key value`.
        let is_header = raw.len() >= 40
            && raw.as_bytes()[40] == b' '
            && raw[..40].bytes().all(|b| b.is_ascii_hexdigit());
        if is_header {
            let mut parts = raw.split(' ');
            hash = parts.next().unwrap_or("").to_string();
            let _orig = parts.next();
            final_line = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            // Réinitialise les champs du nouveau groupe.
            author.clear();
            time = 0;
            summary.clear();
        } else if let Some(v) = raw.strip_prefix("author ") {
            author = v.to_string();
        } else if let Some(v) = raw.strip_prefix("author-time ") {
            time = v.trim().parse().unwrap_or(0);
        } else if let Some(v) = raw.strip_prefix("summary ") {
            summary = v.to_string();
        }
    }
    out
}
