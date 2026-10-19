pub(crate) const SEARCH_IGNORE: &[&str] = &[
    ".git", "node_modules", "target", ".next", "dist", "build",
    ".cache", "__pycache__", ".venv", "venv", ".turbo", "coverage",
    "out", ".parcel-cache", ".svelte-kit",
    // Caches de gestionnaires de paquets : hors code source, et volumineux au
    // point de saturer l'index (constaté en E2E : `.pnpm-store` seul remplissait
    // le plafond de 20 000 fichiers et écrasait tout le code du projet).
    ".pnpm-store", ".yarn", ".npm", ".pnpm", "vendor", "bower_components",
    // Artefacts de build / dépendances natifs et mobiles.
    ".gradle", ".dart_tool", "Pods", ".idea", ".vscode",
];

// ── Text search ───────────────────────────────────────────────────────────────

const MAX_MATCHES: usize = 500;
const MAX_REPLACE_FILES: usize = 5000;

/// Options de recherche/remplacement transmises depuis le frontend.
/// `is_regex` : le motif est une expression régulière.
/// `case_sensitive` : respecte la casse (par défaut insensible).
/// `whole_word` : n'accepte que des correspondances sur des mots entiers.
#[derive(serde::Deserialize)]
pub struct SearchOptions {
    #[serde(default)]
    pub is_regex: bool,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
}

#[derive(serde::Serialize)]
pub struct SearchMatch {
    path: String,
    line: u32,
    col:  u32,
    text: String,
}

/// Échappe une chaîne pour l'utiliser comme littéral dans une regex.
fn regex_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if "\\.+*?()|[]{}^$#&-~".contains(c) { out.push('\\'); }
        out.push(c);
    }
    out
}

/// Compile le motif + options en une regex avec ancrage « mot entier » si demandé.
fn build_regex(query: &str, opts: &SearchOptions) -> Result<regex::Regex, String> {
    let base = if opts.is_regex { query.to_string() } else { regex_escape(query) };
    let pattern = if opts.whole_word { format!(r"\b(?:{})\b", base) } else { base };
    regex::RegexBuilder::new(&pattern)
        .case_insensitive(!opts.case_sensitive)
        .build()
        .map_err(|e| e.to_string())
}

/// Compile un glob simplifié (support `*`, `**`, `?`) en regex ancrée.
/// Un `**/` en tête est rendu optionnel (comportement gitignore : le motif
/// s'applique aussi à la racine).
fn glob_to_regex(glob: &str) -> String {
    let g = glob.replace('\\', "/");
    let mut re = String::from("^");
    let chars: Vec<char> = g.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '*' => {
                if i + 1 < chars.len() && chars[i + 1] == '*' {
                    // `**/` ou `**`
                    if i + 2 < chars.len() && chars[i + 2] == '/' {
                        if i == 0 { re.push_str("(?:.*/)?"); } else { re.push_str(".*/"); }
                        i += 3;
                    } else {
                        re.push_str(".*");
                        i += 2;
                    }
                } else {
                    re.push_str("[^/]*");
                    i += 1;
                }
            }
            '?' => { re.push_str("[^/]"); i += 1; }
            '.' => { re.push_str("\\."); i += 1; }
            other => {
                if "\\.+()|[]{}^$".contains(other) { re.push('\\'); }
                re.push(other);
                i += 1;
            }
        }
    }
    re.push('$');
    re
}

/// Ensemble de matchers d'exclusion compilés à partir des motifs fournis.
fn compile_excludes(excludes: &str) -> Vec<regex::Regex> {
    excludes
        .lines()
        .map(|l| l.trim().trim_start_matches("./").trim_matches('/'))
        .filter(|l| !l.is_empty())
        .filter_map(|pattern| {
            if pattern.ends_with('/') {
                let name = pattern.trim_end_matches('/');
                regex::Regex::new(&format!("(^|/){}($|/.*)", regex_escape(name))).ok()
            } else if pattern.contains('/') {
                let core = pattern.trim_start_matches("**/");
                regex::Regex::new(&glob_to_regex(core)).ok()
            } else if pattern.contains('*') || pattern.contains('?') {
                // Glob sans chemin (ex: `*.lock`) : s'applique à tout l'arbre.
                regex::Regex::new(&glob_to_regex(&format!("**/{}", pattern))).ok()
            } else {
                // Nom simple : exclut le dossier/fichier partout dans l'arbre.
                regex::Regex::new(&format!("(^|/){}($|/.*)", regex_escape(pattern))).ok()
            }
        })
        .collect()
}

/// Vrai si le chemin relatif (séparateurs `/`) correspond à une exclusion.
fn is_excluded(rel: &str, rules: &[regex::Regex]) -> bool {
    rules.iter().any(|r| r.is_match(rel))
}

/// Vrai si le chemin relatif (séparateurs `/`) doit être inclus. Une liste vide
/// signifie « pas de filtre » : tout est inclus (parité VS Code).
fn is_included(rel: &str, rules: &[regex::Regex]) -> bool {
    rules.is_empty() || rules.iter().any(|r| r.is_match(rel))
}

fn search_file(
    path: &std::path::Path,
    re: &regex::Regex,
    results: &mut Vec<SearchMatch>,
) {
    let Ok(bytes) = std::fs::read(path) else { return };
    if bytes.contains(&0u8) { return }
    let Ok(text) = std::str::from_utf8(&bytes) else { return };
    for (i, line) in text.lines().enumerate() {
        if results.len() >= MAX_MATCHES { return }
        if let Some(m) = re.find(line) {
            results.push(SearchMatch {
                path: path.to_string_lossy().into_owned(),
                line: (i + 1) as u32,
                col:  m.start() as u32,
                text: line.trim().to_string(),
            });
        }
    }
}

/// Parcours récursif. `folder` sert de base pour calculer le chemin relatif
/// utilisé par l'évaluation des règles d'exclusion.
fn walk_search(
    dir: &std::path::Path,
    folder: &std::path::Path,
    re: &regex::Regex,
    excludes: &[regex::Regex],
    includes: &[regex::Regex],
    results: &mut Vec<SearchMatch>,
) {
    if results.len() >= MAX_MATCHES { return }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut subdirs = vec![];
    for entry in rd.flatten() {
        let path = entry.path();
        let ns = entry.file_name().to_string_lossy().into_owned();
        if SEARCH_IGNORE.iter().any(|&s| s == ns.as_str()) { continue }
        if path.is_dir() {
            subdirs.push(path);
        } else {
            let rel = path.strip_prefix(folder).unwrap_or(&path).to_string_lossy().replace('\\', "/");
            if is_excluded(&rel, excludes) { continue }
            // Motifs d'inclusion : si fournis, seuls les fichiers correspondants
            // sont parcourus (parité VS Code « files to include »).
            if !is_included(&rel, includes) { continue }
            search_file(&path, re, results);
        }
    }
    for d in subdirs { walk_search(&d, folder, re, excludes, includes, results) }
}

#[tauri::command]
pub async fn search_in_files(
    folder: String,
    query: String,
    options: Option<SearchOptions>,
    excludes: Option<String>,
    includes: Option<String>,
) -> Result<Vec<SearchMatch>, String> {
    if query.is_empty() { return Ok(vec![]) }
    let opts = options.unwrap_or(SearchOptions { is_regex: false, case_sensitive: false, whole_word: false });
    let re = build_regex(&query, &opts)?;
    let excl = compile_excludes(excludes.as_deref().unwrap_or(""));
    let incl = compile_excludes(includes.as_deref().unwrap_or(""));
    tokio::task::spawn_blocking(move || {
        let mut results = Vec::new();
        let base = std::path::Path::new(&folder);
        walk_search(base, base, &re, &excl, &incl, &mut results);
        results
    }).await.map_err(|e| e.to_string())
}

// ── Replace in files ──────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct ReplaceResult {
    files_changed: u32,
    replacements:  u32,
    /// Chemins absolus des fichiers effectivement modifiés (pour rafraîchir les
    /// onglets ouverts). Source de vérité : ne dépend pas d'une re-recherche.
    files:         Vec<String>,
}

#[derive(serde::Deserialize)]
pub struct ReplaceRequest {
    folder: String,
    query: String,
    replacement: String,
    options: Option<SearchOptions>,
    excludes: Option<String>,
    /// Motifs d'inclusion (glob) : si non vide, seuls les fichiers correspondants
    /// sont traités (parité VS Code « files to include »).
    #[serde(default)]
    includes: Option<String>,
    /// Conserve la casse d'origine du texte remplacé (parité VS Code « Preserve Case »).
    #[serde(default)]
    preserve_case: bool,
    /// Chemins absolus des fichiers à traiter. Si `None`, tout le dossier est traité.
    #[serde(default)]
    files: Option<Vec<String>>,
}

/// Requête de remplacement d'UNE occurrence précise (parité VS Code : bouton
/// « Replace » au survol d'un résultat). Le remplacement est appliqué à la
/// première correspondance située à `line`/`col` — col étant l'offset d'octet
/// (comme renvoyé par la recherche) — ce qui évite de reparser tout le fichier.
#[derive(serde::Deserialize)]
pub struct ReplaceOneRequest {
    path: String,
    query: String,
    replacement: String,
    options: Option<SearchOptions>,
    /// Ligne 1-indexée de l'occurrence à remplacer.
    line: u32,
    /// Offset (octets) de l'occurrence dans la ligne.
    col: u32,
    #[serde(default)]
    preserve_case: bool,
}

/// Applique « Preserve Case » à un remplacement littéral en calquant la casse
/// du texte d'origine : tout minuscule → minuscule, tout majuscule → majuscule,
/// première lettre majuscule → première lettre du remplacement en majuscule.
/// Ne s'applique qu'aux remplacements littéraux (un remplacement regex porte
/// déjà sa propre intention de casse via les groupes de capture).
fn apply_preserve_case(matched: &str, replacement: &str) -> String {
    if replacement.is_empty() || matched.is_empty() { return replacement.to_string() }
    let has_alpha = matched.chars().any(|c| c.is_alphabetic());
    if !has_alpha { return replacement.to_string() }
    let all_upper = matched.chars().all(|c| !c.is_alphabetic() || c.is_uppercase());
    let all_lower = matched.chars().all(|c| !c.is_alphabetic() || c.is_lowercase());
    if all_upper {
        // Conserve aussi les chiffres/symboles non alphabétiques tels quels.
        replacement.chars().map(|c| c.to_uppercase().next().unwrap_or(c)).collect()
    } else if all_lower {
        replacement.chars().map(|c| c.to_lowercase().next().unwrap_or(c)).collect()
    } else {
        // Casse mixte (ex. « Foo ») : majuscule sur la première lettre alphabétique.
        let mut done = false;
        replacement.chars().map(|c| {
            if !done && c.is_alphabetic() {
                done = true;
                c.to_uppercase().next().unwrap_or(c)
            } else { c }
        }).collect()
    }
}

/// Construit la chaîne de remplacement en développant les groupes `$1`..`$9`
/// lorsque le motif est une regex. En mode littéral, le remplacement est
/// inséré tel quel (protégé contre l'interprétation `$` par la regex).
fn expand_replacement(caps: &regex::Captures, replacement: &str, is_regex: bool, preserve_case: bool) -> String {
    if is_regex {
        let mut out = String::new();
        caps.expand(replacement, &mut out);
        out
    } else if preserve_case {
        apply_preserve_case(caps.get(0).map(|m| m.as_str()).unwrap_or(""), replacement)
    } else {
        replacement.to_string()
    }
}

fn replace_in_file(
    path: &std::path::Path,
    re: &regex::Regex,
    replacement: &str,
    is_regex: bool,
    preserve_case: bool,
) -> Option<u32> {
    let Ok(bytes) = std::fs::read(path) else { return None };
    if bytes.contains(&0u8) { return None }
    let Ok(text) = std::str::from_utf8(&bytes) else { return None };
    let mut count = 0u32;
    let new_text = re
        .replace_all(text, |caps: &regex::Captures| {
            count += 1;
            expand_replacement(caps, replacement, is_regex, preserve_case)
        })
        .into_owned();
    if new_text != text {
        std::fs::write(path, new_text).ok()?;
    }
    Some(count)
}

#[tauri::command]
pub async fn replace_in_files(req: ReplaceRequest) -> Result<ReplaceResult, String> {
    if req.query.is_empty() { return Ok(ReplaceResult { files_changed: 0, replacements: 0, files: vec![] }) }
    let opts = req.options.unwrap_or(SearchOptions { is_regex: false, case_sensitive: false, whole_word: false });
    let re = build_regex(&req.query, &opts)?;
    let excl = compile_excludes(req.excludes.as_deref().unwrap_or(""));
    let incl = compile_excludes(req.includes.as_deref().unwrap_or(""));
    let is_regex = opts.is_regex;
    let preserve_case = req.preserve_case;
    let replacement = req.replacement;
    tokio::task::spawn_blocking(move || {
        let base = std::path::Path::new(&req.folder);
        let mut files: Vec<std::path::PathBuf> = Vec::new();
        match req.files {
            Some(list) => {
                for f in list {
                    let p = std::path::PathBuf::from(&f);
                    if p.is_file() { files.push(p); }
                }
            }
            None => collect_files(base, base, &excl, &mut files),
        }
        let mut changed = 0u32;
        let mut total = 0u32;
        let mut changed_files: Vec<String> = Vec::new();
        for f in files.iter().take(MAX_REPLACE_FILES) {
            // Filtre d'inclusion : un fichier doit correspondre à au moins un motif.
            if !incl.is_empty() {
                let rel = f.strip_prefix(base).unwrap_or(f).to_string_lossy().replace('\\', "/");
                if !incl.iter().any(|r| r.is_match(&rel)) { continue }
            }
            if let Some(n) = replace_in_file(f, &re, &replacement, is_regex, preserve_case) {
                if n > 0 {
                    changed += 1;
                    total += n;
                    changed_files.push(f.to_string_lossy().into_owned());
                }
            }
        }
        ReplaceResult { files_changed: changed, replacements: total, files: changed_files }
    }).await.map_err(|e| e.to_string())
}

/// Remplace UNE occurrence précise (ligne + col) dans un fichier. Utilisé par le
/// bouton « Replace » au survol d'un résultat. Retourne `true` si une
/// correspondance a bien été trouvée à cet emplacement et remplacée.
#[tauri::command]
pub async fn replace_one(req: ReplaceOneRequest) -> Result<bool, String> {
    if req.query.is_empty() { return Ok(false) }
    let opts = req.options.unwrap_or(SearchOptions { is_regex: false, case_sensitive: false, whole_word: false });
    let re = build_regex(&req.query, &opts)?;
    let is_regex = opts.is_regex;
    let preserve_case = req.preserve_case;
    let path = std::path::PathBuf::from(&req.path);
    let target_line = req.line as usize;
    let target_col = req.col as usize;
    let replacement = req.replacement;
    tokio::task::spawn_blocking(move || -> Result<bool, String> {
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        if bytes.contains(&0u8) { return Ok(false) }
        let text = String::from_utf8(bytes).map_err(|e| e.to_string())?;
        // Édition ciblée : on ne touche qu'à la ligne visée pour préserver le
        // reste du fichier à l'octet près (pas de perte de fins de ligne).
        let mut out = String::with_capacity(text.len() + replacement.len());
        let mut replaced = false;
        for (idx, segment) in text.split_inclusive('\n').enumerate() {
            if idx + 1 != target_line || replaced {
                out.push_str(segment);
                continue;
            }
            // `segment` peut inclure le `\n` final : on isole le corps.
            let (body, nl) = match segment.strip_suffix('\n') {
                Some(b) => (b, "\n"),
                None => (segment, ""),
            };
            // Cherche une correspondance qui commence exactement à target_col.
            let mut found: Option<(usize, usize, String)> = None;
            for m in re.find_iter(body) {
                if m.start() == target_col {
                    let rep = if is_regex {
                        let caps = re.captures(m.as_str()).ok_or_else(|| "regex capture failed".to_string())?;
                        expand_replacement(&caps, &replacement, is_regex, preserve_case)
                    } else if preserve_case {
                        apply_preserve_case(m.as_str(), &replacement)
                    } else {
                        replacement.clone()
                    };
                    found = Some((m.start(), m.end(), rep));
                    break;
                }
            }
            match found {
                Some((start, end, rep)) => {
                    out.push_str(&body[..start]);
                    out.push_str(&rep);
                    out.push_str(&body[end..]);
                    out.push_str(nl);
                    replaced = true;
                }
                None => out.push_str(segment),
            }
        }
        if replaced {
            std::fs::write(&path, out).map_err(|e| e.to_string())?;
        }
        Ok(replaced)
    }).await.map_err(|e| e.to_string())?
}

/// Collecte tous les fichiers d'un dossier en respectant les règles d'exclusion.
fn collect_files(
    dir: &std::path::Path,
    folder: &std::path::Path,
    excludes: &[regex::Regex],
    out: &mut Vec<std::path::PathBuf>,
) {
    if out.len() >= MAX_REPLACE_FILES { return }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut subdirs = vec![];
    for entry in rd.flatten() {
        let path = entry.path();
        let ns = entry.file_name().to_string_lossy().into_owned();
        if SEARCH_IGNORE.iter().any(|&s| s == ns.as_str()) { continue }
        if path.is_dir() {
            subdirs.push(path);
        } else {
            let rel = path.strip_prefix(folder).unwrap_or(&path).to_string_lossy().replace('\\', "/");
            if !is_excluded(&rel, excludes) { out.push(path); }
        }
    }
    for d in subdirs { collect_files(&d, folder, excludes, out) }
}

// ── Symbol search ─────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct SymbolMatch {
    name:         String,
    kind:         String,
    path:         String,
    line:         u32,
    line_content: String,
}

fn extract_ident(s: &str) -> Option<String> {
    let s = s.trim_start();
    let end = s.find(|c: char| !c.is_alphanumeric() && c != '_').unwrap_or(s.len());
    if end == 0 { None } else { Some(s[..end].to_string()) }
}

fn classify_ts(s: &str) -> Option<(String, &'static str)> {
    let s = s.strip_prefix("export default ").unwrap_or(s);
    let s = s.strip_prefix("export ").unwrap_or(s);
    let s = s.strip_prefix("declare ").unwrap_or(s);
    if let Some(r) = s.strip_prefix("async function ").or_else(|| s.strip_prefix("function ")) {
        return extract_ident(r).map(|n| (n, "fn"));
    }
    if let Some(r) = s.strip_prefix("class ")     { return extract_ident(r).map(|n| (n, "class")); }
    if let Some(r) = s.strip_prefix("interface ") { return extract_ident(r).map(|n| (n, "interface")); }
    if let Some(r) = s.strip_prefix("type ") {
        let name = extract_ident(r)?;
        let after = r[name.len()..].trim_start();
        if after.starts_with('=') || after.starts_with('<') {
            return Some((name, "type"));
        }
    }
    if let Some(r) = s.strip_prefix("const ").or_else(|| s.strip_prefix("let ")) {
        let name = extract_ident(r)?;
        let after = r[name.len()..].trim_start();
        if after.starts_with("= (") || after.starts_with("= async") || after.starts_with("= function") {
            return Some((name, "fn"));
        }
        if after.starts_with(':') || after.starts_with("= ") {
            return Some((name, "const"));
        }
    }
    None
}

fn classify_rs(s: &str) -> Option<(String, &'static str)> {
    let s = s.strip_prefix("pub(crate) ").unwrap_or(s);
    let s = s.strip_prefix("pub(super) ").unwrap_or(s);
    let s = s.strip_prefix("pub ").unwrap_or(s);
    if let Some(r) = s.strip_prefix("async fn ").or_else(|| s.strip_prefix("fn ")) {
        return extract_ident(r).map(|n| (n, "fn"));
    }
    if let Some(r) = s.strip_prefix("struct ") { return extract_ident(r).map(|n| (n, "struct")); }
    if let Some(r) = s.strip_prefix("enum ")   { return extract_ident(r).map(|n| (n, "enum")); }
    if let Some(r) = s.strip_prefix("trait ")  { return extract_ident(r).map(|n| (n, "trait")); }
    if let Some(r) = s.strip_prefix("type ")   { return extract_ident(r).map(|n| (n, "type")); }
    None
}

fn classify_py(s: &str) -> Option<(String, &'static str)> {
    if let Some(r) = s.strip_prefix("async def ").or_else(|| s.strip_prefix("def ")) {
        return extract_ident(r).map(|n| (n, "fn"));
    }
    if let Some(r) = s.strip_prefix("class ") { return extract_ident(r).map(|n| (n, "class")); }
    None
}

fn classify_line(line: &str, ext: &str) -> Option<(String, &'static str)> {
    let s = line.trim();
    if s.is_empty() || s.starts_with("//") || s.starts_with('#') || s.starts_with('*') { return None; }
    match ext {
        "ts" | "tsx" | "js" | "jsx" | "vue" | "svelte" => classify_ts(s),
        "rs" => classify_rs(s),
        "py" => classify_py(s),
        _ => None,
    }
}

fn search_symbols_file(path: &std::path::Path, query: &str, results: &mut Vec<SymbolMatch>) {
    let ext = match path.extension().and_then(|e| e.to_str()) {
        Some(e) => e,
        None => return,
    };
    if !matches!(ext, "ts" | "tsx" | "js" | "jsx" | "rs" | "py" | "vue" | "svelte") { return }
    let Ok(bytes) = std::fs::read(path) else { return };
    if bytes.contains(&0u8) { return }
    let Ok(text) = std::str::from_utf8(&bytes) else { return };
    for (i, line) in text.lines().enumerate() {
        if results.len() >= 300 { return }
        if let Some((name, kind)) = classify_line(line, ext) {
            if query.is_empty() || name.to_lowercase().contains(query) {
                results.push(SymbolMatch {
                    name,
                    kind: kind.to_string(),
                    path: path.to_string_lossy().into_owned(),
                    line: (i + 1) as u32,
                    line_content: line.trim().to_string(),
                });
            }
        }
    }
}

fn walk_symbols(dir: &std::path::Path, query: &str, results: &mut Vec<SymbolMatch>) {
    if results.len() >= 300 { return }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut subdirs = vec![];
    for entry in rd.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let ns = name.to_string_lossy();
        if SEARCH_IGNORE.iter().any(|&s| s == ns.as_ref()) { continue }
        if path.is_dir() { subdirs.push(path) } else { search_symbols_file(&path, query, results) }
    }
    for d in subdirs { walk_symbols(&d, query, results) }
}

#[tauri::command]
pub async fn search_symbols(folder: String, query: String) -> Result<Vec<SymbolMatch>, String> {
    if folder.is_empty() { return Ok(vec![]) }
    let q = query.to_lowercase();
    tokio::task::spawn_blocking(move || {
        let mut results = Vec::new();
        walk_symbols(std::path::Path::new(&folder), &q, &mut results);
        results
    }).await.map_err(|e| e.to_string())
}

// ── Workspace file listing ────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct WorkspaceFile {
    name: String,
    path: String,
    ext:  String,
}

fn walk_files(dir: &std::path::Path, results: &mut Vec<WorkspaceFile>) {
    if results.len() >= 2000 { return }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        if results.len() >= 2000 { break }
        let path = entry.path();
        let name = entry.file_name();
        let ns = name.to_string_lossy();
        if SEARCH_IGNORE.iter().any(|&s| s == ns.as_ref()) { continue }
        if path.is_dir() {
            walk_files(&path, results);
        } else {
            let ext = path.extension()
                .map(|e| e.to_string_lossy().to_string())
                .unwrap_or_default();
            results.push(WorkspaceFile {
                name: ns.to_string(),
                path: path.to_string_lossy().into_owned(),
                ext,
            });
        }
    }
}

#[tauri::command]
pub async fn list_workspace_files(folder: String) -> Result<Vec<WorkspaceFile>, String> {
    tokio::task::spawn_blocking(move || {
        let mut results = Vec::new();
        walk_files(std::path::Path::new(&folder), &mut results);
        results
    }).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(is_regex: bool, case_sensitive: bool, whole_word: bool) -> SearchOptions {
        SearchOptions { is_regex, case_sensitive, whole_word }
    }

    // ── build_regex ────────────────────────────────────────────────────────────

    #[test]
    fn build_regex_literal_case_insensitive_by_default() {
        let re = build_regex("Foo", &opts(false, false, false)).unwrap();
        assert!(re.is_match("foo bar"));
        assert!(re.is_match("FOO"));
    }

    #[test]
    fn build_regex_literal_case_sensitive() {
        let re = build_regex("Foo", &opts(false, true, false)).unwrap();
        assert!(re.is_match("Foo"));
        assert!(!re.is_match("foo"));
    }

    #[test]
    fn build_regex_literal_escapes_metacharacters() {
        // Un « . » littéral ne doit pas matcher n'importe quel caractère.
        let re = build_regex("a.b", &opts(false, false, false)).unwrap();
        assert!(re.is_match("a.b"));
        assert!(!re.is_match("axb"));
    }

    #[test]
    fn build_regex_regex_mode() {
        let re = build_regex("a.b", &opts(true, false, false)).unwrap();
        assert!(re.is_match("axb"));
    }

    #[test]
    fn build_regex_whole_word() {
        let re = build_regex("cat", &opts(false, false, true)).unwrap();
        assert!(re.is_match("a cat here"));
        assert!(!re.is_match("category"));
    }

    #[test]
    fn build_regex_invalid_regex_errors() {
        assert!(build_regex("(", &opts(true, false, false)).is_err());
    }

    // ── glob_to_regex / excludes ─────────────────────────────────────────────────

    #[test]
    fn excludes_dir_name_matches_anywhere() {
        let rules = compile_excludes("node_modules");
        assert!(is_excluded("a/node_modules/b.js", &rules));
        assert!(is_excluded("node_modules/x", &rules));
        assert!(!is_excluded("src/app.js", &rules));
    }

    #[test]
    fn excludes_extension_glob() {
        let rules = compile_excludes("*.lock");
        assert!(is_excluded("Cargo.lock", &rules));
        assert!(is_excluded("sub/dir/package.lock", &rules));
        assert!(!is_excluded("Cargo.toml", &rules));
    }

    #[test]
    fn excludes_path_glob() {
        let rules = compile_excludes("src/**/*.test.ts");
        assert!(is_excluded("src/a/b/foo.test.ts", &rules));
        assert!(!is_excluded("src/a/b/foo.ts", &rules));
    }

    #[test]
    fn excludes_ignores_blank_lines_and_leading_dot_slash() {
        let rules = compile_excludes("\n  ./dist  \n\n");
        assert_eq!(rules.len(), 1);
        assert!(is_excluded("dist/x.js", &rules));
    }

    // ── regex_escape ────────────────────────────────────────────────────────────

    #[test]
    fn regex_escape_special_chars() {
        assert_eq!(regex_escape("a.b*c"), r"a\.b\*c");
        assert_eq!(regex_escape("plain"), "plain");
    }

    // ── expand_replacement ──────────────────────────────────────────────────────

    #[test]
    fn expand_replacement_literal_is_verbatim() {
        let re = build_regex("foo", &opts(false, false, false)).unwrap();
        let caps = re.captures("foo").unwrap();
        assert_eq!(expand_replacement(&caps, "$1bar", false, false), "$1bar");
    }

    #[test]
    fn expand_replacement_regex_expands_groups() {
        let re = build_regex(r"(\w+)@(\w+)", &opts(true, false, false)).unwrap();
        let caps = re.captures("user@host").unwrap();
        assert_eq!(expand_replacement(&caps, "$2:$1", true, false), "host:user");
    }

    // ── apply_preserve_case ─────────────────────────────────────────────────────

    #[test]
    fn preserve_case_all_lower() {
        assert_eq!(apply_preserve_case("foo", "BAR"), "bar");
    }

    #[test]
    fn preserve_case_all_upper() {
        assert_eq!(apply_preserve_case("FOO", "bar"), "BAR");
    }

    #[test]
    fn preserve_case_title() {
        assert_eq!(apply_preserve_case("Foo", "bar baz"), "Bar baz");
    }

    #[test]
    fn preserve_case_no_alpha_is_verbatim() {
        assert_eq!(apply_preserve_case("123", "x"), "x");
    }

    // ── classify_ts ────────────────────────────────────────────────────────────

    #[test]
    fn ts_plain_function() {
        assert_eq!(classify_ts("function foo() {}"), Some(("foo".into(), "fn")));
    }

    #[test]
    fn ts_async_function() {
        assert_eq!(classify_ts("async function bar()"), Some(("bar".into(), "fn")));
    }

    #[test]
    fn ts_export_function() {
        assert_eq!(classify_ts("export function baz()"), Some(("baz".into(), "fn")));
    }

    #[test]
    fn ts_export_default_function() {
        assert_eq!(classify_ts("export default function qux()"), Some(("qux".into(), "fn")));
    }

    #[test]
    fn ts_declare_function() {
        assert_eq!(classify_ts("declare function declared()"), Some(("declared".into(), "fn")));
    }

    #[test]
    fn ts_class() {
        assert_eq!(classify_ts("class MyClass {"), Some(("MyClass".into(), "class")));
        assert_eq!(classify_ts("export class Exported {"), Some(("Exported".into(), "class")));
    }

    #[test]
    fn ts_interface() {
        assert_eq!(classify_ts("interface FooBar {"), Some(("FooBar".into(), "interface")));
        assert_eq!(classify_ts("export interface Iface"), Some(("Iface".into(), "interface")));
    }

    #[test]
    fn ts_type_alias_eq() {
        assert_eq!(classify_ts("type Foo = string"), Some(("Foo".into(), "type")));
        assert_eq!(classify_ts("export type Bar = number | string"), Some(("Bar".into(), "type")));
    }

    #[test]
    fn ts_type_alias_generic() {
        assert_eq!(classify_ts("type Result<T> = T[]"), Some(("Result".into(), "type")));
    }

    #[test]
    fn ts_type_no_eq_or_generic_is_not_matched() {
        // "type" keyword followed by an identifier but no '=' or '<'
        assert_eq!(classify_ts("type"), None);
    }

    #[test]
    fn ts_const_arrow_fn() {
        assert_eq!(classify_ts("const foo = () => {}"), Some(("foo".into(), "fn")));
        assert_eq!(classify_ts("const bar = async () => {}"), Some(("bar".into(), "fn")));
        assert_eq!(classify_ts("const baz = function() {}"), Some(("baz".into(), "fn")));
    }

    #[test]
    fn ts_const_value() {
        assert_eq!(classify_ts("const MAX: number = 100"), Some(("MAX".into(), "const")));
        assert_eq!(classify_ts("const val = 42"), Some(("val".into(), "const")));
        assert_eq!(classify_ts("let count = 0"), Some(("count".into(), "const")));
    }

    #[test]
    fn ts_no_match() {
        assert_eq!(classify_ts("import { foo } from './bar'"), None);
        assert_eq!(classify_ts("// a comment"), None);
        assert_eq!(classify_ts(""), None);
    }

    // ── classify_rs ────────────────────────────────────────────────────────────

    #[test]
    fn rs_plain_fn() {
        assert_eq!(classify_rs("fn foo()"), Some(("foo".into(), "fn")));
    }

    #[test]
    fn rs_async_fn() {
        assert_eq!(classify_rs("async fn bar()"), Some(("bar".into(), "fn")));
    }

    #[test]
    fn rs_pub_fn() {
        assert_eq!(classify_rs("pub fn baz()"), Some(("baz".into(), "fn")));
        assert_eq!(classify_rs("pub async fn qux()"), Some(("qux".into(), "fn")));
    }

    #[test]
    fn rs_pub_crate_fn() {
        assert_eq!(classify_rs("pub(crate) fn internal()"), Some(("internal".into(), "fn")));
        assert_eq!(classify_rs("pub(super) fn super_fn()"), Some(("super_fn".into(), "fn")));
    }

    #[test]
    fn rs_struct() {
        assert_eq!(classify_rs("struct Foo {"), Some(("Foo".into(), "struct")));
        assert_eq!(classify_rs("pub struct Bar"), Some(("Bar".into(), "struct")));
    }

    #[test]
    fn rs_enum() {
        assert_eq!(classify_rs("enum Status {"), Some(("Status".into(), "enum")));
        assert_eq!(classify_rs("pub enum Direction"), Some(("Direction".into(), "enum")));
    }

    #[test]
    fn rs_trait() {
        assert_eq!(classify_rs("trait Serialize"), Some(("Serialize".into(), "trait")));
        assert_eq!(classify_rs("pub trait Display"), Some(("Display".into(), "trait")));
    }

    #[test]
    fn rs_type_alias() {
        assert_eq!(classify_rs("type Result<T>"), Some(("Result".into(), "type")));
        assert_eq!(classify_rs("pub type Alias = String"), Some(("Alias".into(), "type")));
    }

    #[test]
    fn rs_no_match() {
        assert_eq!(classify_rs("let x = 5;"), None);
        assert_eq!(classify_rs("use std::io;"), None);
        assert_eq!(classify_rs("// comment"), None);
        assert_eq!(classify_rs(""), None);
    }

    // ── classify_py ────────────────────────────────────────────────────────────

    #[test]
    fn py_def() {
        assert_eq!(classify_py("def foo():"), Some(("foo".into(), "fn")));
        assert_eq!(classify_py("def bar(x, y):"), Some(("bar".into(), "fn")));
    }

    #[test]
    fn py_async_def() {
        assert_eq!(classify_py("async def baz():"), Some(("baz".into(), "fn")));
    }

    #[test]
    fn py_class() {
        assert_eq!(classify_py("class Foo:"), Some(("Foo".into(), "class")));
        assert_eq!(classify_py("class Bar(Base):"), Some(("Bar".into(), "class")));
    }

    #[test]
    fn py_no_match() {
        assert_eq!(classify_py("x = 5"), None);
        assert_eq!(classify_py("import os"), None);
        assert_eq!(classify_py("# comment"), None);
        assert_eq!(classify_py(""), None);
    }

    // ── extract_ident ──────────────────────────────────────────────────────────

    #[test]
    fn extract_ident_basic() {
        assert_eq!(extract_ident("foo()"), Some("foo".into()));
        assert_eq!(extract_ident("my_var: T"), Some("my_var".into()));
        assert_eq!(extract_ident("CamelCase {"), Some("CamelCase".into()));
    }

    #[test]
    fn extract_ident_empty_or_non_alpha_start() {
        assert_eq!(extract_ident(""), None);
        assert_eq!(extract_ident("(args)"), None);
        // extract_ident extracts any [a-zA-Z0-9_]+ run — it does not enforce
        // that identifiers start with a letter (callers rely on keyword-prefix
        // stripping to ensure the remaining text is a valid identifier).
        assert_eq!(extract_ident("123abc"), Some("123abc".into()));
    }

    #[test]
    fn extract_ident_trims_leading_whitespace() {
        assert_eq!(extract_ident("  foo()"), Some("foo".into()));
    }
}
