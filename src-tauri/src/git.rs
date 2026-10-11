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
