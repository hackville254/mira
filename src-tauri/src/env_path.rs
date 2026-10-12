// Résolution du PATH pour une application GUI.
//
// Problème : une app lancée depuis le Finder (macOS) ou le menu Démarrer
// (Windows) **n'hérite pas** du PATH du shell de l'utilisateur. Résultat : des
// binaires pourtant installés (`~/.cargo/bin/rust-analyzer`, `/opt/homebrew/bin`,
// `~/.local/bin/…`) sont invisibles — le classique « language server not found »
// alors que tout est installé.
//
// Réponse : construire un PATH **enrichi et déterministe** en fusionnant :
//   1. le PATH du process (celui hérité),
//   2. le PATH d'un **shell de login** (`zsh -lc` / `bash -lc`) — récupère ce que
//      l'utilisateur a configuré dans ses rc,
//   3. une liste de **dossiers usuels** (Cargo, Homebrew, pipx, npm-global, …).
//
// Sécurité : le shell n'est invoqué qu'avec un **script littéral figé**
// (`printf %s "$PATH"`) — aucune donnée utilisateur n'y est concaténée, donc pas
// d'injection. Un timeout court évite qu'un rc exotique bloque le démarrage.
// Le résultat est **mis en cache** par process (un seul spawn).

use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

/// Dossiers usuels d'outils de développement, ajoutés après le PATH résolu.
/// Dépendants de `$HOME` : on les calcule à l'exécution.
fn well_known_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let Some(home) = std::env::var_os("HOME") else {
        return dirs;
    };
    let home = PathBuf::from(home);

    // Binaires utilisateur (pipx, pip --user, `cargo install`, outils manuels).
    dirs.push(home.join(".local/bin"));
    dirs.push(home.join(".cargo/bin"));
    // npm global (par défaut et préfixe usuel alternatif).
    dirs.push(home.join(".npm-global/bin"));
    dirs.push(home.join(".npm/bin"));
    // Pnpm / Bun (souvent utilisés pour installer des serveurs JS).
    dirs.push(home.join(".bun/bin"));
    dirs.push(home.join(".local/share/pnpm"));

    // Emplacements Apple Silicon et Intel.
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    dirs.push(PathBuf::from("/usr/local/bin"));
    // Chemins système de base (au cas où le process n'aurait presque rien).
    dirs.push(PathBuf::from("/usr/bin"));
    dirs.push(PathBuf::from("/bin"));

    // Gestionnaires de version Node (nvm, `n`, fnm, volta, asdf).
    // Ceux-ci modifient le PATH depuis les rc du shell ; un shell de login
    // peut ne pas les charger (early-return non-interactif). On les résout
    // donc **explicitement** pour que `node`/`npm` soient toujours visibles.
    dirs.extend(node_manager_dirs(&home));

    dirs
}

/// Dossiers « bin » des gestionnaires de version Node usuels.
///
/// `nvm` empile un dossier par version (`~/.nvm/versions/node/<v>/bin`) : on
/// sélectionne la **version active** (`alias/default`) si elle est résolue,
/// sinon la plus récente par tri sémantique — pour ne pas dépendre de l'ordre
/// du système de fichiers.
fn node_manager_dirs(home: &std::path::Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    // `n` : `~/n/bin` (binaires globaux) et `~/n/versions/node/<v>/bin`.
    dirs.push(home.join("n/bin"));
    dirs.extend(latest_version_bin(&home.join("n/versions/node")));

    // nvm : `~/.nvm/alias/default` désigne la version active. L'alias est
    // souvent **partiel** (`24`, `v24`, `lts/*`, `node`) : on le résout contre
    // les versions réellement installées. Repli final : la plus récente.
    let nvm_root = home.join(".nvm/versions/node");
    if let Some(alias) = nvm_alias(&home.join(".nvm/alias/default")) {
        if let Some(dir) = resolve_nvm_alias(&nvm_root, &alias) {
            dirs.push(dir);
        }
    }
    dirs.extend(latest_version_bin(&nvm_root));

    // fnm, volta, asdf (multiversion). On privilégie les alias courants.
    dirs.push(home.join(".fnm/aliases/default/bin"));
    dirs.push(home.join(".volta/bin"));
    dirs.push(home.join(".asdf/shims"));

    dirs
}

/// Lit `~/.nvm/alias/default` (ex. `v24.21.0` ou `24.21.0`) et retourne le nom
/// de dossier canonique `vX.Y.Z`, ou `None` si le fichier est absent/vide.
fn nvm_active_version(alias_file: &std::path::Path) -> Option<String> {
    let raw = std::fs::read_to_string(alias_file).ok()?;
    let v = raw.trim();
    if v.is_empty() {
        return None;
    }
    Some(if v.starts_with('v') { v.to_string() } else { format!("v{v}") })
}

/// Liste les sous-dossiers de versions `vX.Y.Z` d'un root Node et retourne les
/// `<v>/bin` correspondants, **du plus récent au plus ancien** (tri sémantique).
/// Utilisé en repli quand l'alias actif n'est pas disponible.
fn latest_version_bin(root: &std::path::Path) -> Vec<PathBuf> {
    let Ok(read) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut versions: Vec<(u64, u64, u64, PathBuf)> = Vec::new();
    for entry in read.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if let Some(v) = parse_semver(&name) {
            versions.push((v.0, v.1, v.2, entry.path().join("bin")));
        }
    }
    versions.sort_by(|a, b| (b.0, b.1, b.2).cmp(&(a.0, a.1, a.2)));
    versions.into_iter().map(|(_, _, _, p)| p).collect()
}

/// Parse `vX.Y.Z` (ou `X.Y.Z`) en triplet numérique. `None` si non conforme.
fn parse_semver(name: &str) -> Option<(u64, u64, u64)> {
    let s = name.strip_prefix('v').unwrap_or(name);
    let mut parts = s.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

/// Interroge un shell de login pour récupérer son `$PATH` (`zsh -lc` / `bash -lc`).
///
/// Le script est **constant** : `printf %s "$PATH"`. Aucune donnée utilisateur.
/// Retourne une liste de dossiers, ou vide si le shell échoue/traîne.
#[cfg(not(windows))]
fn path_from_login_shell() -> Vec<PathBuf> {
    use std::process::{Command, Stdio};

    // Shell de login prioritaire : $SHELL, sinon zsh (défaut macOS), sinon bash.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let shell = if std::path::Path::new(&shell).is_file() {
        shell
    } else {
        "/bin/bash".to_string()
    };

    // `-l` (login) + `-c` (commande) : charge les rc comme un vrai terminal.
    let mut child = match Command::new(&shell)
        .arg("-lc")
        .arg("printf %s \"$PATH\"")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };

    // Attente bornée : un rc qui bloque ne doit pas geler l'app.
    let deadline = std::time::Instant::now() + Duration::from_millis(1500);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    return Vec::new();
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => return Vec::new(),
        }
    }

    let out = match child.wait_with_output() {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    let s = String::from_utf8_lossy(&out.stdout);
    std::env::split_paths(&*s).filter(|p| !p.as_os_str().is_empty()).collect()
}

/// Windows : pas de shell de login POSIX — on se repose sur le process + dossiers
/// usuels. Le PATH utilisateur est déjà injecté par l'OS pour les apps GUI.
#[cfg(windows)]
fn path_from_login_shell() -> Vec<PathBuf> {
    Vec::new()
}

/// Construit (une seule fois) le PATH enrichi, dans l'ordre de priorité :
/// process → login shell → dossiers usuels. Les doublons sont éliminés en
/// conservant la première occurrence (la plus prioritaire).
fn build_path() -> Vec<PathBuf> {
    let mut seen = std::collections::HashSet::new();
    let mut result: Vec<PathBuf> = Vec::new();

    let push = |p: PathBuf, seen: &mut std::collections::HashSet<PathBuf>, out: &mut Vec<PathBuf>| {
        if p.as_os_str().is_empty() {
            return;
        }
        // Clé de déduplication normale pour éviter les doublons triviaux.
        if seen.insert(p.clone()) {
            out.push(p);
        }
    };

    // 1 + 2 : process, puis login shell (le shell apporte souvent plus).
    if let Some(process_path) = std::env::var_os("PATH") {
        for d in std::env::split_paths(&process_path) {
            push(d, &mut seen, &mut result);
        }
    }
    for d in path_from_login_shell() {
        push(d, &mut seen, &mut result);
    }
    // 3 : dossiers usuels.
    for d in well_known_dirs() {
        push(d, &mut seen, &mut result);
    }

    result
}

/// PATH enrichi mis en cache (calculé une seule fois par process).
fn cached_path() -> &'static Vec<PathBuf> {
    static CACHE: OnceLock<Vec<PathBuf>> = OnceLock::new();
    CACHE.get_or_init(build_path)
}

/// Renvoie le PATH enrichi sous forme de `OsString` (séparateur natif).
///
/// À utiliser pour **définir `PATH`** sur un processus enfant (serveur LSP,
/// tâche), afin qu'il voie les mêmes binaires que l'utilisateur dans son shell.
pub fn enriched_path_os() -> std::ffi::OsString {
    std::env::join_paths(cached_path().iter()).unwrap_or_default()
}

/// Répertoires du PATH enrichi (ordre de priorité conservé).
pub fn enriched_dirs() -> &'static [PathBuf] {
    cached_path().as_slice()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_semver_accepts_v_prefix_and_plain() {
        assert_eq!(parse_semver("v24.21.0"), Some((24, 21, 0)));
        assert_eq!(parse_semver("24.21.0"), Some((24, 21, 0)));
        // Patch optionnel.
        assert_eq!(parse_semver("v20.10"), Some((20, 10, 0)));
        // Non conforme → None (pas de panic).
        assert_eq!(parse_semver("node"), None);
        assert_eq!(parse_semver("v1.2.3.4"), None);
        assert_eq!(parse_semver(""), None);
    }

    #[test]
    fn latest_version_bin_sorts_descending() {
        let tmp = std::env::temp_dir().join(format!("origin_envpath_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        for v in ["v18.2.0", "v24.21.0", "v20.10.0", "not-a-version"] {
            std::fs::create_dir_all(tmp.join(v)).unwrap();
        }
        let bins = latest_version_bin(&tmp);
        let names: Vec<String> = bins.iter().map(|p| {
            p.parent().unwrap().file_name().unwrap().to_string_lossy().to_string()
        }).collect();
        assert_eq!(names, vec!["v24.21.0", "v20.10.0", "v18.2.0"]);
        // Chaque entrée pointe vers un sous-dossier `bin`.
        assert!(bins.iter().all(|p| p.ends_with("bin")));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn latest_version_bin_missing_root_is_empty() {
        let missing = std::env::temp_dir().join("origin_envpath_absent_xyz");
        assert!(latest_version_bin(&missing).is_empty());
    }

    #[test]
    fn nvm_active_version_reads_and_normalizes() {
        let tmp = std::env::temp_dir().join(format!("origin_nvm_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let alias = tmp.join("default");

        std::fs::write(&alias, "24.21.0\n").unwrap();
        assert_eq!(nvm_active_version(&alias), Some("v24.21.0".to_string()));

        std::fs::write(&alias, "v20.10.0").unwrap();
        assert_eq!(nvm_active_version(&alias), Some("v20.10.0".to_string()));

        std::fs::write(&alias, "  \n").unwrap();
        assert_eq!(nvm_active_version(&alias), None);

        let _ = std::fs::remove_file(&alias);
        assert_eq!(nvm_active_version(&alias), None);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn node_manager_dirs_includes_common_locations() {
        let home = PathBuf::from("/tmp/fake-home");
        let dirs = node_manager_dirs(&home);
        assert!(dirs.contains(&home.join("n/bin")));
        assert!(dirs.contains(&home.join(".volta/bin")));
        assert!(dirs.contains(&home.join(".asdf/shims")));
        assert!(dirs.contains(&home.join(".fnm/aliases/default/bin")));
    }
}
