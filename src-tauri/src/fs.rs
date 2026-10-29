fn normalize_path(path: &std::path::Path) -> std::path::PathBuf {
    let mut out = std::path::PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir    => {}
            std::path::Component::ParentDir => { out.pop(); }
            c                               => out.push(c),
        }
    }
    out
}

/// Vérifie que `path` (et sa **cible résolue** si elle existe) reste confiné
/// dans `workspace_root`. La canonicalisation couvre deux attaques qu'une simple
/// comparaison lexicale laisse passer :
///  1. `..` non neutralisé par un composant symbolique en début de chemin ;
///  2. **symlinks** pointant hors du workspace (le chemin textuel est dedans,
///     mais la cible réelle est dehors).
/// Pour une cible inexistante (création), on canonicalise le parent le plus
/// proche qui existe, puis on re-concatène le suffixe non encore créé.
fn assert_in_workspace(path: &str, workspace_root: &str) -> Result<(), String> {
    let norm_path = normalize_path(std::path::Path::new(path));
    let norm_root = normalize_path(std::path::Path::new(workspace_root));

    // 1) Garde lexicale rapide (rejette `../../etc` avant tout accès disque).
    if !norm_path.starts_with(&norm_root) {
        return Err(format!("path escapes workspace: {path}"));
    }

    // 2) Garde réelle : canonicalise la racine une fois, puis le chemin (ou son
    //    plus proche ancêtre existant + suffixe) pour déjouer les symlinks.
    let real_root = std::fs::canonicalize(&norm_root).unwrap_or(norm_root);

    let mut existing = norm_path.clone();
    let mut suffix: Vec<std::ffi::OsString> = Vec::new();
    while !existing.exists() {
        match existing.file_name() {
            Some(name) => suffix.push(name.to_os_string()),
            None => break,
        }
        if !existing.pop() {
            break;
        }
    }

    let real_existing = std::fs::canonicalize(&existing).unwrap_or(existing);
    let mut real_full = real_existing;
    for part in suffix.iter().rev() {
        real_full.push(part);
    }

    if !real_full.starts_with(&real_root) {
        return Err(format!("path escapes workspace: {path}"));
    }
    Ok(())
}

/// Wrapper public de `assert_in_workspace` pour les autres modules (ex.
/// `checkpoint`) qui doivent appliquer la même garde sans dupliquer la logique
/// de canonicalisation / détection de symlinks.
pub fn assert_in_workspace_public(path: &str, workspace_root: &str) -> Result<(), String> {
    assert_in_workspace(path, workspace_root)
}

#[derive(serde::Serialize)]
pub struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[tauri::command]
pub fn read_dir(path: String, workspace_root: Option<String>) -> Result<Vec<DirEntry>, String> {
    if let Some(root) = workspace_root.as_deref() {
        assert_in_workspace(&path, root)?;
    }
    let mut entries: Vec<DirEntry> = std::fs::read_dir(&path)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| DirEntry {
            name: e.file_name().to_string_lossy().to_string(),
            path: e.path().to_string_lossy().to_string(),
            is_dir: e.file_type().map(|t| t.is_dir()).unwrap_or(false),
        })
        .collect();

    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

#[tauri::command]
pub fn read_file(path: String, workspace_root: Option<String>) -> Result<String, String> {
    if let Some(root) = workspace_root {
        assert_in_workspace(&path, &root)?;
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Plafond de lignes renvoyées par `read_file_range`. Au-delà, on tronque et on
/// signale `truncated = true` : le modèle peut alors demander la suite via
/// `start_line`. Borne anti-DoS (un fichier de 500 k lignes ne doit pas saturer
/// la fenêtre de contexte ni la mémoire de la webview).
pub const READ_FILE_MAX_LINES: usize = 2000;

#[derive(serde::Serialize)]
pub struct FileSlice {
    content: String,
    start_line: usize, // 1-based, borne réellement appliquée
    end_line: usize,   // 1-based inclusif
    total_lines: usize,
    truncated: bool,
}

/// Lit un fichier **par plage de lignes** (1-based, `end_line` inclusif).
///
/// `start_line = 0` ou `end_line = 0` sont interprétés comme « depuis le début »
/// / « jusqu'à la fin ». Les bornes sont clampées à la taille réelle du fichier.
/// Le nombre de lignes renvoyées est plafonné à `READ_FILE_MAX_LINES`.
#[tauri::command]
pub fn read_file_range(
    path: String,
    workspace_root: Option<String>,
    start_line: Option<usize>,
    end_line: Option<usize>,
) -> Result<FileSlice, String> {
    if let Some(root) = workspace_root {
        assert_in_workspace(&path, &root)?;
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;

    // `lines()` perd le `\r` final et l'information de newline final : on
    // reconstruit un découpage qui préserve le contenu exact des lignes.
    let all: Vec<&str> = text.split('\n').collect();
    let total_lines = if text.is_empty() { 0 } else { all.len() };

    let start = start_line.unwrap_or(1).max(1);
    let requested_end = end_line.unwrap_or(0);
    let mut end = if requested_end == 0 { total_lines } else { requested_end };
    if end < start {
        end = start.saturating_sub(1);
    }
    if end > total_lines {
        end = total_lines;
    }

    let capped_end = end.min(start.saturating_add(READ_FILE_MAX_LINES).saturating_sub(1));
    let truncated = capped_end < end;

    let slice: String = if total_lines == 0 || start > total_lines {
        String::new()
    } else {
        all[start - 1..capped_end].join("\n")
    };

    Ok(FileSlice {
        content: slice,
        start_line: start,
        end_line: capped_end,
        total_lines,
        truncated,
    })
}

/// Taille maximale d'un fichier binaire renvoyé au front (base64) : au-delà, on
/// refuse plutôt que d'allouer des centaines de Mo en mémoire (anti-DoS).
const MAX_BINARY_BYTES: u64 = 50 * 1024 * 1024; // 50 Mo

/// Lit un fichier **binaire** (image, PDF…) et le renvoie en base64.
///
/// Pourquoi base64 et pas le protocole `asset:` de Tauri : `convertFileSrc`
/// exigerait de déclarer un scope `assetProtocol` couvrant dynamiquement le
/// workspace de l'utilisateur — soit ouvrir un accès fichier large à la webview.
/// Ici, la même garde `assert_in_workspace` que les autres commandes FS
/// s'applique, et la webview ne reçoit que des bytes déjà encodés, sans chemin
/// exploitable.
#[tauri::command]
pub fn read_file_base64(path: String, workspace_root: Option<String>) -> Result<String, String> {
    if let Some(root) = workspace_root {
        assert_in_workspace(&path, &root)?;
    }
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_BINARY_BYTES {
        return Err(format!(
            "file too large ({} MB > {} MB limit)",
            meta.len() / (1024 * 1024),
            MAX_BINARY_BYTES / (1024 * 1024)
        ));
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    use base64::Engine as _;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
pub fn write_file(path: String, content: String, workspace_root: Option<String>) -> Result<(), String> {
    if let Some(root) = workspace_root {
        assert_in_workspace(&path, &root)?;
    }
    let p = std::path::Path::new(&path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(p, content).map_err(|e| e.to_string())
}

/// Indique si un chemin existe déjà (anti-écrasement au renommage/déplacement).
#[tauri::command]
pub fn path_exists(path: String, workspace_root: Option<String>) -> Result<bool, String> {
    if let Some(root) = workspace_root.as_deref() {
        assert_in_workspace(&path, root)?;
    }
    Ok(std::path::Path::new(&path).exists())
}

#[tauri::command]
pub fn rename_path(from: String, to: String, workspace_root: Option<String>) -> Result<(), String> {
    if let Some(root) = workspace_root.as_deref() {
        assert_in_workspace(&from, root)?;
        assert_in_workspace(&to, root)?;
    }
    // Même dossier + même nom → no-op (ex. revalider une saisie inchangée).
    // Comparaison **textuelle** : sur un FS insensible à la casse (macOS/Windows),
    // renommer « README » en « readme » doit rester autorisé, or `to.exists()`
    // renverrait `true` (c'est le même fichier) et bloquerait à tort.
    if from == to {
        return Ok(());
    }
    // Refuse d'écraser une cible existante (jamais de perte silencieuse).
    if std::path::Path::new(&to).exists() {
        return Err(format!("destination already exists: {to}"));
    }
    std::fs::rename(&from, &to).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_path(path: String, workspace_root: Option<String>) -> Result<(), String> {
    if let Some(root) = workspace_root {
        assert_in_workspace(&path, &root)?;
    }
    let p = std::path::Path::new(&path);
    if p.is_dir() {
        std::fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(p).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn create_dir_cmd(path: String, workspace_root: Option<String>) -> Result<(), String> {
    if let Some(root) = workspace_root.as_deref() {
        assert_in_workspace(&path, root)?;
    }
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())
}

/// Copie récursive d'un fichier ou d'un dossier vers `to`.
/// `to` est refusé s'il existe déjà (pas d'écrasement silencieux).
///
/// Sécurité : la **cible** doit impérativement rester dans le workspace (aucune
/// écriture hors workspace). La **source**, elle, peut être externe : c'est le
/// cas d'un drop de fichiers depuis l'OS (Finder/Explorer), où l'utilisateur a
/// lui-même désigné les fichiers. Une source externe n'est ici que **lue** ;
/// elle ne peut pas provoquer d'écriture arbitraire.
#[tauri::command]
pub fn copy_path(from: String, to: String, workspace_root: Option<String>) -> Result<(), String> {
    if let Some(root) = workspace_root.as_deref() {
        assert_in_workspace(&to, root)?;
    }
    let src = std::path::Path::new(&from);
    let dst = std::path::Path::new(&to);
    if from == to {
        return Ok(());
    }
    if dst.exists() {
        return Err(format!("destination already exists: {to}"));
    }
    // Interdit de copier un dossier dans son propre sous-arbre (boucle infinie).
    if src.is_dir() {
        let norm_src = normalize_path(src);
        let mut ancestor = normalize_path(dst);
        while ancestor.pop() {
            if ancestor == norm_src {
                return Err("cannot copy a folder into its own subtree".to_string());
            }
        }
    }
    copy_recursive(src, dst).map_err(|e| e.to_string())
}

fn copy_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(src)?;
    if meta.file_type().is_symlink() {
        // On recopie le lien tel quel (pas de suivi → pas d'évasion de workspace).
        let target = std::fs::read_link(src)?;
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, dst)?;
            return Ok(());
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_file(target, dst)?;
            return Ok(());
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = target;
            return Ok(());
        }
    } else if meta.is_dir() {
        std::fs::create_dir_all(dst)?;
        for entry in std::fs::read_dir(src)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &dst.join(entry.file_name()))?;
        }
        return Ok(());
    }
    std::fs::copy(src, dst)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Crée un fichier temporaire unique contenant `content` et renvoie son chemin.
    /// Suffixe par process-id + compteur atomique pour éviter les collisions entre
    /// tests parallèles (cargo exécute les tests en parallèle par défaut).
    fn tmp_file(content: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let mut p = std::env::temp_dir();
        p.push(format!("origin_fs_test_{}_{}.txt", std::process::id(), n));
        std::fs::write(&p, content).unwrap();
        p
    }

    #[test]
    fn read_file_range_full_file() {
        let p = tmp_file("a\nb\nc");
        let s = read_file_range(p.to_string_lossy().to_string(), None, None, None).unwrap();
        assert_eq!(s.content, "a\nb\nc");
        assert_eq!(s.start_line, 1);
        assert_eq!(s.end_line, 3);
        assert_eq!(s.total_lines, 3);
        assert!(!s.truncated);
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn read_file_range_subrange_is_inclusive() {
        let p = tmp_file("a\nb\nc\nd");
        let s = read_file_range(p.to_string_lossy().to_string(), None, Some(2), Some(3)).unwrap();
        assert_eq!(s.content, "b\nc");
        assert_eq!(s.start_line, 2);
        assert_eq!(s.end_line, 3);
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn read_file_range_clamps_out_of_bounds() {
        let p = tmp_file("a\nb\nc");
        let s = read_file_range(p.to_string_lossy().to_string(), None, Some(2), Some(999)).unwrap();
        assert_eq!(s.content, "b\nc");
        assert_eq!(s.end_line, 3);
        assert!(!s.truncated);
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn read_file_range_start_past_eof_is_empty() {
        let p = tmp_file("a\nb");
        let s = read_file_range(p.to_string_lossy().to_string(), None, Some(50), None).unwrap();
        assert_eq!(s.content, "");
        assert_eq!(s.total_lines, 2);
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn read_file_range_truncates_at_cap() {
        let lines: Vec<String> = (0..(READ_FILE_MAX_LINES + 5)).map(|i| i.to_string()).collect();
        let p = tmp_file(&lines.join("\n"));
        let s = read_file_range(p.to_string_lossy().to_string(), None, Some(1), None).unwrap();
        assert!(s.truncated);
        assert_eq!(s.end_line, READ_FILE_MAX_LINES);
        assert_eq!(s.content.split('\n').count(), READ_FILE_MAX_LINES);
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn read_file_range_zero_start_means_from_top() {
        let p = tmp_file("a\nb\nc");
        let s = read_file_range(p.to_string_lossy().to_string(), None, Some(0), Some(2)).unwrap();
        assert_eq!(s.content, "a\nb");
        assert_eq!(s.start_line, 1);
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn read_file_range_rejects_escape() {
        let fake_root = std::env::temp_dir().join("origin_fs_test_root");
        std::fs::create_dir_all(&fake_root).unwrap();
        let err = read_file_range(
            "/etc/hosts".to_string(),
            Some(fake_root.to_string_lossy().to_string()),
            None,
            None,
        );
        assert!(err.is_err());
        std::fs::remove_dir_all(&fake_root).ok();
    }
}

/// Returns the config base directory for a known editor on the current OS.
/// e.g. editor_config_dir("Code") → C:\Users\<user>\AppData\Roaming\Code
fn editor_config_dir(folder_name: &str) -> Result<std::path::PathBuf, String> {
    #[cfg(windows)]
    {
        let appdata = std::env::var("APPDATA").map_err(|_| "APPDATA not set".to_string())?;
        Ok(std::path::PathBuf::from(appdata).join(folder_name))
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
        Ok(std::path::PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join(folder_name))
    }
    #[cfg(target_os = "linux")]
    {
        let config = std::env::var("XDG_CONFIG_HOME").unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_default();
            format!("{home}/.config")
        });
        Ok(std::path::PathBuf::from(config).join(folder_name))
    }
}

fn editor_folder(id: &str) -> Option<&'static str> {
    match id {
        "vscode"   => Some("Code"),
        "cursor"   => Some("Cursor"),
        "windsurf" => Some("Windsurf"),
        _          => None,
    }
}

/// Read the keybindings.json for a given editor (vscode | cursor | windsurf).
#[tauri::command]
pub fn read_editor_keybindings(editor: String) -> Result<String, String> {
    let folder = editor_folder(&editor)
        .ok_or_else(|| format!("Unknown editor: {editor}"))?;
    let path = editor_config_dir(folder)?
        .join("User")
        .join("keybindings.json");
    std::fs::read_to_string(&path)
        .map_err(|e| format!("Could not read {}: {e}", path.display()))
}

/// Returns which of vscode / cursor / windsurf have a keybindings.json on disk.
#[tauri::command]
pub fn detect_installed_editors() -> Vec<String> {
    ["vscode", "cursor", "windsurf"]
        .iter()
        .filter(|&&id| {
            editor_folder(id)
                .and_then(|f| editor_config_dir(f).ok())
                .map(|p| p.join("User").join("keybindings.json").exists())
                .unwrap_or(false)
        })
        .map(|s| s.to_string())
        .collect()
}

#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        let parent = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone());
        std::process::Command::new("xdg-open")
            .arg(&parent)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
