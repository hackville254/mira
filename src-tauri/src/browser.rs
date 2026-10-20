//! Mira — Contrôle de la webview embarquée par l'agent (« navigateur piloté »).
//!
//! RÔLE
//! ----
//! Parité Trae SOLO : l'agent doit pouvoir **naviguer**, **lire le DOM**, **lire le
//! texte visible**, **cliquer**, **saisir du texte** et **capturer l'écran** de la
//! prévisualisation web embarquée (`WebPreviewPane`), celle-là même que
//! l'utilisateur voit.
//!
//! POURQUOI CE MODULE (et pas seulement `embed_ide_panel`)
//! ------------------------------------------------------
//! `embed_ide_panel` (cf. `lib.rs`) crée une webview NATIVE pointant sur une URL
//! EXTERNE (le dev server local, ex. `http://localhost:5173`). Or, sur
//! macOS/WKWebView comme sur Windows/WebView2, une page externe ne dispose PAS de
//! `window.__TAURI__` : l'IPC d'invoke est injectée uniquement dans les pages
//! servies par Tauri. On ne peut donc PAS demander à la page distante de nous
//! renvoyer un résultat via `invoke`.
//!
//! LA SOLUTION : `Webview::eval_with_callback`
//! -------------------------------------------
//! Tauri 2.11 expose `eval_with_callback(js, cb)` : le JS est évalué DANS la
//! webview, la DERNIÈRE EXPRESSION est sérialisée en JSON et transmise au callback
//! Rust. C'est un canal de retour FOURNI PAR LE RUNTIME, qui ne dépend pas de
//! `__TAURI__` côté page — exactement ce qu'il faut ici.
//!
//! Chaque commande est donc un couple :
//!   1. `eval_with_callback` d'un petit script qui (a) exécute l'action demandée
//!      et (b) se termine par une expression JSON sérialisable (le résultat) ;
//!   2. réception du résultat dans le callback, relayé au front par un `oneshot`.
//!
//! SÉCURITÉ (adversarial)
//! ----------------------
//!   - **Allowlist de schémas** : seules `http`/`https` sont navigables. On refuse
//!     `file:`, `javascript:`, `data:`, `tauri:` — un agent (ou un prompt hostile)
//!     ne doit pas pouvoir lire le disque local via `file://` ni injecter du script
//!     via `javascript:`.
//!   - **Confirmation explicite hors-loopback** : la navigation vers un hôte non
//!     local exige une approbation utilisateur (déléguée au front, qui applique le
//!     même canal d'approbation que les outils d'écriture). Sur loopback
//!     (`localhost`/`127.0.0.1`/`::1`) on navigue directement — c'est le dev server.
//!   - **Bornage systématique** : toute chaîne renvoyée (DOM, texte) est plafonnée
//!     en taille, pour qu'une page ne sature pas la fenêtre de contexte du modèle.
//!   - **Aucun code arbitraire ne vient du front** : le JS injecté est construit
//!     ICI, à partir de valeurs passées en paramètre et échappées via `serde_json`.
//!     Le front ne transporte que des données (sélecteur, texte, coordonnées).
//!   - **Capture masquée par défaut** : on ne renvoie jamais cookies/localStorage
//!     ni attributs d'input — seulement ce que l'action demandée exige.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Plafond d'une chaîne renvoyée à l'agent (DOM/text) — borne la fenêtre de
/// contexte du modèle. Au-delà, on tronque et on le signale.
const MAX_TEXT_BYTES: usize = 60_000;

/// Délai maximal d'exécution d'un script dans la webview. Une page qui bloque le
/// thread JS (boucle infinie) ne doit pas figer l'agent indéfiniment.
const EVAL_TIMEOUT: Duration = Duration::from_secs(10);

/// Résultat d'une opération navigateur renvoyée à l'agent.
#[derive(Debug, Serialize, Clone)]
pub struct BrowserResult {
    pub ok:       bool,
    /// Charge utile textuelle (texte lu, DOM, message de statut).
    pub value:    String,
    /// URL courante de la webview au moment de la réponse (si connue).
    pub url:      Option<String>,
    /// `true` si `value` a été tronqué au plafond.
    pub truncated: bool,
}

impl BrowserResult {
    fn ok(value: impl Into<String>) -> Self {
        Self { ok: true, value: value.into(), url: None, truncated: false }
    }
    fn err(value: impl Into<String>) -> Self {
        Self { ok: false, value: value.into(), url: None, truncated: false }
    }
}

/// URL courante des webviews panel (partagée avec `lib.rs`).
///
/// On réutilise ce state pour connaître l'URL de la webview au moment de
/// l'action, SANS appeler `webview.url()` (qui panic dans wry quand la webview
/// n'a pas encore d'URL — cf. commentaire de `PanelUrlState` dans `lib.rs`).
use crate::PanelUrlState;

/// Trunque une chaîne au plafond d'octets, en respectant les frontières UTF-8.
fn truncate(s: String) -> (String, bool) {
    if s.len() <= MAX_TEXT_BYTES {
        return (s, false);
    }
    let mut end = MAX_TEXT_BYTES;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    (format!("{}\n… [truncated]", &s[..end]), true)
}

/// Vérifie qu'une URL est navigable : schéma `http`/`https` uniquement.
///
/// Refuse `file:` (lecture disque), `javascript:` (injection), `data:` (XSS
/// documenté), `tauri:`/`asset:` (accès aux ressources internes de l'app).
fn assert_navigable(url: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("invalid url: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        other => Err(format!("scheme not allowed: {other}")),
    }
}

/// `true` si l'hôte est en loopback (dev server local) — navigation sans
/// approbation. `localhost`, `127.0.0.0/8`, `::1`, `0.0.0.0`.
fn is_loopback(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(d)) => d == "localhost" || d.ends_with(".localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback() || ip.is_unspecified(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback() || ip.is_unspecified(),
        None => false,
    }
}

/// Évalue `js` dans la webview `panel_id` et attend le résultat JSON renvoyé par
/// `eval_with_callback`. Retourne `None` en cas de timeout (page bloquée).
///
/// POURQUOI `oneshot` + `spawn_blocking`
/// -------------------------------------
/// `eval_with_callback` est SYNCHRONE : il enregistre un callback (appelé plus
/// tard, sur le thread principal) et rend la main immédiatement. Pour transformer
/// cela en `await`, on crée un `oneshot` dont l'émetteur est déplacé dans le
/// callback, puis on l'attend avec un délai maximal. Le tout hors du thread
/// principal (d'où `spawn_blocking`), pour ne pas le bloquer.
async fn eval_json(app: AppHandle, panel_id: String, js: String) -> Result<serde_json::Value, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let tx = std::sync::Mutex::new(Some(tx));

    let handle = app
        .get_webview(&panel_id)
        .ok_or_else(|| format!("browser panel '{panel_id}' not found"))?;

    // `eval_with_callback` doit tourner sur le thread principal : on y dispatche
    // l'appel, le callback remplira le oneshot quand le JS aura rendu sa valeur.
    handle
        .eval_with_callback(js, move |result| {
            if let Ok(mut guard) = tx.lock() {
                if let Some(sender) = guard.take() {
                    let _ = sender.send(result);
                }
            }
        })
        .map_err(|e| format!("eval failed: {e}"))?;

    match tokio::time::timeout(EVAL_TIMEOUT, rx).await {
        Ok(Ok(raw)) => {
            // Le runtime Tauri sérialise le résultat en JSON. Une chaîne JS
            // "null" (script sans expression finale) est traitée comme vide.
            let parsed: serde_json::Value =
                serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null);
            Ok(parsed)
        }
        Ok(Err(_)) => Err("eval channel closed".to_string()),
        Err(_) => Err("eval timed out (page busy?)".to_string()),
    }
}

/// Échappe une valeur Rust en littéral JS sûr (via JSON).
fn js_literal<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "null".to_string())
}

/// Script utilitaire injecté EN TÊTE de chaque évaluation.
///
/// On y définit `__originResolve(selector)` : un résolveur robuste qui accepte
/// soit un sélecteur CSS, soit un « ref » textuel de la forme `text=Connexion`
/// (équivalent Playwright) — ce qui rend le clic/l'écriture bien plus fiables
/// pour un modèle qui raisonne sur du texte visible plutôt que sur du CSS.
const JS_PRELUDE: &str = r#"
(() => {
  const byText = (needle) => {
    const want = needle.trim().toLowerCase();
    if (!want) return null;
    const all = document.querySelectorAll('a,button,input,select,textarea,[role=button],[role=link],[role=tab],[onclick],label,summary,option,[contenteditable=true]');
    let best = null;
    for (const el of all) {
      const t = (el.innerText || el.value || el.textContent || '').trim().toLowerCase();
      if (t === want) return el;                 // correspondance exacte : priorité
      if (!best && t.includes(want)) best = el;   // sinon : premier conteneur
    }
    return best;
  };
  window.__originResolve = (spec) => {
    if (!spec) return null;
    if (typeof spec === 'string' && spec.startsWith('text=')) {
      return byText(spec.slice(5));
    }
    try { return document.querySelector(spec); } catch { return null; }
  };
})();
"#;

/// Prépare le JS complet : prélude + corps, où le corps doit se terminer par une
/// expression sérialisable (le résultat renvoyé au callback).
fn script(body: &str) -> String {
    format!("{JS_PRELUDE}\n{body}")
}

/// Lit l'URL courante depuis le state partagé (jamais `webview.url()`).
fn current_url(app: &AppHandle, panel_id: &str) -> Option<String> {
    app.try_state::<PanelUrlState>()
        .and_then(|s| s.0.lock().ok().and_then(|m| m.get(panel_id).cloned()))
}

/// `browser_navigate` : navigue la webview vers `url`.
///
/// `allow_external` est le verdict d'approbation calculé par le FRONT : le front
/// applique la politique (loopback direct, hors-loopback = confirmation
/// utilisateur) puis rappelle cette commande avec le verdict. Côté Rust on se
/// contente de vérifier le SCHÉMA (défense en profondeur) et d'exécuter — le
/// pilotage de la politique reste dans une seule couche (le front), pour éviter
/// deux sources de vérité divergentes.
#[tauri::command]
pub async fn browser_navigate(
    app: AppHandle,
    panel_id: String,
    url: String,
    allow_external: bool,
) -> Result<BrowserResult, String> {
    let parsed = assert_navigable(&url)?;
    if !is_loopback(&parsed) && !allow_external {
        return Ok(BrowserResult::err(
            "external navigation requires approval (allow_external=false)",
        ));
    }
    let handle = app
        .get_webview(&panel_id)
        .ok_or_else(|| format!("browser panel '{panel_id}' not found"))?;
    handle.navigate(parsed).map_err(|e| e.to_string())?;
    let mut r = BrowserResult::ok(format!("navigating to {url}"));
    r.url = Some(url);
    Ok(r)
}

/// `browser_reload` : recharge la page courante.
#[tauri::command]
pub async fn browser_reload(app: AppHandle, panel_id: String) -> Result<BrowserResult, String> {
    let handle = app
        .get_webview(&panel_id)
        .ok_or_else(|| format!("browser panel '{panel_id}' not found"))?;
    handle.reload().map_err(|e| e.to_string())?;
    Ok(BrowserResult::ok("reloaded"))
}

/// `browser_go` : navigue dans la pile d'historique NATIVE de la webview
/// (`history.back()` / `history.forward()`), sans recharger ni re-embarquer.
///
/// Parité navigateur : Back/Forward doivent restaurer l'état de la page
/// (scroll, bfcache) et non relancer une navigation. On passe par le script
/// plutôt que par les API Tauri (`webview.eval`) pour rester dans le même canal
/// fiable que le reste du module et pouvoir renvoyer l'URL réellement atteinte.
#[tauri::command]
pub async fn browser_go(
    app: AppHandle,
    panel_id: String,
    direction: String,
) -> Result<BrowserResult, String> {
    let delta = match direction.as_str() {
        "back" => -1,
        "forward" => 1,
        _ => return Ok(BrowserResult::err("direction must be 'back' or 'forward'")),
    };
    let js = script(&format!(
        r#"(() => {{
  try {{ history.go({delta}); }} catch (e) {{ return JSON.stringify({{ ok: false, error: String(e) }}); }}
  return JSON.stringify({{ ok: true }});
}})()"#,
    ));
    let value = eval_json(app.clone(), panel_id.clone(), js).await?;
    let mut r = BrowserResult::ok("history moved");
    r.url = current_url(&app, &panel_id);
    if let Some(s) = value.as_str() {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(s) {
            if parsed.get("ok").and_then(|v| v.as_bool()) == Some(false) {
                return Ok(BrowserResult::err("history navigation failed"));
            }
        }
    }
    Ok(r)
}

/// `browser_status` : renvoie URL + titre + état de chargement. Sert de sonde
/// « la page est-elle prête ? » pour l'agent.
#[tauri::command]
pub async fn browser_status(
    app: AppHandle,
    panel_id: String,
) -> Result<BrowserResult, String> {
    let js = script(
        r#"(() => {
  return JSON.stringify({
    title: document.title || '',
    url: location.href,
    readyState: document.readyState,
    canBack: (window.history && history.length > 1) ? true : false,
    viewport: { w: innerWidth, h: innerHeight }
  });
})()"#,
    );
    let value = eval_json(app.clone(), panel_id.clone(), js).await?;
    let mut r = BrowserResult::ok(value.as_str().unwrap_or("{}").to_string());
    r.url = current_url(&app, &panel_id);
    Ok(r)
}

/// `browser_read_text` : renvoie le texte VISIBLE de la page (ou d'un sélecteur).
///
/// On n'utilise pas `innerText` de `body` brut (qui inclut scripts/styles) :
/// `innerText` respecte déjà la mise en page et exclut le non-affiché. On
/// normalise les espaces et on plafonne côté Rust.
#[tauri::command]
pub async fn browser_read_text(
    app: AppHandle,
    panel_id: String,
    selector: Option<String>,
) -> Result<BrowserResult, String> {
    let sel = js_literal(&selector);
    let js = script(&format!(
        r#"(() => {{
  const spec = {sel};
  const el = spec ? window.__originResolve(spec) : document.body;
  if (!el) return JSON.stringify({{ error: 'element not found' }});
  const text = (el.innerText || el.textContent || '').replace(/[ \t]+\n/g, '\n').trim();
  return JSON.stringify({{ text }});
}})()"#
    ));
    let value = eval_json(app.clone(), panel_id.clone(), js).await?;
    let text = value
        .get("text")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            value
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("no text")
                .to_string()
        })?
        .to_string();
    let (text, truncated) = truncate(text);
    let mut r = BrowserResult::ok(text);
    r.url = current_url(&app, &panel_id);
    r.truncated = truncated;
    Ok(r)
}

/// `browser_read_dom` : renvoie le HTML d'un élément (ou `body`), plafonné.
#[tauri::command]
pub async fn browser_read_dom(
    app: AppHandle,
    panel_id: String,
    selector: Option<String>,
) -> Result<BrowserResult, String> {
    let sel = js_literal(&selector);
    let js = script(&format!(
        r#"(() => {{
  const spec = {sel};
  const el = spec ? window.__originResolve(spec) : document.body;
  if (!el) return JSON.stringify({{ error: 'element not found' }});
  return JSON.stringify({{ html: el.outerHTML || '' }});
}})()"#
    ));
    let value = eval_json(app.clone(), panel_id.clone(), js).await?;
    let html = value
        .get("html")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "no html".to_string())?
        .to_string();
    let (html, truncated) = truncate(html);
    let mut r = BrowserResult::ok(html);
    r.url = current_url(&app, &panel_id);
    r.truncated = truncated;
    Ok(r)
}

/// `browser_query` : inventaire STRUCTURÉ des éléments interactifs visibles.
///
/// C'est le « map » à la `tauri-connector` : l'agent obtient d'un coup les
/// champs, boutons et liens avec un identifiant stable (`ref`) qu'il peut
/// réutiliser pour cliquer/écrire sans deviner de sélecteur CSS.
#[tauri::command]
pub async fn browser_query(
    app: AppHandle,
    panel_id: String,
) -> Result<BrowserResult, String> {
    let js = script(
        r#"(() => {
  const out = [];
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  let i = 0;
  for (const el of document.querySelectorAll('a,button,input,select,textarea,[role=button],[role=link],[role=tab],[contenteditable=true]')) {
    if (!visible(el)) continue;
    const tag = el.tagName.toLowerCase();
    const ref = `e${i++}`;
    el.setAttribute('data-origin-ref', ref);
    out.push({
      ref,
      tag,
      type: el.getAttribute('type') || null,
      name: el.getAttribute('name') || null,
      text: (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 120),
      href: tag === 'a' ? (el.getAttribute('href') || null) : null
    });
    if (out.length >= 150) break; // borne : page très dense
  }
  return JSON.stringify({ elements: out, url: location.href, title: document.title });
})()"#,
    );
    let value = eval_json(app.clone(), panel_id.clone(), js).await?;
    let mut r = BrowserResult::ok(serde_json::to_string(&value).unwrap_or_default());
    r.url = current_url(&app, &panel_id);
    Ok(r)
}

/// `browser_click` : clique un élément résolu par `selector` (CSS ou `text=…`)
/// ou par `ref` (issu de `browser_query`).
#[tauri::command]
pub async fn browser_click(
    app: AppHandle,
    panel_id: String,
    selector: Option<String>,
    ref_id: Option<String>,
) -> Result<BrowserResult, String> {
    let sel = js_literal(&selector);
    let rf = js_literal(&ref_id);
    let js = script(&format!(
        r#"(() => {{
  const spec = {sel};
  const ref = {rf};
  let el = ref ? document.querySelector('[data-origin-ref="' + ref + '"]') : window.__originResolve(spec);
  if (!el) return JSON.stringify({{ error: 'element not found' }});
  el.scrollIntoView({{ block: 'center', inline: 'center' }});
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const opts = {{ bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window }};
  el.dispatchEvent(new PointerEvent('pointerdown', opts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new PointerEvent('pointerup', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.dispatchEvent(new MouseEvent('click', opts));
  if (typeof el.click === 'function') el.click();
  return JSON.stringify({{ clicked: true, tag: el.tagName.toLowerCase(), url: location.href }});
}})()"#
    ));
    let value = eval_json(app.clone(), panel_id.clone(), js).await?;
    if value.get("error").is_some() {
        return Ok(BrowserResult::err("element not found"));
    }
    let mut r = BrowserResult::ok(format!(
        "clicked <{}>",
        value.get("tag").and_then(|v| v.as_str()).unwrap_or("?")
    ));
    r.url = current_url(&app, &panel_id);
    Ok(r)
}

/// `browser_type` : saisit `text` dans un champ résolu par `selector`/`ref`.
///
/// On applique un setter natif (via le prototype) pour que les frameworks
/// réactifs (React/Vue) voient la mutation : écrire directement `.value` ne
/// déclenche pas leurs écouteurs (`onChange`).
#[tauri::command]
pub async fn browser_type(
    app: AppHandle,
    panel_id: String,
    text: String,
    selector: Option<String>,
    ref_id: Option<String>,
) -> Result<BrowserResult, String> {
    let sel = js_literal(&selector);
    let rf = js_literal(&ref_id);
    let txt = js_literal(&text);
    let js = script(&format!(
        r#"(() => {{
  const spec = {sel};
  const ref = {rf};
  const value = {txt};
  const el = ref ? document.querySelector('[data-origin-ref="' + ref + '"]') : window.__originResolve(spec);
  if (!el) return JSON.stringify({{ error: 'element not found' }});
  el.focus();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value');
  if (setter && setter.set) setter.set.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', {{ bubbles: true }}));
  el.dispatchEvent(new Event('change', {{ bubbles: true }}));
  return JSON.stringify({{ typed: true, length: value.length }});
}})()"#
    ));
    let value = eval_json(app.clone(), panel_id.clone(), js).await?;
    if value.get("error").is_some() {
        return Ok(BrowserResult::err("element not found"));
    }
    let mut r = BrowserResult::ok(format!("typed {} chars", text.chars().count()));
    r.url = current_url(&app, &panel_id);
    Ok(r)
}

/// `browser_screenshot` : capture la page et renvoie un data-URL PNG.
///
/// POURQUOI LA CAPTURE VIT DANS LA PAGE
/// -----------------------------------
/// Tauri n'expose AUCUNE API portable de capture d'une webview enfant (ni côté
/// JS `@tauri-apps/api`, ni côté Rust : `Webview::capture` n'existe pas). Une
/// capture native exigerait, sur macOS, de descendre au `WKWebView` via FFI —
/// coût de maintenance disproportionné et build fragile.
///
/// On rasterise donc la page DEPUIS ELLE-MÊME : le script ci-dessous sérialise
/// `document.documentElement` dans un `<foreignObject>` SVG, le dessine dans un
/// `<canvas>`, et renvoie `canvas.toDataURL('image/png')`. Tout s'exécute dans
/// la webview cible via `eval_with_callback` — le même canal que les autres
/// commandes, sans dépendance supplémentaire.
///
/// LIMITE ASSUMÉE : les ressources cross-origin (images distantes) peuvent
/// « teinter » le canvas et faire échouer `toDataURL`. On le signale alors
/// explicitement (jamais un succès trompeur).
#[tauri::command]
pub async fn browser_screenshot(
    app: AppHandle,
    panel_id: String,
) -> Result<BrowserResult, String> {
    if app.get_webview(&panel_id).is_none() {
        return Ok(BrowserResult::err(format!(
            "browser panel '{panel_id}' not found"
        )));
    }

    let js = script(
        r#"(() => {
  try {
    const doc = document.documentElement;
    const w = doc.scrollWidth || window.innerWidth;
    const h = doc.scrollHeight || window.innerHeight;
    // Sérialise la page courante (styles inline compris) dans un SVG.
    const clone = doc.cloneNode(true);
    // Neutralise les scripts dans le clone (ils ne s'exécuteront pas de toute
    // façon dans foreignObject, mais on évite tout contenu actif).
    clone.querySelectorAll('script').forEach(s => s.remove());
    const serialized = new XMLSerializer().serializeToString(clone);
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">' +
      '<foreignObject width="100%" height="100%">' +
      '<div xmlns="http://www.w3.org/1999/xhtml" style="width:' + w + 'px;height:' + h + 'px;">' +
      serialized.replace(/<html[^>]*>|<\/html>|<body[^>]*>|<\/body>/gi, '') +
      '</div></foreignObject></svg>';
    const img = new Image();
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    // Passe 1 : production du data-URL (asynchrone via onload).
    return new Promise((resolve) => {
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0);
          resolve(c.toDataURL('image/png'));
        } catch (e) {
          resolve({ error: 'canvas tainted: ' + String(e) });
        }
      };
      img.onerror = () => resolve({ error: 'svg rasterization failed' });
      img.src = url;
    });
  } catch (e) {
    return { error: String(e) };
  }
})()"#,
    );

    let value = eval_json(app.clone(), panel_id.clone(), js).await?;
    // Le script peut renvoyer une chaîne (data-URL) OU un objet { error }.
    let (payload, is_error) = match value {
        serde_json::Value::String(s) => (s, false),
        serde_json::Value::Object(ref o) => {
            let msg = o
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("screenshot failed")
                .to_string();
            (msg, true)
        }
        serde_json::Value::Null => ("screenshot returned no data".to_string(), true),
        other => (other.to_string(), true),
    };

    let mut r = if is_error {
        BrowserResult::err(payload)
    } else {
        BrowserResult::ok(payload)
    };
    r.url = current_url(&app, &panel_id);
    Ok(r)
}

/// `browser_press_key` : presse une touche clavier dans la page (Entrée, Tab…).
///
/// Utile pour valider un formulaire sans cliquer sur un bouton précis.
#[tauri::command]
pub async fn browser_press_key(
    app: AppHandle,
    panel_id: String,
    key: String,
) -> Result<BrowserResult, String> {
    let k = js_literal(&key);
    let js = script(&format!(
        r#"(() => {{
  const key = {k};
  const target = document.activeElement || document.body;
  const opts = {{ key, bubbles: true, cancelable: true }};
  target.dispatchEvent(new KeyboardEvent('keydown', opts));
  target.dispatchEvent(new KeyboardEvent('keypress', opts));
  target.dispatchEvent(new KeyboardEvent('keyup', opts));
  return JSON.stringify({{ pressed: key }});
}})()"#
    ));
    let value = eval_json(app.clone(), panel_id.clone(), js).await?;
    let mut r = BrowserResult::ok(format!(
        "pressed {key}",
    ));
    r.url = current_url(&app, &panel_id);
    let _ = value;
    Ok(r)
}

/// State partagé pour suivre les webviews connues comme « panel navigateur ».
///
/// On ne peut pas énumérer de façon fiable les webviews « navigateur » côté
/// Rust ; le front déclare celle qu'il expose à l'agent via `browser_register`.
#[derive(Default)]
pub struct BrowserState(pub Mutex<HashMap<String, bool>>);

/// `browser_register` : marque une webview panel comme pilotable par l'agent.
#[tauri::command]
pub async fn browser_register(
    state: tauri::State<'_, BrowserState>,
    panel_id: String,
) -> Result<(), String> {
    let mut map = state.0.lock().map_err(|e| e.to_string())?;
    map.insert(panel_id, true);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigable_allows_http_and_https_only() {
        assert!(assert_navigable("http://localhost:5173").is_ok());
        assert!(assert_navigable("https://example.com").is_ok());
        assert!(assert_navigable("file:///etc/passwd").is_err());
        assert!(assert_navigable("javascript:alert(1)").is_err());
        assert!(assert_navigable("data:text/html,<script>1</script>").is_err());
        assert!(assert_navigable("tauri://localhost").is_err());
    }

    #[test]
    fn loopback_detection_is_conservative() {
        assert!(is_loopback(&url::Url::parse("http://localhost:3000").unwrap()));
        assert!(is_loopback(&url::Url::parse("http://127.0.0.1:8080").unwrap()));
        assert!(is_loopback(&url::Url::parse("http://app.localhost").unwrap()));
        assert!(is_loopback(&url::Url::parse("http://[::1]:3000").unwrap()));
        assert!(!is_loopback(&url::Url::parse("https://example.com").unwrap()));
        assert!(!is_loopback(&url::Url::parse("http://192.168.1.10").unwrap()));
    }

    #[test]
    fn truncate_respects_utf8_boundaries() {
        let s = "é".repeat(MAX_TEXT_BYTES); // 2 octets par 'é'
        let (out, truncated) = truncate(s);
        assert!(truncated);
        assert!(out.len() <= MAX_TEXT_BYTES + 32);
        // Aucune panique de frontière UTF-8 : `truncate` a coupé proprement.
        assert!(out.starts_with('é'));
    }

    #[test]
    fn truncate_leaves_small_strings_intact() {
        let (out, truncated) = truncate("hello".to_string());
        assert_eq!(out, "hello");
        assert!(!truncated);
    }

    #[test]
    fn script_includes_prelude_and_resolver() {
        let s = script("return 1;");
        assert!(s.contains("__originResolve"));
        assert!(s.trim_end().ends_with("return 1;"));
    }

    #[test]
    fn js_literal_escapes_quotes() {
        // Un sélecteur hostile ne doit pas pouvoir casser le littéral JS.
        let lit = js_literal(&"a\"; alert(1); \"");
        assert_eq!(lit, "\"a\\\"; alert(1); \\\"\"");
    }
}
