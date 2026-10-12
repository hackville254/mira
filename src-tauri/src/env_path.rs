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

    dirs
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
