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
