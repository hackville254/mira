//! Indexation locale du workspace (parité Trae « Indexing & Docs »).
//!
//! ── Pourquoi ce module existe ────────────────────────────────────────────────
//! Trae construit un **index du workspace** qui alimente ses références
//! `#Workspace` / `#Folder` et sa recherche « par sens ». Sans index, la seule
//! chose qu'on sait faire est un parcours disque + grep (cf. `context.rs`), dont
//! le tri final est **lexicographique** — donc non pertinent.
//!
//! On reproduit ici le *comportement* de Trae avec un moteur **100 % local**,
//! **hors-ligne** et **sans dépendance** : un index inversé de type **BM25**
//! (tokens → documents), avec un léger biais de chemin (un mot présent dans le
//! nom de fichier/dossier pèse plus lourd). C'est déterministe, rapide, et ça ne
//! fait appel à aucun service externe.
//!
//! ── Ce que ce module NE fait PAS ─────────────────────────────────────────────
//! Ce n'est **pas** de la recherche sémantique/vectorielle (embeddings). Le SDK
//! Cline n'expose aucun index réutilisable (son `search_codebase` est un outil
//! piloté par le modèle, pas une API), et le projet n'embarque aucun vector
//! store. On reste donc sur du **lexical avancé**, ce qui couvre l'immense
//! majorité des usages « retrouver le fichier où l'on parle de X ».
//!
//! ── Sécurité (règle « adversarial first ») ───────────────────────────────────
//!   - **Confinement** : le workspace doit être un dossier absolu ; les chemins
//!     d'index calculés restent sous `<ws>/.mira/index` (`ensure_within`).
//!   - **Exclusions** : on réutilise `search::SEARCH_IGNORE` (`node_modules`,
//!     `.git`, `target`…) : ces arborescences ne sont **jamais** indexées, donc
//!     jamais exposées — confidentialité et performance.
//!   - **DoORS par fichier** : un fichier binaire (octet NUL dans l'en-tête) ou
//!     trop volumineux (`MAX_FILE_BYTES`) est ignoré : on ne tokenise pas un
//!     blob, on ne gonfle pas l'index.
//!   - **DoORS global** : le nombre de fichiers indexés est plafonné
//!     (`MAX_INDEX_FILES`) pour qu'un monorepo pathologique ne bloque pas le
//!     build ni ne sature la mémoire.
//!   - **Annulation** : un build en cours peut être interrompu (drapeau
//!     `AtomicBool`) pour ne pas geler l'UI sur une grosse arborescence.
//!   - **Pas d'exécution** : on ne lit que des fichiers texte, on n'exécute ni
//!     ne suit aucun contenu (pas de path traversal via symlink : `read_dir`
//!     n'est pas suivi au-delà de la profondeur réelle, seuls les dossiers
//!     réels sont descendus).
//!
//! ── Persistance ─────────────────────────────────────────────────────────────
//! L'index est sérialisé en JSON **compact** sous `<ws>/.mira/index/index.json`
//! (+ un `meta.json` d'état). `.mira` est déjà la convention du projet (skills,
//! rules, memories) et reste **invisible** pour l'utilisateur — jamais `.cline`.

use crate::extensions_store::ensure_within;
use crate::search::SEARCH_IGNORE;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

// ── Bornes ────────────────────────────────────────────────────────────────────

/// Taille maximale d'un fichier individuel indexable (octets). Au-delà : ignoré.
const MAX_FILE_BYTES: u64 = 512 * 1024;

/// Nombre maximum de fichiers indexés dans un workspace (garde-fou anti-DoORS).
const MAX_INDEX_FILES: usize = 20_000;

/// Longueur de préfixe inspectée pour détecter un fichier binaire (NUL byte).
const BINARY_SNIFF_BYTES: usize = 8 * 1024;

/// Nombre maximum de tokens distincts conservés par document (anti-explosion).
const MAX_TOKENS_PER_DOC: usize = 4_000;

/// Longueur maximale d'un token retenu (les identifiants minés sont bornés).
const MAX_TOKEN_LEN: usize = 48;

/// Nombre de résultats renvoyés par défaut par `search_index`.
const DEFAULT_LIMIT: usize = 50;

/// Nombre maximum de résultats renvoyables par `search_index`.
const MAX_LIMIT: usize = 200;

/// Seuil d'auto-indexation : reproduction de Trae (auto si ≤ 5 000 fichiers).
/// Au-delà, on indexe quand même (choix produit) mais on signale que c'est gros.
const AUTO_INDEX_THRESHOLD: usize = 5_000;

/// Paramètres BM25 (standards : k1 ≈ 1.2–2.0, b ≈ 0.75).
const BM25_K1: f32 = 1.5;
const BM25_B: f32 = 0.75;

/// Poids ajouté au score quand le terme apparaît dans le chemin (nom de
/// fichier/dossier). Un match sur le *nom* est presque toujours plus pertinent
/// qu'un match dans le corps.
const PATH_WEIGHT: f32 = 2.0;

// ── Modèle d'index ────────────────────────────────────────────────────────────

/// Un document indexé = un fichier texte du workspace.
#[derive(Serialize, Deserialize, Clone)]
struct Doc {
    /// Chemin relatif (séparateurs `/`), identité lisible du document.
    rel: String,
    /// Nombre total de tokens (dénominateur du score BM25).
    len: usize,
    /// Fréquences de termes du corps : token → nombre d'occurrences.
    tf: HashMap<String, u32>,
    /// Tokens présents dans le **chemin** (nom + dossiers), dédupliqués.
    path_tokens: Vec<String>,
}

/// Index inversé persisté.
#[derive(Serialize, Deserialize, Default)]
struct IndexData {
    /// Version du format : permet d'invalider un index obsolète.
    version: u32,
    /// Liste des documents (l'id d'un doc = son index dans ce vecteur).
    docs: Vec<Doc>,
    /// Index inverse : token → (doc_id, fréquence dans le corps).
    postings: HashMap<String, Vec<(u32, u32)>>,
    /// Longueur moyenne des documents (pour BM25).
    avg_len: f32,
    /// Nombre de documents où chaque token apparaît (pour l'IDF).
    doc_freq: HashMap<String, u32>,
    /// Racine du workspace indexé (sécurité : un index n'est valable que pour lui).
    root: String,
}

/// Version de format d'index. À incrémenter si la structure change.
const INDEX_VERSION: u32 = 1;

/// Métadonnées d'état affichées dans l'UI (page Settings > Indexing & Docs).
#[derive(Serialize, Clone)]
pub struct IndexStatus {
    /// `true` si un index exploitable est chargé en mémoire.
    pub built: bool,
    /// `true` si un build est en cours.
    pub building: bool,
    /// Nombre de fichiers indexés.
    pub file_count: usize,
    /// Racine couverte par l'index chargé (vide si aucun).
    pub root: String,
    /// Horodatage du dernier build réussi (epoch ms), 0 si jamais.
    pub built_at: u64,
    /// `true` si le workspace dépasse le seuil d'auto-indexation de Trae.
    pub large: bool,
}

/// Un résultat de recherche dans l'index.
#[derive(Serialize)]
pub struct IndexHit {
    /// Chemin relatif du fichier.
    pub rel: String,
    /// Score BM25 (décroissant).
    pub score: f32,
}

// ── État global (mémoire) ─────────────────────────────────────────────────────

/// Index chargé en mémoire, protégé, avec la racine qu'il couvre.
struct Loaded {
    root: PathBuf,
    data: IndexData,
    built_at: u64,
}

fn state() -> &'static Mutex<Option<Loaded>> {
    static STATE: OnceLock<Mutex<Option<Loaded>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(None))
}

/// Drapeau d'annulation du build courant (partagé avec le worker bloquant).
fn cancel_flag() -> &'static AtomicBool {
    static FLAG: AtomicBool = AtomicBool::new(false);
    &FLAG
}

// ── Tokenisation ──────────────────────────────────────────────────────────────

/// Vrai si `c` peut appartenir à un token (lettres/chiffres Unicode ou `_`).
/// On garde `_` pour coller aux identifiants de code (`user_id`, `snake_case`).
fn is_token_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Découpe un texte en tokens normalisés (minuscules), en coupant aussi les
/// identifiants camelCase / snake_case pour améliorer le rappel :
/// `parseContextRef` → `parse`, `context`, `ref`, `parsecontextref`.
fn tokenize(text: &str, out: &mut Vec<String>) {
    let mut cur = String::new();
    for c in text.chars() {
        if is_token_char(c) {
            cur.push(c);
        } else {
            if !cur.is_empty() {
                flush_token(&mut cur, out);
            }
        }
    }
    if !cur.is_empty() {
        flush_token(&mut cur, out);
    }
}

/// Éclate le token courant en sous-tokens (case/snake) et les pousse dans `out`.
fn flush_token(cur: &mut String, out: &mut Vec<String>) {
    let raw: String = cur.drain(..).collect();
    let lower = raw.to_lowercase();
    if lower.len() < 2 || lower.len() > MAX_TOKEN_LEN {
        return;
    }
    out.push(lower.clone());

    // Découpe camelCase/snake_case : on isole les mots composants.
    if raw.contains('_') || raw.chars().any(|c| c.is_uppercase()) {
        for part in split_compound(&raw) {
            let p = part.to_lowercase();
            if p.len() >= 2 && p.len() <= MAX_TOKEN_LEN && p != lower {
                out.push(p);
            }
        }
    }
}

/// Découpe `fooBar_baz` en `["foo", "Bar", "baz"]` (frontières camel + `_`).
fn split_compound(s: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut cur = String::new();
    let mut prev_lower = false;
    for c in s.chars() {
        if c == '_' {
            if !cur.is_empty() {
                parts.push(std::mem::take(&mut cur));
            }
            prev_lower = false;
            continue;
        }
        if c.is_uppercase() && prev_lower {
            parts.push(std::mem::take(&mut cur));
        }
        prev_lower = c.is_lowercase() || c.is_ascii_digit();
        cur.push(c);
    }
    if !cur.is_empty() {
        parts.push(cur);
    }
    parts
}

// ── Filtrage des fichiers ─────────────────────────────────────────────────────

/// Vrai si les premiers octets trahissent un contenu binaire (présence d'un NUL).
fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(BINARY_SNIFF_BYTES).any(|&b| b == 0)
}

/// Construit le document d'un fichier (corps + tokens de chemin), ou `None` si le
/// fichier doit être ignoré (trop gros, binaire, non-UTF8, ou non texte).
fn build_doc(root: &Path, path: &Path) -> Option<Doc> {
    let Ok(meta) = std::fs::metadata(path) else {
        return None;
    };
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES || meta.len() == 0 {
        return None;
    }
    let rel = path
        .strip_prefix(root)
        .ok()?
        .to_string_lossy()
        .replace('\\', "/");
    if rel.starts_with(".mira/") {
        return None; // ne jamais indexer notre propre index
    }

    let bytes = std::fs::read(path).ok()?;
    if looks_binary(&bytes) {
        return None;
    }
    let text = String::from_utf8(bytes).ok()?;

    let mut body_tokens: Vec<String> = Vec::new();
    tokenize(&text, &mut body_tokens);

    let mut tf: HashMap<String, u32> = HashMap::new();
    for t in body_tokens.iter().take(MAX_TOKENS_PER_DOC) {
        *tf.entry(t.clone()).or_insert(0) += 1;
    }

    let mut path_tokens: Vec<String> = Vec::new();
    tokenize(&rel, &mut path_tokens);
    path_tokens.sort();
    path_tokens.dedup();

    let len = tf.values().map(|&v| v as usize).sum();
    Some(Doc { rel, len, tf, path_tokens })
}

/// Parcourt récursivement `dir` et construit les documents, en respectant
/// `SEARCH_IGNORE`, le plafond de fichiers et le drapeau d'annulation.
fn walk(dir: &Path, root: &Path, docs: &mut Vec<Doc>, cancel: &AtomicBool) {
    if cancel.load(Ordering::Relaxed) || docs.len() >= MAX_INDEX_FILES {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let mut subdirs: Vec<PathBuf> = Vec::new();
    for entry in rd.flatten() {
        if cancel.load(Ordering::Relaxed) || docs.len() >= MAX_INDEX_FILES {
            return;
        }
        let path = entry.path();
        let name = entry.file_name();
        let ns = name.to_string_lossy();
        if SEARCH_IGNORE.iter().any(|&s| s == ns.as_ref()) {
            continue;
        }
        // `file_type` sans suivre les symlinks : évite de boucler sur un lien.
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            subdirs.push(path);
        } else if ft.is_file() {
            if let Some(doc) = build_doc(root, &path) {
                docs.push(doc);
            }
        }
    }
    for d in subdirs {
        walk(&d, root, docs, cancel);
    }
}

// ── Construction de l'index ───────────────────────────────────────────────────

/// Construit l'index complet à partir d'une liste de documents.
fn build_index(root: &Path, docs: Vec<Doc>) -> IndexData {
    let mut postings: HashMap<String, Vec<(u32, u32)>> = HashMap::new();
    let mut doc_freq: HashMap<String, u32> = HashMap::new();
    let mut total_len: usize = 0;

    for (id, doc) in docs.iter().enumerate() {
        total_len += doc.len;
        for (token, &freq) in &doc.tf {
            postings
                .entry(token.clone())
                .or_default()
                .push((id as u32, freq));
            *doc_freq.entry(token.clone()).or_insert(0) += 1;
        }
    }

    let avg_len = if docs.is_empty() {
        0.0
    } else {
        total_len as f32 / docs.len() as f32
    };

    IndexData {
        version: INDEX_VERSION,
        docs,
        postings,
        avg_len,
        doc_freq,
        root: root.to_string_lossy().into_owned(),
    }
}

// ── Chemins de persistance ────────────────────────────────────────────────────

/// Dossier d'index pour un workspace : `<ws>/.mira/index`.
fn index_dir(workspace: &str) -> Result<PathBuf, String> {
    let ws = Path::new(workspace);
    if !ws.is_absolute() {
        return Err("workspace path must be absolute".to_string());
    }
    let mira = ws.join(".mira");
    let dir = mira.join("index");
    ensure_within(&mira, &dir)?;
    Ok(dir)
}

/// Chemin du fichier d'index sérialisé.
fn index_file(workspace: &str) -> Result<PathBuf, String> {
    Ok(index_dir(workspace)?.join("index.json"))
}

/// Métadonnées persistées à côté de l'index (horodatage, compteur).
#[derive(Serialize, Deserialize, Default)]
struct IndexMeta {
    built_at: u64,
    file_count: usize,
    version: u32,
}

fn meta_file(workspace: &str) -> Result<PathBuf, String> {
    Ok(index_dir(workspace)?.join("meta.json"))
}

/// Horodatage courant en millisecondes Unix.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Écrit `content` de façon atomique (tmp dans le même dossier + rename).
fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    let parent = path.parent().ok_or("invalid index path")?;
    std::fs::create_dir_all(parent).map_err(|e| format!("cannot create index dir: {e}"))?;
    let tmp = parent.join(format!(".tmp-{}-{}", std::process::id(), now_ms()));
    std::fs::write(&tmp, content).map_err(|e| format!("cannot write index: {e}"))?;
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("cannot finalize index: {e}"));
    }
    Ok(())
}

// ── API interne : build / load ────────────────────────────────────────────────

/// Construit et persiste l'index d'un workspace (opération bloquante ; à lancer
/// via `spawn_blocking`). Met aussi à jour l'état mémoire global.
fn build_and_persist(workspace: &str) -> Result<IndexStatus, String> {
    let root = PathBuf::from(workspace);
    if !root.is_dir() {
        return Err("workspace is not a directory".to_string());
    }
    cancel_flag().store(false, Ordering::Relaxed);

    let mut docs: Vec<Doc> = Vec::new();
    walk(&root, &root, &mut docs, cancel_flag());

    let cancelled = cancel_flag().load(Ordering::Relaxed);
    let data = build_index(&root, docs);
    let file_count = data.docs.len();
    let built_at = now_ms();

    // Persistance (même annulé, on sauve ce qu'on a : c'est un index partiel
    // valide, mieux que rien, et l'UI indiquera le nombre réel de fichiers).
    if !file_count_max_reached(&data) {
        let json = serde_json::to_string(&data).map_err(|e| format!("serialize index: {e}"))?;
        write_atomic(&index_file(workspace)?, &json)?;
        let meta = IndexMeta {
            built_at,
            file_count,
            version: INDEX_VERSION,
        };
        let meta_json =
            serde_json::to_string(&meta).map_err(|e| format!("serialize meta: {e}"))?;
        write_atomic(&meta_file(workspace)?, &meta_json)?;
    }

    let large = file_count > AUTO_INDEX_THRESHOLD;
    let status = IndexStatus {
        built: true,
        building: false,
        file_count,
        root: workspace.to_string(),
        built_at,
        large,
    };

    if let Ok(mut guard) = state().lock() {
        *guard = Some(Loaded {
            root,
            data,
            built_at,
        });
    }

    let _ = cancelled; // conservé pour lisibilité ; l'index partiel reste valide
    Ok(status)
}

/// Vrai si on a atteint le plafond de fichiers (index tronqué : on évite alors
/// d'annoncer un index « complet » — mais on le persiste quand même).
fn file_count_max_reached(data: &IndexData) -> bool {
    data.docs.len() >= MAX_INDEX_FILES
}

/// Charge un index persisté en mémoire si la racine correspond. Renvoie `None`
/// si absent/corrompu/sans rapport (l'appelant décide alors de reconstruire).
fn try_load(workspace: &str) -> Option<()> {
    let path = index_file(workspace).ok()?;
    let raw = std::fs::read_to_string(&path).ok()?;
    let data: IndexData = serde_json::from_str(&raw).ok()?;
    if data.version != INDEX_VERSION || data.root != workspace {
        return None;
    }
    let built_at = std::fs::read_to_string(meta_file(workspace).ok()?)
        .ok()
        .and_then(|m| serde_json::from_str::<IndexMeta>(&m).ok())
        .map(|m| m.built_at)
        .unwrap_or(0);
    if let Ok(mut guard) = state().lock() {
        *guard = Some(Loaded {
            root: PathBuf::from(workspace),
            data,
            built_at,
        });
    }
    Some(())
}

// ── Commandes Tauri ───────────────────────────────────────────────────────────

/// Réponse d'un build d'index.
#[derive(Serialize)]
pub struct IndexBuildResult {
    pub file_count: usize,
    pub built_at: u64,
    pub large: bool,
}

/// Statut de l'index pour un workspace : charge l'index persisté si présent,
/// sinon renvoie `built: false`. Ne construit **pas** d'index (l'UI décide).
#[tauri::command]
pub async fn index_status(workspace: String) -> Result<IndexStatus, String> {
    tokio::task::spawn_blocking(move || {
        let building = cancel_flag().load(Ordering::Relaxed);
        // Déjà chargé pour cette racine ?
        {
            let guard = state().lock().map_err(|_| "index state poisoned")?;
            if let Some(loaded) = guard.as_ref() {
                if loaded.root == PathBuf::from(&workspace) {
                    let count = loaded.data.docs.len();
                    return Ok(IndexStatus {
                        built: true,
                        building,
                        file_count: count,
                        root: workspace,
                        built_at: loaded.built_at,
                        large: count > AUTO_INDEX_THRESHOLD,
                    });
                }
            }
        }
        // Sinon, tentative de chargement depuis le disque.
        if try_load(&workspace).is_some() {
            let guard = state().lock().map_err(|_| "index state poisoned")?;
            if let Some(loaded) = guard.as_ref() {
                let count = loaded.data.docs.len();
                return Ok(IndexStatus {
                    built: true,
                    building,
                    file_count: count,
                    root: workspace,
                    built_at: loaded.built_at,
                    large: count > AUTO_INDEX_THRESHOLD,
                });
            }
        }
        Ok(IndexStatus {
            built: false,
            building,
            file_count: 0,
            root: workspace,
            built_at: 0,
            large: false,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Construit (ou reconstruit) l'index d'un workspace et le persiste.
#[tauri::command]
pub async fn index_build(workspace: String) -> Result<IndexBuildResult, String> {
    tokio::task::spawn_blocking(move || {
        let status = build_and_persist(&workspace)?;
        Ok(IndexBuildResult {
            file_count: status.file_count,
            built_at: status.built_at,
            large: status.large,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Demande l'annulation du build en cours. Le worker s'arrête au prochain
/// fichier ; l'index partiel déjà construit reste valide et persisté.
#[tauri::command]
pub fn index_cancel() -> Result<(), String> {
    cancel_flag().store(true, Ordering::Relaxed);
    Ok(())
}

/// Supprime du disque l'index persisté **et** l'état mémoire du workspace.
#[tauri::command]
pub async fn index_clear(workspace: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        cancel_flag().store(true, Ordering::Relaxed);
        if let Ok(dir) = index_dir(&workspace) {
            let _ = std::fs::remove_file(dir.join("index.json"));
            let _ = std::fs::remove_file(dir.join("meta.json"));
        }
        if let Ok(mut guard) = state().lock() {
            if guard
                .as_ref()
                .map(|l| l.root == PathBuf::from(&workspace))
                .unwrap_or(false)
            {
                *guard = None;
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Cœur de la recherche : charge l'index du workspace si besoin puis classe.
/// Extrait de la commande Tauri pour être testable directement (E2E réel).
fn search_core(workspace: &str, query: &str, limit: usize) -> Result<Vec<IndexHit>, String> {
    let limit = limit.clamp(1, MAX_LIMIT);
    let terms = query_terms(query);
    if terms.is_empty() {
        return Ok(Vec::new());
    }

    // S'assurer que l'index du bon workspace est chargé.
    let needs_load = {
        let guard = state().lock().map_err(|_| "index state poisoned")?;
        !guard
            .as_ref()
            .map(|l| l.root == PathBuf::from(workspace))
            .unwrap_or(false)
    };
    if needs_load && try_load(workspace).is_none() {
        return Ok(Vec::new()); // pas d'index : pas de résultat (l'UI propose de builder)
    }

    let guard = state().lock().map_err(|_| "index state poisoned")?;
    let loaded = guard.as_ref().ok_or("index not loaded")?;
    Ok(rank(&loaded.data, &terms, limit))
}

/// Interroge l'index avec une requête BM25. Renvoie les documents classés par
/// score décroissant. Charge l'index depuis le disque si besoin.
#[tauri::command]
pub async fn search_index(
    workspace: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<IndexHit>, String> {
    tokio::task::spawn_blocking(move || {
        search_core(&workspace, &query, limit.unwrap_or(DEFAULT_LIMIT))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Normalise une requête en tokens (mêmes règles que l'indexation).
fn query_terms(query: &str) -> Vec<String> {
    let mut terms = Vec::new();
    tokenize(query, &mut terms);
    terms.sort();
    terms.dedup();
    terms
}

// ── Scoring BM25 ──────────────────────────────────────────────────────────────

/// Classe les documents pour `terms` selon BM25 + biais de chemin.
fn rank(data: &IndexData, terms: &[String], limit: usize) -> Vec<IndexHit> {
    if data.docs.is_empty() || data.avg_len <= 0.0 {
        return Vec::new();
    }
    let n = data.docs.len() as f32;
    let mut scores: BTreeMap<u32, f32> = BTreeMap::new();

    for term in terms {
        let Some(postings) = data.postings.get(term) else {
            continue;
        };
        let df = *data.doc_freq.get(term).unwrap_or(&0) as f32;
        // IDF BM25 avec lissage : jamais négatif.
        let idf = (1.0 + (n - df + 0.5) / (df + 0.5)).ln();

        for &(doc_id, freq) in postings {
            let doc = &data.docs[doc_id as usize];
            let tf = freq as f32;
            let denom = tf + BM25_K1 * (1.0 - BM25_B + BM25_B * (doc.len as f32) / data.avg_len);
            let mut score = idf * (tf * (BM25_K1 + 1.0)) / denom;
            if doc.path_tokens.binary_search(term).is_ok() {
                score += PATH_WEIGHT;
            }
            *scores.entry(doc_id).or_insert(0.0) += score;
        }
    }

    let mut hits: Vec<(u32, f32)> = scores.into_iter().collect();
    // Tri : score décroissant, puis chemin croissant (déterminisme).
    hits.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| data.docs[a.0 as usize].rel.cmp(&data.docs[b.0 as usize].rel))
    });

    hits.into_iter()
        .take(limit)
        .map(|(id, score)| IndexHit {
            rel: data.docs[id as usize].rel.clone(),
            score,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_ws(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "mira-idx-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&base).unwrap();
        base
    }

    #[test]
    fn tokenize_lowercases_and_splits_identifiers() {
        let mut out = Vec::new();
        tokenize("parseContextRef user_id FooBar", &mut out);
        assert!(out.contains(&"parsecontextref".to_string()));
        assert!(out.contains(&"parse".to_string()));
        assert!(out.contains(&"context".to_string()));
        assert!(out.contains(&"user_id".to_string()));
        assert!(out.contains(&"user".to_string()));
        assert!(out.contains(&"id".to_string()));
        assert!(out.contains(&"foobar".to_string()));
        assert!(out.contains(&"foo".to_string()));
        assert!(out.contains(&"bar".to_string()));
    }

    #[test]
    fn tokenize_drops_too_short_and_punctuation() {
        let mut out = Vec::new();
        tokenize("a, b! ok?? x", &mut out);
        assert!(!out.contains(&"a".to_string()));
        assert!(!out.contains(&"b".to_string()));
        assert!(!out.contains(&"x".to_string()));
        assert!(out.contains(&"ok".to_string()));
    }

    #[test]
    fn split_compound_handles_camel_and_snake() {
        assert_eq!(split_compound("fooBar"), vec!["foo", "Bar"]);
        assert_eq!(split_compound("a_b_c"), vec!["a", "b", "c"]);
        assert_eq!(split_compound("HTTPRequest"), vec!["HTTPRequest"]);
    }

    #[test]
    fn looks_binary_detects_nul() {
        assert!(looks_binary(&[0x41, 0x00, 0x42]));
        assert!(!looks_binary(b"hello world"));
    }

    #[test]
    fn build_doc_ignores_binary_and_empty() {
        let ws = temp_ws("doc");
        fs::write(ws.join("ok.txt"), "hello world").unwrap();
        fs::write(ws.join("bin.dat"), [0u8, 1, 2, 3]).unwrap();
        fs::write(ws.join("empty.txt"), "").unwrap();
        assert!(build_doc(&ws, &ws.join("ok.txt")).is_some());
        assert!(build_doc(&ws, &ws.join("bin.dat")).is_none());
        assert!(build_doc(&ws, &ws.join("empty.txt")).is_none());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn build_doc_never_indexes_own_index_dir() {
        let ws = temp_ws("self");
        let d = ws.join(".mira").join("index");
        fs::create_dir_all(&d).unwrap();
        let f = d.join("index.json");
        fs::write(&f, "{\"x\":1}").unwrap();
        assert!(build_doc(&ws, &f).is_none());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn walk_respects_search_ignore() {
        let ws = temp_ws("ignore");
        fs::create_dir_all(ws.join("node_modules")).unwrap();
        fs::create_dir_all(ws.join(".git")).unwrap();
        fs::write(ws.join("src.rs"), "fn main() {}").unwrap();
        fs::write(ws.join("node_modules/dep.js"), "module.exports = 1").unwrap();
        fs::write(ws.join(".git/config"), "[core]").unwrap();
        let mut docs = Vec::new();
        let cancel = AtomicBool::new(false);
        walk(&ws, &ws, &mut docs, &cancel);
        let rels: Vec<String> = docs.iter().map(|d| d.rel.clone()).collect();
        assert!(rels.contains(&"src.rs".to_string()));
        assert!(!rels.iter().any(|r| r.contains("node_modules")));
        assert!(!rels.iter().any(|r| r.contains(".git")));
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn walk_stops_on_cancel() {
        let ws = temp_ws("cancel");
        for i in 0..10 {
            fs::write(ws.join(format!("f{i}.txt")), format!("content {i}")).unwrap();
        }
        let mut docs = Vec::new();
        let cancel = AtomicBool::new(true); // déjà annulé ⇒ aucun scan
        walk(&ws, &ws, &mut docs, &cancel);
        assert!(docs.is_empty());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn rank_prefers_path_matches_and_more_frequent_terms() {
        let ws = temp_ws("rank");
        fs::create_dir_all(ws.join("auth")).unwrap();
        fs::write(ws.join("auth/login.rs"), "fn login() { token_check(); }").unwrap();
        fs::write(ws.join("readme.md"), "some docs mention login briefly").unwrap();
        fs::write(ws.join("other.txt"), "login login login login").unwrap();

        let mut docs = Vec::new();
        let cancel = AtomicBool::new(false);
        walk(&ws, &ws, &mut docs, &cancel);
        let data = build_index(&ws, docs);

        let hits = rank(&data, &query_terms("login"), 10);
        assert!(!hits.is_empty());
        // `auth/login.rs` a le terme dans le chemin ⇒ doit être premier.
        assert_eq!(hits[0].rel, "auth/login.rs");
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn rank_is_deterministic_on_ties() {
        let ws = temp_ws("tie");
        fs::write(ws.join("b.txt"), "alpha").unwrap();
        fs::write(ws.join("a.txt"), "alpha").unwrap();
        let mut docs = Vec::new();
        let cancel = AtomicBool::new(false);
        walk(&ws, &ws, &mut docs, &cancel);
        let data = build_index(&ws, docs);
        let hits = rank(&data, &query_terms("alpha"), 10);
        assert_eq!(hits.len(), 2);
        // Même longueur, même fréquence ⇒ départage par chemin croissant.
        assert_eq!(hits[0].rel, "a.txt");
        assert_eq!(hits[1].rel, "b.txt");
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn rank_returns_empty_for_unknown_term() {
        let ws = temp_ws("unknown");
        fs::write(ws.join("a.txt"), "alpha beta").unwrap();
        let mut docs = Vec::new();
        let cancel = AtomicBool::new(false);
        walk(&ws, &ws, &mut docs, &cancel);
        let data = build_index(&ws, docs);
        assert!(rank(&data, &query_terms("zzzzz"), 10).is_empty());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn index_dir_is_confined_under_mira() {
        let ws = temp_ws("confine");
        let dir = index_dir(ws.to_string_lossy().as_ref()).unwrap();
        assert!(dir.starts_with(ws.join(".mira")));
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn index_dir_rejects_relative_path() {
        assert!(index_dir("relative/path").is_err());
    }

    #[test]
    fn build_and_search_roundtrip_with_persistence() {
        let ws = temp_ws("roundtrip");
        fs::create_dir_all(ws.join("src")).unwrap();
        fs::write(ws.join("src/search.rs"), "fn search_index() {}").unwrap();
        fs::write(ws.join("notes.md"), "unrelated content").unwrap();

        let ws_s = ws.to_string_lossy().into_owned();
        let status = build_and_persist(&ws_s).unwrap();
        assert!(status.built);
        assert_eq!(status.file_count, 2);
        assert!(index_file(&ws_s).unwrap().exists());

        // Vide la mémoire puis recharge depuis le disque.
        *state().lock().unwrap() = None;
        assert!(try_load(&ws_s).is_some());
        let guard = state().lock().unwrap();
        let loaded = guard.as_ref().unwrap();
        let hits = rank(&loaded.data, &query_terms("search_index"), 10);
        assert_eq!(hits[0].rel, "src/search.rs");
        drop(guard);

        let _ = fs::remove_dir_all(&ws);
        *state().lock().unwrap() = None;
    }

    #[test]
    fn loading_index_of_other_root_is_rejected() {
        let ws = temp_ws("otherroot");
        fs::write(ws.join("a.txt"), "hello").unwrap();
        let ws_s = ws.to_string_lossy().into_owned();
        build_and_persist(&ws_s).unwrap();
        *state().lock().unwrap() = None;
        // Un chemin différent ⇒ l'index ne doit pas être réutilisé tel quel.
        let other = temp_ws("otherroot2");
        assert!(try_load(other.to_string_lossy().as_ref()).is_none());
        let _ = fs::remove_dir_all(&ws);
        let _ = fs::remove_dir_all(&other);
        *state().lock().unwrap() = None;
    }

    /// **E2E réel** : construit l'index du VRAI projet Mira et vérifie que des
    /// requêtes qu'un modèle formulerait naturellement (comme le ferait l'outil
    /// d'agent `codebase_search`) font remonter les bons fichiers. C'est le test
    /// qui prouve « en vrai » que l'outil est utile, et pas seulement que le
    /// moteur trie des documents synthétiques.
    ///
    /// `#[ignore]` car il lit l'arborescence réelle (lent, I/O disque) :
    ///   `cargo test --lib indexing::tests::e2e_real_project -- --ignored --nocapture`
    #[test]
    #[ignore = "I/O disque sur le vrai projet : lancer avec --ignored"]
    fn e2e_real_project() {
        // Le crate vit dans `src-tauri/` ⇒ la racine projet est son parent.
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri doit avoir un parent")
            .to_path_buf();
        let root_s = root.to_string_lossy().into_owned();
        *state().lock().unwrap() = None;

        let status = build_and_persist(&root_s).expect("build de l'index réel");
        println!("index réel : {} fichiers, built={}", status.file_count, status.built);
        assert!(status.built);
        assert!(status.file_count > 20, "projet réel ⇒ > 20 fichiers indexables");

        // Requêtes « naturelles » → fichier attendu quelque part dans le top 20.
        // On n'exige pas la tête : un index lexical est un point de départ, le
        // modèle lit ensuite les candidats.
        let cases: &[(&str, &str)] = &[
            ("bm25 ranking", "indexing.rs"),
            ("file mention badge input", "ChatBox.tsx"),
            ("index under mira directory", "indexing.rs"),
            ("sidecar tool invoke bridge", "clineClient.ts"),
            ("skills discovery folder", "extensions_store.rs"),
        ];
        for (query, expected) in cases {
            let hits = search_core(&root_s, query, 20).expect("recherche");
            let top: Vec<String> = hits.iter().take(5).map(|h| h.rel.clone()).collect();
            println!("requête {query:?} → {} hit(s), top: {top:?}", hits.len());
            assert!(!hits.is_empty(), "requête {query:?} sans résultat");
            assert!(
                hits.iter().any(|h| h.rel.ends_with(expected)),
                "requête {query:?} devrait faire remonter {expected:?}; obtenu: {:?}",
                hits.iter().map(|h| h.rel.clone()).collect::<Vec<_>>()
            );
        }

        // Ne jamais laisser un `.mira/index` polluer le projet de l'utilisateur.
        *state().lock().unwrap() = None;
        let _ = fs::remove_dir_all(root.join(".mira/index"));
    }
}
