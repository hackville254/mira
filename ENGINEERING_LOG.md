# ENGINEERING LOG — Mira

> Journal technique chronologique (la plus récente entrée en haut).
> Format : `[ISO-DATE-HEURE] | [Titre]` → Contexte / Modifications / Décisions / Impacts / Prochaines étapes.

---

### [2026-10-29T18:10] | Windows Store : paquet MSIX correct + workflow CI dédié

- **Contexte :** le premier jet de `build-msix.ps1` empaquetait l'installeur NSIS
  (`MiraSetup.exe`) alors que `AppxManifest.xml` déclarait
  `Application/@Executable="Mira.exe"`. Un MSIX n'est **pas** un conteneur
  d'installeur : c'est un paquet contenant l'application elle-même. Le paquet
  aurait donc été rejeté en certification (et n'aurait pas démarré). Les
  identifiants Partner Center (produit « Application MSIX ou PWA ») sont
  désormais renseignés dans le manifeste.
- **Modifications effectuées :**
  - `src-tauri/msix/build-msix.ps1` : packager `target/release/mira.exe` +
    les ressources déclarées dans `bundle.resources` (lues depuis
    `tauri.conf.json`, aucune liste dupliquée). Ajout d'un garde-fou :
    `Application/@Executable` (parsé en XML) doit exister dans le paquet,
    sinon échec explicite.
  - `src-tauri/msix/AppxManifest.xml` : `Executable="mira.exe"` (nom réel du
    binaire Cargo), `Identity`/`Publisher`/`PublisherDisplayName` = valeurs
    Partner Center (`MiraCoder.MiraCoder`).
  - `package.json` : `build:msstore` → `tauri build --no-bundle` (on ne veut
    ni NSIS ni artefacts updater, seulement le binaire + ressources).
  - `src-tauri/tauri.microsoftstore.conf.json` : `createUpdaterArtifacts:false`
    (le Store gère les MAJ ; évite un échec de signature minisign en CI).
  - Nouveau `.github/workflows/windows-msix.yml` : build sur `windows-latest`,
    packaging MSIX, **vérification du contenu du paquet** (zip : manifeste,
    `mira.exe`, assets), upload de l'artefact.
  - **Emplacement corrigé** : les workflows étaient dans `origin/.github/`,
    un dossier **hors de tout dépôt git** (le repo est `mira`, remote
    `hackville254/mira`) → ils n'ont jamais été exécutés par GitHub. Déplacés
    dans `mira/.github/workflows/` et chemins réécrits pour une racine = `mira`
    (plus de préfixe `mira/`, plus de `working-directory: mira`).
  - **Endpoint updater corrigé** dans `tauri.conf.json` :
    `Origin-AI-IDE/origin` → `hackville254/mira` (l'ancienne URL renvoyait un
    404, les mises à jour n'auraient jamais fonctionné).
- **Décisions techniques :**
  - Voie MSIX (et non « EXE/MSI » recommandée par Tauri) car c'est la **seule**
    voie gratuite où Microsoft signe le paquet → plus d'avertissement
    SmartScreen. La voie EXE/MSI exige un certificat de signature de code payant.
  - `--no-bundle` : le config MSIX du Store (offline WebView2, perMachine)
    ne concerne que la voie NSIS abandonnée ; inutile de la payer en temps de
    build et en artefacts.
  - Garde-fou + vérification CI : ce bug est silencieux en local (Windows
    uniquement) et coûte des cycles de certification (1-3 jours ouvrés).
- **Impacts :** le canal Windows ne dépend plus de l'updater Tauri (feature
  `msstore` déjà en place). Les versions MSIX sont dérivées de
  `Cargo.toml` → **doivent être incrémentées** à chaque soumission.
- **Prochaines étapes :**
  1. lancer le workflow, télécharger `windows-msix`, soumettre dans Partner
     Center (justification requise pour `runFullTrust`) ;
  2. **`latest.json` manquant** : `tauri build` NE génère PAS ce manifeste
     d'updater (c'est `tauri-action` qui le fait). Tant qu'il n'est pas publié
     dans la release `latest`, l'auto-update macOS/Linux reste silencieusement
     inopérant — à implémenter (génération du JSON à partir des `.sig`) ;
  3. valider une première installation MSIX sur un PC Windows via `-SelfSign`.

### [2026-10-29T14:30] | Distribution macOS : signature auto-signée (gratuite) + DMG signé

- **Contexte :** distribution publique sans budget Apple Developer (99 $/an).
  Le build adhoc précédent produisait une signature instable/identifiable.
- **Modifications effectuées :**
  - Nouveau [scripts/macos-sign.sh](scripts/macos-sign.sh) :
    génère un certificat self-signed **"Mira Developer"** (RSA-4096, 10 ans,
    **EKU Code Signing obligatoire** — sans lui `find-identity -p codesigning`
    renvoie 0 identités), l'importe dans le keychain login via PKCS#12
    `-legacy` (OpenSSL 3.6 `security` MAC incompat.), le marque `trustRoot`/
    `codeSign`, puis signe le `.app` (hardened runtime + entitlements).
  - Option `MIRA_BUILD_DMG=1` : régénère le DMG **après** signature
    (`hdiutil`) + empreinte SHA-512 base64 (format updater Tauri).
- **Décisions techniques :**
  - Le bundler Tauri `--bundles dmg` **recrée** l'app en adhoc et supprime
    même le `.app` précédent → le DMG doit impérativement être construit
    après la signature, jamais via le bundler ensuite.
  - Certificat signé avec timestamp + hardened runtime : durable et à jour.
- **Impacts :** `.dmg` produits dans `src-tauri/target/release/bundle/dmg/`
  porte maintenant `Authority=Mira Developer` (vérifié après montage).
  Gatekeeper reste `rejected` (normal sans notarisation Apple) : les
  utilisateurs font Clic droit ▸ Ouvrir au 1er lancement.
- **Prochaines étapes :** brancher ce script en CI (macos runner) si l'on
  abandonne l'ad-hoc dans release.yml ; évaluer l'App Store pour notarisation gratuite.

### [2026-10-28T18:30] | Navigateur intégré : fin des échecs `browser command timed out` + bouton Stop qui disparaît

- **Contexte :** deux bugs signalés sur l'agent utilisant le navigateur intégré :
  1. les outils `browser_*` (surtout `browser_navigate`) échouaient avec
     `Error: {"error":"browser command timed out"}` — message opaque ne
     correspondant à aucun délai réel côté Rust ;
  2. dès que le navigateur était lancé, **l'icône Stop** du panneau agent
     **disparaissait**.

- **Analyse (cause racine de #2) :** la webview native est créée via
  `add_child` (Tauri 2) : elle est peinte **au-dessus de tout le HTML**, sans
  rapport avec le `z-index` CSS. Sa géométrie est pilotée par
  `resize_ide_panel`, elle-même déclenchée par un `ResizeObserver` qui
  n'observait que `outerWrapperRef` ([WebPreviewPane.tsx](file:///Users/user/code/orvyx-desktop/origin/mira/src/components/editor/WebPreviewPane.tsx)).
  Un `ResizeObserver` ne réagit qu'aux changements **de taille** : aucune
  détection des **translations** ni des variations de taille d'un **ancêtre**.
  Quand `AiPanel` s'élargit (drag du séparateur) ou que `TaskProgressBar`
  apparaît, le panneau central se décale sans que la webview soit re-mesurée :
  elle reste à ses anciennes coordonnées et **recouvre** le bouton Stop (qui vit
  dans `AiPanel`, piloté par `isStreaming`).

- **Analyse (cause racine de #1) :** le bus `tool_invoke` (sidecar Node) attend un
  `tool_invoke_response` avec un timeout de 30 s ; en son absence l'outil échoue
  avec ce message trompeur. Deux fuites possibles : (a) un échec **précoce** dans
  `respondToInvoke` (allowlist, résolution d'onglet) pouvait ne pas être
  acquitté ; (b) le `reply` d'échec du `catch` pouvait lui-même lever.

- **Modifications effectuées :**
  - `src/components/editor/WebPreviewPane.tsx` : l'effet de resynchronisation
    observe désormais **toute la chaîne d'ancêtres** (jusqu'au `body`) via un
    `ResizeObserver`, **plus** un `MutationObserver` sur les attributs
    `style`/`class` des ancêtres (capte les translations pures). Les deux
    notifient un `scheduleSync` coalescé par `requestAnimationFrame` → une seule
    mesure par frame, pas de spam d'`invoke` pendant un drag.
  - `src/lib/agent/clineClient.ts` : le `catch` de `respondToInvoke` isole son
    `reply` d'échec (try/catch interne) pour garantir qu'**aucune exception ne
    remonte** hors du handler (défense en profondeur sur la garantie de réponse).
  - `src-tauri/cline-sidecar/src/index.ts` (session précédente, confirmé) :
    `withTimeout` prend un `timeoutMs` explicite ; `INVOKE_TIMEOUT_MS = 30_000`
    appliqué aux deux `invoke` (browser + origin) ; les chemins d'approbation
    conservent 120 s ; constante morte supprimée.

- **Décisions techniques :** observer les ancêtres plutôt que de recalculer en
  boucle (polling) — on reste événementiel et déterministe ; le `MutationObserver`
  est filtré sur `style`/`class` (attributs susceptibles de porter une
  translation) et **ne** surveille **pas** les enfants, pour un coût négligeable.
  On ne touche à rien d'autre dans la logique du navigateur.

- **Impacts & Dépendances :** aucun changement d'API ni de contrat d'outil. Le
  comportement visuel (webview bornée au conteneur, onglets inactifs hors écran)
  est inchangé ; seule la réactivité géométrique s'améliore. Cas encore non
  couvert : si l'écouteur `cline://event` est détaché (`dispose`) **pendant**
  qu'un `tool_invoke` est en vol, la réponse peut manquer — non reproduit, laissé
  tel quel pour ne pas élargir le périmètre.

- **Prochaines étapes :** valider en local (lancement du navigateur depuis
  l'agent → plus de timeout ; ouvrir/redimensionner le panneau agent → le bouton
  Stop reste cliquable). Surveillance : si le timeout réapparaît, vérifier
  l'ordre `abort()`/`dispose()` côté `AiPanel`.

---

### [2026-10-28T12:00] | Distribution multi-OS à coût nul : macOS ad-hoc, Windows via Microsoft Store, Linux AppImage/deb/rpm

- **Contexte :** besoin de distribuer Mira sur macOS, Windows et Linux **sans
  payer** de certificat OV/EV (Windows, ~70–300 $/an) ni de compte Apple
  Developer (99 $/an), tout en supprimant au maximum les avertissements à
  l'installation, et en gardant des mises à jour fonctionnelles.

- **Contrainte de fond (mesurée, pas supposée) :** aucune signature GRATUITE
  n'est « de confiance » pour SmartScreen/Gatekeeper (les CA facturent la
  vérification d'identité). Conséquences retenues :
  - **Windows** : un certificat auto-signé **n'enlève pas** SmartScreen et
    obligerait l'utilisateur à installer la racine à la main (pire UX). → Seule
    voie propre et gratuite = **Microsoft Store (MSIX)** : Microsoft signe le
    paquet, l'utilisateur ne voit AUCUN avertissement. Décision : le Store est
    le canal Windows officiel.
  - **macOS** : signature **ad-hoc** (`APPLE_SIGNING_IDENTITY="-"`, gratuite) +
    retrait de la quarantaine côté utilisateur ⇒ plus d'erreur « app
    endommagée ». Reste « développeur non identifié » au 1er clic, contournable
    (Clic droit ▸ Ouvrir). Acceptable, documenté.
  - **Linux** : aucune signature requise ; distribution directe.

- **Modifications effectuées :**
  - `src-tauri/tauri.conf.json` : `bundle.targets` += `appimage, deb, rpm`
    (Linux absent auparavant) ; ajout du bloc `bundle.macOS` (entitlements +
    `minimumSystemVersion 10.15`) ; bloc `bundle.linux.deb`.
  - `src-tauri/entitlements.plist` (nouveau) : entitlements macOS minimaux
    (JIT WebView, mémoire exécutable non signée pour sidecar/LSP, réseau sortant,
    fichiers). Volontairement **non sandboxé** (IDE : écrit partout, lance des
    process) et **sans** `allow-unsigned-executable-memory=true` inutile.
  - `src-tauri/tauri.microsoftstore.conf.json` (nouveau) : override de build
    Store — NSIS `perMachine` + `webviewInstallMode: offlineInstaller`
    (exigé par le Store pour un installateur hors-ligne).
  - `src-tauri/msix/AppxManifest.xml` (nouveau) : manifeste MSIX
    (FullTrust + internetClient, target 17763). `Identity/Name` et
    `Publisher` = placeholders à remplir depuis le Partner Center.
  - `src-tauri/msix/build-msix.ps1` (nouveau) : empaquette l'installeur NSIS +
    assets icônes (dérivation auto des 7 visuels Store via System.Drawing),
    substitution de version semver → quadripartite, appel à `MakeAppx`,
    option `-SelfSign` (PFX de test) pour installation locale.
  - `src-tauri/src/distribution.rs` (nouveau) : source de vérité du canal
    (feature Cargo `msstore`) + commande `distribution_channel`.
  - `src-tauri/Cargo.toml` : features `default` / `msstore`.
  - `src-tauri/src/lib.rs` : l'updater Tauri est monté **uniquement** hors
    `msstore` ; enregistrement de `distribution_channel`.
  - `src/lib/distribution.ts` (nouveau) + `AboutSection.tsx` + `App.tsx` :
    le front **n'appelle jamais** l'updater sur le Store (il n'y est pas
    enregistré) ; l'écran Réglages › À propos affiche « géré par le Microsoft
    Store » à la place du bouton.
  - `package.json` : script `build:msstore`.
  - `.github/workflows/release.yml` (nouveau) : CI macOS (universel, ad-hoc) +
    Linux, avec signature minisign des artefacts de MAJ et release GitHub.

- **Décisions techniques :**
  - Choix **compile-time** (feature Cargo) pour le canal, pas runtime : le
    binaire Store n'embarque même pas le code updater ⇒ impossible de se tromper,
    et respect strict de la politique Store (deux updaters concurrents
    corrompraient le paquet géré par Windows).
  - La signature des mises à jour (minisign, `tauri-plugin-updater`) est
    **indépendante** des signatures OS et **gratuite** : elle reste active sur
    macOS ad-hoc et Linux. Le Store, lui, gère ses propres MAJ.
  - MSIX plutôt que NSIS signé pour Windows : c'est la seule option gratuite
    qui supprime réellement l'avertissement SmartScreen.

- **Impacts & dépendances :**
  - Nouveau contrat IPC `distribution_channel` (ajout, non breaking).
  - Le build Windows **Store** doit utiliser `npm run build:msstore` (features +
    config dédiée) puis `msix/build-msix.ps1`. Le build Windows hors Store
    (`nsis`/`msi`) reste non signé (SmartScreen visible).
  - CI : nécessite les secrets `TAURI_SIGNING_PRIVATE_KEY` (+
    `_PASSWORD`). Le fichier `latest.json` de l'updater devra être publié en
    asset de release « latest ».

- **Prochaines étapes :**
  1. Réserver le nom de l'app dans le Partner Center et renseigner
     `Identity/Name` + `Identity/Publisher` dans `AppxManifest.xml`.
  2. Créer le certificat auto-signé de test (PFX) pour valider le MSIX en local
     avant soumission.
  3. Vérifier la génération de `latest.json` au premier build macOS/Linux et le
     publier.
  4. À terme (optionnel) : notarisation macOS via compte Apple Developer, et
     éventuelle signature OV Windows si distribution hors Store.

---

### [2026-10-26T04:10] | Clé Orvyx : le coffre restait vide (secret non re-livrable) → rééquipement par rotation

- **Contexte :** « la génération ne marche pas » + bouton « Open Mira » inerte.
  En dev la génération n'était sauvée que par le repli `.env` ; en release, plus
  aucune clé. Investigation sur la zone signalée par l'utilisateur (chiffrement
  de la clé).
- **Diagnostic (mesuré) :**
  - **Aucun `secrets.vault` n'existait sur la machine** (`find` exhaustif), alors
    que `set_secret` est bien appelé à l'approbation.
  - Cause racine côté serveur : le secret Orvyx n'est livrable **qu'à la
    création** de la clé. Si la clé existe déjà, `ensure_key_for_user` renvoie
    `(link, None)` → `key_secret: null` dans le poll → `if let Some(secret)`
    côté desktop est faux → **`set_secret` jamais appelé** → coffre jamais créé.
    Un poste dont le coffre est vide (réinstall, profil neuf, coffre illisible)
    ne pouvait donc **jamais** récupérer sa clé.
  - Bug secondaire : `machine_secret()` acceptait `HOSTNAME` **vide**
    (`std::env::var` → `Ok("")`), donc `host=` vide entrait dans la clé HKDF →
    clé variable selon le shell → coffre indéchiffrable → vidé silencieusement
    (`unwrap_or_default`).
- **Modifications effectuées :**
  - `keychain.rs` : `machine_secret()` ignore toute valeur blanche (fallback
    `hostname()`), `hostname()` ne renvoie jamais vide ; `load_vault()` préserve
    un coffre illisible sous `.bak` au lieu de le détruire ; ajout de
    `vault_has_secret()` (test **du coffre seul**, sans repli `.env`) ;
    log de diagnostic du chemin de persistance ; 2 tests de régression.
  - `cloud.rs` : le poll envoie `force_reprovision = !vault_has_secret(...)`.
    Si le poste n'a **aucune copie persistée**, le serveur tourne la clé et en
    livre une neuve. Erreur de persistance enrichie (compte + cause).
  - (backend) `DevicePollRequest.force_reprovision` + `device.py` révoque la clé
    avant `ensure_key_for_user` quand le flag est posé.
- **Décisions techniques :** tester le **coffre**, pas `get_secret()`, car ce
  dernier inclut le repli `.env` de dev — un biais qui aurait masqué le bug en
  local et laissé le coffre vide en production. La rotation est **idempotente**
  et ne se déclenche que sur absence locale, ce qui respecte la consigne
  « ne pas créer une clé à chaque connexion ».
- **Impacts & dépendances :** contrat IPC `POST /device/poll` enrichi d'un champ
  optionnel (rétrocompatible). Le secret reste livré **hors navigateur** (le
  `device_code` ne quitte pas Rust) : aucun secret exposé au front.
- **Prochaines étapes :** tester le rééquipement en réel (coffre supprimé →
  reconnexion → génération). Surveiller le taux de rotation anormal.

---


### [2026-10-26T02:50] | macOS dev : cause racine unique = absence de bundle `.app`

- **Contexte :** après connexion, (1) le bouton « Open Mira » du portail ne fait
  rien et (2) la fenêtre ne revient pas au premier plan. Mon correctif précédent
  (inclure macOS dans `register_all`) a échoué : log runtime
  `register_all failed: unsupported platform`.
- **Diagnostic (mesuré, pas supposé) :**
  - Le plugin `tauri-plugin-deep-link` **ne supporte PAS l'enregistrement à
    chaud sur macOS** (`Error::UnsupportedPlatform`, documenté dans la source
    du crate) : le schéma vient uniquement de l'`Info.plist` du `.app`.
  - Instrumentation `[FOCUS-DIAG]` (temporaire) dans `window_focus.rs` : on est
    bien sur le main thread, mais `isActive=false` **avant ET après**
    `activateIgnoringOtherApps(true)`, `policy` restant `Regular(0)`.
  - `file target/debug/mira` → `Mach-O 64-bit executable arm64` (binaire **nu**),
    aucun `.app` généré.
  - `bundle.targets` ne contenait que `["nsis","msi"]` (Windows) : même un
    `tauri build` ne produisait pas d'`.app` macOS.
- **Cause racine UNIQUE :** macOS ne confie le premier plan NI l'association d'un
  schéma URL à un **exécutable nu**. Il exige une application **bundle**, connue
  de LaunchServices. Les deux symptômes viennent de là — pas du code.
- **Modifications effectuées :**
  - `src-tauri/src/lib.rs` : `register_all` **retiré de macOS** (limite du
    plugin) ; commentaire expliquant la conséquence assumée (le parcours de
    connexion ne doit jamais dépendre du deep link sur macOS).
  - `src-tauri/src/window_focus.rs` : `activate()` (non-garanti selon Apple,
    déprécié) → `activateIgnoringOtherApps(true)` ; logs `[FOCUS-DIAG]` retirés ;
    commentaire documentant le refus OS sur binaire nu.
  - `src-tauri/tauri.conf.json` : `bundle.targets` → `["app","dmg","nsis","msi"]`
    (ajout des cibles macOS).
- **Décisions Techniques :** ne pas tenter de contourner LaunchServices (aucune
  API ne le permet) ; rendre le focus tolérant (best-effort) ; la validation
  macOS du deep link ET du focus passe par l'**.app installée** (comme en prod),
  pas par `cargo tauri dev`.
- **Impacts & Dépendances :** `lib.rs`, `window_focus.rs`, `tauri.conf.json`.
  Contrat IPC inchangé. `cargo check --no-default-features` → exit 0.
- **Prochaines étapes :** produire un `.app` de test (`tauri build` ou
  `tauri dev` après bundle) et l'installer dans `/Applications` pour valider le
  focus et le deep link comme un vrai utilisateur.

---

### [2026-10-26T02:15] | Deep link macOS en dev + retour au premier plan (analyse initiale, corrigée ci-dessus)

- **Contexte :** après une connexion réussie, (1) le bouton « Open Mira » du
  portail ne faisait rien et (2) la fenêtre Mira ne revenait plus au premier
  plan. Deux causes **indépendantes**, toutes deux sur macOS en dev.
- **Cause 1 — schéma `mira://` non enregistré :** l'appel
  `app.deep_link().register_all()` du setup était conditionné à
  `#[cfg(any(target_os = "linux", all(debug_assertions, windows)))]` — **macOS
  exclu**. Or l'association du schéma vient normalement de l'`Info.plist` du
  bundle `.app`, inexistant en dev (`target/debug/mira` est un binaire nu, aucun
  `.app` généré — vérifié). LaunchServices ignorait donc totalement `mira://` :
  le bouton du portail ne trouvait aucune app.
- **Cause 2 — activation macOS hors main thread :** `window_focus.rs` appelait
  `NSApplication.activate()` via `MainThreadMarker::new()`, mais
  `cloud_focus_window` est une commande Tauri **`async`**, donc exécutée sur le
  runtime asynchrone → hors main thread → `new()` renvoie `None` → activation
  **silencieusement abandonnée** → seul `set_focus()` restait, que macOS ignore
  pour une app non activée.
- **Modifications effectuées :**
  - **`src-tauri/src/lib.rs`** : le `cfg` de `register_all` inclut désormais
    `all(debug_assertions, any(target_os = "windows", target_os = "macos"))`
    (macOS **en dev seulement** ; en release le bundle fournit l'association).
  - **`src-tauri/src/window_focus.rs`** : `bring_to_front` publie le geste sur
    le main thread via `app.run_on_main_thread(...)` (activation OS + focus
    fenêtre réunis dans la closure) ; `bring_window_to_front` délègue à
    `bring_to_front` au lieu de dupliquer. Commentaires enrichis sur la
    contrainte `MainThreadOnly`.
- **Décisions Techniques :** centraliser le geste de focus (une seule
  implémentation pour les 3 chemins) ; ne pas appeler `register_all` en release
  macOS (inutile et modifierait l'enregistrement de l'app installée) ;
  best-effort intégral conservé (un focus refusé ne casse jamais la connexion).
- **Impacts & Dépendances :** `src-tauri/src/lib.rs`, `src-tauri/src/window_focus.rs`.
  Contrat IPC inchangé (`cloud_focus_window` signature identique).
  `cargo check --no-default-features` → exit 0.
- **Prochaines étapes :** valider en réel — au 1er lancement dev, macOS doit
  demander/l'accepter l'association `mira://` ; le bouton « Open Mira » doit
  ramener la fenêtre, et le poll (`focusCloudWindow`) aussi.

---

### [2026-10-26T01:30] | Carte « forfait supérieur » : texte calé sur le budget mensuel

- **Contexte :** clarification produit — le budget des comptes gratuits est
  **mensuel** (1 USD/mois). À épuisement, l'utilisateur doit être invité à passer
  à **un forfait supérieur**. La carte d'upgrade existait déjà mais son texte
  (« You've reached your plan's usage limit ») ne disait ni « mensuel » ni
  « change d'offre ».
- **Vérification d'ensemble (rien à recâbler) :** le budget par plan est déjà la
  source de vérité côté backend (`plan_budget_free = 1.0`, `pro = 20`, etc.), la
  clé Orvyx est provisionnée avec `monthlyLimitUsd = budget du plan`, le 402 est
  détecté (`isQuotaError`) et marque le message (`quotaExhausted`), et le bouton
  ouvre `<dashboard>/pricing` via `cloud_upgrade_url` (URL fabriquée côté Rust).
- **Modifications effectuées :**
  - **`src/components/ai/UpgradeNotice.tsx`** : titres/textes explicites —
    « You've used up this month's plan credit » + corps expliquant que le crédit
    **mensuel** est épuisé et proposant d'**upgrade** à une offre supérieure (ou
    d'attendre le reset mensuel). Commentaire d'en-tête mis à jour.
- **Décisions Techniques :** **ne pas relever** `plan_budget_free` (exigence
  explicite : 1 USD/mois reste la limite du gratuit) ; le plafond de sortie
  `maxTokensPerTurn` reste à **8192** (choix validé) — assez large pour un tour
  d'agent, assez borné pour un pré-contrôle prévisible.
- **Impacts & Dépendances :** texte UI uniquement (anglais, cohérent avec le
  reste de `components/ai`). Aucun impact backend. `npx tsc --noEmit` → exit 0.
- **Prochaines étapes :** confirmer visuellement la carte dans l'UI au prochain
  épuisement réel (ou en forçant un 402).

---

- **Contexte :** en local, la génération ne produisait plus rien. Le log
  applicatif s'arrêtait après `[checkpoint] begin turn=…` sans aucune erreur :
  normal, le refus venait du réseau et n'était pas journalisé côté app.
- **Diagnostic (empirique, pas d'hypothèse) :** interception des appels réseau
  réels du SDK (`__netspy.mjs`) puis reproduction en `curl`. Constats :
  1. **Le routage est sain** : la requête part bien vers
     `https://api.orvyx-ai.com/v1/chat/completions` (variantes `orvyx` et
     `openai-compatible` identiques). Aucun bug Mira.
  2. **Orvyx renvoie `HTTP 402 insufficient_credits`** : Orvyx fait un
     *pré-contrôle de crédit* qui réserve `prompt_tokens + max_tokens` AVANT
     l'appel modèle et refuse si la réservation dépasse le solde.
  3. **Le SDK Cline n'envoyait AUCUN `max_tokens`** : un modèle custom routé par
     `routingProviderId` n'a pas de `ModelInfo.maxTokens` connue → pas de
     plafond → Orvyx applique un défaut énorme → 402 même sur un prompt trivial.
     Prouvé : corps sans `max_tokens` → 402 ; avec `max_tokens` borné → 200.
  4. **La clé Orvyx du `.env` de dev était quasi à sec** (`oryx_l2ef…`, solde
     de l'ordre de quelques centimes). Ce n'est PAS une clé utilisateur du compte
     provisionneur (`Invalid account token` sur le control plane).
- **Modifications effectuées :**
  - **`src-tauri/cline-sidecar/src/index.ts`** :
    - nouveau champ `StartCommand.maxTokensPerTurn?: number` ;
    - constante `DEFAULT_MAX_TOKENS_PER_TURN = 8192` ;
    - `maxTokensPerTurn: cmd.maxTokensPerTurn ?? DEFAULT_MAX_TOKENS_PER_TURN`
      posé dans la config de session → converti par le SDK en `max_tokens`.
      Le plafond borne la réservation et rend le pré-contrôle prévisible, sans
      toucher aux budgets (le plan gratuit reste à 1 USD).
  - **`.env`** : remplacement de la clé de dev à sec par une clé fraîche
    `mira-dev-desktop` provisionnée via le compte Orvyx (`POST /v1/keys`),
    **`monthlyLimitUsd = maxSpendUsd = 1`**, scopes `["chat","embeddings"]`
    (moindre privilège, aligné sur `OrvyxClient.create_key`).
- **Décisions Techniques :** (1) s'appuyer sur le levier **officiel**
  `CoreModelConfig.maxTokensPerTurn` plutôt que de bidouiller la requête HTTP —
  c'est le contrat du SDK et ça survit aux montées de version ; (2) **ne pas
  relever le budget du plan gratuit** (exigence explicite) — on corrige la cause
  (plafond manquant + clé épuisée), pas le symptôme ; (3) provisionner la clé via
  le même chemin que la prod (`OrvyxClient`) pour rester reproductible.
- **Impacts & Dépendances :** `dist/index.mjs` du sidecar rebuilt ; `npx tsc
  --noEmit` → exit 0. Aucun changement de contrat IPC. Le champ est optionnel :
  un appelant qui ne le fournit pas obtient le défaut sûr de 8192.
- **Validation bout-en-bout :** `mira_diag.mjs` (SDK réel) avec la nouvelle clé
  → `max_tokens: 8192` envoyé, **HTTP 200**, réponse `PONG`, événement `done`
  complet (`inputTokens: 3169, outputTokens: 3`).
- **Prochaines étapes :** relancer `pnpm run dev` et confirmer la génération dans
  l'UI. Surveiller la consommation : à 8192 de plafond et 1 USD de budget, un
  usage intensif peut épuiser la clé — prévoir un réapprovisionnement de dev.

---

- **Contexte :** après une authentification réussie (device flow), la fenêtre du
  desktop ne revenait plus automatiquement au premier plan (surtout en dev, mais
  aussi quand le navigateur gardait le focus). Symptôme supplémentaire : un
  backend local non lancé faisait échouer `device/start` (corrigé séparément en
  démarrant l'API sur 8747).
- **Cause racine (macOS) :** `window.set_focus()` ne suffit pas quand le process
  n'est pas une application *activée* (`NSApplicationActivationPolicy::Regular`
  + `NSApplication.activate()`). Le binaire de dev lancé par `cargo tauri dev`
  n'est pas enregistré auprès de LaunchServices → le système refuse le premier
  plan. Le focus était de plus **dupliqué** en trois endroits
  (`cloud_focus_window`, `deep_link::handle_urls`, callback `single_instance`).
- **Modifications effectuées :**
  - **`src-tauri/src/window_focus.rs` (nouveau)** : module partagé exposant
    `bring_to_front(app)` et `bring_window_to_front(window)`. Sur macOS :
    `setActivationPolicy(Regular)` + `unhide` + `NSApplication.activate()` via
    `objc2-app-kit`, puis `unminimize`/`show`/`set_focus`. Best-effort intégral
    (aucune erreur ne remonte à l'appelant).
  - **`src-tauri/src/deep_link.rs`** : `handle_urls` appelle désormais
    `window_focus::bring_to_front` (import `Manager` retiré, devenu inutile).
  - **`src-tauri/src/cloud.rs`** : `cloud_focus_window` délègue à
    `window_focus::bring_window_to_front`.
  - **`src-tauri/src/lib.rs`** : callback `single_instance` délègue à
    `window_focus::bring_to_front` ; module déclaré.
  - **`src-tauri/Cargo.toml`** : deps macOS-scoped `objc2 = "0.6"`,
    `objc2-app-kit = "0.3"`, `objc2-foundation = "0.3"` (déjà présentes en
    transitif via Tauri, désormais explicites et directes).
- **Décisions Techniques :** (1) **centraliser** le geste au lieu de le copier en
  trois exemplaires — un seul endroit à corriger si la stratégie d'activation
  change ; (2) cibler les deps **uniquement sur macOS** pour ne rien alourdir
  ailleurs ; (3) rester **best-effort** : un refus de focus ne doit jamais faire
  échouer une connexion ni un deep link.
- **Impacts & Dépendances :** aucun changement de contrat IPC (les commandes et
  évènements existants sont conservés à l'identique) ; le comportement sur
  Windows/Linux est inchangé (no-op d'activation, mêmes appels de fenêtre).
  Vérifié : `cargo check` **exit 0, zéro warning**.
- **Prochaines étapes :** valider sur un build dev macOS réel (connexion →
  fenêtre au premier plan). Résidus antérieurs inchangés.

---

### [2026-10-26T00:00] | Crédit Orvyx épuisé : carte d'action « upgrade » dans le fil

- **Contexte :** le routage Orvyx est correctement câblé, mais quand le contexte
  agentique devient volumineux (~15k tokens), Orvyx répond **HTTP 402
  `insufficient_credits`** avant l'inférence. L'utilisateur ne voyait qu'un
  message d'erreur technique, sans piste d'action. Besoin métier : l'inviter à
  passer sur une offre supérieure, directement depuis le chat.
- **Modifications effectuées :**
  - **`src/lib/aiTypes.ts`** : flag `quotaExhausted?` sur `DisplayMessage` +
    helper `isQuotaError(message)` (reconnaissance par *substring* — le SDK
    rethrow uniquement le message, le `code` est perdu).
  - **`src/components/ai/AiPanel.tsx`** : dans `case "error"`, détection quota,
    statut persisté `"quota"` (au lieu de `"error"`) et pose du flag.
  - **`src/lib/sessionStore.ts`** : `dbMsgsToDisplay` restaure le flag depuis le
    statut DB → l'invite survit à un rechargement de conversation.
  - **`src-tauri/src/cloud.rs`** : commande `cloud_upgrade_url` renvoyant
    `<dashboard>/pricing` (jamais d'URL en dur côté front).
  - **`src-tauri/src/lib.rs`** : enregistrement de la commande.
  - **`src/lib/agent/account.ts`** : helper `openUpgradePage()` (invoke + `openUrl`).
  - **`src/components/ai/UpgradeNotice.tsx`** : carte + bouton « Upgrade plan ».
  - **`src/components/ai/MessageBubble.tsx`** : rendu de la carte **sous** l'erreur
    brute, jamais à sa place.
- **Décisions Techniques :** (1) on **ne supprime pas** le message d'erreur brut —
  on informe, on n'efface rien ; (2) le statut DB `"quota"` est un marqueur
  *libre* (colonne sans contrainte CHECK) → aucune migration ; (3) l'URL
  d'upgrade passe par le **control plane / dashboard configuré** via `.env`, donc
  local et prod partagent le même code ; (4) détection par message côté client,
  seule surface disponible sans modifier l'agent (contrainte « on ne change rien
  sur l'agent, juste l'affichage »).
- **Impacts & Dépendances :** `dbMsgsToDisplay`, `AiPanel`, `MessageBubble`,
  `account.ts`, `cloud.rs`/`lib.rs`. Aucun impact sur le SDK Cline ni sur la
  logique agent. Le nouveau statut `"quota"` est sans effet sur les autres
  lecteurs (`db.ts` ne teste que `'streaming'`/`'interrupted'`).
- **Prochaines étapes :** relever éventuellement le `plan_budget_free` côté
  Orvyx (non nécessaire, choix produit à confirmer) ; valider le parcours en
  local avant prod.

### [2026-10-21T23:10] | Connexion desktop : suppression totale du code (100 % par lien)

- **Contexte :** malgré le mode « launch » (lien d'appairage), l'utilisateur
  voyait encore le gros code dans la modale de connexion **et** dans la carte
  Account des réglages. Cause racine : le bloc de repli était rendu
  **inconditionnellement** dès que `flow` existait (c'est-à-dire dès la réponse
  de `device/start`), avant même que `openUrl` ait réussi. Le code s'affichait
  donc toujours, même quand le navigateur s'ouvrait parfaitement — ce qui
  trahissait le parcours « par lien » voulu (façon Trae).
- **Modifications effectuées :**
  - **`src/components/SignInDialog.tsx`** : suppression du bloc « Or enter this
    code manually » et de l'affichage du code. En attente : spinner +
    « Waiting for you to confirm in your browser… » + bouton « Open browser
    again » (message dédié si le navigateur ne s'est pas ouvert).
  - **`src/components/settings/AccountSection.tsx`** : même traitement dans la
    carte d'attente des réglages (plus de code, message + bouton seulement).
  - **`src/lib/agent/account.ts`** : `DeviceStart.userCode` retiré du contrat
    front (et `startDeviceFlow` ne lit plus `user_code`) — plus aucune surface
    morte pour un code que plus personne n'affiche.
- **Décisions Techniques :** on supprime le **repli par code** plutôt que de le
  conditionner à l'échec du navigateur. Justification : (1) fidélité au parcours
  Trae (un lien, un clic, rien à recopier) ; (2) le bouton « Open browser again »
  couvre déjà le cas « navigateur fermé » en relançant la même page ; (3) moins
  de surface affichée = moins de risque qu'un tiers lise un code à l'écran. Le
  backend continue d'exposer `user_code` (compat) mais le desktop ne le remonte
  plus au front.
- **Impacts & Dépendances :** `cloud.rs` conserve `user_code` dans `DeviceStart`
  (métadonnée non sensible, inoffensive) ; seul le contrat **front** a été
  resserré. `cargo build` OK, `tsc` 0 erreur (hors `bench/` préexistant).
- **Prochaines étapes :** aucune. Si un jour un navigateur s'avère non ouvrable
  sur une plateforme cible, réintroduire un repli **explicite** (bouton
  « Afficher le code ») plutôt qu'un affichage automatique.

---

### [2026-10-21T21:25] | Sélecteur de modèles de l'input : ancré au bouton (vrai select)

- **Contexte :** le menu du sélecteur de modèles s'ouvrait « loin du select » et
  ne laissait pas voir les modèles. Cause : il était rendu dans un **portal
  `position: fixed`** dont la position était calculée par mesure
  (`getBoundingClientRect`) dans un effet dépendant de l'ancre. Une ancre
  capturée avant attachement, ou une logique de repli qui remontait de 440 px,
  envoyait le menu n'importe où à l'écran.
- **Modifications effectuées :**
  - **`src/components/ai/PreferencesDropdown.tsx`** :
    - Suppression du `createPortal` et de la mesure d'écran. Le menu est
      désormais `position: absolute`, ancré au-dessus du bouton
      (`bottom: calc(100% + 6px)`), largeur 280 px, hauteur max 340 px.
    - Suppression de la prop `anchorEl` (devenue inutile : plus aucune mesure).
  - **`src/components/ai/ChatBox.tsx`** :
    - Le bouton modèle et son menu sont enveloppés dans un `<div
      style={{ position: "relative" }}>` : le menu s'ancre exactement au bouton,
      comme un select natif.
    - Suppression de `modelAnchorRef` (plus utilisé).
    - Retour visuel du bouton à l'ouverture (bordure/accent + chevron inversé),
      cohérent avec le bouton Agent.
- **Décisions Techniques :**
  - **Ancrage CSS plutôt que calcul JS.** Un menu ancré par CSS au parent relatif
    suit toujours son déclencheur — pas de mesure à maintenir, pas de dérive au
    redimensionnement, pas de dépendance à un ref lu pendant le rendu. C'est le
    comportement d'un vrai `<select>`, ce qui était demandé.
  - **Suppression du code mort.** `anchorEl`, `pos`, `modelAnchorRef` et le
    `createPortal` deviennent inutiles : les retirer évite de laisser un chemin
    fragile qui pourrait être réactivé par erreur.
- **Impacts & Dépendances :**
  - `PreferencesDropdown` ne dépend plus d'aucune mesure : son API est réduite à
    `selectedModelId` / `onSelect` / `onClose`.
  - Le menu s'ouvre au-dessus du bouton ; s'il manque de place en haut, il
    faudra un repli (à surveiller si le panneau devient très court).
- **Prochaines étapes :**
  - Vérifier visuellement l'ouverture au-dessus du bouton dans le panneau AI, et
    l'ajout éventuel d'un repli bas si la place manque au-dessus.

### [2026-10-21T21:00] | Le bouton « Log in » lance le device flow directement (modale dédiée)

- **Contexte :** le bouton « Log in » de la barre de titre ouvrait la page
  Réglages > Compte et demandait un second clic sur « Sign in to Mira ». Pour une
  action d'accueil, ce détour était inutile : l'utilisateur doit pouvoir se
  connecter en un clic là où il voit le bouton.
- **Modifications effectuées :**
  - **`src/lib/agent/account.ts`** : nouvelle fonction `runDeviceSignIn()` qui
    orchestre tout le flow (start → attente d'approbation → provision de la clé
    → synchronisation du catalogue). C'est désormais la **seule** implémentation.
  - **`src/components/SignInDialog.tsx`** (nouveau) : modale de connexion
    autonome. Lance le flow au montage, affiche le code utilisateur pendant
    l'attente, gère refus / expiration / erreur, propose « Open browser again ».
  - **`src/components/TitleBar.tsx`** : le `LoginButton` ouvre cette modale
    (`setSignInOpen(true)`) au lieu de renvoyer vers les réglages.
  - **`src/components/settings/AccountSection.tsx`** : consomme
    `runDeviceSignIn()` ; suppression de la logique dupliquée (`finishSignIn`).
- **Décisions Techniques :**
  - **Une seule implémentation du flow.** Deux points d'entrée (Réglages et
    TitleBar) qui réimplémentent chacun le flow finiraient par diverger — un
    correctif de sécurité sur l'un ne profiterait pas à l'autre. La logique vit
    dans `account.ts`, les composants ne font que l'affichage.
  - **Garde anti-double-exécution.** La modale protège son effet d'un
    `useRef(started)` : le double-montage du mode strict de React ne doit pas
    lancer deux device flows (deux codes, deux navigations).
  - **Aucun secret dans la modale.** Comme `AccountSection`, elle ne voit jamais
    le token ni la clé : tout reste côté Rust.
- **Impacts & Dépendances :**
  - La modale et la page Réglages partagent maintenant le même code de
    connexion : toute évolution du flow est à faire dans `account.ts` uniquement.
  - La fermeture de la modale annule le polling (AbortController) : pas de
    boucle orpheline.
- **Prochaines étapes :**
  - Envisager un affichage du budget/plan dans la modale une fois une route
    `GET /me` disponible (aujourd'hui la réponse de provision ne porte ni
    `email` ni `plan`).

### [2026-10-21T20:30] | URL du plan de contrôle : le `.env` devient la source de vérité

- **Contexte :** la première version distinguait deux chemins (variable `.env`
  en dev, constante compilée en prod). C'est incohérent avec le reste de la
  config Mira, où le `.env` pilote tout. Demande utilisateur : ne pas hardcoder
  l'URL de prod, la porter depuis le `.env` comme les autres variables.
- **Modifications effectuées :**
  - **`src-tauri/src/cloud.rs`** : `dashboard_url()` lit désormais
    `ai_env::default_dashboard_url()` (donc `MIRA_DASHBOARD_URL` du `.env`) en
    priorité. La constante est renommée `FALLBACK_DASHBOARD_URL` et n'est plus
    qu'un filet de sécurité pour la release (`.env` absent). Suppression du
    `#[cfg(debug_assertions)]` local : la lecture passe par `ai_env`, qui garde
    déjà sa propre frontière debug-only.
  - **`src-tauri/src/ai_env.rs`** : commentaires alignés (le `.env` est la
    source de vérité, pas un simple override de dev).
  - **`mira/.env`** et **`mira/.env.example`** : bloc « Plan de contrôle »
    unifié, documentant les deux valeurs (local / en ligne).
- **Décisions Techniques :**
  - **Un seul point de lecture.** `cloud.rs` ne lit plus `std::env::var`
    directement : il passe par `ai_env`, ce qui garde la frontière debug-only
    centralisée en un seul endroit et évite deux comportements divergents.
  - **Constante conservée, mais déclassée.** En release il n'y a aucun `.env` :
    sans repli, l'application n'aurait aucune URL. Le repli garantit un binaire
    fonctionnel ; il reste surchargeable en dev via la variable.
- **Impacts & Dépendances :**
  - Le comportement observable ne change pas en dev (toujours
    `http://localhost:8747`). En release, la valeur vient du repli.
  - Changer d'environnement = éditer `MIRA_DASHBOARD_URL` dans le `.env`, comme
    n'importe quel autre réglage Mira.
- **Prochaines étapes :**
  - Si l'on veut aussi surcharger l'URL en release (ex. build CI vers un
    staging), il faudra lire la variable d'environnement du process au lieu du
    `.env` — à décider explicitement, car cela rouvre le vecteur de
    détournement local.

### [2026-10-21T20:05] | URLs du plan de contrôle externalisées dans le `.env` (dev) vs constante compilée (prod)

- **Contexte :** l'URL du plan de contrôle était codée en dur dans `cloud.rs`,
  sans distinction dev/prod. Il fallait pouvoir tester en local
  (`http://localhost:8747`) tout en embarquant en release le domaine de
  production `https://api.miracoder.com` — sans qu'un `.env` traîne dans le
  binaire distribué.
- **Modifications effectuées :**
  - **`src-tauri/src/cloud.rs`** : `PRODUCTION_DASHBOARD_URL =
    "https://api.miracoder.com"` (contrat produit, compilé) ;
    `dashboard_url()` ne surcharge via `MIRA_DASHBOARD_URL` **qu'en
    `#[cfg(debug_assertions)]`**.
  - **`src-tauri/src/ai_env.rs`** : `KEY_DASHBOARD_URL`, `default_dashboard_url()`,
    champ `dashboard_url` dans `DevAiConfig`.
  - **`mira/.env`** et **`mira/.env.example`** : réécrits — `MIRA_DASHBOARD_URL`
    documenté (dev local / prod compilée), plus de références obsolètes
    (anthropic/gemini/ollama).
- **Décisions Techniques :**
  - **La surcharge d'URL est debug-only.** En release, accepter une URL venue de
    l'environnement permettrait à un attaquant local de rediriger le device flow
    et la provision de clé vers un serveur tiers (interception du secret Orvyx).
    Le `cfg(debug_assertions)` ferme ce vecteur : le binaire release ne se
    détourne pas.
  - **L'URL de prod reste une constante, pas une variable.** Il n'y a pas de
    `.env` en release ; une constante garantit une source unique non modifiable
    après compilation.
  - **Pas de `MIRA_DASHBOARD_URL` côté dashboard** : `PUBLIC_BASE_URL` (déjà
    présent) est l'autorité des `verification_uri` — c'est le seul point à
    basculer vers le sous-domaine en production.
- **Impacts & Dépendances :**
  - `cloud.rs` est la seule source de l'URL côté desktop ; tout nouvel appel au
    plan de contrôle doit passer par `dashboard_url()`.
  - En production, la bascule se fait en changeant `PRODUCTION_DASHBOARD_URL`
    **et** `PUBLIC_BASE_URL` côté dashboard (cohérence des redirections).
- **Prochaines étapes :**
  - Vérifier le sous-domaine exact (`api.miracoder.com`) retenu pour la prod
    (DNS + certificat + `PUBLIC_BASE_URL`).
  - Aucun `.env` obsolète côté desktop : `mira/.env(.example)` sont les seuls et
    sont à jour.

### [2026-10-21T19:40] | Account — état de connexion réel dans l'UI (sidebar, TitleBar)

- **Contexte :** trois défauts liés à l'absence de compte :
  1. l'URL du plan de contrôle pointait sur un domaine fictif ;
  2. la sidebar des réglages affichait une identité et un plan **hardcodés**
     (« franklin DZUKAM », « Pro+ ») même déconnecté ;
  3. le sélecteur IDE/AI mode restait affiché sans compte, alors que les deux
     modes dépendent de modèles.
- **Modifications effectuées :**
  - **`src-tauri/src/cloud.rs`** : `DEFAULT_DASHBOARD_URL` → `https://miracoder.com`.
  - **`src/lib/agent/account.ts`** : ajout de l'événement `CLOUD_ACCOUNT_EVENT`
    (émis à la connexion, au rafraîchissement et à la déconnexion) et du hook
    `useAccount()` qui expose `{ signedIn, account, loading }`. `signedIn` est
    dérivé de `cloud_status` (jeton réellement présent côté Rust), jamais du
    cache local.
  - **`SettingsPanel.tsx`** : l'en-tête de la sidebar est rendu **uniquement**
    si `signedIn && account` ; l'avatar est l'initiale de l'email, le nom et le
    plan viennent des métadonnées. Plus aucune donnée inventée.
  - **`TitleBar.tsx`** : nouveau composant `LoginButton` ; le `ModeSwitch`
    n'apparaît que si connecté, sinon un bouton « Log in » ouvre les réglages
    sur la page Account.
- **Décisions Techniques :**
  - **`signedIn` = source de vérité Rust, pas localStorage.** Le cache local
    (`mira-cloud-account`) ne sert qu'à l'affichage ; il peut survivre à une
    déconnexion ou à l'expiration d'un jeton. Faire dépendre l'UI du cache
    laisserait croire à une session valide alors qu'aucune inférence n'est
    possible — et afficherait un plan payant non effectif.
  - **Un événement plutôt qu'un contexte React global** : `SettingsPanel` et
    `TitleBar` sont dans des sous-arbres distincts et le magasin de compte n'est
    pas un état d'application. Un `CustomEvent` reste découplé et évite
    d'introduire un provider supplémentaire pour deux consommateurs.
  - **Masquer IDE/AI mode plutôt que le désactiver** : un mode inactif grisé
    sans explication est plus confus qu'un appel à l'action. Le bouton « Log in »
    indique directement quoi faire.
- **Impacts & Dépendances :**
  - `SettingsPanel` et `TitleBar` consomment désormais `useAccount()`.
  - Le bouton « Log in » déclenche `origin-open-settings` avec
    `{ section: "account" }` — mécanisme déjà en place.
  - Aucun impact sur l'agent ni sur la chaîne d'inférence.
- **Prochaines étapes :**
  - Alimenter `account.email` et `account.plan` : `POST /keys` ne renvoie
    aujourd'hui que l'empreinte, le hint et le budget. Une route `GET /me` (ou
    un enrichissement de la réponse de connexion) est nécessaire pour afficher
    l'email et le plan réels.

---

### [2026-10-21T19:00] | Account — connexion au compte Mira + modèles embarqués en release

- **Contexte :** Mira est un produit payant avec SES PROPRES modèles (comme
  Trae), en plus de ceux que le client apporte via « Custom Model ». Or la clé
  Orvyx et le catalogue ne venaient que du `.env` **de debug**
  (`ai_env.rs`, no-op en release) : en production, aucun modèle Mira n'était
  utilisable. Le plan de contrôle `mira-web-dashboard` sait déjà émettre une clé
  par utilisateur (device flow + `POST /keys`), mais le desktop ne s'y connectait
  pas.
- **Modifications effectuées :**
  - **Rust — `src-tauri/src/cloud.rs` (nouveau)** : client du plan de contrôle.
    `cloud_device_start` / `cloud_device_poll` (device flow OAuth 2.0),
    `cloud_provision_key` (range le secret Orvyx dans le keychain OS, compte
    `provider:orvyx`), `cloud_fetch_models`, `cloud_status`, `cloud_sign_out`.
    Les jetons et le secret vivent dans `CloudState` (Tauri managed state) et ne
    sortent JAMAIS vers le front.
  - **`src-tauri/src/lib.rs`** : `mod cloud`, `.manage(cloud::CloudState::default())`,
    6 commandes enregistrées.
  - **Front — `src/lib/agent/account.ts` (nouveau)** : orchestration device flow
    (`startDeviceFlow` / `waitForApproval` avec `AbortSignal`), `provisionKey`,
    `syncModels`, `signOut`, `isSignedIn`, plus un cache local non sensible
    (`mira-cloud-models`, `mira-cloud-account`).
  - **`src/lib/agent/miraModels.ts`** : `loadMiraModels()` a désormais DEUX
    sources — `.env` de dev d'abord (confort), puis le catalogue synchronisé du
    plan de contrôle (production), via un helper `buildModels()` partagé. Ajout
    de `MIRA_BASE_URL` (constante produit, jamais fournie par l'utilisateur).
  - **`src/components/settings/AccountSection.tsx` (nouveau)** : page
    « Account » — bouton *Sign in to Mira*, affichage du code utilisateur +
    ouverture navigateur, état connecté (email/plan/empreinte de clé, budget),
    *Refresh models*, *Sign out*. Câblée dans `SettingsPanel` (retirée de
    `ComingSoonSection`).
- **Décisions Techniques :**
  - **Device flow plutôt que callback local** : pas de navigateur embarqué
    fiable, pas de port d'écoute à ouvrir → RFC 8628 est le standard desktop.
  - **Jetons et secret strictement côté Rust.** Le front ne reçoit que le
    `user_code` et des métadonnées (empreinte, budget, plan). Un XSS dans la
    WebView ne peut donc pas exfiltrer la clé Orvyx depuis le JS.
  - **URL du dashboard non fournie par l'utilisateur** (`MIRA_DASHBOARD_URL`
    sinon défaut) : pas de surface SSRF, contrairement aux endpoints custom.
  - **Réponses bornées** (`MAX_RESPONSE_BYTES`, timeout 20 s) : un plan de
    contrôle compromis ne peut pas faire exploser la mémoire du poste.
  - **Pas de suppression de la clé au sign-out** : la clé reste valide pour
    l'inférence tant que le compte la détient ; sa révocation est une action
    serveur distincte (`DELETE /keys`).
  - **L'ordre du catalogue est porteur de sens** : il définit la cascade de repli
    en cas d'indisponibilité. Le `.env` prime en dev pour ne pas dépendre du
    réseau pendant le développement.
- **Impacts & Dépendances :**
  - Nouvelle variable d'env `MIRA_DASHBOARD_URL` (optionnelle).
  - Le sélecteur de modèles se rafraîchit à la connexion via
    `emitCustomModelsChanged()` — pas de rechargement requis.
  - Dépend de la route `GET /api/v1/models` du dashboard (ajoutée dans le même
    lot) et des routes `device`/`keys` existantes.
- **Prochaines étapes :**
  - Remplacer `DEFAULT_DASHBOARD_URL` par l'URL de production réelle avant la
    première release.
  - Prévoir la rotation transparente du jeton d'accès (le refresh token est
    stocké mais pas encore utilisé).

---

### [2026-10-20T23:59] | Settings → Models — fin du catalogue hardcodé, tout est déclaré par le client

- **Contexte :** le panneau Settings → Models exposait un catalogue figé de 12
  providers et leurs modèles (API keys « Connect AI »). Le besoin produit : le
  client déclare LUI-MÊME son modèle — URL de requête, clé, id de modèle, format
  d'API — via une modale « Custom Model », et ce modèle apparaît ensuite dans le
  sélecteur de l'input pour être utilisé dans son travail.

- **Modifications effectuées :**
  - `src/lib/agent/customModels.ts` (nouveau magasin) : persistance
    `localStorage['mira-custom-models']`, validation d'URL, résolution de l'URL
    finale selon le format, bus de changement (`mira:custom-models-changed`).
  - `SettingsPanel.tsx` : suppression de l'ancienne section « API Keys » (214 l.)
    remplacée par la modale `CustomModelModal` (API Format, Custom Request URL +
    toggle *Full URL*, Model ID, Display Name 0/64, API Key, Advanced Settings
    repliable : Model Series, Context Window in/out avec presets, Tool Call
    Rounds = 500) et une liste dynamique des modèles.
  - `PreferencesDropdown.tsx` : le sélecteur de l'input lit désormais
    `loadCustomModels()` en état réactif ; « Add Model » ouvre Settings → Models
    via `origin-open-settings`.
  - `ChatBox.tsx` : label du modèle = `displayName` du modèle custom, tenu à jour
    par abonnement au magasin.
  - `AiPanel.tsx` : suppression du garde-fou `PROVIDERS.find` (bloquant), clé lue
    sur `providerId`, coût/usage via `findCustomModel` + `accentForModel`, et
    propagation de `clientType` + `maxIterations` jusqu'au harness.

- **Décisions techniques :**
  - **Un seul magasin, une seule vérité :** plus aucun catalogue de modèles n'est
    importable par les composants ; le providerId EST la clé du modèle custom.
  - **`clientType` porte le protocole :** `openai-chat` → `openai-compatible`,
    `openai-responses` → `openai`, `anthropic` → `anthropic`. Le libellé d'UI
    n'a aucune influence sur le transport — mapping centralisé dans
    `toClientType()`.
  - **Secrets en dehors du magasin :** la clé API vit dans le keychain OS sous
    `provider:<modelKey>` ; la suppression d'un modèle purge aussi sa clé (pas
    de secret orphelin).
  - Validation d'URL **côté client ET côté Rust** (défense en profondeur) : la
    validation d'affichage ne dispense pas du contrôle SSRF serveur.

- **Impacts & Dépendances :** `providers.ts` du dossier `ai/` ne contient plus
  que des helpers de présentation (`AIModel`, `accentForModel`, `FALLBACK_PROVIDER`).
  `modelCascade.ts`/`resolveAllowedModels` deviennent orphelins (nettoyage à
  décider). `tsc --noEmit` = 0 erreur hors `bench/` ; `cargo build` = OK.

- **Prochaines étapes :** test manuel de bout en bout (ajout d'un modèle →
  apparition dans le sélecteur → envoi d'un message) ; décider du retrait des
  modules orphelins ; valider la normalisation du localStorage corrompu
  (`origin-ai-provider = "o"`).

---

### [2026-10-20T23:58] | Source Control — refonte complète du panneau + fin du faux « Git could not be found »

- **Contexte :** deux problèmes liés. (1) L'utilisateur voyait en boucle
  « Git could not be found. Install Git (or add it to your shell PATH), then restart
  Mira. » alors que git **fonctionnait** (les commandes git de l'explorateur, du
  diff et du log répondaient normalement). (2) Le panneau Source Control était un
  monolithe de 851 lignes avec `window.prompt`/`window.confirm`, des dropdowns
  inline, un graph plat sans métadonnées et aucun regroupement Staged/Changes —
  loin du ressenti Trae.

- **Cause racine du faux « git could not be found » :** ce n'était **pas** git. Le
  provider IA persisté en `localStorage` était corrompu (`origin-ai-provider = "o"`,
  `origin-ai-model = "d"`). `buildLanguageModel("o", …)` lève `Unknown provider: o`
  **hors du try/catch** de `gitCommitMessage.ts` ; l'exception remontait jusqu'à
  l'UI et était affichée comme un échec git. En parallèle,
  `gitCommitDiff(...).catch(() => null)` **avalait** tout échec IPC et le
  réétiquetait `git-unavailable` — un défaut de diagnostic qui masquait la vraie
  cause.

- **Modifications effectuées :**
  - `src/components/SourceTreePanel.tsx` — **réécriture complète** :
    - helper `errMsg(e, fallback)` qui normalise `string` | `Error` | objet
      sérialisé : les commandes Rust renvoient `Result<_, String>`, donc un
      `invoke` rejeté porte une **chaîne**, pas une `Error` ; l'ancien motif
      `e instanceof Error ? e.message : fallback` masquait le message réel.
    - découpage en sous-composants `SectionHeader`, `FileGroup`, `FileRow` ;
    - groupes **Staged / Changes** séparés avec compteurs (parité Trae) ;
    - `DropdownMenu` (portal, clamp viewport) pour les menus More / Commit /
      Branches, à la place des dropdowns inline ;
    - **dialogue de saisie inline** (branche / stash) avec Enter/Escape, à la
      place de `window.prompt` ;
    - zone de commit en `textarea` multi-lignes + bouton Sparkles en surimpression ;
    - graph enrichi (hash en mono + auteur + date, `title` au survol) ;
    - import inutilisé `CloudUpload`/`Download` retiré, `openBranches` rebranché.
  - `src/lib/git.ts` — `CommitDiffResult` gagne `{ kind: 'ipc-error'; message }` ;
    `gitCommitDiff` **ne relance plus** l'exception et ne confond plus un échec IPC
    avec « git introuvable ».
  - `src/lib/agent/activeModel.ts` — `LlmActionFailure` gagne `ipc-error`.
  - `src/lib/gitCommitMessage.ts` — `buildLanguageModel` enveloppé dans un IIFE
    try/catch retournant `Error` ; un provider inconnu devient `no-provider` avec
    `detail: "Unknown provider: o"` (au lieu d'une exception qui remonte) ; le cas
    `ipc-error` du diff est traduit en `reason: 'ipc-error'`.
  - `src-tauri/src/git.rs` — bug latent corrigé :
    `combined.truncate(cap)` (dans `git_diff` et `git_commit_diff`) **panique** si
    la coupe tombe au milieu d'un caractère UTF-8 (accent/emoji dans un diff). Nouveau
    helper `truncate_on_char_boundary` qui recule jusqu'à une frontière valide. Les
    `eprintln!` de diagnostic temporaires sont retirés.

- **Décisions techniques :**
  - **Typage explicite des causes plutôt que messages génériques.** On distingue
    désormais `git-unavailable` (binaire absent), `not-a-repo`, `no-changes`,
    `no-provider` (config IA) et `ipc-error` (échec d'appel backend). L'utilisateur
    sait quoi corriger sans deviner.
  - **Périmètre UI uniquement** : aucun contrat de commande git changé, les 24
    appels existants sont réutilisés tels quels. Le backend n'est touché que pour le
    bug de troncature UTF-8 (correctif minimal et nécessaire).
  - **Réutilisation de `DropdownMenu`** (portal + clamp viewport) plutôt qu'un
    dropdown maison : un seul composant à maintenir, comportement clavier/outside-click
    cohérent dans toute l'app.

- **Impacts & dépendances :** `SourceTreePanel.tsx`, `git.ts`, `agent/activeModel.ts`,
  `gitCommitMessage.ts`, `git.rs`. Aucun autre appelant de `generateCommitMessage`
  n'utilise les nouvelles raisons — extension rétro-compatible de l'union.

- **Prochaines étapes :** valider visuellement dans l'app (Staged/Changes, menus,
  dialogue inline, graph). Reste à surveiller : un repli automatique si le provider
  persisté est invalide (`origin-ai-provider` corrompu) — actuellement l'UI prévient
  explicitement, mais ne corrige pas la valeur stockée.

---

### [2026-10-20T23:40] | Token `border.strong` — bordures de séparation lisibles entre panneaux

- **Contexte :** retour utilisateur : *« quand on ouvre par exemple explorer il faut
  mettre une border qui montre la séparation, pas une shadow »*. Les bordures
  ajoutées au lot précédent existaient mais étaient **invisibles**.

- **Cause racine :** `border.default` vaut `#242424` (dark) et `#ebebeb` (light),
  alors que les fonds voisins sont `bg.sidebar` `#0a0a0a` et `bg.editor` `#0a0a0a`
  (dark) / `#fafafa` et `#ffffff` (light). L'écart de luminance est trop faible
  pour distinguer un trait de séparation : l'œil ne perçoit aucune frontière, d'où
  l'impression d'un panneau « flottant sans contour ».

- **Modifications effectuées :**
  - Nouveau token `border.strong` :
    `origin-dark` → `#3a3a3a` ; `origin-light` → `#d4d4d4` (contraste nettement
    supérieur à `border.default` sur les fonds concernés).
  - `vscodeTheme.ts` : mapping `border.strong` ← `activityBar.border`,
    `sideBar.border`, `panel.border`, `editorGroup.border`. Le fallback existant
    (l.213-214) garantit la présence du token même si le thème importé ne le
    fournit pas.
  - Séparations structurelles basculées sur `--origin-border-strong` :
    `Sidebar` (bordure droite, côté éditeur), `ActivityBar` (côté panneau
    fichiers), `TaskRail` (mode IA), `AiPanel` (section chat + Pinboard).

- **Décisions techniques :**
  - **Token dédié plutôt que rehausser `border.default`.** `border.default` sert à
    des traits fins (séparateurs de listes, contours de champs) : le durcir
    partout aurait produit un rendu bruyant. On sépare les deux usages —
    `border.default` = trait interne discret, `border.strong` = frontière de
    panneau.
  - **Deux valeurs choisies par contraste perçu**, pas par symétrie : en dark on
    monte à `#3a3a3a` (le noir écrase tout), en light `#d4d4d4` suffit car le
    fond clair amplifie les traits sombres.
  - **Mapping VS Code orienté bordures de panneau** (`activityBar.border`,
    `sideBar.border`) plutôt que `panel.border` seul, souvent absent des thèmes
    clairs.

- **Impacts & dépendances :** `origin-dark/theme.json`, `origin-light/theme.json`,
    `vscodeTheme.ts`, `Sidebar.tsx`, `ActivityBar.tsx`, `TaskRail.tsx`,
    `AiPanel.tsx`. Le type `OriginTheme.colors` est `Record<string, string>`
    (ouvert) : aucun changement de schéma requis, les thèmes VS Code importés
    héritent du fallback.

- **Vérifications :** `tsc` → seule l'erreur **préexistante** du bench ; JSON
    relus (`origin-dark` → `#3a3a3a`, `origin-light` → `#d4d4d4`) ;
    `vitest` → **818/818 verts**.

- **Prochaines étapes :** **Lot E** (index sémantique embeddings) en attente de
    discussion.

---

### [2026-10-20T23:15] | Panneaux — séparation franche au lieu des interstices `gap-1`

- **Contexte :** retour utilisateur : *« les panneaux que ce soit à gauche ou à droite,
  les shadow sont [des] éléments en fait, pas bon »*. Ce qui était perçu comme des
  ombres/éléments parasites était en réalité des **interstices de 4 px** (`gap-1`)
  entre panneaux, laissant voir le fond racine (`--origin-bg-base`).

- **Cause racine :** le layout empilait les surfaces avec Tailwind `gap-1`. Chaque
  panneau portait déjà son propre fond, mais l'espace entre eux affichait le fond de
  base — un liseré sombre irrégulier selon la couleur des voisins. Trae, lui, colle
  les panneaux et marque la séparation par une **bordure** d'un demi-pixel.

- **Modifications effectuées :**
  - `App.tsx` (layout classique) : retrait des 5 `gap-1` de structure
    (racine `h-full w-full flex-col`, conteneur `flex-1 overflow-hidden` ×2,
    colonne centrale, volet de split).
  - `AgentModeView.tsx` (mode IA) : retrait des 2 `gap-1` (racine, panneau central).
  - `Sidebar.tsx` : retrait du `gap-1` interne (ActivityBar ↔ fichiers) et
    correction de la largeur (`width + 44 + 4` → `width + 44`, le `+4` compensait
    le gap disparu) ; ajout d'un `borderRight` sur le conteneur.
  - `ActivityBar.tsx` : ajout d'un `borderRight` (l'ActivityBar et le panneau de
    fichiers partagent le MÊME fond `--origin-bg-sidebar` : sans bordure, ils
    fusionnent).
  - `AiPanel.tsx` : retrait du `gap-1` chat ↔ Pinboard ; `borderLeft` sur le
    Pinboard ; bordure conditionnelle sur la section chat — `borderRight` en mode
    agent (chat à gauche), `borderLeft` en mode classique (chat à droite).

- **Décisions techniques :**
  - **Bordure plutôt qu'interstice.** Un `gap` expose le fond parent : le rendu
    dépend du contexte et laisse des liserés irréguliers. Une bordure est
    auto-suffisante, constante, et survit au redimensionnement des panneaux.
  - **Corriger la largeur compensée.** Le `+4` de `Sidebar` était intriqué au
    `gap-1` ; le laisser aurait produit 4 px de vide permanent.
  - **Bordures conditionnelles côté chat.** Le même composant `AiPanel` est rendu à
    gauche (agent) ou à droite (classique) : on choisit le côté de la bordure via
    `isAgent` plutôt que dupliquer le conteneur.
  - **Pas de touche au comportement.** Modification purement visuelle ; aucun
    état, aucune prop, aucun contrat agent modifié.

- **Impacts & dépendances :** `App.tsx`, `AgentModeView.tsx`, `Sidebar.tsx`,
  `ActivityBar.tsx`, `AiPanel.tsx`. Les resize handles restent fonctionnels
  (éléments absolus, indépendants du gap supprimé).

- **Vérifications :** `npx tsc --noEmit` → seule l'erreur **préexistante** du bench
  (`clineSidecar.ts` — `CONVERGENCE` non lu) subsiste ; diagnostics IDE vides.

- **Prochaines étapes :** **Lot E** (index sémantique embeddings) toujours en
  attente de discussion.

---

### [2026-10-20T22:45] | Build — cache Cargo corrompu après déplacement dans `mira/`

- **Contexte :** `pnpm run dev` échouait au build de `mira` :
  `failed to read file '.../origin/src-tauri/target/debug/build/tauri-.../out/permissions/app/autogenerated/commands/app_hide.toml'`
  (os error 2). Le projet a été déplacé de `origin/` vers `origin/mira/`.

- **Cause racine :** le dossier `target/` de `origin/mira/src-tauri` contenait des
  artefacts compilés **sous l'ancien chemin** `origin/src-tauri`. Les scripts de
  build (et leurs `OUT_DIR`) écrivent des chemins ABSOLUS ; Cargo les réutilise
  tels quels grâce au cache de fraîcheur, puis tente de lire des fichiers sous
  l'ancien emplacement — disparu depuis le déplacement. Ce n'est PAS un problème
  de code applicatif : uniquement un cache de build périmé.

- **Modifications effectuées :**
  - Purge ciblée du cache d'artefacts de build :
    `rm -rf target/debug/build target/debug/.fingerprint/mira-* target/debug/.fingerprint/origin-*`
    (dans `origin/mira/src-tauri`). On conserve les dépendances déjà compilées,
    seule la régénération des scripts de build est forcée — plus rapide qu'un
    `cargo clean` complet sur 31 Go.
  - Vérification : `cargo build --no-default-features` → `Finished dev profile
    in 51.62s`, aucune erreur de permissions Tauri.
  - Vérification bout en bout : `pnpm run dev` → Vite **HTTP 200** sur
    `localhost:1420`, process `tauri dev` actif.

- **Décisions techniques :**
  - **Purge ciblée plutôt que `cargo clean`.** La cause est strictement locale aux
    scripts de build (`build/` + `.fingerprint`) ; supprimer 31 Go de dépendances
    saines aurait rallongé le cycle inutilement.
  - **Aucun changement de configuration.** Ni `CARGO_TARGET_DIR`, ni
    `target-dir` dans `Cargo.toml`, ni `.cargo/config` : le chemin par défaut
    (`<workspace>/src-tauri/target`) est correct une fois le cache assaini. On ne
    fige donc aucun chemin absolu dans le dépôt — le projet reste déplaçable.

- **Impacts & dépendances :** aucun fichier de code modifié. Pas de dette
  introduite. Le cache se régénère automatiquement au prochain build.

- **Prochaines étapes :** éviter de committer `src-tauri/target/` (déjà dans
  `.gitignore`) pour qu'un futur déplacement ne réintroduise pas le problème.
  **Lot E** (index sémantique embeddings) toujours en attente de discussion.

---

### [2026-10-20T21:30] | Bloc de code — parité Trae (en-tête, Run, insert into terminal)

- **Contexte :** retour utilisateur avec une capture de rendu Trae. Notre bloc de
  code était trop pauvre : en-tête en minuscules (`bash`), simple bouton `Copy`,
  aucune action pour EXÉCUTER une commande pourtant affichée par l'agent.

- **Modifications effectuées :**
  - `MarkdownMessage.tsx` — `CodeBlock` :
    - en-tête enrichi : icône `Terminal` (accent bleu) + libellé capitalisé
      (« Bash », « TypeScript », « Code »), police sans, `fontWeight: 500` ;
    - `Copy` réduit à l'icône (12 px) avec `title`/`aria-label` ;
    - bouton **« insert into terminal »** (`TerminalSquare`) : écrit la commande
      dans le PTY SANS l'exécuter ;
    - bouton **`Run`** (accent, `Play` + libellé), proposé uniquement pour les
      langages shell (`bash`/`sh`/`shell`/`zsh`/`console`/`terminal`) ;
    - corps : `fontSize 12.5`, `lineHeight 1.65`, rayon 8.
    - nouvelle interface : `onRunCommand?`, `onInsertTerminal?` (optionnels →
      l'aperçu Markdown d'un fichier n'affiche ni `Run` ni insert).
  - `MessageBubble.tsx`, `AiPanel.tsx` — props `onRunCommand`/`onInsertTerminal`
    uniquement relayées (pas de logique ajoutée).
  - `AgentModeView.tsx` — `handleRunCommand` / `handleInsertTerminal` : suspendent
    le Flow, affichent l'onglet `terminal`, puis délèguent au `TerminalPanel`
    (`runInNewTab` / `insertIntoActive`).
  - `TerminalPanel.tsx` — nouvelle méthode `insertIntoActive(text)` sur le handle :
    injecte dans l'onglet ACTIF (pas de nouvel onglet) via `pendingInserts`,
    indexé par un `nonce` incrémental.
  - `Terminal.tsx` — nouvelle prop `insertRequest?: { text; nonce }` et effet
    dédié écrivant dans le PTY **sans `\r`** ; le `nonce` (et non le texte)
    déclenche l'effet, sinon deux insertions du même bloc seraient ignorées
    (`termIdRef` est null tant que le PTY n'est pas prêt → écriture silencieuse).

- **Décisions techniques :**
  - **`Run` sur liste blanche de langages.** Un `Run` sur un bloc `json` ou `diff`
    n'a aucun sens ; on ne l'affiche que pour les commandes shell.
  - **Deux canaux distincts.** `runInNewTab` (exécution, `\r`) et `insertIntoActive`
    (injection, sans `\r`) ne partagent pas le même état : mélanger les deux
    aurait donné soit une exécution non voulue, soit une commande inerte.
  - **`nonce` plutôt que texte.** Le texte est un état de rendu ; deux clics sur
    le même bloc doivent produire deux insertions. Un compteur monotone est le
    signal fiable, exactement comme `clearKey` pour l'effacement.
  - **Sécurité :** rien n'est exécuté sans un clic utilisateur explicite sur `Run` ;
    l'insertion, elle, n'envoie jamais `Entrée`. Aucune commande issue du modèle
    n'est lancée automatiquement par l'UI.

- **Impacts & dépendances :** `MarkdownMessage.tsx`, `MessageBubble.tsx`,
  `AiPanel.tsx`, `AgentModeView.tsx`, `TerminalPanel.tsx`, `Terminal.tsx`. Les
  autres appelants de `MarkdownMessage` (aperçu Markdown, `DocViewPanel`,
  `ReasoningBlock`, `ToolCallCard`) ne passent pas les nouvelles props : aucun
  bouton `Run`/insert n'y apparaît — comportement inchangé.

- **Vérifications :** `npx tsc --noEmit` → seule l'erreur **préexistante** du bench
  (`clineSidecar.ts` — `CONVERGENCE` non lu) subsiste ; `npx vitest run src/lib` →
  **818/818 verts (58 fichiers)**.

- **Prochaines étapes :** **Lot E** (index sémantique embeddings) toujours en
  attente de discussion avant implémentation.

---

### [2026-10-20T22:15] | Éditeur — ouverture depuis l'explorateur, lecture média, bloc de code épuré

- **Contexte :** trois demandes d'AFFICHAGE, **comportement de l'agent inchangé** :
  1. *« dans l'éditeur met en place la lecture des fichiers audio mp3 et tout le reste »* ;
  2. *« peu importe où je suis, quand je clique sur un fichier dans l'explorateur ça
     ouvre le fichier dans l'éditeur »* ;
  3. *« quand ça affiche code, ça doit être plus pro, et retirer le Apply »*.

- **Diagnostic :**
  - **Audio :** les lecteurs (`ImageViewerPane`, `PdfViewerPane`, `VideoViewerPane`,
    `AudioViewerPane`) et le routage par `fileKindOf` étaient **déjà** en place dans
    les deux layouts (`EditorArea.tsx`, `AgentModeView.tsx`), tout comme la lecture
    base64 (`useTabs` → `readFileBase64`). Le vrai défaut était l'**accès** : en mode
    IA, l'éditeur n'est rendu que si `activeToolTab === "editor"`, si bien qu'un clic
    explorateur depuis une autre surface (chat, navigateur, terminal…) créait
    l'onglet **sans l'afficher**. La demande « lecture audio » était donc un symptôme
    du même bug.
  - **Bloc de code :** le composant `CodeBlock` (dans `MarkdownMessage.tsx`) exposait
    deux actions (`Copy` + `Apply`), la seconde jugée parasite.

- **Modifications effectuées :**
  - **Ouverture depuis l'explorateur (mode IA).** `AgentModeView.tsx` : nouveau
    `handleOpenFile(path)` qui (a) suspend le suivi automatique de surface
    (`flowPausedRef.current = true`), (b) ouvre l'onglet (`openTab`), (c) active la
    surface éditeur (`openToolTab("editor")`). `Sidebar` reçoit désormais
    `onFileOpen={handleOpenFile}`. Résultat : un clic explorateur affiche toujours
    l'éditeur, quelle que soit la surface active.
  - **Bloc de code épuré.** `MarkdownMessage.tsx` : retrait du bouton **`Apply`** et
    de la détection de chemin cible (`findFilePathFor`) ; barre d'en-tête resserrée
    (padding, `textTransform: lowercase`, `userSelect: none`), `type`/`title`/`aria-label`
    sur le bouton `Copy`, `tabSize: 2` sur le `pre`. Le rendu reste sobre (pas de
    coloration syntaxique : le contenu est arbitraire).
  - **Suppression de la chaîne morte `onApplyCode`** de bout en bout (approche sans
    biais : on retire le câblage, on ne masque pas le bouton) :
    `MarkdownMessage.tsx` (prop supprimée), `MessageBubble.tsx` (prop + `makeApplyCode` +
    `resolveTargetPath`), `DocViewPanel.tsx` (prop), `AiPanel.tsx` (props + ref/effet
    morts), `AgentModeView.tsx` (passage de props) et `App.tsx` (`handleApplyCode`
    + machinerie `pendingDiffRef`/`pendingDiffTick` devenues orphelines).

- **Décisions techniques :**
  - **Corriger l'accès, pas dupliquer le lecteur.** Aucun nouveau composant média :
    on réutilise le routage `fileKindOf` existant. La cause racine était la surface
    active, pas l'absence de lecteur.
  - **Suspension du Flow à l'ouverture manuelle.** Cohérent avec `selectToolTab` :
    quand l'utilisateur agit lui-même, on ne laisse pas l'agent lui reprendre la
    surface des yeux.
  - **Nettoyage complet plutôt que masquage.** Retirer `onApplyCode` jusqu'à
    `App.tsx` évite de laisser une API fantôme et supprime du code mort
    (`pendingDiffRef`/`pendingDiffTick`, effets associés).

- **Impacts & dépendances :** `AgentModeView.tsx`, `MarkdownMessage.tsx`,
  `MessageBubble.tsx`, `DocViewPanel.tsx`, `AiPanel.tsx`, `App.tsx`. Aucun changement
  de protocole agent ni de prompt. Les warnings eslint `flowPausedRef.current` de
  `AgentModeView` sont **préexistants** (même patron que `selectToolTab`) et non
  introduits ici.

- **Vérifications :** `npx tsc --noEmit` → seule l'erreur **préexistante** du bench
  (`bench/coding/headless/clineSidecar.ts` — `CONVERGENCE` non lu) subsiste ;
  `npx vitest run src/lib` → **818/818 verts (58 fichiers)**.

- **Prochaines étapes :** **Lot E** (index sémantique embeddings) toujours en attente
  de discussion avant implémentation.

---

### [2026-10-20T21:05] | Affichage agent — navigateur, rafraîchissement explorer, rendu document

- **Contexte :** trois défauts d'AFFICHAGE signalés, **sans toucher au comportement de
  l'agent** (*« on change rien sur l'agent juste l'affichage »*) :
  1. le navigateur de l'agent ouvrait le **port local** au lieu de l'URL demandée ;
  2. l'**explorateur ne se rafraîchissait pas** quand l'agent écrit un fichier ;
  3. le **message final** et les sorties de commandes n'étaient pas rendus
     « humain » (tableaux, mise en forme type document).

- **Modifications effectuées :**
  - **NAV — navigateur routé par le store.** `clineClient.ts` : interception de
    `browser_navigate` dans `respondToInvoke` AVANT la résolution générique de
    `panelId`. L'URL est normalisée, `external = !isLoopbackUrl(url)` ; l'externe
    n'est permis que si `loadPermissionMode() === "full"`. On appelle
    `navigateActiveOrCreate(url)` (source de vérité = store `previewTabs`), puis
    `requestPreviewFocus()` et `invoke("browser_navigate", { …, allow_external })`.
    Helper `isLoopbackUrl` (localhost/127.0.0.1/0.0.0.0/::1).
  - **WATCH — watcher OS.** Nouveau module Rust `fs_watch.rs` (crate `notify` :
    FSEvents/inotify/ReadDirectoryChangesW). Une seule racine surveillée à la fois,
    canonicalisée, dossier existant requis ; dossiers bruyants filtrés via
    `SEARCH_IGNORE` ; payload = dossiers PARENTS dédupliqués et plafonnés
    (`MAX_DIRS_PER_EVENT`). Commandes `watch_workspace` / `unwatch_workspace` /
    `watch_status`, état géré par Tauri, `Cargo.toml` (`notify = "6"`) et `lib.rs`
    mis à jour. Pont front `src/lib/explorer/fsWatch.ts` (`listen("fs://changed")`
    → `notifyExplorerDirsChanged`), armé dans `App.tsx` (armement unique + suivi du
    `folderPath`).
  - **SAVE — écritures éditeur.** `useTabs.ts` : `handleSave` et `handleSaveAs`
    émettent vers `refreshBus` après écriture, en réutilisant le debounce existant
    de `useExplorer` (120 ms).
  - **MD — rendu document.** `MarkdownMessage.tsx` : échelle de titres h1–h4,
    paragraphes/listes aérés (lineHeight 1.7), blockquote contrasté, tableaux
    enrichis (en-tête sur fond actif, bordures, padding). `ToolCallCard.tsx` : le
    panneau replié affiche la ligne `$ command` PUIS la sortie rendue via
    `MarkdownMessage` (document) ; repli en mono pour les sorties non-commandes.

- **Décisions techniques :**
  - La **politique de navigation vit côté front**, source unique, et est transportée
    au Rust via `allow_external` — Rust reste une défense en profondeur (il refuse
    le non-loopback sans drapeau). Auto pour loopback, approbation pour l'externe.
  - Le watcher passe par l'**OS** et non par un sondage : un changement produit
    ailleurs (git, outil externe, agent) devient visible sans action de l'utilisateur.
    Bornage strict (une racine, filtre ignore, plafond) pour éviter l'explosion
    d'événements sur `npm install`.
  - Le rendu réutilise `react-markdown`/`remark-gfm` **déjà installés** : on enrichit
    les styles inline existants (aucune dépendance nouvelle, aucun changement agent).

- **Impacts & dépendances :** `clineClient.ts`, `fs_watch.rs`, `Cargo.toml`,
  `lib.rs`, `fsWatch.ts`, `App.tsx`, `useTabs.ts`, `MarkdownMessage.tsx`,
  `ToolCallCard.tsx`. Le watcher Rust ajoute un thread OS par workspace (borné).
  Aucune modification du protocole agent ni des prompts.

- **Prochaines étapes :** **Lot E** (index sémantique embeddings) toujours en attente
  de discussion avant implémentation.

---

### [2026-10-20T20:10] | Chantier architecture agent (Lot C + Lot D) — contrôle qualité & gate de terminaison

- **Contexte :** second chantier demandé — *« en mode IA, l'agent gère-t-il lui-même
  son contexte, a-t-il des checkpoints et de la récupération ? »*, avec l'objectif
  d'un agent autonome capable de travailler sur des projets de plus de 5 millions
  de lignes sans se tromper : explorer, planifier, agir, vérifier, corriger,
  terminer. Cinq piliers posés par l'utilisateur. Audit préalable : boucle agent
  (Lot 3), gestion du contexte (Lot 6 — `tokenBudget`/`compactHistory`/`ContextUsageBar`)
  et checkpoints (Lot 7 — `turnCheckpoint`/`checkpoint.rs`) déjà complets. Décision :
  traiter les lots manquants **lot par lot**, et **différer le Lot E** (index
  sémantique embeddings) pour discussion.

- **Modifications effectuées :**
  - **Lot B (rappel, terminé session précédente) :** outils de compréhension du
    projet exposés à l'agent — `project_overview`, `git_status`, `git_diff`,
    `search_symbols`, `find_imports` (`projectTools.ts` côté sidecar), branchés
    conditionnellement au mode `act` et à la préférence Settings › Agent.
  - **Lot A (terminé session précédente) :** blocs de prompt `PLAN_BEFORE_ACTING`
    et `ANSWER_COHERENCE_RULES` (plan avant édition ; juger la réponse de
    l'utilisateur, re-questionner si vague/contradictoire, ne jamais implémenter
    une décision non prise).
  - **Lot C — Contrôle qualité :**
    - `cline-sidecar/src/qualityTool.ts` : outil `detect_checks` qui lit une liste
      FIGÉE de manifestes (`package.json`, `Cargo.toml`, `pyproject.toml`… via
      `read_file`) et renvoie les commandes de vérification (typecheck/tests/lint/
      build). **Détecte, n'exécute pas.**
    - `cline-sidecar/src/index.ts` : import, `ExtraToolSpec.kind` étendu (`quality`),
      branchement `buildExtraTools`, `TOOL_POLICIES.detect_checks = autoApprove`
      (lecture pure).
    - `clineClient.ts` : handler `read_file` dans `respondToInvoke` (chaîne brute,
      comme `git_diff`) + `read_file` dans `INVOKE_ALLOWLIST`.
    - `AiPanel.tsx` : `wantsQualityTools` + branchement `{ kind: "quality" }`.
    - `agentToolPrefs.ts` : famille `quality` (outil `detect_checks`).
    - `toolPresentation.ts` : `QUALITY_CONTRACT_ACT`, `FULL_TOOL_NAMES` enrichi,
      famille `quality` dans `CONTRACT_LINES_BY_TOOL` et `flattenFamilies`.
    - `clineApproval.ts` (`READ_TOOLS`) et `clineBridge.ts` (`SEARCH_TOOL_NAMES`) :
      `detect_checks` ajouté.
  - **Lot D — Gate de terminaison :**
    - `lib/agent/terminationGate.ts` (nouveau) : `isVerificationCommand`,
      `claimsSuccess` (avec fenêtre anti-négation), `shouldBlockForVerification`,
      `VERIFY_BEFORE_FINISH_REMINDER`.
    - `lib/agent/runState.ts` : trois faits observés par run — `ranVerification`,
      `askedUser`, `verificationGuardFired` (collant).
    - `AiPanel.tsx` : collecte des faits dans `case "tool-call"` ; à la clôture
      (`case "finish"`), si le tour a écrit sans vérifier et revendique un succès,
      on REFUSE le `finish` et on relance un tour de vérification (une seule fois).
    - `__tests__/terminationGate.test.ts` (nouveau) : 13 tests.

- **Décisions Techniques :** (a) **`detect_checks` DÉTECTE, ne lance pas** — un seul
  chemin d'exécution (`run_commands`, non auto-approuvé) : pas de duplication de
  politique, l'utilisateur garde le contrôle des commandes. (b) **Gate fondé sur
  des faits observables** (a-t-on écrit ? a-t-on exécuté un check ?), jamais sur la
  seule formulation — anti-biais. (c) **Une seule relance** (`verificationGuardFired`)
  pour ne jamais boucler ; (d) **abstention** si l'outillage de contrôle est coupé
  (un gate sans échappatoire serait un piège). (e) Négation gérée dans
  `claimsSuccess` : un aveu d'échec (« not done ») n'est pas une revendication.
  (f) Budget prompt : agent/max = 9906 caractères, sous le plafond documenté de
  10000 (test `prompts.metrics`).

- **Impacts & Dépendances :** côté sidecar `qualityTool.ts`, `index.ts` ; côté front
  `clineClient.ts`, `AiPanel.tsx`, `runState.ts`, `agentToolPrefs.ts`,
  `toolPresentation.ts`, `clineApproval.ts`, `clineBridge.ts`, `terminationGate.ts`.
  Effet de bord : un nouveau tour peut s'enchaîner automatiquement après un `finish`
  (relance de vérification) — visible dans le fil comme un tour de suivi.

- **Vérifications :** `npx tsc --noEmit` (propre hors `bench/` pré-existant),
  `tsc --noEmit` sidecar (propre), `cargo check` (OK), `npx vitest run src/lib`
  (**818 tests verts**), budget prompt mesuré 9906 < 10000.

- **Prochaines étapes :** **Lot E** (index sémantique embeddings) — à DISCUTER avant
  toute implémentation, comme convenu avec l'utilisateur.

---

### [2026-10-20T19:55] | Badge de contexte du chat : clic direct → surlignage (bug de garde)

- **Contexte :** *« j'ai sélectionné un fichier, c'est dans l'input c'est bon,
  mais quand je reclique dessus ça ne met pas l'élément en surbrillance ; je dois
  pouvoir cliquer dans l'input pour être sûr d'avoir sélectionné le bon élément,
  comme sur Trae »*.

- **Modifications effectuées :**
  - `ChatBox.tsx` — **tout le badge** est désormais cliquable (nom de fichier +
    libellé de plage), plus seulement la petite icône ⤢ : le `onMouseDown` de
    révélation est remonté sur le conteneur du badge, `cursor: pointer`, et le
    bouton de fermeture (✕) fait `stopPropagation` pour ne pas déclencher la
    révélation. L'icône ⤢ devenue redondante est retirée.
  - `Editor.tsx` — **correction du bug de garde** : la vérification comparait
    `sliceDoc(ligneDébut.from, ligneFin.to) !== code`, c'est-à-dire le **texte des
    lignes entières** à la **sélection seule** (qui est un sous-ensemble des
    lignes). L'égalité était donc toujours fausse → aucun surlignage. On localise
    maintenant la sélection exacte par `indexOf` dans la plage de lignes et on ne
    surligne que ce fragment.

- **Décisions Techniques :** (a) **Badge entièrement cliquable** : une cible de
  quelques pixels (l'icône) est contraire à l'usage attendu et à Trae ; (b)
  **localisation par sous-chaîne** plutôt qu'égalité stricte : le contexte épinglé
  porte la sélection, la plage porte les lignes — l'inclusion est la bonne
  relation, pas l'égalité. Un `indexOf < 0` (contenu absent) abandonne proprement,
  garantissant qu'on ne surligne jamais le mauvais code.

- **Impacts & Dépendances :** `ChatBox.tsx`, `Editor.tsx`.

- **Vérifications :** `npx tsc --noEmit` (propre hors `bench/`), diagnostics IDE
  sans erreur.

- **Prochaines étapes :** aucun. Cas résiduel connu : si le fichier épinglé n'est
  plus l'onglet actif, le surlignage ne s'applique qu'à l'onglet actif — envisager
  plus tard d'ouvrir automatiquement l'onglet du fichier concerné.

---

### [2026-10-20T19:35] | Éditeur : surbrillance de ligne active adoucie + popup inline proche de la sélection

- **Contexte :** deux retours d'ergonomie :
  1. *« quand on met le curseur sur un élément dans l'éditeur, la couleur de
     surbrillance fait mal aux yeux, c'est trop fort »* → la ligne active utilisait
     `--origin-bg-hover` (`#ffffff1a` en sombre, `#0000001a` en clair), soit 10 %
     d'opacité — trop marqué sur les fonds purs ; la sélection native
     (`bg.selection-focused`) était elle aussi très saturée ;
  2. *« même l'input inline est trop éloigné »* → la popup d'instruction
     « Edit inline » était centrée en haut de l'éditeur, à l'opposé du code.

- **Modifications effectuées :**
  - **Nouveau token de thème `bg.editor-line-highlight`** — `#ffffff0d` (sombre) /
    `#0000000d` (clair), soit ~5 % : deux fois plus discret que l'ancien hover.
    Ajouté aux deux thèmes et mappé sur `editor.lineHighlightBackground` dans
    `vscodeTheme.ts` (import de thèmes VS Code). Token dédié plutôt que modifier
    `--origin-bg-hover` : celui-ci sert à tous les hovers de panneaux, on ne
    dégrade pas le reste de l'UI.
  - `Editor.tsx` — `.cm-activeLine` / `.cm-activeLineGutter` utilisent désormais
    `var(--origin-bg-editor-line-highlight, var(--origin-bg-hover))` (repli sur
    l'ancien token si un thème importé ne définit pas le nouveau).
  - `Editor.tsx` — sélection de texte adoucie : `.cm-selectionBackground` (y
    compris l'état focalisé) et `::selection` passent à un
    `color-mix(accent-blue 22-26 %, transparent)` au lieu du bleu saturé.
  - `Editor.tsx` — la popup inline d'« Edit inline » **suit la sélection** (top =
    fin de sélection + 6 px, `left` = bord gauche − 12 px, clamp aux bords du
    conteneur) au lieu d'être centrée en haut ; cohérent avec la barre d'actions.

- **Décisions Techniques :** (a) **Token dédié** pour la ligne active : ne pas
  casser les hovers de panneaux qui partagent `--origin-bg-hover`. (b) Estimations
  en `color-mix` sur `accent-blue` : un seul point de vérité pour la teinte de
  sélection, lisible sur tous les thèmes, avec repli explicite pour les thèmes
  importés qui n'auraient pas le nouveau token. (c) La popup suit la sélection
  avec clamp : même logique que la barre d'actions, jamais hors écran ni sur le code.

- **Impacts & Dépendances :** `Editor.tsx`, `themes/origin-dark/theme.json`,
  `themes/origin-light/theme.json`, `themes/vscodeTheme.ts`.

- **Vérifications :** `npx tsc --noEmit` (propre hors `bench/`), diagnostics IDE
  sans erreur.

- **Prochaines étapes :** si des thèmes importés (VS Code) n'exposent pas
  `editor.lineHighlightBackground`, le repli sur `--origin-bg-hover` s'applique —
  vérifier au besoin que l'intensité reste acceptable sur ces thèmes.

---

### [2026-10-20T19:15] | Sélection épinglée : surbrillance persistante + barre d'actions à portée

- **Contexte :** deux retours utilisateur sur le geste « sélection → IA » :
  1. après « Add to AI », l'utilisateur n'a aucune confirmation visuelle dans
     l'éditeur : la sélection native disparaît au blur → impossible d'être sûr de
     ce qui a été envoyé. Il demande qu'un clic sur le badge du chat remette
     l'élément **en surbrillance** ;
  2. la barre « Add to AI / Edit inline », ancrée en haut-à-droite, était **trop
     éloignée** de la sélection (à l'autre bout de l'écran) : « on ne voit
     presque pas ».

- **Modifications effectuées :**
  - `src/components/editor/Editor.tsx` —
    - nouveau `StateField` `pinnedSelectionField` (+ `StateEffect` `setPinnedRange`) :
      décoration `mark` de fond, **indépendante de la sélection native** de
      CodeMirror, donc persistante au blur. La plage est remappée à chaque
      édition (`tr.changes.mapPos`) et effacée à la première interaction de
      l'utilisateur (clic, saisie) ou après 8 s (minuterie nettoyée au démontage).
    - `highlightPinnedSelection()` / `clearPinnedSelection()`.
    - `addSelectionToAi()` déclenche la surbrillance après l'épinglage.
    - la barre d'actions **suit la fin de la sélection** : ancre écran recalculée
      dans l'`updateListener` (`coordsAtPos(sel.to)` — `selectionSet` /
      `docChanged` / `geometryChanged`), avec repli en haut-à-droite si l'ancre
      est inconnue et **clamp** aux bords du conteneur pour ne jamais sortir.
    - `useEffect` abonné à `onRevealSelection` : surligne + scrolle + focus la
      plage demandée par le chat, **uniquement si le fichier (basename) et le
      contenu correspondent encore** (garde anti-dérive).
  - **nouveau `src/lib/selectionRevealBus.ts`** : `revealSelection()` /
    `onRevealSelection()` — `CustomEvent` window `origin:reveal-selection`
    (même pattern que `gitDiffBus` / `origin:git-changed`). Le `ChatBox` vit dans
    le panneau IA, sans accès à la vue CodeMirror : ce bus évite de faire
    remonter une prop à travers toute la hiérarchie.
  - `src/components/ai/ChatBox.tsx` — bouton `Map` (⤢) dans le badge de contexte :
    au clic, émet `revealSelection({ filename, startLine, endLine, code })`
    (ignoré pour une sélection terminal). `onMouseDown` + `preventDefault` pour
    ne pas voler le focus de l'input.
  - `src/index.css` — classe `.origin-pinned-selection` : fond accentué
    (`color-mix` accent 28 %) + liseré, pour un rendu lisible sur tous les thèmes.

- **Décisions Techniques :** (a) **Décoration dédiée** plutôt que de forcer la
  sélection native : la sélection CodeMirror est effacée par le navigateur au
  blur, une décoration est le seul moyen fiable de « figer » visuellement la
  plage. (b) **Bus window** pour le badge ↔ éditeur (découplage panneau IA ↔
  éditeur, cohérent avec l'existant). (c) **Barre qui suit la sélection** avec
  clamp et repli : proximité voulue par l'utilisateur sans jamais recouvrir le
  code (elle est placée *après* la fin de la sélection) ni sortir de l'écran.
  (d) **Garde de correspondance** (basename + contenu) avant de surligner : on ne
  ment jamais sur ce qui est épinglé.

- **Impacts & Dépendances :** `Editor.tsx`, `ChatBox.tsx`,
  `selectionRevealBus.ts` (nouveau), `index.css`.

- **Vérifications :** `npx tsc --noEmit` (propre hors `bench/`),
  `npx vitest run src/lib` (805 tests OK), diagnostics IDE sans erreur.

- **Prochaines étapes :** si un fichier est renommé/déplacé entre l'épinglage et
  le clic, la garde par basename ne retrouve plus la plage → aucun surlignage
  (comportement sûr) ; envisager plus tard d'ajouter le chemin absolu à
  `EditorContext` pour lever toute ambiguïté entre homonymes.

---

### [2026-10-20T18:40] | Git : bug « not a git repository », sélection → IA, diff cliquable, icônes

- **Contexte :** plusieurs retours utilisateur sur la partie Git et l'éditeur :
  1. blocage total : *« This folder is not a git repository. Initialize git first
     (git init) »* alors que le dépôt **est** initialisé ;
  2. aucune action IA quand on sélectionne du code dans un fichier (il faut « Add
     to AI » **et** « Edit inline » comme Trae) ;
  3. cliquer sur un fichier modifié dans le panneau Source Control **n'ouvre pas
     le diff** (VS Code le fait) ;
  4. les lignes du panneau Git affichent des icônes génériques au lieu des vraies
     icônes de type de fichier (comme l'explorateur).

- **Modifications effectuées :**
  - **Bug Git (cause racine) — `src-tauri/src/git.rs` :** une app Tauri lancée
    depuis le Finder n'hérite PAS du `PATH` du shell → `git` (Homebrew,
    `/opt/homebrew/bin`) introuvable → l'erreur « not a git repository » était
    **mensongère**. Correctif : `git_cmd()` applique
    `cmd.env("PATH", crate::env_path::enriched_path_os())`. Ajout de la variante
    `CommitDiffResult::GitUnavailable` pour distinguer « git absent » de
    « pas un dépôt » (ne plus mentir au client).
  - **Sélection → IA (`src/components/editor/Editor.tsx`) :** barre flottante
    ancrée **à droite fixe** (`top:8, right:12`) — jamais au-dessus du texte —
    avec deux boutons « Add to AI » (`Sparkles`) et « Edit inline » (`Wand2`),
    `onMouseDown` + `preventDefault` pour lire la sélection avant que le clic ne
    la vide. « Edit inline » ouvre une popup centrée (Entrée = générer, Échap =
    fermer) ; l'IA réécrit **uniquement la sélection**.
  - **nouveau `src/lib/inlineEdit.ts` :** `editSelectionInline()` — prompt
    `INLINE_EDIT_SYSTEM_PROMPT` (réécrit la sélection, sortie = code brut,
    préserve indentation/guillemets, pas d'imports superflus, renvoie inchangé si
    impossible). Résolution du modèle via `resolveActiveModelTarget` (source
    unique : sélection UI > localStorage > `.env` > défaut).
  - **Diff ciblé (accept/reject durci) :** `applyInlineDiff` remplace **seulement
    la plage** sélectionnée et reconfigure la merge view avec `original` = texte
    d'origine de la sélection ; vérifie que la plage n'a pas bougé entre-temps
    (sinon toast + abandon, pour ne jamais appliquer un diff sur du texte
    décalé).
  - **Diff Git cliquable :** nouveau bus `src/lib/gitDiffBus.ts`
    (`origin:open-git-diff`, `{ filePath, repoPath }`) — le panneau latéral n'a
    pas accès aux onglets de l'éditeur, on passe donc par un `CustomEvent` window
    (même pattern que `origin:git-changed`). `SourceTreePanel` émet,
    `App.tsx` écoute → `useTabs.openGitDiffTab()` ouvre l'onglet
    `__gitdiff__<filePath>` (`kind: 'git-diff'`, icône `GitCompare` dans la
    `TabBar`).
  - **nouveau `src/components/editor/GitDiffPane.tsx` :** lecture seule (parité
    VS Code) ; lit le working tree (`readFile`) + HEAD (`gitFileHead` +
    `relativeToRoot`) puis construit un `unifiedMergeView({ original,
    highlightChanges:true, collapseUnchanged:{margin:3,minSize:4} })`. Gère
    untracked (original `''`), fichier supprimé (current `''`), loading, erreur.
    Rendu dans `EditorArea.tsx` **et** `AgentModeView.tsx` (le mode IA ne le
    rendait pas → l'onglet aurait été invisible en mode IA).
  - **Vraies icônes (`src/components/SourceTreePanel.tsx`) :** `<FileIcon
    name={fileName} size={13} />` sur chaque ligne (réutilise le composant de
    l'explorateur) ; `e.stopPropagation()` sur tous les boutons d'action
    (stage/unstage/discard/confirmer/annuler) pour qu'ils ne déclenchent plus
    l'ouverture du diff.

- **Décisions Techniques :** (a) **PATH enrichi côté Rust**, pas côté JS : le
  sous-process `git` doit hériter d'un PATH utilisable quel que soit le mode de
  lancement du binaire. (b) **Distinguer** `not-a-repo` de `git-unavailable` :
  un message faux est pire qu'un message manquant. (c) **Diff ciblé** sur la
  sélection plutôt que de réutiliser `showDiff` (qui remplace tout le document) :
  on n'affecte que la plage sélectionnée, avec garde anti-décalage. (d) **Bus
  window** pour découpler le panneau latéral des onglets (pas de prop drilling ni
  de couplage sidebar ↔ éditeur). (e) Réutilisation de `FileIcon` : une seule
  source d'icônes pour l'explorateur et la partie Git.

- **Impacts & Dépendances :** `git.rs`, `Editor.tsx`, `gitDiffBus.ts` (nouveau),
  `inlineEdit.ts` (nouveau), `GitDiffPane.tsx` (nouveau), `useTabs.ts`,
  `EditorArea.tsx`, `AgentModeView.tsx`, `TabBar.tsx`, `App.tsx`,
  `SourceTreePanel.tsx`.

- **Vérifications :** `cargo check` (exit 0), `npx tsc --noEmit` (propre hors
  `bench/`), `npx vitest run src/lib` (805 tests OK), diagnostics IDE sans erreur.

- **Prochaines étapes :** surveiller le comportement de `GitDiffPane` sur de très
  gros fichiers (collapse des zones inchangées) ; le diff est en lecture seule —
  si l'édition depuis le diff devient nécessaire, passer par un merge view
  éditable partagé avec l'éditeur.

---

### [2026-10-20T16:05] | Terminal : bouton « Add to AI » sur la sélection

- **Contexte :** sélectionner une ligne dans le terminal ne proposait aucune action
  pour l'envoyer au chat, contrairement à l'éditeur (qui a « Add to AI context »
  via menu contextuel). L'utilisateur voulait le même geste que Trae : sélection →
  bouton flottant → la sélection alimente l'input du chat avec un prompt.

- **Modifications effectuées :**
  - `src/components/editor/Editor.tsx` — `EditorContext.type` accepte désormais
    `'terminal'` en plus de `'selection' | 'viewport'`.
  - `src/components/terminal/Terminal.tsx` — nouvelle prop `onAddSelectionToAi`.
    Écoute `xterm.onSelectionChange` ; si une sélection non vide existe, convertit
    la position de cellule (`getSelectionPosition`) en pixels via la taille de
    cellule réelle (`.xterm-screen`) et affiche un bouton flottant « Add to AI »
    au-dessus de la sélection. `onMouseDown` + `preventDefault` : on lit la
    sélection AVANT que le clic ne la vide. Cleanup du disposable.
  - `src/components/terminal/TerminalPanel.tsx` — prop `onAddSelectionToAi`
    relayée à chaque instance de terminal.
  - `src/components/ai/AgentModeView.tsx` et `src/App.tsx` — branchent le terminal
    sur le canal EXISTANT « contexte épinglé » (`setPinnedContext`) déjà utilisé par
    l'éditeur ; construction d'un `EditorContext` `{ filename: "Terminal",
    language: "shell", type: "terminal" }`.
  - `src/components/ai/AiPanel.tsx` — `buildContextPrefix` gère `type === "terminal"` :
    bloc `[Terminal selection]` + fence `shell` (sinon le modèle croirait à un
    fichier nommé « Terminal »).
  - `src/components/ai/ChatBox.tsx` — `contextLabel` renvoie « Terminal » (au lieu
    de « L0 ») et l'icône du badge devient `SquareTerminal` pour ce type.

- **Décisions Techniques :** AUCUNE voie parallèle. On réutilise le canal unique
  `onAddToAiContext` → `setPinnedContext` → `forcedContext` → `contextSnap`, déjà
  emprunté par l'éditeur : le terminal ne connaît pas le chat, il remonte juste son
  texte. Cela garantit que la sélection terminal bénéficie du MÊME traitement
  (badge, injection dans l'API, envoi) que le contexte éditeur, sans duplication.
  Le `type: 'terminal'` évite les faux libellés de lignes (L0) et un fence erroné.

- **Impacts & Dépendances :** `EditorContext` (type élargi, rétrocompatible),
  `Terminal`, `TerminalPanel`, `AgentModeView`, `App`, `AiPanel`, `ChatBox`.

- **Prochaines étapes :** surveiller le placement du bouton en cas de zoom
  important ou de sélection multi-lignes très haute.

---

### [2026-10-20T15:55] | Terminal en onglet (mode IA) : occupe enfin toute la hauteur

- **Contexte :** en mode IA, le terminal est affiché comme un ONGLET plein écran
  (pas comme le panneau bas de l'éditeur). Il rendait pourtant une hauteur figée
  (`height` persistée) avec `flexShrink: 0`, laissant une grande zone vide sous
  lui alors que le conteneur disposait de toute la hauteur.

- **Modifications effectuées :**
  - `src/components/terminal/TerminalPanel.tsx` — nouvelle prop `fill` (défaut
    `false`). Quand `true`, le panneau rend `height: 100%` + `flex: 1` +
    `minHeight: 0` au lieu de la hauteur persistée ; la poignée de
    redimensionnement vertical est masquée (une hauteur qui remplit l'espace n'est
    pas réglable). Le `ResizeObserver` interne du xterm (`FitAddon`) adapte
    automatiquement le nombre de lignes/colonnes.
  - `src/components/ai/AgentModeView.tsx` — passe `fill` au terminal rendu en
    onglet.
  - `src/App.tsx` — inchangé : le panneau bas de l'éditeur reste `fill={false}`
    (hauteur redimensionnable conservée, comportement attendu pour un panneau
    ancré).

- **Décisions Techniques :** on distingue explicitement « panneau bas ancré »
  (hauteur libre, redimensionnable) de « onglet plein écran » (remplit l'espace).
  Forcer `100%` partout aurait cassé le resize du panneau bas ; forcer la hauteur
  figée partout créait le vide observé. La prop `fill` traduit cette distinction
  sans détour.

- **Impacts & Dépendances :** `TerminalPanel` (nouvelle prop optionnelle,
  rétrocompatible), `AgentModeView`. Aucun impact sur le layout du panneau bas.

- **Prochaines étapes :** surveiller l'usage de `fill` si d'autres contextes
  affichent le terminal plein cadre.

---

### [2026-10-20T15:50] | « No changes to describe » mensonger : diff typé + diagnostic exact

- **Contexte :** l'utilisateur obtenait « No changes to describe » alors que le
  panneau Source Control ne listait aucun fichier. Cause : le diff ET le statut
  git étaient calculés de façon à confondre plusieurs situations distinctes —
  « pas un dépôt git », « dépôt propre », et « échec d'appel IPC ». L'utilisateur
  demandait aussi que le message de commit suive les bonnes pratiques.
  Il proposait de « créer un plugin Cline » pour surcharger ce message.

- **Décisions Techniques (refus du détour) :** un « plugin Cline » n'est PAS la
  bonne approche. Cline est un agent conversationnel ; surcharger un message
  d'erreur via un plugin serait un détour lourd, fragile et hors périmètre. La
  cause réelle est un manque de DIAGNOSTIC côté source (Rust/TS), pas un défaut de
  Cline. Corrigé à la source, sans biais architectural.

- **Modifications effectuées :**
  - `src-tauri/src/git.rs` — `git_commit_diff` renvoie désormais un
    `CommitDiffResult` typé et sérialisé (`diff` / `no-changes` / `not-a-repo`) au
    lieu d'une `String`. Vérification explicite `rev-parse --is-inside-work-tree`
    pour distinguer « pas un dépôt » de « dépôt propre ». Le type agit comme
    source de vérité côté backend (là où l'information est réellement connue).
  - `src/lib/git.ts` — `gitCommitDiff` renvoie `CommitDiffResult` (union TS) ;
    un échec d'invoke est remonté comme `not-a-repo` au lieu d'être avalé par
    `.catch(() => '')` (qui mentait en affichant « no changes »).
  - `src/lib/agent/activeModel.ts` — `LlmActionFailure` gagne la raison
    `not-a-repo`.
  - `src/lib/gitCommitMessage.ts` — traduit `CommitDiffResult` en
    `LlmActionFailure` (`not-a-repo` → `not-a-repo`, `no-changes` → `empty-input`).
    Le prompt système reste conforme « Conventional Commits » (déjà en place :
    type/scope/impératif, `!` en cas de rupture, ≤ 50/72 caractères, langue
    alignée sur l'historique).
  - `src/components/SourceTreePanel.tsx` — toast dédié pour `not-a-repo`
    (« This folder is not a git repository… ») distinct de « No changes ».

- **Impacts & Dépendances :** changement de contrat IPC (`git_commit_diff`) et du
  type de retour `gitCommitDiff`. Un seul appelant TS (`generateCommitMessage`),
  mis à jour. Rétro-compatibilité non nécessaire (app interne, déployé ensemble).

- **Sécurité :** aucune nouvelle surface — les args restent passés via
  `Command::args` (pas de shell) ; la distinction `not-a-repo` évite d'envoyer un
  diff vide au réseau ; `no-provider` continue de bloquer tout envoi sans clé.

- **Prochaines étapes :** si l'utilisateur est bien dans un dépôt propre, le
  message désormais affiché sera « No changes to describe. » (correct) ; sinon
  « not a git repository » (actionnable : `git init`).

---

### [2026-10-20T15:40] | Échecs IA explicites + optimisation de prompt réellement améliorante

- **Contexte :** deux retours d'usage :
  1. Le message « No changes to describe, or no AI provider is configured in
     Settings. » est ambigu : impossible de savoir si le problème vient du dépôt
     (diff vide) ou de la configuration IA.
  2. L'optimisation de prompt « n'améliore pas vraiment » : le prompt système
     interdisait tout ajout, donc le modèle se contentait de reformuler à peine.

- **Modifications effectuées :**
  - `src/lib/agent/activeModel.ts` — ajout des types `LlmActionFailure`
    (`no-provider` | `empty-input` | `call-failed`) et `LlmActionResult`
    (`{ ok: true, text }` | `{ ok: false, reason, detail? }`).
  - `src/lib/gitCommitMessage.ts` — `generateCommitMessage` renvoie
    `LlmActionResult` au lieu de `string | null` : diff vide → `empty-input`,
    provider sans clé → `no-provider`, exception provider → `call-failed` (avec
    `detail`). Sortie modèle vide → `call-failed`.
  - `src/components/SourceTreePanel.tsx` — toasts PRÉCIS par cause au lieu du
    message unique ambigu.
  - `src/lib/promptOptimizer.ts` — retour typé + **prompt système réécrit** :
    il AUTORISE désormais la structuration (objectif, livrable, critères
    d'acceptation, étapes) — ce qui rend le prompt exploitable — tout en
    INTERDISANT l'invention de technos/chemins/exigences non exprimés. Ajout d'un
    `projectContext` facultatif (racine du workspace) pour ancrer les références
    sans supposer l'existence de fichiers.
  - `src/components/ai/ChatBox.tsx` — `handleOptimizePrompt` consomme le résultat
    typé (message précis par cause) et transmet `projectContext` (racine du
    workspace uniquement, aucune lecture disque).

- **Décisions Techniques :**
  - Résultat TYPÉ plutôt qu'un `null` muet : le diagnostic devient possible côté
    utilisateur sans deviner, et interdit de confondre deux causes distinctes.
  - Prompt d'optimisation : ligne rouge explicite entre « structurer/reformuler »
    (autorisé, c'est le but) et « décider à la place de l'utilisateur » (interdit).
    Corrige directement le « pas vraiment amélioré » sans introduire de biais.
  - `projectContext` minimal et honnête (racine seule) : un vrai contexte projet
    complet demanderait une lecture disque ; on ne veut pas que le modèle invente
    des fichiers. Évolution possible : arborescence réelle bornée.

- **Impacts & Dépendances :** `gitCommitMessage` et `promptOptimizer` changent de
  signature de retour (rupture de contrat interne) ; les DEUX appelants ont été
  mis à jour (aucun autre usage). `optimizePrompt` gagne un 4ᵉ paramètre optionnel.

- **Prochaines étapes :** envisager d'enrichir `projectContext` avec une
  arborescence bornée (profondeur limitée) si l'ancrage s'avère insuffisant.

---

### [2026-10-20T15:30] | Actions IA « Améliorer le prompt » et « Générer le message de commit » : alignement sur le modèle du chat

- **Contexte :** les deux icônes IA ne fonctionnaient pas. Cause racine : elles
  construisaient leur modèle LLM différemment du chat, donc appelaient une cible
  invalide ou un défaut figé, indépendamment du provider/modèle réellement choisi
  par l'utilisateur dans la barre de saisie.

- **Modifications effectuées :**
  - `src/lib/agent/activeModel.ts` (nouveau) — `resolveActiveModelTarget(providerId?,
    modelId?)` + `LOCAL_PROVIDER_IDS`. Résolution unique, mêmes priorités que le
    chat : sélection UI > `localStorage` (`origin-ai-*`) > `.env` > défaut app ;
    lit la clé API du provider RÉSOLU et expose `usable`.
  - `src/lib/promptOptimizer.ts` — utilise le helper. Suppression du fallback
    erroné `const mid = modelId ?? pid` (passait un **providerId** comme id de
    modèle) et de la lecture de clé sur un provider deviné.
  - `src/lib/gitCommitMessage.ts` — `generateCommitMessage(repoPath, providerId?,
    modelId?)` ; remplace les défauts figés (`resolveDefaultProvider('anthropic')`,
    `resolveDefaultModel('claude-haiku-4-5-20251001')`) par le helper. Le
    commentaire redevient conforme au comportement.
  - `src/components/ai/ChatBox.tsx` — inchangé sur ce point : il écrit déjà la
    sélection dans `localStorage` (`origin-ai-model`/`origin-ai-provider`), source
    partagée par les deux actions.

- **Décisions Techniques :**
  - Centraliser la résolution dans UN helper plutôt que dupliquer la logique :
    garantit que chat, optimisation et commit utilisent réellement le même modèle
    (exigence « même modèle et même truc que le chat »), et supprime les
    divergences futures.
  - Source de vérité = `localStorage` : c'est déjà ce qu'écrit la barre de modèle,
    et `SourceTreePanel` (commit) est monté indépendamment du panneau AI — il ne
    peut donc pas recevoir la sélection par props sans couplage artificiel.
  - `usable` = provider local OU clé présente : un provider distant sans clé
    renvoie `null` (pas d'envoi réseau), un provider local passe sans clé.
  - Aucune biais introduit : pas de modèle « spécial commit » figé, pas de
    provider imposé.

- **Impacts & Dépendances :** `promptOptimizer`, `gitCommitMessage` et (en
  lecture) `secrets`/`providers`. `gitCommitMessage` gagne deux paramètres
  optionnels : les appels existants restent valides (rétrocompatible par défaut de
  paramètre, sans shim).

- **Prochaines étapes :** surveiller le cas où l'optimisation est demandée alors
  que l'input ne contient QUE des chips de contexte (texte vide → aucune action) :
  comportement volontaire pour l'instant.

---

### [2026-10-20T15:05] | Glisser-déposer un dossier/fichier vers l'input du chat (chip `#Folder` / `#File`)

- **Contexte :** impossible de reproduire le geste Trae « je prends un dossier et je
  le lâche dans l'input, avec un prompt qui l'accompagne ». Deux sources de drag à
  supporter : l'explorateur Mira **et** le Finder/OS.

- **Modifications effectuées :**
  - `src/lib/ai/dragBus.ts` (nouveau) — bus singleton minimal
    (`getPathDrag` / `subscribePathDrag` / `beginPathDrag` / `endPathDrag`), calqué
    sur `refreshBus`. Motif : l'explorateur implémente son drag en **PointerEvents**
    (pas de HTML5 DnD) → aucun `dataTransfer`, donc rien à recevoir via `onDrop`.
  - `src/lib/ai/__tests__/dragBus.test.ts` (nouveau) — 7 tests (transitions,
    abonné monté en plein drag, désabonnement, idempotence).
  - `src/lib/explorer/useExplorer.ts` — `beginDrag` publie `beginPathDrag(paths)`,
    `endDrag` publie `endPathDrag()`.
  - `src/components/explorer/ExplorerTree.tsx` — dans `onUp`, hit-test DOM
    `document.elementFromPoint(x, y)?.closest("[data-chat-drop]")` : si la cible est
    la zone de drop du chat, on émet un `CustomEvent("origin-chat-drop")` (bulles)
    au lieu d'effectuer le drop interne. Évite de dépendre de l'ordre des listeners
    `window` (non garanti).
  - `src/components/ai/ChatBox.tsx` — `dropZoneRef` + `data-chat-drop="1"` ;
    surbrillance `pathDragActive` (bordure pointillée accent) pilotée par
    `subscribePathDrag` ; `handleDropPaths(paths)` classifie chaque chemin
    (dossier vs fichier via `readDir`, jamais l'extension) puis appelle
    `attachContextRef` (chip `#Folder`/`#File`) ; écoute de l'événement interne
    `origin-chat-drop` ; écoute Tauri `getCurrentWebviewWindow().onDragDropEvent()`
    pour le drop Finder, avec hit-test position (px physiques ÷ `devicePixelRatio`).
  - `src/components/ai/AiPanel.tsx` — aucun changement : `resolveContextRefs` gère
    déjà `kind === "folder"` → `invoke("expand_context_folder", …)`, donc une chip
    déposée alimente réellement le contenu du dossier pour l'agent.

- **Décisions Techniques :**
  - Réutiliser `attachContextRef` (le canal `#` existant) plutôt que d'insérer du
    texte brut : une seule voie, pas de doublon de logique, cohérent avec le geste
    Trae demandé (« chip #Folder + prompt »).
  - Bus de drag plutôt qu'un `dataTransfer` : l'arbre et l'input sont des arbres
    React distincts, et le drag interne n'est pas du HTML5 DnD.
  - Délégation par hit-test DOM (et non par ordre de listeners) : déterministe quel
    que soit le moment où la zone de drop s'enregistre.
  - Discrimination fichier/dossier par `readDir` (source de vérité disque) et non
    par devinette sur le suffixe.
  - Drop OS via `onDragDropEvent` (fournit les **chemins absolus**), contrairement à
    `dataTransfer.files` qui ne les expose pas sous Tauri v2.

- **Impacts & Dépendances :** `useExplorer` (drag), `ExplorerTree` (drop interne),
  `ChatBox` (zone de drop + ingestion). Aucune API publique modifiée. Le drop OS
  dépend de `dragDropEnabled` dans `tauri.conf.json` (actif par défaut) : à confirmer
  si un drop Finder reste sans effet.

- **Prochaines étapes :** surveiller le comportement du drop Finder selon la config
  Tauri ; envisager un indicateur de survol identique depuis le Finder (position
  fournie par l'événement, déjà hit-testée au drop).

---

### [2026-10-20T14:15] | Correctifs mode IA/IDE : modal de suppression, hauteur terminal, ordre des messages, chemins cliquables

- **Contexte :** quatre défauts distincts signalés en usage réel :
  1. En mode IA (hors éditeur), la modale de confirmation de suppression d'un
     dossier/fichier n'apparaissait pas : la suppression semblait sans garde-fou.
  2. La hauteur du terminal restait trop petite : coupée sur l'axe Y, elle ne
     descendait pas au fil du contenu.
  3. Au changement de mode (IA ↔ IDE), les messages se « mélangeaient » : on ne
     savait plus où commençait la conversation.
  4. Quand l'agent citait le chemin d'un dossier/fichier (ex. un repo cloné), rien
     n'était cliquable : impossible d'ouvrir ce qu'il venait de créer.

- **Modifications effectuées :**
  - `src/components/FileTree.tsx` — `DeleteConfirmDialog` montée via
    `createPortal(..., document.body)`.
  - `src/components/terminal/TerminalPanel.tsx` — `rootRef` + `ResizeObserver` sur
    `parentElement` → `maxAvailable` ; `renderHeight = max(MIN_HEIGHT,
    min(height, maxAvailable))` utilisée pour le rendu ET le drag.
  - `src/lib/db.ts` — `insertMessage(..., createdAt?)`, écriture de
    `params.createdAt ?? Date.now()` ; `loadMessages` trie par
    `created_at ASC, rowid ASC`.
  - `src/components/ai/AiPanel.tsx` — `turnStartMs` (user = t, assistant = t+1) à
    l'envoi ; réhydratation au montage qui réutilise le miroir `getRunMessages`
    quand un run est vivant ; nouveau `handleOpenPath` + `setFolderPath` du contexte.
  - `src/lib/ai/pathDetection.ts` (nouveau) — `looksLikePath`, `guessPathKind`,
    `extractPathTokens` (purs, testables, sans accès disque).
  - `src/components/ai/MarkdownMessage.tsx` — prop `onOpenPath` ; code inline et
    liens dont l'`href` est un chemin deviennent cliquables ; `linkifyChildren`
    détecte les chemins en texte brut dans `p`/`li`.
  - `src/components/ai/MessageBubble.tsx` — relais de `onOpenPath` vers
    `MarkdownMessage`.
  - `src/lib/ai/__tests__/pathDetection.test.ts` (nouveau) — 13 tests.

- **Décisions Techniques :**
  - **Portail (point 1)** : `position: fixed` ne suffit pas dans un conteneur à
    clipping (`Sidebar` repliée = `width: 0` + `overflow: hidden`). Seul un portail
    vers `document.body` sort l'élément de la chaîne de clipping.
  - **Clamp par espace réel (point 2)** : la hauteur était persistée en
    localStorage sans borne, d'où un débordement après rétrécissement de fenêtre.
    On mesure l'espace réel du parent et on borne le rendu — sans écraser la valeur
    préférée de l'utilisateur (elle reste intacte pour quand l'espace revient).
  - **Ordre déterministe (point 3)** : les inserts user/assistant partaient en
    `Promise.all` → `created_at` identiques possibles → tri SQL non déterministe.
    On fixe un `createdAt` explicite croissant ET on ajoute `rowid` comme
    tiebreaker (ordre d'insertion réel). Le miroir mémoire est réutilisé au montage
    quand un run est vivant, pour ne pas recharger un état divergent.
  - **Chemins cliquables (point 4, choix utilisateur « les deux selon contexte »)** :
    détection PURE de la forme du chemin (aucun accès disque dans le rendu) ;
    l'existence et la nature sont vérifiées au CLIC par l'appelant. Dossier dans le
    workspace → révélé dans le gestionnaire système ; dossier HORS workspace (repo
    cloné ailleurs) → ouvert comme workspace (seul moyen de le voir dans Mira) ;
    fichier → ouvert dans l'éditeur. Aucune ouverture arbitraire : un chemin
    inexistant ne déclenche rien de plus qu'un onglet vide, sans garantie feinte.
  - **Détection stricte** : motifs limités (absolu POSIX/Windows, `./`, `../`,
    projet avec extension, dossier à séparateur final), refus des URL, des schémas
    connus, des mots ordinaires (`et/ou`, `1/2`) et des chemins à espaces internes —
    pour ne pas transformer du texte courant en faux liens.

- **Impacts & Dépendances :**
  - `AiPanel` consomme désormais `setFolderPath` du `WorkspaceContext` : un clic sur
    un dossier hors workspace change le workspace courant (action visible, attendue).
  - `MessageBubble`/`MarkdownMessage` gagnent une prop optionnelle ; sans
    `onOpenPath`, le rendu est strictement identique à avant (rétro-compatible).
  - Le tri `loadMessages` s'appuie sur `rowid` : valable pour la table `messages`
    (rowid-table, PK `id TEXT`). Toute future table sans rowid devrait adapter.
  - Warns ESLint pré-existants (compaction, m°11) non touchés : hors périmètre.

- **Prochaines étapes :** valider manuellement en mode IA : (1) suppression d'un
  dossier affiche la modale, (2) terminal étiré au maximum sans coupe et descend
  au fil de la sortie, (3) aller-retour IA ↔ IDE conserve l'ordre de conversation,
  (4) clic sur un chemin de repo cloné ouvre le workspace / l'éditeur.

---

### [2026-10-20T12:48] | Compaction de contexte sémantique (nettoyage déterministe + résumé LLM persisté)

- **Contexte :** en cliquant « Compact » depuis la jauge de contexte, l'utilisateur
  obtenait « Aucun résultat de lecture périmé à compacter. » L'ancienne compaction
  (`compactHistory`) ne retirait QUE les `read_file` périmés (relus plus tard ou
  invalidés par une écriture). Sur une session majoritairement composée d'écritures,
  de commandes et de recherches, il n'y avait donc strictement rien à retirer : le
  bouton semblait cassé. Ce n'était pas la compaction de Trae, qui **résume** via LLM
  l'historique ancien.

- **Modifications effectuées :**
  - `src/lib/agent/historySummary.ts` (nouveau) : `SUMMARY_SYSTEM_PROMPT` (préserve
    intention/décisions/faits, interdit d'inventer, sort uniquement le résumé, langue
    du fil) ; `recentWindowStart()` (index du premier message de la fenêtre récente,
    **aligné sur une frontière de tour** pour ne jamais couper un couple
    assistant/tool-calls ↔ tool-results) ; `renderTranscript()` (rendu texte compact
    tête 60 % + queue 30 %) ; `summarizeHistory()` (résume la tête, renvoie la queue
    comme historique compacté + `coveredCount`).
  - `src/lib/agent/compactionStore.ts` (nouveau) : persistance **par session** dans
    localStorage (`read/write/clearCompactionSummary`) et `withCompactionSummary()`
    qui préfixe l'historique modèle d'un unique pont `user`+`assistant` portant le
    résumé.
  - `src/lib/agent/compactHistory.ts` : nouvelle `compactLargeToolResults()` —
    vide le contenu des tool results volumineux (`LARGE_TOOL_RESULT_MAX_CHARS = 6_000`)
    **hors** fenêtre récente, quels que soient les outils, non destructif pour le fil
    affiché.
  - `src/components/ai/AiPanel.tsx` : `handleManualCompact` refondu en deux étages
    (1. nettoyage déterministe large ; 2. résumé LLM via `generateText` +
    `buildLanguageModel`), écriture du résumé persisté + `compactionVersion` ;
    `contextTokens` estimé sur ce qui est RÉELLEMENT envoyé (fenêtre récente +
    résumé) ; `handleSend` injecte le résumé (`withCompactionSummary`) ; purge du
    résumé à la suppression de session ; recalcul de la jauge au changement de session.

- **Décisions Techniques :**
  - **Bulles du fil intactes + résumé injecté à côté** (choix utilisateur) : aucune
    réécriture destructrice de la conversation affichée. Conséquence directe : le
    résumé doit être persisté à part (par session) et réinjecté à chaque tour, sinon
    le prochain envoi repartirait de l'historique complet et le gain disparaîtrait.
  - **Pas d'undo** (choix utilisateur) : la compaction est volontairement non
    réversible côté UI ; le résumé reste supprimable via la purge de session.
  - **Fenêtre récente alignée sur une frontière de tour** : couper au milieu d'un
    échange `tool-calls`/`tool-results` produirait un historique modèle invalide.
  - **Source unique du pont de résumé** : `summarizeHistory` ne génère PAS le pont
    (bug de double-injection corrigé) ; seul le store l'injecte.
  - **Jauge = envoi réel** : `contextTokens` reflète fenêtre récente + résumé, pas le
    fil affiché — d'où `compactionVersion` (incrémenté à la compaction ET au
    changement de session) pour forcer le recalcul.

- **Impacts & Dépendances :** touche `AiPanel.tsx` (compaction, envoi, jauge,
  cycle de vie des sessions) et trois modules agent. Dépend de
  `tokenBudget.ts` (`estimateTokens`, `PRESERVE_RECENT_TOKENS`) et de
  `providers.ts` (`buildLanguageModel`). Aucun fichier Rust modifié.

- **Prochaines étapes :** vérifier en `tauri dev` le cycle complet (clic jauge →
  Compact → jauge qui baisse durablement + bannière chiffrée + télémétrie
  `compaction`), y compris la persistance après rechargement et le changement de
  conversation.

---

### [2026-10-20T08:56] | Benchmark de génération de fonctions EvalPlus (HumanEval+ / MBPP+) — modes model-only et agent

- **Contexte :** la mission demandait un benchmark de programmation reproductible
  mesurant **séparément** (1) le modèle seul, (2) le harness, (3) le système complet
  ORVYX Code. Les rotations SWE-bench + LiveCodeBench existaient déjà
  (`bench/coding/swebench`, `bench/coding/livecodebench`) mais **aucune** mesure de
  génération de fonctions (Pass@1) ni de mode « modèle seul » comparable.

- **Modifications effectuées :**
  - `bench/coding/generation/` (nouveau module, 8 fichiers) :
    `types.ts` (contrat versionné + `ErrorClass` à 8 valeurs), `dataset.ts` (chargement
    des datasets RÉELS EvalPlus), `evaluator.ts` (exécution du programme de test
    OFFICIEL dans Docker verrouillé), `modelOnly.ts` (appel HTTP Chat Completions
    standardisé), `agent.ts` (pilotage du sidecar Cline), `results.ts` (JSONL versionné
    + reprise + garde-fou anti-clé-API), `report.ts` (Pass@1, ventilation, médiane/p95,
    coût), `run.ts` (CLI : `--mode=model-only|agent|both`, `--benchmark`, `--limit`,
    `--tasks`, `--runs`, `--resume`).
  - `bench/coding/generation/fetchDatasets.ts` (nouveau) — téléchargement reproductible
    des datasets (HumanEval+ JSONL, MBPP+ parquet→JSONL via pyarrow).
  - `src/lib/agent/__tests__/bench.generation.test.ts` (nouveau) — 42 tests unitaires
    à fixtures déterministes (chargement, extraction de code, ventilation des erreurs,
    métriques, reprise, isolation des clés).
  - `package.json` — scripts `bench:gen`, `bench:gen:datasets`, `bench:gen:quick`.
  - `bench/coding/headless/clineSidecar.ts` — suppression du champ mort `ready`
    (écrit deux fois, jamais lu) qui bloquait `tsc --noEmit`.

- **Décisions Techniques :**
  - **Exécuter le `task.test` officiel EvalPlus** (contient `check(candidate)` et son
    appel final) plutôt que réimplémenter un harness → alignement strict sur le
    protocole officiel, conformément à la consigne.
  - **Image Docker DÉRIVÉE** (`orvyx-gen-eval:latest`, `python:3.11-slim` + numpy)
    construite une fois. Cause racine d'un bug corrigé en cours de route : un
    `docker run --rm python pip install numpy` installe dans un conteneur JETABLE →
    l'étape de test ne voyait jamais numpy → `ModuleNotFoundError` → **échecs attribués
    à tort au modèle**. Le premier run réel a produit un faux `0/3` ; après correction,
    le même sous-ensemble donne `5/5`. C'est la démonstration que la ventilation par
    origine n'est pas cosmétique.
  - **Isolation du code candidat** : `--network none`, `--memory 1g`, `--cpus 1`,
    `--pids-limit 256`, `--read-only`, `--cap-drop ALL`, `--user 65534:65534`, volume
    en lecture seule, timeout dur. Le réseau n'est actif que pendant la construction de
    l'image (étape séparée, avant tout code candidat).
  - **Même prompt et même évaluateur dans les deux modes** → comparaison interprétable.
  - **Honnêteté des valeurs** : `p95 = null` sous 20 échantillons ; coût `null` sans
    tarif explicite (`ORVYX_BENCH_PRICE_*`) — jamais 0 ; `subset:true` systématiquement
    étiqueté ; aucune clé d'API écrite (garde-fou actif dans `results.ts`).

- **Impacts & Dépendances :**
  - Aucune modification du moteur d'agent, de l'UI Tauri/React ni du système de
    fournisseurs. Le module est Node pur, exécutable hors application.
  - Dépendances : Docker (pour l'évaluation) et `pyarrow` (hôte, uniquement pour la
    conversion MBPP+ parquet→JSONL). Le moteur ORVYX Code n'exige toujours pas Python.
  - Datasets versionnés explicitement (`evalplus/humanevalplus@main:test.jsonl`,
    `evalplus/mbppplus@main`), licence Apache-2.0 vérifiée.
  - `clineSidecar.ts` : retrait d'un champ privé inutilisé — sans effet fonctionnel.

- **Prochaines étapes :**
  - Élargir la campagne (HumanEval+ complet 164 tâches, MBPP+ 378) pour un Pass@1
    statistiquement exploitable avec p95.
  - Ajouter un tarif (`ORVYX_BENCH_PRICE_INPUT_PER_M` / `_OUTPUT_PER_M`) pour obtenir
    un coût par tâche réussie réel.
  - Étendre le mode agent avec des tâches nécessitant plusieurs fichiers (au-delà de la
    génération mono-fonction).

---

### [2026-10-20T05:00] | Réparation des deux icônes IA de l'éditeur (commit + optimiser le prompt)

- **Contexte :** deux actions IA étaient **inertes** en production :
  1. l'icône « Generate commit message with AI » (panneau Git) ne produisait rien ou
     affichait « No changes to describe » à tort ;
  2. l'icône en haut à droite de l'input était un `<Sparkles>` **purement décoratif**
     (`pointerEvents:"none"`, aucun handler) — cliquer dessus ne faisait rien.

- **Modifications effectuées :**
  - `src/lib/gitCommitMessage.ts` — **cause racine n°1** : le provider et le modèle
    étaient **codés en dur** (`anthropic` + `claude-haiku-4-5-20251001`). Un utilisateur
    configuré sur OpenAI/Orvyx/Gemini/etc. partait donc toujours vers Anthropic → échec
    (ou null si aucune clé Anthropic). Correction : on résout le provider/modèle depuis
    `localStorage` (`origin-ai-provider` / `origin-ai-model`), **mêmes clés que la barre
    de saisie** — donc l'action IA utilise le modèle réellement choisi par l'utilisateur.
  - `src/components/SourceTreePanel.tsx` — **cause racine n°2** : `aiGenerateMessage`
    décidait « y a-t-il des changements ? » à partir de `getStatusFiles`, qui retombe sur
    `[]` en cas d'erreur IPC → « No changes » trompeur. Désormais l'autorité est le
    **diff** calculé côté Rust (`git_commit_diff`) : le pré-jugement a été supprimé, et
    le message d'échec couvre les deux causes réelles (diff vide **ou** provider absent).
  - `src/lib/promptOptimizer.ts` (nouveau) — `optimizePrompt(draft, providerId?, modelId?)` :
    `generateText` avec un prompt système qui **préserve strictement l'intention**
    (interdiction d'ajouter des exigences non exprimées), nettoie les préfixes/fences
    parasites, renvoie `null` si aucun provider n'est exploitable.
  - `src/components/ai/ChatBox.tsx` — le `<Sparkles>` décoratif devient un vrai
    `<button>` (« Optimize prompt ») : état `optimizing` (un seul appel en vol, icône qui
    tourne), désactivé sur brouillon vide, **masqué pendant une génération**.
    `handleOptimizePrompt` réinjecte le texte via `writeEditorText` et ferme les menus
    d'autocomplétion. Nouvelle prop `onOptimizeError` remontée au parent.
  - `src/components/ai/AiPanel.tsx` — `onOptimizeError={(m) => showToast(m, "error")}` sur
    les **deux** instances de `ChatBox`.

- **Décisions techniques :**
  - **Une seule source de vérité pour le modèle** : les actions IA « one-shot »
    (commit, optimisation) réutilisent la résolution du modèle de la barre de saisie
    plutôt qu'un modèle figé. C'est ce qui rend le comportement prévisible pour
    l'utilisateur, quel que soit son provider.
  - **Pas de présomption côté UI** : l'existence de changements est jugée par le diff
    (source Rust fiable) et non par un listing d'état potentiellement vide pour de
    mauvaises raisons. On ne réintroduit pas de biais en supposant la cause d'un échec.
  - **Contrat anti-dégradation du prompt** : `optimizePrompt` ne remplace le brouillon
    qu'en cas de succès ; sur erreur, le texte de l'utilisateur reste **intact** et une
    bannière explique pourquoi (jamais de perte silencieuse de saisie).
  - **Sécurité** : aucune clé n'est exposée (lecture keychain inchangée) ; les appels
    one-shot passent par `tauriFetch` comme le reste ; bornage du diff (12 000 octets)
    conservé ; pas de nouvel appel réseau déclenché sans action explicite de l'utilisateur.

- **Impacts & Dépendances :** `gitCommitMessage` dépend désormais du provider/modèle
  persistés — un utilisateur sans clé pour SON provider verra le message d'échec, ce qui
  est le comportement attendu. `ChatBox` gagne une prop optionnelle (`onOptimizeError`),
  rétro-compatible.

- **Prochaines étapes :** vérifier en `tauri dev` → clic sur chaque icône avec un provider
  distant configuré : le champ de commit se remplit, le brouillon de l'input est
  reformulé sans perdre l'intention.

---

### [2026-10-20T04:55] | Compaction manuelle du contexte (popover de la jauge, parité Trae)

- **Contexte :** la compaction existait **uniquement en automatique** (seuils 80 %/90 %
  détectés fin de tour, appliqués par `compactHistory` sur l'historique modèle).
  L'utilisateur n'avait aucun moyen de **déclencher lui-même** une réduction —
  contrairement à Trae, dont le popover de la jauge offre un bouton « Compact ».
  Besoin : bouton manuel, sans biais, sans appel LLM, réutilisant la règle existante.

- **Modifications effectuées :**
  - `src/lib/agent/compactHistory.ts` — scission décision/application :
    `findStaleReads(ModelMessage[]): Set<string>` (calcule **quels** `toolCallId` de
    `read_file` sont périmés, sans rien réécrire), `applyStaleReads` (réécriture de
    l'historique MODÈLE), `compactDisplayMessages(DisplayMessage[], stale, mutated)`
    (matérialise les marqueurs dans le **fil affiché**), `mutatedPathsOf(DisplayMessage[])`.
  - `src/components/ai/ContextUsageBar.tsx` — la jauge devient un déclencheur : clic →
    popover « Context Usage Rate / X% of YK / [Compact] » (reproduction de la capture
    Trae). Fermeture clic extérieur + Échap. `onCompact` **absent** ailleurs que sur le
    dernier message → jauge non cliquable (curseur et rendu inchangés).
  - `src/components/ai/MessageActionsBar.tsx` / `MessageBubble.tsx` — prop `onCompact`
    transmise de bout en bout.
  - `src/components/ai/AiPanel.tsx` — `handleManualCompact` (garde `if (isStreaming)
    return`) : calcule les périmés, réécrit le fil affiché, calcule `saved`, pousse une
    bannière `status{kind:"compaction"}` et incrémente la télémétrie. Si rien de périmé :
    bannière explicite « Aucun résultat de lecture périmé ». Câblé sur le seul dernier
    message via `onCompact={i === messages.length - 1 && !isStreaming ? … : undefined}`.

- **Décisions techniques :**
  - **Deux représentations du même fil** : `ModelMessage[]` (ce que `compactHistory`
    réécrit) vs `DisplayMessage[]` (ce que la jauge lit). Compacter la seule première
    faisait **baisser les tokens du modèle mais pas la jauge** → bouton perçu comme sans
    effet. D'où `compactDisplayMessages`, qui rejoue le marqueur dans les
    `ToolCallDisplay.result`.
  - **Aucun appel LLM** : on réutilise exactement la règle de péremption d'auto
    (déterministe, idempotente). Pas de duplication de logique, pas de latence, pas de coût.
  - **Volonté de NE PAS brancher la compaction native du SDK Cline** :
    `CoreCompactionMode = "manual"` existe côté `@cline/core`, mais elle n'est exposée
    que comme `prepareTurn` **interne** (appelé avant chaque requête modèle) — aucune API
    de déclenchement à la demande. L'activer aurait ajouté un second moteur concurrent et
    des allers-retours sidecar, sans bénéfice.
  - **Sécurité / intégrité** : garde `isStreaming` (jamais de réécriture d'un fil en
    cours de production d'événements) ; jamais le dernier message ni la fenêtre récente
    (~20 000 tokens) ; purement **local** (ni disque, ni réseau, ni sidecar) ; non
    destructif (nouveaux tableaux). Le miroir du run (`setRunMessages`) est synchronisé
    pour qu'un aller-retour de tâche ne réaffiche pas les résultats complets.

- **Impacts & Dépendances :** `compactHistory.ts` change de signature interne (les
  appelants auto de `run.ts` restent inchangés via `compactHistory` conservé). La jauge
  n'est cliquable que sur le dernier message — cohérent avec l'affichage conditionnel
  existant de `contextUsed`.

- **Prochaines étapes :** vérifier en `tauri dev` → clic jauge → « Compact » → jauge qui
  baisse + bannière « Compaction manuelle — N résultat(s) » + télémétrie `compaction`.

---

### [2026-10-20T04:35] | Gestion des onglets du navigateur par l'agent (parité Trae SOLO)

- **Contexte :** le navigateur intégré est multi-onglets (une webview vivante par
  onglet, cf. entrée précédente), mais l'agent n'en avait **aucune
  connaissance** : il ne pouvait viser que « ce qui est affiché ». Toute demande
  « ouvre ceci dans un nouvel onglet », « qu'est-ce qui est ouvert ? », « lis la
  page de l'autre onglet » était hors de portée. Besoin : rendre le navigateur
  **pilotable au niveau onglet**, sans biais de source, et sans exposer
  l'infrastructure (labels de webview) au modèle.

- **Modifications effectuées :**
  - `src-tauri/cline-sidecar/src/tabTool.ts` (nouveau) — 4 outils déclaratifs
    (`createTool` @cline/core, `lifecycle.completesRun:false`) : `browser_list_tabs`,
    `browser_open_tab`, `browser_close_tab`, `browser_activate_tab`. Table
    **fermée** de commandes (`TAB_COMMANDS`) ; transport de **données typées**
    uniquement (aucun code exécutable) ; sortie bornée (`clamp` 8 000 car.).
  - `src-tauri/cline-sidecar/src/index.ts` — branche `spec.kind === "browser"` :
    après `buildBrowserTools`, ajout de `buildTabTools((req) =>
    originInvoke(req.command, req.args))`. Même condition d'activation que
    `browser_*` (pas de navigateur exposé → pas d'outils d'onglets).
  - `src/lib/ai/previewTabs.ts` — surface publique hors React :
    `PreviewTabInfo {tabId,url,title,active}`, `listPreviewTabs()`,
    `panelIdForAgentTab(tabId)`, `activatePreviewTabById(tabId)`,
    `closePreviewTabById(tabId)` (`titleForUrl` dérivé du chemin).
  - `src/lib/ai/previewBus.ts` — `requestPreviewFocus()` : notifie les abonnés
    d'ouverture **sans** republier d'URL ni toucher au store (déjà à jour) —
    garantit que le panneau est monté avant de piloter sa webview.
  - `src/lib/agent/clineClient.ts` — `TAB_COMMANDS`/`isTabCommand`,
    `normalizeTabUrl` (http(s) seul, miroir Rust), `handleTabCommand` (chaque
    issue produit une phrase exploitable, jamais un succès silencieux), ajout des
    4 commandes à `INVOKE_ALLOWLIST`, routage dans `respondToInvoke` **avant** la
    résolution `panelId`.
  - `src/lib/agent/toolPresentation.ts` — noms d'outils + deux lignes de contrat
    (mode actif / lecture seule) rappelant `tabId` opaque et « ne jamais
    inventer un `tabId` ».
  - `src/lib/__tests__/prompts.metrics.test.ts` — budget prompt maintenu
    **< 8 000** caractères sur le preset agent/max après condensation des lignes.

- **Décisions Techniques :**
  - **Séparation onglet / page.** Un onglet n'est pas une page : deux cycles de
    vie distincts. La gestion d'onglets est purement **front** (store
    `previewTabs`) — il n'y a **aucune webview à manipuler** pour ouvrir/fermer.
    On ne réutilise donc **pas** `browserInvoke` (qui injecte un `panelId` de
    webview) mais `originInvoke`, sans cible matérielle.
  - **Frontière de confiance : `tabId` opaque ≠ `panelId`.** Le modèle ne
    manipule jamais un label de webview (forgeable) ; il reçoit un `tabId` opaque
    de `browser_list_tabs` que le **front seul** sait traduire. Un id inconnu est
    refusé (`error: unknown tabId … call browser_list_tabs first`) : impossible de
    viser autre chose que ce qui a été montré.
  - **Fermeture non silencieuse.** `tabs_list` renvoie 0 ligne explicite quand
    rien n'est ouvert ; `tabs_open`/`activate` appellent `requestPreviewFocus()`
    pour rendre la cible visible (sinon l'agent piloterait une page invisible).

- **Impacts & Dépendances :**
  - Aucun fichier Rust modifié : le backend supportait déjà N webviews indexées
    par label. Chemin de navigation d'un `tabs_open` inchangé (schéma http(s)
    imposé côté Rust, confirmation utilisateur pour hôte externe).
  - **Limite de timing assumée :** si la webview du nouvel onglet n'est pas encore
    embarquée, la commande `browser_*` suivante reçoit une erreur explicite
    (`browser panel '…' not found`) — l'agent doit alors relire l'état, pas
    boucler.

- **Prochaines étapes :**
  - Valider en `tauri dev` le scénario « liste → ouvre 3 onglets → bascule →
    lis/ferme », y compris l'ordre des événements quand plusieurs onglets
    s'ouvrent en rafale.

---

### [2026-10-20T03:40] | Benchmark SWE-bench réel : 3 instances, protocole honnête, 2/3 resolved

- **Contexte :** le benchmark de codage interne (6 mini-fixtures) était jugé trop
  simple. Objectif : exécuter le **vrai agent** (sidecar Cline, production) sur de
  **vraies instances SWE-bench Lite** (`princeton-nlp/SWE-bench_Lite`), tests dans
  Docker par instance, et produire un `predictions.jsonl` publiable.

- **Modifications effectuées :**
  - `bench/coding/benchWebview.ts` — pilotage du VRAI agent depuis la webview Tauri :
    - envoi **non bloquant** (`void handle.send(...).catch(...)`) : `engine.send` du
      SDK n'acquitte `{accepted:true}` qu'à la **fin du tour** ; tout tour > 30 s
      dépassait `COMMAND_REPLY_TIMEOUT` du sidecar Rust → `SIDECAR_REPLY_TIMEOUT`
      alors que l'agent travaillait. On n'attend plus que les événements terminaux
      réels (`finish`/`error`) ou le timer de tâche.
    - `maxIterations` borné (défaut 25) — paramètre **public** du contrat, pas une
      modification du moteur.
    - **Remise à l'état officiel** avant Docker : les fichiers du `test_patch` sont
      restaurés au `base_commit` puis le `test_patch` officiel est réappliqué. Toute
      modification de test par l'agent est **ignorée** (constaté : l'agent avait
      édité le test astropy pour « tricher »).
    - `parsePatchTargets()` (chemins d'un patch unifié) + FAIL_TO_PASS qualifiés
      (`testFilesFor`) pour cibler pytest même quand l'instance ne donne que des
      noms de test nus (cas sympy).
  - `bench/coding/swebench/instance.ts` — nouvelle fonction `testFilesFor` qui
    résout le fichier de test via le `test_patch` quand `FAIL_TO_PASS` est non
    qualifié. `toCodingTask` l'utilise.
  - `vite.config.ts` — `watch.ignored` inclut `**/bench/**` : le dépôt cloné vit dans
    l'arbre du projet ; sans exclusion, chaque écriture de l'agent déclenchait un
    full-reload Vite qui **détruisait le run mesuré**.
  - `src-tauri/src/bench.rs` (DEV-ONLY) + enregistrement dans `lib.rs` —
    `bench_bash_run(command, cwd, timeout_ms)` borné à 30 min / 4 Mo
    (`agent_bash_run` plafonne à 120 s / 64 Ko : insuffisant pour pytest Docker).

- **Décisions techniques :**
  - **Ne pas modifier le moteur** (§6 mission) : les correctifs sont dans le harnais
    ou via des paramètres publics. Le `SIDECAR_REPLY_TIMEOUT` est un problème
    structurel du moteur (acquittement en fin de tour) : il est **contourné côté
    harnais**, il n'est pas corrigé dans le moteur (hors périmètre).
  - **Honnêteté avant score** : les tests officiels sont toujours réappliqués ; un
    patch qui ne touche que les tests ne peut pas « réussir ». Le `model_patch`
    publié ne contient que les sources. `predictions.jsonl` au format officiel.
  - **Score non revendiqué comme officiel** : échantillon de 3, harnais distinct du
    harness Python officiel. Aucune comparaison Cursor/Claude Code inventée.

- **Impacts & dépendances :** `bench/coding/results/predictions.jsonl` (2 patches
  réels) et `bench/coding/results/swebench-results.json`. Le README `bench/README.md`
  (§3.4 + §8) reflète désormais les vrais résultats. Les images Docker
  `orvyx-swebench:*` et les envs préparés sont **réutilisés** (non supprimés).
  Aucune modification de comportement de production : `bench_bash_run` est
  `#[cfg(debug_assertions)]`, `installBenchHook` DEV-only.

- **Prochaines étapes :**
  - Corriger le comptage `turns` (basé sur `timing`, off : 0/1 pour 16-25 tool-calls).
  - Réinitialiser le dépôt **entre** instances dans le runner webview (le harnais
    officiel le fait systématiquement).
  - Étendre l'échantillon (coût réseau → accord explicite requis).

---

### [2026-10-20T02:15] | Navigateur intégré : vrai comportement multi-onglets (webviews persistantes)

- **Contexte :** le premier jet ouvrait bien plusieurs onglets mais ne se comportait
  pas comme un VRAI navigateur : basculer d'onglet détruisait puis ré-embarquait la
  webview (donc **rechargement** de la page à chaque aller-retour). Inacceptable.

- **Modifications effectuées :**
  - `src/lib/ai/previewTabs.ts` — l'état runtime par onglet (pile d'historique,
    dimensions, `reloadKey`, `loading`, `error`, `canBack`) est désormais **possédé
    par le store** (`runtimeFor`, `resetTabHistory`), plus par des `useRef` du
    composant : il survit à tout re-rendu et à tout changement d'onglet.
  - `src/components/editor/WebPreviewPane.tsx` — **une webview VIVANTE par onglet**.
    Chaque onglet a son conteneur DOM ; la webview native y est ancrée une fois et
    n'est plus détruite au changement d'onglet. La bascule d'onglet se fait par
    **déplacement hors écran / restauration des bornes** (`resize_ide_panel`), donc
    sans rechargement. Nettoyage : destruction des webviews des onglets fermés et
    de **toutes** les webviews au démontage du panneau (plus de surface fantôme).
  - `src-tauri/src/browser.rs` — nouvelle commande `browser_go(panel_id, direction)`
    qui pilote l'historique NATIF de la webview (`history.go(±1)`), sans rechargement.
    `browser_status` expose en plus `canBack` (`history.length > 1`).
  - `src-tauri/src/lib.rs` — enregistrement de `browser_go`.

- **Décisions techniques :**
  - **N webviews natives vivantes** : c'est le seul moyen d'offrir le comportement
    d'un vrai navigateur (état et scroll préservés). Coût : une webview par onglet
    (mémoire). Compromis retenu car c'est exactement ce que fait un navigateur.
  - **Masquer = déplacer hors écran**, pas `set_visible` : le backend n'expose pas
    d'API de visibilité par label ; déplacer à `-100000` est portable et sans effet
    de bord (la webview reste vivante, ne reçoit pas d'événements souris visibles).
  - **Back/Forward via l'historique natif** : la pile JS de la webview est la seule
    vérité (elle inclut les navigations internes à la page). On évite d'avoir deux
    historiques divergents — le front ne suit que ses propres navigations.
  - **Correction d'un bug de clé** : `mountedRef` indexe par `<id>:<url>:<reload>`
    mais était comparé à des ids bruts → les webviews des onglets fermés n'étaient
    jamais détruites. Extraction de l'id par `key.slice(0, key.indexOf(':'))`.

- **Impacts & Dépendances :** `WebPreviewPane` reste monté à deux endroits
  d'`AgentModeView`, mais les deux branches (`activeToolTab === "editor"` /
  `"browser"`) sont **mutuellement exclusives** : une seule instance vit à la fois.
  `browser_go` est réservé au FRONT (contrôle utilisateur) ; l'agent dispose de son
  propre jeu d'outils `browser_*` inchangé.

- **Prochaines étapes :** valider en `tauri dev` le non-rechargement à la bascule
  d'onglet et le retour arrière natif ; surveiller la consommation mémoire avec
  beaucoup d'onglets ouverts.

### [2026-10-20T02:05] | Navigateur intégré : multi-onglets illimités (utilisateur + agent)

- **Contexte :** impossible d'ouvrir plusieurs onglets dans le navigateur intégré,
  y compris en mode IA. Diagnostic : le backend Rust supportait **déjà** N webviews
  simultanées (`PanelUrlState : Mutex<HashMap<String,String>>`, commandes
  `embed_ide_panel` / `resize_ide_panel` / `destroy_ide_panel` / `get_ide_panel_url`
  toutes indexées par `panelId`). Le verrou était purement côté UI : `WebPreviewPane`
  ne gérait qu'un **label fixe** (`origin-web-preview`), donc un seul onglet possible.

- **Modifications effectuées :**
  - `src/lib/ai/previewTabs.ts` — **créé**. Source de vérité des onglets, hors React
    (lisible par `clineClient` au moment d'un `tool_invoke`). Expose : `PreviewTab`,
    état `{ tabs, activeIndex }`, `subscribePreviewTabs`, `getPreviewTabsSnapshot`,
    `openPreviewTab`, `activatePreviewTab`, `closePreviewTab`, `setPreviewTabUrl`,
    `replacePreviewTabs`, `navigateActiveOrCreate`, `panelIdForTab`, et
    `resolvePreviewPanel` (cible logique → label de l'onglet actif).
  - `src/components/editor/WebPreviewPane.tsx` — **réécrit**. Barre d'onglets
    (`PreviewTabStrip`) avec ouvertures/fermetures illimitées, bouton `+`, `×` par
    onglet. État **par onglet** (pile d'historique, dimensions, preset) dans des
    `Map` indexées par id, purgées à la fermeture. Persistance de la liste
    (`localStorage`). **Seul l'onglet actif** embarque une webview native ; les
    inactifs sont détruits et ré-embarqués à l'activation.
  - `src/lib/agent/clineClient.ts` — `respondToInvoke` résout `args.panelId` via
    `resolvePreviewPanel` **avant** l'`invoke`. Aucun onglet ouvert → erreur
    explicite à l'agent (`no browser tab is open; call browser_navigate first`)
    au lieu d'une action dans le vide.
  - `src/components/ai/AiPanel.tsx` — la cible passée au sidecar devient
    `PREVIEW_ACTIVE_TARGET` (cible logique) au lieu du label matériel.

- **Décisions techniques :**
  - **Cible logique vs label matériel :** l'agent ne connaît pas les onglets et vise
    toujours « l'onglet actif » ; le remappage vers le label réel se fait dans le
    front, seul endroit qui connaît l'état des onglets. Cela évite d'exposer la
    notion d'onglet dans le prompt et ne casse pas le pilotage existant.
  - **Une seule webview vivante (celle de l'onglet actif) :** N webviews natives
    superposées produiraient des fantômes et des positions jamais synchronisées.
    Coût assumé : rechargement de la page au changement d'onglet.
  - **`ensurePreviewPanelFor` écarté :** ouvrir un onglet à la demande de l'agent
    posait un problème de timing (la webview n'est pas encore embarquée quand
    `browser_navigate` arrive) ; aurait été du code mort. Limite acceptée : l'agent
    cible un onglet déjà ouvert.

- **Impacts & Dépendances :** `WebPreviewPane` est monté à **deux endroits** de
  `AgentModeView` (zone éditeur et onglet outil `browser`) — les deux instances
  partagent le même store ; un seul onglet actif embarque la webview, donc pas de
  double embarquement. `previewBus` (liens des messages) passe par
  `navigateActiveOrCreate` : un lien cliqué charge l'onglet actif ou en crée un.

- **Prochaines étapes :** vérifier en `tauri dev` l'ouverture/fermeture de plusieurs
  onglets et le pilotage de l'onglet actif par l'agent ; surveiller le double montage.

### [2026-10-20T01:50] | Skills : consigne ACTIVE dans le contrat d'outils (mode IA et IDE)

- **Contexte :** le modèle « avait du mal avec les skills » en mode IA **comme**
  en mode IDE (les deux lisent le même `toolPresentation.ts`). Diagnostic : la
  découverte était correcte (sidecar `withMiraDirectories` → `.mira/skills` +
  `~/.mira/skills`, `userInstructionConfigService.start()` obligatoire, et le SDK
  appende lui-même `Available skills: <noms>` à la description de l'outil
  `skills`). Le problème était **comportemental** : notre puce était passive
  (« invoke a configured skill by name when it matches the task »), donc le
  modèle répondait directement sans jamais vérifier la liste ni invoquer.

- **Modifications effectuées :**
  - `src/lib/agent/toolPresentation.ts` — nouvelle constante exportée
    [`SKILLS_CONTRACT_LINE`](file:///Users/user/code/orvyx-desktop/origin/src/lib/agent/toolPresentation.ts#L63)
    (consigne active : vérifier `Available skills` d'abord, invoquer avec le nom
    EXACT, `args` = chaîne, la skill prime sur l'improvisation, ne jamais
    prétendre avoir utilisé une skill absente de la liste). Les **4** occurrences
    de l'ancienne puce passive (`TOOL_CONTRACT_FULL`, `TOOL_CONTRACT_READ_ONLY`,
    `buildFullToolContract`, `buildReadOnlyToolContract`) sont remplacées.
  - `src/lib/agent/__tests__/prompts.test.ts` — test d'invariant : la constante
    mentionne `Available skills` et est présente dans les deux modes ;
    l'ancienne formulation passive ne doit plus apparaître.

- **Décisions techniques :** agir **en amont (prompt)** plutôt qu'un filtrage a
  posteriori (un appel de skill ne se détecte qu'au runtime). Consigne **concise
  sur une seule ligne** : le test de budget (8000 car.) a d'abord échoué à 8020
  avec une version multi-puces → condensée à 7812, marge rétablie sans perdre le
  contenu prescriptif. La liste des skills n'est PAS citée dans le contrat : elle
  est propre au workspace et injectée par le SDK.

- **Impacts & Dépendances :** `toolPresentation.ts` est la source unique du
  contrat lu par le modèle ; le changement profite aux modes IA et IDE
  simultanément. Aucun impact sur la mécanique d'approbation (`skills` reste non
  désactivable et toujours annoncé).

- **Prochaines étapes :** vérifier en `tauri dev` que le modèle invoque bien un
  skill sur une demande qui matche (ex. une skill de la liste `Available skills`).

### [2026-10-20T02:35] | Commit IA : diff incluant les fichiers non suivis + prompt conforme Conventional Commits

- **Contexte :** le bouton « Generate commit message with AI » (icône Sparkles)
  répondait *« No changes to describe »* alors que des changements existaient.
  Deux causes cumulées :
  1. [git_diff (Rust)](file:///Users/user/code/orvyx-desktop/origin/src-tauri/src/git.rs#L593)
     ne fait que `git diff --cached` + `git diff` → les fichiers **non suivis**
     (nouveaux fichiers jamais `git add`) sont invisibles → diff vide ;
  2. `SourceTreePanel` jugeait `files.length === 0` sur un état chargé au montage
     (rafraîchi toutes les 5 s seulement si `autoRefresh`), donc périmé au clic.

- **Modifications effectuées :**
  - `src-tauri/src/git.rs` — nouvelle commande `git_commit_diff` (+ helper
    `diff_untracked_file`) : assemble `diff --cached` + `diff` +
    `diff --no-index /dev/null` pour chaque fichier de `ls-files --others
    --exclude-standard`, plafonné à `max_bytes`. `git_diff` de l'éditeur
    **inchangé** (aucune régression sur le gutter inline).
  - `src-tauri/src/lib.rs` — enregistrement de `git::git_commit_diff`.
  - `src/lib/git.ts` — wrapper `gitCommitDiff`.
  - `src/lib/gitCommitMessage.ts` — prompt système `COMMIT_SYSTEM_PROMPT`
    réécrit selon **Conventional Commits** (type/scope, impératif, ≤ 50/72 chars,
    `!` réservé aux ruptures, poids des lockfiles/générés ignoré, langue alignée
    sur les commits existants) + nettoyage défensif de la sortie (1ʳᵉ ligne, sans
    fences/guillemets/« commit message: »). Source du diff basculée sur
    `gitCommitDiff`.
  - `src/components/SourceTreePanel.tsx` — `aiGenerateMessage` **recharge l'état
    git avant de juger** ; le message d'échec ne présuppose plus la cause
    (provider manquant *ou* diff vide).

- **Décisions techniques :**
  - **Commande Rust dédiée** plutôt qu'élargir `git_diff` : le diff « commit »
    a un besoin différent (exhaustivité, untracked) de celui de l'éditeur
    (léger, suivi). Séparer évite de gonfler le gutter et de coupler deux usages.
  - `git diff --no-index` sort en code 1 quand il y a des différences : ce n'est
    **pas** une erreur → on lit `stdout` sans conditionner au `status.success()`.
  - **Injection :** les chemins de fichiers proviennent de `git ls-files`
    (sortie de git, pas d'entrée utilisateur brute) et sont passés après `--`,
    donc traités comme chemins littéraux. La sortie est plafonnée (`max_bytes`)
    pour borner le coût du prompt et éviter un DoS par diff géant.
  - Le **prompt** reflète les bonnes pratiques demandées (Conventional Commits)
    sans imposer de langue ni de provider.

- **Impacts & Dépendances :** `git.rs`, `lib.rs`, `git.ts`, `gitCommitMessage.ts`,
  `SourceTreePanel.tsx`. Nouveau contrat IPC `git_commit_diff` (front ↔ back) :
  nécessite un rebuild Tauri (le sidecar n'est pas concerné).

- **Prochaines étapes :** vérifier en `tauri dev` que le bouton remplit bien le
  champ titre ; surveiller la troncature sur les dépôts à beaucoup de nouveaux
  fichiers (le plafond est volontaire).

- **Vérifications :** `cargo check` ✅ · `tsc --noEmit` ✅ · `vitest run src/lib`
  → **685 tests ✅**.

---

### [2026-10-20T02:20] | Anti-404 : politique de liens neutre dans le prompt système

- **Contexte :** retour utilisateur — *« les liens rendus sont soit morts, soit 404,
  soit n'existent même pas »*. Demande explicite : corriger **sans mettre de
  biais** (ne pas forcer une source, ne pas interdire de fournir des liens).

- **Modifications effectuées :**
  - `src/lib/agent/prompts.ts` — nouveau bloc `LINK_SOURCING_RULES` (« ## Links »),
    injecté dans les TROIS modes (`agent`, `ask`, `plan`) via le tableau de
    `buildSystemPrompt`. Règles : ne citer une URL que si elle a été **observée**
    dans la session (résultat d'outil, code, message utilisateur), copiée
    verbatim ; nommer la source en mots quand aucun lien vérifié n'existe ;
    jamais de page d'accueil générique présentée comme la page précise.
  - `src/lib/agent/__tests__/prompts.test.ts` — import de `LINK_SOURCING_RULES` +
    test d'invariant « les trois modes portent la politique de liens ».

- **Décisions techniques :**
  - **Correctif au niveau le plus amont** (le prompt) plutôt qu'un filtrage a
    posteriori des liens : un validateur de liens en sortie imposerait un aller-
    retour réseau par lien, échouerait sur les pages qui bloquent les `HEAD`, et
    pénaliserait la latence. Empêcher l'hallucination à la source est à la fois
    plus robuste et sans coût d'exécution.
  - **Neutralité volontaire** (exigence utilisateur) : le bloc ne privilégie
    aucune source et n'interdit pas les liens ; il ne fixe qu'un critère
    **vérifiable** — l'origine du lien. C'est la seule règle qui distingue un
    lien réel d'un lien reconstruit de mémoire sans introduire de biais de
    sélection.

- **Impacts & Dépendances :** `prompts.ts` (source unique du prompt système, donc
  effet sur les 3 modes et le mode IA). Budget de prompt préservé (bloc ~430
  caractères, seuil de garde-fou à 8000 non franchi — test métriques vert).

- **Prochaines étapes :** observer en conditions réelles si le modèle respecte la
  contrainte ; si des liens inventés subsistent, envisager un **outil de
  vérification** optionnel que le modèle peut appeler avant de citer une URL
  (toujours sans biais de source).

- **Vérifications :** `tsc --noEmit` ✅ · `vitest run src/lib` → **685 tests ✅**
  (dont les tests métriques de prompt : aucune redite, budget respecté).

---

### [2026-10-20T02:05] | Corrections UX : copie, explorer, terminal, navigateur, historique input

- **Contexte :** retour utilisateur groupant cinq frictions d'usage de l'IDE :
  1. copier une conversation à la souris embarque le **style** (HTML rendu) ;
  2. l'Explorer ne se rafraîchit pas quand l'agent crée un fichier/dossier ;
  3. le terminal est **coupé sur l'axe Y** (plafond de hauteur fixe) ;
  4. l'agent peine à piloter le navigateur, et un clic sur un lien Markdown
     ouvre une fenêtre impossible à fermer ;
  5. impossible de remonter l'historique des messages avec ↑/↓ dans l'input.

- **Modifications effectuées :**
  - **Copie (c1)**
    - `src/lib/ai/copyConversation.ts` (nouveau) — normalisation de la sélection
      en **texte brut** (`text/plain`), sans jamais lire `innerHTML` : les blocs
      (P/DIV/LI/PRE/…) deviennent des sauts de ligne.
    - `src/components/ai/AiPanel.tsx` — intercepte `onCopy` sur la zone messages
      (`handleThreadCopy`, préserve tout sauf si la sélection est dans la zone) ;
      ajoute un bouton « Copy conversation » (transcript complet préfixé
      `You:`/`Agent:`). `MessageActionsBar` copiait déjà le markdown brut.
  - **Explorer (c2)**
    - `src/lib/explorer/refreshBus.ts` (nouveau) — bus minimal
      (`subscribeExplorerRefresh` / `notifyExplorerDirsChanged`).
    - `src/lib/explorer/useExplorer.ts` — abonnement avec **debounce 120 ms** et
      rafraîchissement **ciblé** (`refreshDirs`) des dossiers signalés.
    - `src/components/ai/AiPanel.tsx` — `touchTurn` publie `parentOf(path)` : un
      unique point d'émission, dédupliqué par l'appelant.
  - **Terminal (c3)**
    - `src/components/terminal/TerminalPanel.tsx` — le plafond fixe
      `MAX_HEIGHT = 600` est remplacé par un plafond **dynamique**
      `window.innerHeight - RESERVED_ABOVE` (≈ 96 px). Le drag reste libre, le
      minimum conservé.
  - **Navigateur (c4)**
    - `src/lib/ai/previewBus.ts` (nouveau) — `subscribePreviewNavigation`,
      `requestPreviewUrl` (URL mémorisée si le pane n'est pas monté),
      `takePendingPreviewUrl`, `subscribePreviewOpen`, `openPreviewAt`.
    - `src/lib/ai/linkRouting.ts` (nouveau) — `routeMarkdownLink` : `#…` → none,
      `http(s)` → preview, `mailto:`/`tel:` → external, **tout le reste**
      (`javascript:`, `data:`, `file:`, `vbscript:`) → none (barrière sécurité).
    - `src/components/ai/MarkdownMessage.tsx` — `handleLinkClick` route les clics
      vers le panel intégré ou le navigateur système.
    - `src/components/ai/AgentModeView.tsx` — `subscribePreviewOpen` ouvre
      l'onglet `browser` au bon moment.
    - `src/components/editor/WebPreviewPane.tsx` — pop-out réécrit en
      `openUrl(url)` système (plus de `WebviewWindow` fantôme non suivie) ;
      s'abonne à la navigation et consomme l'URL en attente au montage.
  - **Historique input (c5)**
    - `src/lib/inputCommands.ts` — `resolveHistoryNav` : logique **pure** de
      navigation (`-1` = brouillon, `0` = plus récent), restaure le brouillon en
      redescendant. + 4 tests dans `inputCommands.test.ts`.
    - `src/components/ai/ChatBox.tsx` — prop `getUserHistory` ; refs
      `historyIndexRef` / `historyDraftRef` ; `writeEditorText` + `navigateHistory`
      branchés sur ↑/↓ (désactivés si menu slash/`#`/`@` ouvert ou texte
      multiligne, pour laisser le caret natif). `handleInput` réinitialise la
      navigation à la moindre frappe.
    - `src/components/ai/AiPanel.tsx` — `getUserHistory` dérivé de `messagesRef`
      (messages `user` non streaming, non vides), passé aux **deux** `<ChatBox>`.

- **Décisions techniques :**
  - **Copie** : agir sur `onCopy` (event natif) plutôt que sur un état React,
    car seul le DOM connaît la sélection courante ; écrire `text/plain` neutralise
    le style sans jamais sérialiser le HTML rendu.
  - **Explorer** : préféré un **bus ciblé + debounce** à un `reloadAll()` global
    (coût O(dossier) au lieu de O(workspace)) ; évite aussi de propager
    `setFileTreeVersion` à travers toute la hiérarchie de props.
  - **Terminal** : plafond **dérivé de la fenêtre** plutôt qu'une constante
    arbitraire — le terminal s'étend jusqu'à l'espace réellement disponible.
  - **Navigateur** : un **bus** (et non des props) découple les calques profonds
    (`MarkdownMessage` → `AgentModeView` → pane), et la mémorisation d'URL gère
    la course « lien cliqué avant montage du pane ». `routeMarkdownLink` refuse
    par défaut tout schéma non explicitement autorisé (défense en profondeur
    contre `javascript:`/`data:`).
  - **Historique** : logique pure hors composant (testable en `node`), index
    sémantique `-1`/`0..len-1` ; on ne vole ↑/↓ que si ça ne casse pas l'édition
    multiligne.

- **Impacts & Dépendances :** `AiPanel.tsx` (copie, explorer, `getUserHistory`),
  `ChatBox.tsx`, `MarkdownMessage.tsx`, `AgentModeView.tsx`, `WebPreviewPane.tsx`,
  `TerminalPanel.tsx`, `useExplorer.ts`, `inputCommands.ts`. Deux nouveaux bus
  module-level (`previewBus`, `refreshBus`) : leur état est **transitoire** et
  ne survit pas à un reload, ce qui est acceptable (aucune persistance attendue).

- **Prochaines étapes :** fiabiliser la « readiness » de la webview native du
  panel navigateur (course possible si l'agent appelle un outil *browser* avant
  le montage du pane). Vérifier le comportement en `tauri dev`.

- **Vérifications :** `npx tsc --noEmit` ✅ · `vitest run src/lib` → **679 tests
  ✅** · build sidecar (`esbuild`) ✅ · diagnostics IDE vides ✅.

---

### [2026-10-20T01:15] | Mode IA : escalade d'équipe pilotée par le modèle (remplace le classificateur lexical)

- **Contexte :** la version précédente décidait l'activation des équipes Cline via
  un classificateur **lexical** (`teamDemand.ts`). Retour utilisateur décisif :
  *« classificateur trop fragile […] il confond la forme d'une demande avec la
  complexité réelle du travail nécessaire »*. C'est exact : la longueur, les
  mots-clés ou les puces décrivent la **forme** du message, pas le **travail**
  réel (nombre de fichiers, dépendances, inconnues découvertes en lisant). Un
  « corrige ce bug » court mais profond était raté ; un « refactorise ça » long
  mais trivial était sur-déclenché.

- **Modifications effectuées :**
  - `src/lib/agent/teamDemand.ts` + `__tests__/teamDemand.test.ts` —
    **SUPPRIMÉS** (le classificateur ne juge plus rien).
  - `src-tauri/cline-sidecar/src/teamEscalateTool.ts` (nouveau) — outil custom
    léger `escalate_to_team` : le modèle l'appelle quand il **bute** sur l'ampleur.
    Il n'exécute rien, il **émet** `tool_event` `{ tool: "team_escalate", reason }`.
    `reason` bornée à 400 caractères. Auto-approuvé (`TOOL_POLICIES`).
  - `src-tauri/cline-sidecar/src/index.ts` — `ExtraToolSpec.kind` gagne
    `"team_escalate"` ; `buildExtraTools` résout le kind ; politique
    `escalate_to_team: { autoApprove: true }`.
  - `src/lib/agent/clineClient.ts` — `ClineExtraToolSpecAny` gagne
    `{ kind: "team_escalate"; sessionId }` ; `ClineToolEvent.reason` ;
    `extractToolEvent` parse `reason` (borné 400).
  - `src/components/ai/AiPanel.tsx` — en IA, **départ léger systématique**
    (`enableTeams:false`, `enableEscalate:true`) ; `onToolEvent` route
    `team_escalate` → marque `run.teamsEnabled` (verrou), abandonne le tour léger
    et **relance à froid avec `enableTeams:true`** sur la MÊME session (reprise
    par re-seed → le travail déjà produit est conservé, aucun texte rejoué).
    **Correction du bug des outils non réinjectés** : `extraTools` (todo/browser/
    code_index/escalade) et `enabledMcpServers` sont désormais conditionnés à
    `!!sessionId` (et non `!clineSessionId`) — la reprise étant un **re-seed**,
    ils disparaissaient dès le 2ᵉ tour (et un agent MCP restreint ré-verrait tous
    les serveurs : régression de sécurité corrigée).
  - `src/lib/agent/runState.ts` — `teamsEnabled` conservé comme verrou collant.

- **Décisions Techniques :**
  - **Le modèle juge, pas la forme du texte** : seul le modèle, une fois face au
    code, sait si la tâche excède sa capacité. La décision d'escalade repose donc
    sur son observation réelle (`escalate_to_team`), pas sur une heuristique.
  - **Départ léger** : TTFT proche de l'IDE sur les demandes simples (pas de 18
    outils `team_*` injectés), puissance complète sur les demandes larges.
  - **Escalade orchestrée par le FRONT** : le sidecar ne peut pas re-seeder sa
    propre session en plein run (pas d'API `addTools`, `includeLeadManagementTools`
    codé en dur). Le front coupe le run léger et re-`start` avec `initialMessages`
    → chemin de reprise déjà en place, **travail conservé**.
  - **Verrou anti-boucle** : `run.teamsEnabled` est basculé AVANT la relance ; une
    demande d'escalade ultérieure est un no-op. La relance part avec
    `enableEscalate:false` (plus rien à escalader).

- **Impacts & Dépendances :**
  - Comportement IA : plus de bascule « devinée » — l'agent commence léger et
    **demande lui-même** les équipes seulement s'il bute.
  - `extraTools`/MCP désormais réaffirmés à CHAQUE `start` : toute nouvelle
    surface d'outil doit l'être aussi (sinon disparition au 2ᵉ tour).
  - Le toast d'escalade passe par `neutralizeForClient` (jamais de marque interne
    visible du client).

- **Prochaines étapes :**
  - Confirmer en `tauri dev` : (1) TTFT d'une demande simple en IA rejoint l'IDE ;
    (2) une demande large déclenche bien `escalate_to_team` puis la relance avec
    équipes, sans perte du travail du tour léger.
  - Vérifier que le SDK termine proprement le tour léger après l'`abort` du front
    (pas d'événement résiduel).

---


### [2026-10-20T00:45] | Mode IA : équipes « à la demande » (TTFT, sans réglage utilisateur)

- **Contexte :** en mode IA, l'agent semblait systématiquement plus lent qu'en IDE.
  Diagnostic mesuré : le prompt système IA ne diffère de l'IDE que de **86 tokens**
  (négligeable) ; la vraie cause est que le SDK Cline, dès `enableAgentTeams:true`,
  expose **18 outils `team_*`** dans CHAQUE requête (câblage codé en dur côté SDK,
  `includeLeadSpawnTool:!0, includeLeadManagementTools:!0` — non réductible par
  config). Chaque schéma d'outil alourdit le payload : coût de **TTFT fixe**, subi
  même pour un « bonjour ». Le mode IDE (`enableTeams:false`) répond plus vite.

- **Modifications effectuées :**
  - `src/lib/agent/teamDemand.ts` (nouveau) — classificateur **déterministe**
    `shouldEnableTeams(request, sticky)` : active l'outillage d'équipe seulement
    si la demande le justifie. Signaux : verbes d'investigation, portée transverse
    (codebase/repo/modules/« partout »/« tous les fichiers »), longueur
    multi-étapes. **Aucun appel modèle supplémentaire** (ce serait du TTFT en plus).
    Règle **asymétrique** : un faux négatif (rater une tâche qui aurait eu besoin
    des équipes) coûte plus cher qu'un faux positif → tout doute raisonnable
    penche vers l'arrêt.
  - `src/lib/agent/runState.ts` — champ `teamsEnabled` (collant) dans `RunState`.
  - `src/components/ai/AiPanel.tsx` — remplace `enableTeams: convIsAgent &&
    !selectedAgent` par `shouldEnableTeams(apiText, run.teamsEnabled)` ; une fois
    activées, `run.teamsEnabled` reste vrai (la conversation ne rebascule pas en
    runtime allégé en plein travail d'équipe).
  - `src/lib/agent/__tests__/teamDemand.test.ts` (nouveau) — 7 cas (refus court,
    activation investigation+portée, portée+étapes, collant, pas d'activation sur
    signal faible isolé).

- **Décisions Techniques :**
  - **Pourquoi un classement déterministe et pas un appel LLM** : un routeur LLM
    ajouterait lui-même un aller-retour réseau avant chaque tour — exactement le
    TTFT qu'on cherche à supprimer. Le texte de la demande contient assez de
    signaux explicites pour trancher localement, en microsecondes.
  - **Pourquoi collant** : le SDK fige les outils au `start`. Repasser d'équipes à
    « léger » en cours de conversation rouvrirait une session sans les outils
    d'équipe alors qu'un coéquipier peut être actif → incohérence. On ne rouvre
    jamais un runtime allégé après activation.
  - **Décision prise au niveau du front, chaque tour** : la reprise re-seede
    l'historique (`initialMessages`) et le SDK reconstruit le runtime avec la
    config fournie → `enableTeams` peut changer entre deux tours sans perdre le
    contexte. Vérifié dans `clineClient.ts` (reprise par re-seed) et
    `sidecar/index.ts` (`engine.start` appelé à chaque `start`).

- **Impacts & Dépendances :**
  - Comportement IA : les tâches simples (question, édition ciblée) démarrent
    désormais **sans** orchestration → TTFT proche de l'IDE. Les tâches larges
    (refactor, audit, recherche transverse) conservent les équipes.
  - `RunState` gagne un champ : tout constructeur d'état doit l'initialiser
    (`fresh()` mis à jour).
  - Le seuil de classement est volontairement prudent ; si des tâches légitimes
    n'activent pas les équipes, enrichir `INVESTIGATION_SIGNALS`/`SCOPE_SIGNALS`
    plutôt que desserrer la règle.

- **Prochaines étapes :**
  - Confirmer en `tauri dev` que le TTFT d'une demande simple en IA rejoint celui
    de l'IDE (instrumentation `1er événement d'UI @+Xms` déjà en place).
  - Surveiller les cas limites du classement (demandes sobres mais réellement
    larges) et compléter les listes de signaux si besoin.

---

### [2026-10-20T00:10] | Prompt système : bloc « Objective » (poursuite de l'objectif, sans biais)

- **Contexte :** l'utilisateur veut qu'en mode IA l'agent **atteigne toujours**
  l'objectif, en mobilisant tout ce qui est à sa disposition pour trouver la
  meilleure solution et satisfaire la demande — sans introduire de biais dans le
  prompt. Risque identifié : un bloc mal formulé (« utilise les sous-agents »,
  « fais tout seul ») entrerait en conflit avec les blocs de délégation, qui
  raisonnent eux sur le COÛT.

- **Modifications effectuées :**
  - `src/lib/agent/prompts.ts` — nouveau bloc exporté `OBJECTIVE_PURSUIT`
    (section « ## Objective », 6 puces). Neutralité sur la MÉTHODE : il ne
    prescrit ni délégation ni travail en solo. Il fixe une seule finalité (le but
    réel de l'utilisateur atteint) et pose des **garde-fous anti-échec
    silencieux** : comprendre l'intention, contourner un chemin bloqué, n'utiliser
    un outil que s'il sert l'objectif, vérifier avant de déclarer « fait »,
    signaler un vrai blocage plutôt que livrer du non-fini, ne pas confondre
    tâche longue et tâche cassée.
  - `OBJECTIVE_PURSUIT` est inséré dans `buildSystemPrompt` juste après
    `CONCISION` → présent dans **les trois modes** (agent, ask, plan) : viser
    l'objectif n'est pas spécifique aux équipes.
  - `src/lib/agent/__tests__/prompts.metrics.test.ts` — seuil de budget de prompt
    relevé de **6000 → 8000** caractères (garde-fou anti-dérive, pas une cible),
    avec commentaire justifiant la marge (le preset IA réel ajoute en plus la
    délégation d'équipe, non mesurée par ce test).

- **Décisions Techniques :**
  - **Neutralité volontaire** : le bloc n'énonce que le POURQUOI (satisfaire le
    besoin) jamais le COMMENT (quel outil, seul ou en équipe). Les décisions de
    méthode restent portées par `DELEGATION_GUIDANCE_TEAMS` / `BATCHING_RULES`,
    qui ne se contredisent donc pas.
  - **Formulé en interdictions d'échec, pas en injonction d'en faire plus** :
    « ne pas s'arrêter à un résultat plausible », « ne jamais présenter un travail
    inachevé comme fini ». Cela pousse à la persévérance sans encourager le
    sur-travail (« le chemin le plus court qui satisfait pleinement l'utilisateur
    gagne »).
  - **Budget mesuré, pas supposé** : vérifié par mesure (`agent/max` 5831 → 6922
    chars) et par `git stash` que le dépassement venait bien de ce bloc, avant de
    toucher le seuil. La décision de relever le seuil a été validée par
    l'utilisateur (le seuil datait d'avant les capacités teams/navigateur/skills).

- **Impacts & Dépendances :**
  - Le bloc apparaît dans tous les prompts système ; les tests d'uniformité et de
    non-redite passent (43/43 sur `prompts.*`, 334/334 sur `src/lib/agent`).
  - Toute nouvelle capacité qui gonfle le prompt devra rester sous le seuil 8000.

- **Prochaines étapes :**
  - Observer en usage réel que le bloc ne provoque pas de tours excessifs
    (sur-vérification) — le contre-poids « ne pas gonfler le travail » est prévu
    pour cela.

---

### [2026-10-20T00:30] | Mode IA : visibilité des événements (outils, web, sous-agents)

- **Contexte :** en mode IA, le fil de chat n'affiche quasiment rien pendant un
  run : les recherches web, les lectures, les recherches codebase et surtout les
  **sous-agents lancés** restaient invisibles, alors qu'en mode IDE ces
  événements s'affichent. Symptôme associé : « le TTFT est lent », « on ne voit
  même pas les sous-agents qui sont lancés ». Deux causes distinctes :
    1. **Noms d'outils divergents** : le SDK Cline émet des noms canoniques
       (`read_files`, `search_codebase`, `fetch_web_content`, `web_search`,
       `apply_patch`, `editor`, `run_commands`, + 18 `team_*`) qui NE
       correspondaient à AUCUN des noms connus de `toolGroups.ts` (calibré sur le
       harness historique : `read_file`, `grep`, `glob`, `edit`). Résultat : ni
       regroupement (« Read 2 files »), ni clic-vers-fichier, ni libellé lisible
       pour ces outils.
    2. **TTFT perçu** : pendant le silence de l'orchestrateur (avant le premier
       token), une bulle assistant vide n'affichait qu'un curseur 2px discret,
       indistinguable d'un gel.

- **Modifications effectuées :**
  - `src/lib/agent/clineBridge.ts` — ajout d'un bloc **« SOURCE DE VÉRITÉ UNIQUE
    DES NOMS D'OUTILS »** : `READ_TOOL_NAMES`, `SEARCH_TOOL_NAMES`,
    `LIST_TOOL_NAMES`, `WEB_TOOL_NAMES`, `TEAM_TOOL_NAMES` (18) + helpers
    `isTeamTool(toolName)` et `toolFilePath(toolName, args)` (gère `path` ET
    `paths[0]`). Un seul endroit à faire évoluer quand le SDK renomme un outil.
  - `src/lib/toolGroups.ts` — réécrit pour **consommer** ces constantes au lieu
    de listes locales périmées : `toolVerb` mappe désormais read→`read`,
    search→`search`, list→`list`, web→`fetch` ; `isGroupable` couvre les 4
    familles ; `toolTargetPath` délègue à `toolFilePath` ; `groupLabel` gagne le
    cas `"fetch"` (« Fetched N pages »).
  - `src/components/ai/ToolCallCard.tsx` — `TOOL_LABELS` enrichi (`apply_patch`,
    `web_search`, **les 18 `team_*`** : « Spawn teammate », « Team status »,
    « Run teammate task »…) ; `FILE_TOOLS` complété (`read_files`, `apply_patch`,
    `write_to_file`) ; `argsPreview` affiche l'URL/requête pour les outils web
    (`fetch_web_content`/`web_fetch` → `url ?? query`, `web_search` → `query`).
  - `src/components/ai/MessageBubble.tsx` — l'état de streaming vide n'affiche
    plus un simple curseur mais un indicateur **« Working »** + 3 points animés
    (`pulse 1.2s`, délais décalés) : l'utilisateur voit immédiatement que le
    moteur travaille, même avant le premier token.

- **Décisions Techniques :**
  - **Source de vérité unique** plutôt que duplication : avant, chaque fichier
    (toolGroups, ToolCallCard, clineApproval) avait sa propre liste de noms, qui
    divergeaient. En centralisant dans `clineBridge.ts` (déjà le point de
    traduction SDK→UI), un renommage SDK se corrige en un seul endroit.
  - **Regrouper les lectures, pas les écritures** : on ne regroupe que les
    familles sans risque (read/search/list/web). Les écritures et le shell
    restent en cartes individuelles, pour ne jamais masquer une action sensible.
  - **Indicateur d'activité explicite** : « Working » lève l'ambiguïté d'un
    curseur clignotant. C'est un gain de TTFT **perçu** sans mentir sur l'état
    (on n'affiche pas de faux contenu).

- **Impacts & Dépendances :**
  - `toolGroups.ts` importe désormais `./agent/clineBridge` : pas de cycle
    (clineBridge n'importe pas toolGroups). Toute évolution de noms d'outils doit
    passer par `clineBridge.ts`.
  - Le regroupement change l'affichage de plusieurs outils de lecture en IA/IDE :
    vérifier visuellement qu'aucun outil n'est « avalé » (un groupe a un
    en-tête cliquable et dépliable).

- **Prochaines étapes :**
  - Vérifier en `tauri dev` que les `team_progress` arrivent bien (non
    vérifiable statiquement) : la carte « Spawn teammate » doit afficher les
    outils du coéquipier en direct puis se figer à la fin du run.
  - Vérifier que les recherches web (`fetch_web_content`/`web_search`) affichent
    bien URL/requête et se regroupent.

---

### [2026-10-19T23:45] | Mode IA : alléger l'orchestration d'équipe (lenteur perçue)

- **Contexte :** l'utilisateur trouve l'agent **plus lent en mode IA qu'en mode IDE**.
  Diagnostic : ce n'est pas un bug mais un surcoût **structurel**. En IA,
  `AiPanel` passe `enableTeams:true` → le sidecar active `enableAgentTeams` :
  un orchestrateur racine + des coéquipiers = **boucles LLM multiples** et des
  tours de coordination (`team_spawn_teammate` → `team_run_task` →
  `team_await_runs` → `team_shutdown_teammate`) qui ne produisent pas de travail
  visible. En IDE, `enableTeams:false` = **un seul agent**, zéro coordination.
  Facteur aggravant **textuel** : le prompt `DELEGATION_GUIDANCE_TEAMS` disait
  au modèle de déléguer « **by default on broad work** », et le bloc
  `contextStatusPrompt` poussait à déléguer **même à contexte quasi vide** →
  spawn réflexe pour du travail qu'un agent seul finissait plus vite.

- **Modifications effectuées :**
  - `src/lib/agent/prompts.ts` — `DELEGATION_GUIDANCE_TEAMS` recalibré :
    message d'ouverture « use it judiciously », coût explicite du spawn
    (« an extra model loop plus coordination round-trips »), et consigne
    inversée : « Do NOT delegate by default… a single round-trip beats an
    orchestration every time ». Ajout d'une règle anti-fuite : « Never leave a
    teammate running idle ».
  - `src/lib/agent/tokenBudget.ts` — `contextStatusPrompt` : à budget `ok`
    (contexte non contraint), la consigne devient « handle the work directly
    unless an investigation is genuinely broad ». La pression à déléguer ne
    réapparaît qu'aux niveaux `compact`/`critical`, où elle est réellement
    justifiée.

- **Décisions Techniques :**
  - **Agir par le prompt, pas par un plafond dur** : le SDK n'expose aucune
    limite de coéquipiers (`maxTeammates` & co. absents). La décision « spawner
    ou non » est prise par le modèle ; on corrige donc **sa consigne**, pas un
    artifice fragile. Zéro perte de capacité : la délégation reste disponible là
    où elle paie (investigation large, contexte qui se remplit).
  - **Ne pas désactiver les équipes** : choix explicite de l'utilisateur
    (« Alléger les équipes », pas « Aligner IA sur IDE »). On conserve
    l'orchestration multi-agents comme capacité, on en retire le **réflexe**.
  - **Invariants testés préservés** : les tests vérifient la présence/absence du
    bloc et de ses outils (`team_spawn_teammate`), pas le texte exact → le
    recalibrage passe sans casser le contrat (`33 tests OK`).

- **Impacts & Dépendances :**
  - `prompts.ts`, `tokenBudget.ts`. Aucun changement de contrat côté SDK/sidecar.
  - Effet attendu : en IA, moins de spawns inutiles, tours plus courts, TTFT plus
    bas sur les tâches ciblées ; le multi-agents reste engagé sur gros travaux.
  - Vérif : `npx tsc --noEmit` (fichiers `src/` → 0 erreur) ; `vitest` sur
    `prompts.test.ts` + `prompts.metrics.test.ts` → **33 passed**.

- **Prochaines étapes :**
  - Mesurer en conditions réelles : comparer TTFT / nombre de tours IDE vs IA sur
    une même tâche ciblée (scripts `scripts/ttft-probe.ts`, `scripts/turn-probe.ts`).
  - Si la lenteur persiste sur des tâches simples, envisager un garde
    déterministe (n'activer `enableTeams` que si la tâche dépasse un seuil de
    complexité) — piste évoquée, non retenue pour ce lot.

---

### [2026-10-19T10:40] | Approbation interactive des commandes (ask → carte, plus d'erreur `approval_required`)

- **Contexte :** quand l'agent voulait exécuter une commande (`Run command`) en
  mode `manual`/`auto`, l'UI affichait une **erreur d'outil** :
  `Error: {"error":"approval_required -- NOT a tool or system failure. Clarify
  with user before proceeding."}`. Le pipeline Cline (`tool_approval` → front →
  `decideApproval` → `tool_approval_response`) renvoyait `{approved:false,
  reason:"approval_required"}` **immédiatement** pour un verdict `ask`, au lieu
  d'attendre l'accord de l'utilisateur. Résultat : le SDK recevait un refus et le
  transformait en erreur d'outil, au lieu de **mettre le run en pause** le temps
  d'une confirmation.

- **Modifications effectuées :**
  - `src/lib/agent/clineHarness.ts` :
    - `makeApprovalDecider(workspace, onBlocked?, emitAsk?)` : le verdict `ask`
      renvoie désormais une **Promise** résolue par l'UI (`emitAsk(action)`)
      quand un canal UI est branché ; repli sûr `{approved:false,
      reason:"approval_required"}` seulement si `emitAsk` est absent.
    - `startClineHarness` : pont `emitAsk` — émet un event `approval-required`
      (id local `harness-approval-N`) dans le fil, résout par `approve/reject`,
      puis émet `approval-resolved` pour **figer la carte** après le clic.
  - `src/lib/agent/permissions.ts` :
    - Mémoire « Always allow » (localStorage `origin-ai-always-allow-commands`,
      bornée à 200) : `loadAlwaysAllowCommands` / `addAlwaysAllowCommand` /
      `removeAlwaysAllowCommand`, comparaison sur **commande exacte** normalisée.
    - `decideApproval` : une commande `bash_run` présente dans l'allowlist est
      auto-approuvée — placé **après** la garde anti-catastrophe (jamais
      court-circuitée) et après le court-circuit `full`.
  - `src/components/ai/ToolCallCard.tsx` : bouton **« Always allow »** sur la
    carte d'approbation `bash_run` → `addAlwaysAllowCommand(command)` puis
    `tc.approve?.()`.

- **Décisions Techniques :**
  - **Réutiliser la carte du fil existante** (pas de nouveau composant) : la
    carte `approval-required` de `bash_run` portait déjà Reject/Approve ; on y
    ajoute « Always allow ». Cohérence avec l'existant, zéro surface d'UI neuve.
  - **`ask` = pause, pas refus** : c'est la correction de fond. Un `ask` doit
    *attendre*, pas *refuser* — le refus immédiat était un bug de sémantique qui
    se traduisait en erreur visible côté agent.
  - **Allowlist à portée étroite** : commande **exacte** (jamais un préfixe, qui
    ouvrirait l'exécution de variantes injectées). Ne contourne **jamais** la
    garde anti-catastrophe. Uniquement les commandes shell (les écritures gardent
    l'onglet diff, plus sûr).
  - **Bornage** : 200 entrées max (éviction FIFO via l'ordre d'insertion du Set)
    → borne le stockage localStorage et limite la fenêtre d'une allowlist qui
    deviendrait trop large par usure.

- **Impacts & Dépendances :**
  - `clineHarness.ts`, `permissions.ts`, `ToolCallCard.tsx`.
  - Contrat inchangé côté sidecar/Rust : `decideApproval` acceptait déjà une
    Promise. Le délai sidecar (120 s) reste le garde-fou : sans clic dans la
    fenêtre, l'outil est refusé (dégradation sûre).
  - Vérif : `npx tsc --noEmit` → exit 0.

- **Prochaines étapes :**
  - Tester en `tauri dev` : une commande non catastrophique ouvre la carte, le
    run attend ; « Approve » débloque, « Always allow » mémorise et ré-exécute
    sans redemander, « Reject » annule proprement.
  - Surveiller : en cas de forte latence, la promesse `emitAsk` peut survivre au
    timeout sidecar de 120 s (résolution post-refus, inoffensive car `settled`).

---

### [2026-10-18T20:05] | MCP ENOENT + garde-fou workspace de l'agent (2 lots)

- **Contexte :**
  1. Au lancement d'une session agent : `Extension mcp: ENOENT ... open
     '/Users/user/Library/Application Support/com.mira.ide/mira/settings/
     mira_mcp_settings.json'`, suivi de `[ai/panel] tour en erreur ... erreur du
     moteur d'agent`. Cause : le SDK Cline lit ce fichier de façon **non
     tolérante** (`registerMcpServersFromSettingsFile` → ENOENT fatal), mais il
     n'était **jamais créé par défaut** — seulement au premier ajout d'un serveur
     MCP via Settings. Sur une install neuve, ni `settings/` ni le fichier
     n'existent. (`mira_mcp_settings.json` dans le message est un artefact de
     neutralisation de marque ; le vrai fichier est `cline_mcp_settings.json`.)
  2. L'agent « se perd » dans le workspace (ex. invente
     `/home/user/workspace/mareg/src/index.ts`). Diagnostic : le workspace est
     unique et explicite (`WorkspaceContext.folderPath` → `start.cwd`), mais des
     fallbacks `"."` subsistaient côté lancement, et `process.cwd()` du sidecar
     est `<app_data>/mira` (jamais le projet) → tout `"."` pointe hors projet.

- **Modifications effectuées :**
  - **Lot A — provisioning MCP (cause racine)**
    - `src-tauri/src/extensions_store.rs` : nouvelle fonction
      `ensure_mcp_settings_file(app)` — crée `<app_data>/mira/settings/
      cline_mcp_settings.json` avec `{"mcpServers":{}}` **si absent uniquement**
      (idempotent, best-effort, journalisé).
    - `src-tauri/src/lib.rs` : appel dans `setup()`, après `default_skills`.
    - `src-tauri/cline-sidecar/src/instructions.ts` : garde-fou
      `ensureMcpSettingsFile(path)` avant l'appel SDK (défense en profondeur :
      lancement hors setup Tauri, dossier purgé). Écriture avec flag `wx`
      (n'écrase jamais), `EEXIST` ignoré (course avec Rust).
  - **Lot B — workspace agent**
    - `src/components/ai/AiPanel.tsx` : suppression des fallbacks `"."` morts et
      trompeurs (`workspace: fp || "."` → `fp` ; `touchTurn(path, ws ?? fp ??
      ".")` → `ws ?? fp`). `fp` est déjà garanti non vide par la garde-fou
      workspace en amont.
    - `App.tsx:942` `cwd={folderPath ?? "."}` (terminal) : **laissé tel quel** —
      le terminal doit pouvoir s'ouvrir sans projet ; ce n'est pas un chemin
      agent.

- **Décisions Techniques :**
  - **Provisionner plutôt que rendre l'absence acceptable** : on garantit au SDK
    un fichier de configuration **valide et vide**, ce qui est l'état attendu
    « aucun serveur MCP ». Deux niveaux (Rust setup + sidecar) car le sidecar
    peut tourner sans le setup Tauri (tests, lancement manuel).
  - **Idempotence stricte** : on ne touche jamais un fichier existant, même
    vide/partiel → zéro risque d'écraser la config utilisateur. `flag: "wx"`
    côté Node ferme la fenêtre de course.
  - **Cross-platform** : chemins via `app_data_dir()` (Rust) et résolution du
    SDK (Node) → macOS `~/Library/Application Support/com.mira.ide`,
    Windows `%APPDATA%\com.mira.ide`, Linux `~/.local/share/com.mira.ide`.
  - Suppression des fallbacks `"."` côté agent uniquement : élimine un
    chemin d'écriture hors-projet silencieux (risque de sécurité).

- **Impacts & Dépendances :**
  - `extensions_store.rs`, `lib.rs`, `instructions.ts`, `AiPanel.tsx`.
  - Aucune migration nécessaire : les configs existantes restent intactes.
  - Vérifs : `cargo check --no-default-features` → Finished (0 warning) ;
    `npx tsc --noEmit` → exit 0 ; `npm run build` du sidecar → OK (11.6 mb).

- **Prochaines étapes :**
  - Tester au prochain `tauri dev` : plus d'ENOENT au lancement, l'agent démarre
    avec un workspace valide. Si l'agent invente encore des chemins, envisager
    d'injecter un aperçu réel de l'arborescence dans le prompt (piste évoquée,
    non retenue pour ce lot).

---

### [2026-10-18T19:20] | Logs : `listExtensions` bruité en preview (faux warning `SIDECAR_NOT_RUNNING`)

- **Contexte :** la console affichait en boucle un `warn` :
  `[agent/clineClient] listExtensions ignoré: {"code":"SIDECAR_NOT_RUNNING", ...}`.
  Diagnostic : `listExtensions` (peuplement de l'auto-complétion `#skills` /
  `/commands`) est appelé au montage de l'UI, avant tout `send`. Dans
  `trae-preview` (aperçu navigateur sans backend Tauri) l'`invoke` échoue
  toujours → code `SIDECAR_NOT_RUNNING`. Or cet échec est **nominal** : le repli
  « surface vide » est le comportement prévu (cf. doc de la fonction). Le logger
  le classait en `warn`, polluant la console avec une fausse alerte.

- **Modifications effectuées :**
  - `src/lib/agent/clineClient.ts` :
    - nouveau helper `describeErrorCode(error)` : extrait le champ `code` d'une
      erreur Tauri, qu'il arrive en objet `{ code, message }` ou sérialisé en
      JSON dans le message (deux formes possibles selon le chemin IPC) ; renvoie
      `null` sans jamais jeter.
    - `listExtensions` : `SIDECAR_NOT_RUNNING` → `log.debug` (état attendu) ;
      toute AUTRE erreur reste `log.warn` (vraie anomalie). Aucun changement de
      comportement fonctionnel (retour `{ skills: [], commands: [], issues: [] }`
      inchangé).

- **Décisions Techniques :** on **ne supprime pas** le log — on le **dégrade** en
  `debug` uniquement pour le code attendu. Cela préserve l'observabilité (un
  vrai échec de sidecar pendant un run reste visible en `warn`) tout en
  supprimant le bruit de démarrage. Lecture du code d'erreur tolérante aux deux
  formes de sérialisation, sans dépendance à la structure interne de Tauri.

- **Impacts & Dépendances :** `src/lib/agent/clineClient.ts` uniquement.
  Rétrocompatible ; `npx tsc --noEmit` → exit 0.

- **Prochaines étapes :** surveiller qu'aucun autre appel précoce au sidecar ne
  produit le même faux `warn` (même traitement à appliquer si constaté).

---

### [2026-10-18T18:05] | Agents : création d'agents personnalisés (prompt + outils + MCP) et sélection dans l'input

- **Contexte :** parité Trae « Agents » (docs.trae.ai/ide/agent), avec un périmètre
  volontairement réduit : l'utilisateur crée ses propres agents (nom + prompt +
  outils + serveurs MCP), ils sont **globaux** (toutes sessions, tous projets), et
  il les **sélectionne dans le dropdown Agent** de l'input du chat. Exclus : Smart
  Generate, « Callable by other agents ».

- **Modifications effectuées :**
  - **Backend Rust** — `src-tauri/src/extensions_store.rs` : section « Agents
    personnalisés » (`AgentInfo { id, name, prompt, tools, mcp, avatar,
    created_at }`, `agents_root() = ~/.mira/agents`, `validate_agent_id`,
    `list_agents` / `read_agent` / `write_agent` / `delete_agent`, écriture
    atomique). `src-tauri/src/lib.rs` : 4 commandes enregistrées.
  - **Front (état + invoke)** — `src/lib/agent/customAgents.ts` : `CustomAgent`,
    `slugifyAgentId`, `listAgents` / `saveAgent` (anti-collision `-2`, `-3`),
    `deleteAgent`, `readSelectedAgentId` / `setSelectedAgentId`
    (`localStorage: origin-ai-agent`), `resolveSelectedAgent`,
    émission `CUSTOM_AGENTS_EVENT`.
  - **Settings** — `src/components/settings/AgentsSection.tsx` : liste Custom /
    Built-In + éditeur (Name, Prompt, MCP cochés via `list_mcp_servers`, Built-In
    Tools). `SettingsPanel.tsx` : section `agents`, prop `initialSection`, écoute
    `origin-open-settings`. `App.tsx` : état `settingsSection` + handler d'ouvert.
  - **Dropdown input** — `src/components/ai/ChatBox.tsx` : `ModeDropdown` reçoit
    `customAgents` / `selectedAgentId` / `onSelectAgent` / `onCreate`, section
    « Custom Agents » sous « Built-In Agents », bouton « Create Agent » →
    `origin-open-settings { section: "agents" }`. Sélection = `mode = "agent"`.
  - **Moteur** — `src/components/ai/AiPanel.tsx` : le prompt de l'agent est
    **injecté** dans le prompt système (bloc `# Agent Role`, jamais en
    remplacement) ; filtrage d'outils = préférences globales ∪ (outils non
    retenus) ; équipes coupées si agent perso ; `enabledMcpServers` dérivé de
    `agent.mcp` à la CRÉATION de session. `clineHarness.ts` /
    `clineClient.ts` : champ `enabledMcpServers` transmis.
  - **Sidecar** — `src-tauri/cline-sidecar/src/blockedTool.ts` (nouveau) :
    `buildBlockedTools` fabrique des outils « refus » de MÊME NOM pour masquer
    les outils MCP des serveurs non autorisés. `index.ts` : `StartCommand`
    gagne `enabledMcpServers` ; `blockedMcpSpecs` déduit `<server>` du nom
    `mcp__<server>__<tool>` ; les outils « refus » rejoignent `extraTools`.

- **Décisions Techniques :** agents persistés **globalement** dans
  `~/.mira/agents/<slug>.json` (réponse explicite de l'utilisateur). Prompt
  injecté (pas substitué) pour préserver les garde-fous système. Le SDK charge
  TOUS les serveurs MCP du fichier global : faute de pouvoir filtrer sa config
  côté front, l'isolation se fait par **outils de même nom qui refusent** —
  l'appel échoue donc proprement au lieu d'exécuter une action non autorisée.
  `undefined` (pas d'agent) → tous les serveurs restent exposés (comportement
  par défaut inchangé) ; tableau vide → aucun.

- **Impacts & Dépendances :** nouveaux fichiers front/TS et un module sidecar ;
  `AiPanel` / `ChatBox` / `SettingsPanel` / `App.tsx` modifiés. Le champ
  `enabledMcpServers` traverse `cline_sidecar_send` (Rust passe le JSON tel quel,
  aucune modif Rust du transport). Effet de bord voulu : masquage des serveurs
  MCP par session via outils « refus ».

- **Prochaines étapes :** dette connue (non prioritaire) — migrer les
  `window.confirm` asynchrones de `SourceTreePanel.tsx` / `SettingsPanel.tsx`.

---

### [2026-10-18T12:10] | Editeur : fermeture d'onglet à la suppression, gutter compacte, bordures allégées

- **Contexte :** trois irritants UI signalés sur l'éditeur/explorateur :
  1. Supprimer un fichier ouvert depuis l'explorateur laissait l'onglet ouvert
     (contrairement à VS Code) — le fichier n'existant plus, l'éditeur restait
     sur un contenu fantôme.
  2. La gutter des numéros de ligne était trop large (`minWidth: 3.2em` +
     `padding: 0 12px 0 8px`), gaspillant de l'espace horizontal.
  3. Trop de bordures dans l'éditeur (gutter, minimap, sticky scroll, chunks de
     diff) — certaines masquaient visuellement le code.

- **Modifications effectuées :**
  - `src/components/FileTree.tsx` : ajout de la prop `onExternalFileChanges`
    (Props + signature) ; dans `performDelete`, calcul de `deleted` (chemins
    réellement supprimés) puis appel de `onExternalFileChanges?.(deleted)`.
  - `src/components/Sidebar.tsx` : prop `onExternalFileChanges` ajoutée à
    `Props` / `ActivePanel` / `Sidebar`, transmise à `FileTree` (case
    "explorer").
  - `src/App.tsx` : `onExternalFileChanges={applyExternalFileChanges}` passé à
    `<Sidebar>` (l.863).
  - `src/components/editor/Editor.tsx` (`originBaseTheme`) :
    - `.cm-gutters` : suppression de `borderRight`, ajout `minWidth: '0'`.
    - `.cm-lineNumbers .cm-gutterElement` : `minWidth: 3.2em → 1.8em`,
      `padding: 0 12px 0 8px → 0 4px 0 4px`.
    - `.cm-minimap-gutter` : suppression de `borderLeft`.
    - `.cm-sticky-scroll` : suppression de `borderBottom`.
    - `.cm-deleted|changed|insertedChunk-gutter` : `borderRight: 3px → 2px` et
      opacité réduite (65% → 55%).

- **Décisions Techniques :** `applyExternalFileChanges` (useTabs) faisait déjà
  exactement le comportement VS Code voulu (relit chaque chemin ; si
  `readFile` échoue → ferme l'onglet). Plutôt que dupliquer cette logique dans
  `FileTree`, on rebranche cette fonction existante via une prop dédiée — zéro
  duplication, sémantique unique conservée. On ne notifie que les chemins
  **réellement supprimés** (`r.ok && r.path`) pour ne pas fermer d'onglet sur
  un échec partiel. Côté thème, on conserve les gutters de diff fonctionnels
  (repère visuel utile) mais on amincit la bordure pour ne plus masquer le code.

- **Impacts & Dépendances :** `FileTree`, `Sidebar`, `App.tsx`, `Editor.tsx`.
  Aucun changement d'API publique hors ces props optionnelles (rétrocompatible :
  `onExternalFileChanges` est optionnel). `npx tsc --noEmit` → exit 0.

- **Prochaines étapes :** surveillance visuelle multi-thème (contraste de la
  gutter compacte) ; le comportement est identique pour suppression unitaire,
  multiple et via raccourci `Delete`/`Backspace`.

---

- **Contexte :** gros lot de Réglages demandé. Trois sections devaient devenir
  **fonctionnelles** (et non plus des coquilles « Coming soon ») : **CUE**,
  **Agent** (façon Trae) et **Browser**. En parallèle : livrer une bibliothèque de
  **skills par défaut** avec l'app (tous les skills HyperFrames + media-use +
  InsForge + copywriting), activés d'office, **désactivables dans l'UI**, et
  surtout **réellement chargés par le moteur Cline** (pas seulement listés).

- **Modifications effectuées :**
  - **CUE** — `src/lib/cuePrefs.ts` (clés `origin-cue-tab`, `-smart-import`,
    `-smart-rename`, opt-out : absent = activé) + `CueSection.tsx` (3 toggles avec
    badges Beta). Gâchette réelle : `App.tsx` coupe la complétion inline quand
    `origin-cue-tab === "false"`.
  - **Agent** — `src/lib/agent/agentToolPrefs.ts` (`origin-agent-disabled-tools`,
    catalogue `read_files`/`search_codebase`/`editor`/`run_commands`/
    `fetch_web_content`/`browser`) + `AgentSection.tsx` (liste activable, compteur
    « N of M »). Le contrat d'outils du système prompt devient **filtré** :
    `buildFullToolContract`/`buildReadOnlyToolContract` dans `toolPresentation.ts`,
    5ᵉ paramètre `disabledTools` de `buildSystemPrompt` (`prompts.ts`), alimenté
    par `getDisabledTools()` dans `AiPanel.tsx`.
  - **Browser** — `src/lib/browserPrefs.ts` (`origin-browser-builtin-control`
    [défaut ON], `-external-control` [opt-in, défaut OFF], `-default-target`,
    `-auto-screenshot`) + `BrowserSection.tsx` (3 blocs conformes à la maquette :
    Built-in / External Chrome avec bouton « Install extension » et lien manuel /
    General). Le toggle « builtin » pilote réellement l'injection de l'outil
    `browser` (`extraTools`) dans `AiPanel.tsx`.
  - **Skills par défaut** — 12 `SKILL.md` créés sous `src-tauri/default_skills/`
    (10 HyperFrames/media-use + `insforge` + `copywriting`), frontmatter
    `name`+`description` valide, **sans** `enabled: false` (activés d'office).
  - **Installation native** — nouveau module `src-tauri/src/default_skills.rs` :
    `install_default_skills` copie `default_skills/**` du bundle vers
    `~/.mira/skills` **de façon idempotente** (un skill déjà présent — ou
    désactivé par l'utilisateur — n'est JAMAIS écrasé), noms validés
    (`validate_name`), confinement (`ensure_within`), copie atomique
    (tmp voisin + `rename`), dossiers cachés/`node_modules` ignorés. Appelée
    **best-effort** dans `.setup()` de `lib.rs`. `default_skills` ajouté à
    `bundle.resources` (`tauri.conf.json`).
  - **Câblage moteur Cline (correctif clé)** — `cline-sidecar/src/instructions.ts` :
    `resolveSkillsConfigSearchPaths` ne connaît QUE `.cline`/`.claude`/`.agents` et
    **ignore `.mira`**. Sans correctif, les skills par défaut auraient été visibles
    dans Réglages (qui lit `.mira/skills`) mais **jamais proposés au modèle**. On
    ajoute donc `~/.mira/{skills,rules,workflows}` (via `homedir()`) à
    `withMiraDirectories`. Bundle sidecar rebuild.

- **Décisions Techniques :**
  - **Politique de préférence unifiée** : « opt-out » pour les fonctions à forte
    valeur (CUE, contrôle du navigateur intégré, auto-screenshot) → l'absence de
    clé vaut « activé » ; « opt-in » pour ce qui touche à l'extérieur (contrôle du
    Chrome externe) → désactivé par défaut. Cohérent avec la règle « secure by
    default » du projet.
  - **Skills : livrer sans écraser.** On copie seulement les skills absents. Un
    skill désactivé reste désactivé après mise à jour de l'app : on respecte l'état
    utilisateur plutôt que de « réparer » silencieusement. Compromis assumé : une
    correction de contenu sur un skill déjà installé ne se propage pas (l'UI permet
    la ré-édition/import).
  - **Filtrer le contrat ≠ retirer l'outil.** Les familles désactivées sont
    retirées du prompt système (le modèle ne les voit plus) ; les outils non
    désactivables (progression todo, questions, skills) restent toujours présents.

- **Impacts & Dépendances :** nouveaux fichiers `cuePrefs.ts`, `browserPrefs.ts`,
  `agentToolPrefs.ts`, `CueSection.tsx`, `BrowserSection.tsx`, `AgentSection.tsx`,
  `default_skills.rs`, `default_skills/**`. Modifiés : `SettingsPanel.tsx` (montage
  des 3 sections), `App.tsx`, `AiPanel.tsx`, `prompts.ts`, `toolPresentation.ts`,
  `instructions.ts` (sidecar, rebuild requis), `lib.rs`, `tauri.conf.json`. La
  découverte des skills gagne `~/.mira/*` globalement — effet de bord voulu pour
  les règles/workflows `.mira` globaux.

- **Sécurité / revue adversariale :** l'installation n'accepte **aucune entrée**
  du webview (source = bundle, destination = `~/.mira/skills`) ; noms de dossiers
  du bundle traités comme **non fiables** (validés + confinement) ; skills = 
  Markdown **inerte**, jamais exécuté. Le toggle navigateur externe reste opt-in.
  Pas de secret introduit.

- **Validation :** `cargo check` OK, `cargo test default_skills` OK, `tsc` OK,
  `eslint` 10 warnings préexistants (0 erreur), `vitest` **640/640**, `vite build`
  OK, sidecar `tsc` + tests (8/8) + rebuild bundle OK.

- **Prochaines étapes :** (1) dette précédente — migrer les `window.confirm`
  asynchrones (`SourceTreePanel.tsx:288`, `SettingsPanel.tsx:1144`). (2) Optionnel :
  versionner les skills par défaut (marqueur de version) pour propager les
  corrections de contenu sans écraser l'état utilisateur.

---

### [2026-10-18T01:35] | Skills auto-load (sans run) + boutons Indexing à droite + i18n EN élargie

- **Contexte :** trois écarts remontés par l'utilisateur. (1) Le « chargement
  automatique des skills » n'était pas opérationnel : la liste des skills restait
  vide tant qu'aucun message n'avait été envoyé. (2) Dans **Indexing & Docs**, les
  boutons Build/Clear étaient sous le contenu au lieu d'être à droite de la ligne
  « Index status ». (3) Du français subsistait dans l'UI, au-delà des Réglages.

- **Modifications effectuées :**
  - **Skills sans session — côté sidecar** (`src-tauri/cline-sidecar/src/index.ts`) :
    nouvelle commande `listExtensions { cwd }` → appelle `resolveSessionExtensions`
    (même résolution que `start`, sans créer de session) et renvoie
    `{ skills, commands, customCommands, extensionIssues }`. Les issues sont
    neutralisées (`neutralizeForClient`) comme au `start`.
  - **Skills sans session — côté client** (`src/lib/agent/clineClient.ts`) :
    `listExtensions(cwd): Promise<ClineSessionExtensions>` via
    `invoke("cline_sidecar_send", { command: { type: "listExtensions", cwd } })`
    réutilise le MÊME normaliseur défensif que `start` (`normalizeExtensions`).
    Non fatal : toute erreur renvoie une surface vide.
  - **Câblage UI** (`src/components/ai/AiPanel.tsx`) : effet déclenché dès qu'un
    `folderPath` est connu → peuple `sessionExtensions` sans attendre un run. Un
    `CustomEvent` (`EXTENSIONS_CHANGED_EVENT` = `mira:extensions-changed`, exporté
    depuis `clineClient`) est écouté pour recharger après mutation depuis les
    Réglages. `SkillsSection` émet ce signal après save/delete/toggle/import.
  - **Indexing & Docs** (`IndexingSection.tsx`) : Build/Rebuild + Cancel + Clear
    déplacés sur la ligne « Index status », ancrés à droite (`marginLeft:auto`),
    masqués tant que le statut charge ou sans workspace.
  - **i18n EN** : traduction des chaînes FR **visibles** restantes hors Réglages
    (viewers audio/vidéo/image/PDF/Markdown, terminal & debug, notifications,
    permissions, notices de run, consentement binaires tiers, toasts d'install
    LSP dans `App.tsx`). Les commentaires de code restent en français.

- **Décisions Techniques :**
  - **Résolution à la demande plutôt qu'un watcher** : le sidecar résout les
    extensions au `start` uniquement (choix architectural existant pour éviter un
    scan permanent). On ajoute donc une RPC ponctuelle, idempotente, réutilisant
    strictement la même forme de retour → une seule source de vérité sur le
    schéma, aucun risque de divergence entre `start` et `listExtensions`.
  - **`CustomEvent` natif plutôt qu'un store global** : signal découplé, sans état
    partagé ni dépendance nouvelle entre les modules Settings et l'AI Panel. Coût
    nul, testable, et extensible aux autres surfaces d'extension.

- **Impacts & Dépendances :**
  - `cline-sidecar` reconstruit (`npm run build` → `dist/index.mjs`).
  - `SkillsSection` importe désormais `notifyExtensionsChanged` depuis
    `lib/agent/clineClient` (dépendance UI → client agent, volontairement minime :
    une constante + une fonction pure).
  - Aucune migration de données ; aucune API Rust modifiée.

- **Prochaines étapes :**
  - Refonte visuelle structurelle profonde des modales Réglages (esprit Trae,
    identité Mira) — validée avec l'utilisateur, à mener en itération dédiée.
  - Section **Models** façon Trae : recherche de modèles + activer/désactiver par
    provider.
  - Dette connue : `SourceTreePanel.tsx` (drop de stash) et `SettingsPanel.tsx`
    (serveur MCP) utilisent encore `window.confirm` asynchrone sous Tauri —
    remplacement par une modale React déterministe à prévoir.


- **Contexte :** deux écarts avec l'UI de Trae. (1) De nombreux libellés des
  pages Réglages étaient restés en français, alors que l'interface de référence
  (Trae) est entièrement en anglais. (2) L'icône « + » de l'input agent ouvrait
  un menu dont plusieurs items semblaient présents mais n'étaient pas branchés.

- **Modifications effectuées :**
  - **Traduction EN (8 fichiers, chaînes visibles uniquement — les commentaires
    de code restent en français par convention du projet) :** `IndexingSection`,
    `inputCommands`, `settings/ui` (ScopeTabs, KeyValueEditor), `HooksSection`,
    `RulesMemoriesSection`, `SkillsSection`, `CommandsSection`, `McpSection`,
    `AboutSection`, `MessageActionsBar` (titles des boutons d'action message).
    Normalisation des replis d'erreur sur `"Something went wrong"` (au lieu de
    « Une erreur est survenue ») pour homogénéiser les 4 pages CRUD.
  - **Icône « + » (AttachMenu) :** les 4 items agissent réellement —
    « Add Context » → file picker ; « / for commands & skills » → insère `/` et
    ouvre le catalogue de slash-commands ; « Upload image » → copie l'image dans
    `.mira/attachments/` puis ajoute un badge de fichier ; sous-menu « Skills »
    branché sur `onSkill`. Handlers convertis en fonctions simples (plus de
    `useCallback`) pour satisfaire React Compiler (« Existing memoization could
    not be preserved »).

- **Décisions techniques :**
  - Traduire **uniquement les chaînes rendues** et laisser les JSDoc en français
    : la convention interne du projet (commentaires FR) est un actif pour les
    relecteurs ; seules les surfaces utilisateur doivent suivre Trae (EN).
  - Garder les handlers de l'AttachMenu en fonctions simples plutôt que
    `useCallback` : le style existant recrée déjà `handleInput` à chaque render,
    donc mémoïser uniquement certains handlers créait une instabilité que React
    Compiler refusait de préserver.

- **Impacts & Dépendances :** `ChatBox.tsx` (props passées à `AttachMenu`),
  `settings/*` (textes), `ai/MessageActionsBar.tsx`. Aucun changement d'API ou
  de commande Rust ; `npx tsc --noEmit` passe (exit 0).

- **Prochaines étapes :** traduire les dernières surfaces résiduelles
  (`terminal/TerminalPanel` : « Commande en cours », « Terminal de l'agent ») ;
  lot « Docs » (URL / upload local) séparé, différé.

---

### [2026-10-18T00:30] | L'agent utilise l'index — outil d'agent `codebase_search`

- **Contexte :** le moteur d'index (Lot 6) était complet mais **inertes pour
  l'agent** : l'index n'était interrogeable que par Rust/UI. Or Trae dit
  explicitement que l'index « improves contextual understanding » — autrement
  dit, **c'est l'agent qui s'en sert**, pas seulement l'utilisateur. Il fallait
  donc exposer l'index au modèle pour qu'il localise le code avant de le lire.

- **Modifications effectuées :**
  - **Sidecar — nouveau `src-tauri/cline-sidecar/src/codeIndexTool.ts` :** outil
    custom `codebase_search` (`createTool` de `@cline/core`, zod : `query`
    1..300 car., `limit` 1..50 optionnel, défaut 12, `lifecycle.completesRun =
    false`). `execute` appelle `originInvoke("search_index", { workspace, query,
    limit })`, parse le JSON en `IndexHit[]` et le formate en lignes
    `- <chemin relatif> (score X.XX)`. Un échec remonte une **erreur explicite**
    (jamais un résultat vide trompeur).
  - **Sidecar (`index.ts`) :** `ExtraToolSpec.kind` étendu à `"code_index"` ;
    `buildExtraTools(specs, cwd)` instancie l'outil quand le spec est présent ;
    nouveau pont générique `originInvoke(command, args)` (calqué sur
    `browserInvoke`, sans injection de `panelId`) ; `TOOL_POLICIES.codebase_search
    = { autoApprove: true }` (lecture seule stricte).
  - **Front (`clineClient.ts`) :** `ClineExtraToolSpecAny` + `{ kind:
    "code_index"; sessionId }` ; `INVOKE_ALLOWLIST` + `"search_index"` ; dans
    `respondToInvoke`, cas dédié `search_index` → `invoke("search_index", args)`
    puis `reply({ output: JSON.stringify(hits ?? []) })`.
  - **Front (`AiPanel.tsx`) :** `wantsCodeIndex = !clineSessionId && !!sessionId
    && opts.sdkMode === "act"` → ajoute `{ kind: "code_index", sessionId }` aux
    `extraTools` **uniquement** en mode Agent/SOLO.
  - **Contrat de prompt (`toolPresentation.ts`) :** `codebase_search` ajouté à
    `FULL_TOOL_NAMES` **et** documenté au contrat Agent (« search the LOCAL
    codebase index… use it FIRST to locate code »). Sans cette ligne, le modèle
    ignorait l'outil et ne l'appelait jamais.
  - **Transparence UI :** `clineApproval.ts` (`READ_TOOLS`), `ToolCallCard.tsx`
    (label « Search codebase index », aperçu = `"<query>"`).

- **Décisions techniques :**
  - **Nom distinct de `search_codebase` (SDK).** Volontaire : le SDK possède déjà
    un outil homonyme piloté par le modèle. Mélanger les deux aurait créé une
    ambiguïté pour le modèle **et** dans les logs/UI. `codebase_search` ≠
    `search_codebase`.
  - **Double barrière de sécurité.** L'outil n'existe que si le spec
    `kind:"code_index"` est reçu (sidecar figé), **et** l'invocation est
    refiltrée côté front par `INVOKE_ALLOWLIST`. Défense en profondeur : un
    sidecar compromis ne peut pas appeler une commande arbitraire.
  - **Auto-approbation justifiée.** `search_index` est **lecture seule** et ne
    retourne que des **chemins relatifs** issus de son propre index (confiné via
    `ensure_within`). Aucune exfiltration de contenu, aucune écriture → pas de
    friction d'approbation.
  - **Mode `act` (Agent/SOLO) uniquement.** Choix produit validé : pas d'outil
    d'index en mode chat/plan ; l'index est une capacité d'action.

- **Impacts & Dépendances :**
  - **Nouveau** : `codeIndexTool.ts`. **Modifiés** : `index.ts` (sidecar),
    `clineClient.ts`, `AiPanel.tsx`, `toolPresentation.ts`, `clineApproval.ts`,
    `ToolCallCard.tsx`.
  - **Contrainte** : `toolPresentation` doit rester sous **6 000 caractères** par
    preset (`prompts.metrics.test.ts`) — la ligne de contrat a été raccourcie
    jusqu'à passer.
  - **Rebuild requis** : `node scripts/build-sidecar.mjs` (le sidecar est bundlé
    dans `dist/index.mjs`).
  - Aucun effet de bord sur `context.rs` (l'expansion `#Workspace` n'utilise
    toujours pas l'index).

- **Validation :**
  - `npx tsc --noEmit` (front + sidecar) → OK.
  - `npx eslint` sur les 7 fichiers touchés → 0 erreur (2 warnings « File
    ignored » sur des fichiers sidecar, non bloquants).
  - `vitest run` → **640 passés** (48 fichiers).
  - `cargo test` → OK (inchangé, 1 ignoré réseau).
  - `node scripts/build-sidecar.mjs` → `dist/index.mjs` reconstruit (11,6 Mo).

- **Prochaines étapes :**
  - **Optionnel** : brancher `search_index` sur le tri de `context.rs`
    (`#Workspace`/`#Folder` triés par pertinence au lieu de l'ordre
    d'arborescence).
  - **Différé** : volet « Docs » (URL / upload local) de la page Indexing,
    `#Doc`/`#Web`.

---

### [2026-10-17T23:45] | Indexing local — moteur BM25 + page Settings « Indexing & Docs »

- **Contexte :** Mira ne savait faire qu'un parcours disque + grep (`context.rs`,
  `search.rs`) dont le tri final était **lexicographique** — donc peu pertinent
  pour « retrouver le fichier où l'on parle de X ». Trae construit un **index du
  workspace** (« Indexing & Docs ») qui alimente ses références `#Workspace` /
  `#Folder`. Besoin : reproduire ce **comportement** (auto-index, statut,
  rebuild/cancel/clear, respect des fichiers ignorés) avec un moteur local.

- **Modifications effectuées :**
  - **Backend — nouveau module `src-tauri/src/indexing.rs` :**
    - **Index inversé local** (type BM25) : `tokenize` (minuscules + découpe
      camelCase/snake_case pour `parseContextRef` → `parse`,`context`,`ref`),
      `build_doc` (corps + tokens de chemin), `walk` récursif respectant
      `search::SEARCH_IGNORE`, `build_index` (postings + `doc_freq` + `avg_len`),
      `rank` (BM25 `k1=1.5, b=0.75` + `PATH_WEIGHT=2.0` quand le terme est dans le
      chemin, départage déterministe par chemin croissant).
    - **Persistance** sous `<ws>/.mira/index/{index.json,meta.json}` en écriture
      atomique (tmp + rename). **Jamais** `.cline` visible.
    - **Bornes/DoORS** : `MAX_FILE_BYTES=512 KiB`, `MAX_INDEX_FILES=20 000`,
      `MAX_TOKENS_PER_DOC=4 000`, sniff binaire (octet NUL), pas de suivi de
      symlinks (`file_type` sans `follow`).
    - **Annulation** via `AtomicBool` : le worker s'arrête au prochain fichier,
      l'index partiel reste valide et persisté.
    - **Commandes Tauri** : `index_status`, `index_build`, `index_cancel`,
      `index_clear`, `search_index(query, limit)` (limit borné `1..=200`).
    - **Confinement** : `index_dir` exige un workspace absolu et passe par
      `extensions_store::ensure_within` (racine `.mira`).
    - **15 tests unitaires** : tokenisation, camel/snake, binaire/vide, exclusion
      de `.mira/index`, respect des ignores, annulation, ranking path-aware,
      déterminisme des égalités, confinement, round-trip build→persist→reload,
      rejet d'un index d'une autre racine.
  - **Enregistrement (`lib.rs`) :** `mod indexing;` + 5 commandes dans
    `generate_handler!` (après `context::*`).
  - **UI — nouveau `src/components/settings/IndexingSection.tsx` :** page
    « Indexing & Docs » réelle (remplace le `ComingSoonSection`). Toggle
    « Indexation automatique » (préférence localStorage `mira-indexing-auto`,
    activée par défaut), badge d'état (`Index construit` / `Indexation en cours…`
    / `Index non construit`), compteur de fichiers, « dernière construction »
    relative, boutons **Reconstruire / Annuler / Vider l'index**, avertissement
    « projet volumineux » au-delà de 5 000 fichiers. Auto-index au premier
    montage si rien n'est construit (une seule fois par workspace, via `useRef`).
  - **`SettingsPanel.tsx` :** import + rendu `section === "indexing"`, retrait de
    `"indexing"` de la liste des sections « Coming soon ».

- **Décisions techniques :**
  - **Moteur 100 % local, zéro dépendance.** L'exploration a montré que le SDK
    Cline **n'expose aucun index réutilisable** : son `search_codebase` est un
    *outil piloté par le modèle* (« by pattern or meaning »), sans API
    déterministe ni commande NDJSON/Tauri, et aucun vector store n'existe côté
    Rust ni côté SDK. On implémente donc un index lexical avancé maison (BM25) —
    déterministe, hors-ligne, sans embeddings. C'est le seul chemin fiable pour
    une recherche programmable depuis Rust/UI.
  - **Persister sous `.mira/index`.** Cohérent avec `.mira/{skills,rules,…}` déjà
    en place et invisible pour l'utilisateur (règle « le client ne voit jamais
    `.cline` »). Un champ `root` dans l'index invalide tout index d'un autre
    workspace (anti-fuite entre projets).
  - **Auto-index sans plafond dur mais garde-fous.** Choix produit validé :
    indexer tout le workspace (pas de limite à 5 000 comme Trae), mais
    `MAX_INDEX_FILES` et l'annulation protègent contre un monorepo pathologique ;
    le seuil 5 000 ne sert qu'à **avertir** dans l'UI.

- **Impacts & Dépendances :**
  - **Nouveau module** `indexing.rs` ; `lib.rs` (module + 5 commandes).
  - **Réutilise** `search::SEARCH_IGNORE` (couplage volontaire : une seule liste
    d'exclusions pour la recherche, l'expansion de contexte et l'indexation) et
    `extensions_store::ensure_within` (confinement).
  - **UI** : `IndexingSection.tsx` (nouveau) + `SettingsPanel.tsx` (branché).
  - Aucun effet de bord sur `context.rs` : l'expansion `#Workspace` n'utilise pas
    encore l'index (branchement = lot ultérieur optionnel).
  - L'index est ignoré par lui-même (`rel.starts_with(".mira/")`) : pas de
    récursion sur ses propres fichiers.

- **Validation :**
  - `cargo test` → **168 passés** (153 + 15 nouveaux), 1 ignoré (réseau).
  - `vitest run` → **640 passés** (48 fichiers).
  - `npx tsc --noEmit` → OK ; `npx eslint` sur les fichiers touchés → 0 erreur.

- **Prochaines étapes :**
  - **Optionnel** : brancher `search_index` sur le tri de `context.rs`
    (`#Workspace`/`#Folder` triés par pertinence au lieu de l'ordre
    d'arborescence) et exposer l'index comme outil d'agent.
  - **Différé** : `#Doc` / `#Web`, nesting 3 niveaux des commands/rules, Agent
    Review, Refactoring Insights.

---

- **Contexte :** la page Hooks était en **lecture seule** car le moteur d'agent ne
  lit les hooks que dans des dossiers fixes (`.cline/hooks`) et exige un fichier
  nommé exactement comme l'événement. Une page d'édition qui écrirait ailleurs
  aurait produit des hooks inertes (fausse promesse). Besoin : rendre les hooks
  réellement gérables depuis Mira, sans jamais exposer la convention interne.

- **Modifications effectuées :**
  - **Backend (`extensions_store.rs`) :**
    - `HookInfo` enrichi d'un champ `executable: bool` (le fichier porte-t-il une
      extension reconnue par le moteur ?).
    - Dossier réel lu/écrit par le moteur centralisé dans `hooks_dir(scope, ws)`
      (`~/.cline/hooks` / `<ws>/.cline/hooks`).
    - `HOOK_EVENTS` : liste blanche stricte des 10 événements du moteur.
    - `validate_hook_event`, `validate_hook_extension` (`.js|.mjs|.cjs|.sh`),
      `hook_path` (confinement via `ensure_within`).
    - Nouvelles commandes : `read_hook(scope, ws, event, ext)`,
      `write_hook(scope, ws, event, ext, content)` (contenu vide ⇒ supprime),
      `delete_hook(scope, ws, event)` (balaie les 4 extensions connues).
    - `list_hooks` ne retient que le nom d'événement et marque l'exécutabilité.
  - **Enregistrement (`lib.rs`) :** ajout de `read_hook`, `write_hook`,
    `delete_hook` dans `generate_handler!`.
  - **UI (`HooksSection.tsx`) :** page réécrite en CRUD complet — bouton
    « Nouveau hook » à droite, liste avec badge `actif`/`inactif`, éditeur
    (choix d'événement parmi les libellés lisibles + éditeur de script JS),
    suppression. Avertissement sécurité conservé.

- **Décisions techniques :**
  - **Écrire là où le moteur lit, pas sous `.mira`.** Le SDK n'accepte pas de
    dossier de hooks personnalisé : `.mira/hooks` serait ignoré. On écrit donc
    dans `.cline/hooks`, mais l'UI ne montre **jamais** cette convention (noms
    d'événements + libellés uniquement). C'est le compromis retenu plutôt qu'un
    pont sidecar (plus complexe, à maintenir au fil des versions du SDK).
  - **Liste blanche d'événements + extension forcée :** impossible d'écrire un
    nom de fichier arbitraire ; un fichier sans extension reconnue serait inerte,
    donc interdit. Le chemin est toujours reconstruit côté Rust (jamais fourni
    par le front) ⇒ pas d'évasion de répertoire.
  - **Aucune exécution côté Mira :** ce module ne fait qu'écrire/supprimer le
    script. L'exécution (donc le risque) reste déclenchée par le moteur. Le
    contenu est borné par `MAX_CONTENT_BYTES` et écrit atomiquement.

- **Impacts & Dépendances :** `HookInfo` gagne un champ (purement additif,
  `#[serde(default)]` non nécessaire car toujours renseigné côté Rust).
  `list_hooks` filtre désormais sur l'extension — un fichier déposé sans
  extension n'apparaît plus comme « exécutable ». Touche `extensions_store.rs`,
  `lib.rs`, `HooksSection.tsx`.

- **Validation :** `cargo build` + `cargo test` (153 passés), `tsc --noEmit` OK,
  `eslint` 0 erreur, `vitest` 640 tests passés.

- **Prochaines étapes :** envisager un pont sidecar si une future version du SDK
  accepte un `hooksDir` configurable (permettrait `.mira/hooks` sans écriture
  cachée) ; sinon conserver cet alias.

### [2026-10-17T22:50] | Settings — logo Mira (About), icône Skills, boutons à droite, compat skills

- **Contexte :** retours utilisateur sur la page Réglages : (1) About affichait un
  carré « M » au lieu du logo ; (2) l'état vide de Skills montrait l'icône IA
  (« étincelles ») plutôt que l'éclair attendu ; (3) les boutons d'action des
  formulaires étaient alignés à gauche alors que la convention est à droite ;
  (4) les skills devaient être compatibles avec les conventions d'écosystèmes
  tiers (`.agents/skills`, Claude, skills.sh).

- **Modifications effectuées :**
  - **About (`AboutSection.tsx`) :** import de `logo-code.svg` et remplacement du
    carré dégradé « M » par un conteneur `overflow: hidden` (fond
    `--origin-bg-base`, bordure `--origin-border-default`) contenant
    `<img src={logoSrc} width=40 height=40 objectFit="contain" />`.
  - **Skills (`SkillsSection.tsx`) :** icône d'état vide passée de `Sparkles`
    (étincelles, perçue comme « icône IA ») à `Zap` (éclair), cohérent avec la
    navigation. Ajout du champ `source` et rendu **lecture seule** pour les skills
    externes (badge « externe », pas de toggle/édit/suppression).
  - **Boutons à droite (Skills/Commands/Mcp/Keybindings) :** barres d'action des
    éditeurs passées à `justifyContent:"flex-end"` ; dans Keybindings, « Reset
    all » déplacé en bas à droite et « Import from » aligné à droite. `PageHeader`
    était déjà à droite.
  - **Compat skills (backend `extensions_store.rs`) :** `list_skills` agrège
    désormais plusieurs racines — `.mira/skills` (source `mira`), puis
    `.agents/skills` et `.claude/skills` (source `external`) — avec priorité Mira
    et déduplication par nom. `read_skill` cherche dans toutes les racines.
    Helpers `workspace_dot_mira`, `external_skill_roots`, `skill_roots`,
    `find_skill_file`, `priority` ; champ `source: Option<String>` ajouté à
    `ArtifactInfo` (rétro-compatible via `#[serde(default)]`).

- **Décisions techniques :**
  - **Lecture seule des racines externes.** Écrire dans `.agents/skills` ou
    `.claude/skills` ferait de Mira un gestionnaire de fichiers appartenant à
    d'autres outils (risque de corruption / conflits). On lit pour rester
    compatible, on n'écrit que sous `.mira`. Le confinement strict existant
    (`ensure_within`, `safe_rel_under`) est conservé : `find_skill_file`
    revérifie que le chemin reste sous la racine.
  - **Déduplication par priorité.** En cas de même nom, Mira gagne — évite les
    doublons d'affichage et un comportement non déterministe.
  - **`skills.sh`** distribue des packs **au format Agent Skills** ; en lisant
    `.agents/skills`, Mira couvre donc l'installation manuelle de ces packs sans
    nouvelle intégration réseau (aucun téléchargement côté IDE = pas de surface
    SSRF/supply-chain supplémentaire).

- **Impacts & Dépendances :** `ArtifactInfo.source` est nullable côté TS (aucune
  break) ; le front n'affiche jamais les chemins disque. Le listing skills fait
  maintenant jusqu'à 3 `read_dir` au lieu d'un (coût négligeable, dossiers
  absents ignorés silencieusement).

- **Validation :** `cargo test` — 146 verts (dont 11 dans `extensions_store`,
  +3 nouveaux : `find_skill_file_priorise_la_premiere_racine`,
  `find_skill_file_refuse_une_nomination_dangereuse`,
  `priority_place_mira_avant_externe`) ; `vitest run` — 640 verts ;
  `tsc --noEmit` et `eslint` propres sur les fichiers touchés.

- **Prochaines étapes :** éventuel import/installation d'un skill depuis
  skills.sh (téléchargement + validation) ; hooks fonctionnels `.mira/hooks.json`.

---

### [2026-10-17T20:37] | Chantier Contexte `#` — mentions Trae (Code/File/Folder/Workspace/Problems/Rule)

- **Contexte :** aligner Mira sur le système de **contexte `#` de Trae** (saisie `#`
  dans le chat → menu de types → sélection). Portée validée : `#File`, `#Folder`,
  `#Workspace`, `#Problems`, `#Rule` + le `#Code` (fichier actif) déjà existant.
  Contrainte durable : **aucun `#Doc`/`#Web`** pour l'instant (nécessite crawl /
  index) et le client ne doit jamais voir l'infra sous-jacente.

- **Modifications effectuées :**
  - **L1 — Logique pure (`src/lib/contextMentions.ts`, nouveau) :** source unique de
    vérité côté front. `ContextKind = code|file|folder|workspace|problems|rule`,
    `CONTEXT_KINDS` (ordre d'affichage + `needsPicker` : `file`/`folder`/`rule`
    exigent un picker, `code`/`workspace`/`problems` sont directs). Helpers
    `contextRefKey`, `hasContextRef`, `addContextRef`, `removeContextRef`,
    `getHashQuery` (déclencheur `#` en fin de mot), `filterContextKinds`,
    `serializeContextRefs` / `parseContextRef` (format `kind:path`, coupe au
    **premier** `:` → chemins Windows-safe), `contextIconName`. Tests :
    `src/lib/__tests__/contextMentions.test.ts` — **32 tests verts**.
  - **L2 — Backend Rust (`src-tauri/src/context.rs`, nouveau) :** expansion bornée
    côté natif pour ne jamais saturer la mémoire ni le prompt. Bornes multi-niveaux :
    `MAX_FILES=80`, `MAX_FILE_BYTES=128 Kio`, `MAX_TOTAL_BYTES=512 Kio`, détection
    binaire (`NUL` byte sur `BINARY_SNIFF_BYTES=8 Kio`). Types
    `WorkspaceFile { name, path, rel, content, skipped }` (le champ `rel` est
    **relatif à la racine** et normalisé en `/` — indispensable pour un affichage
    de prompt portable et non fuyant le chemin disque absolu) et
    `ContextExpansion { files, truncated, included }`. Helpers `normalize_rel` /
    `rel_to` (strip_prefix, fallback basename). Commands
    `expand_context_folder(path, workspace_root)` (avec `assert_in_workspace_public`)
    et `expand_context_workspace(workspace_root)`. `lib.rs` : `mod context;` +
    enregistrement des 2 commands. Tests : **9/9 verts** (dont
    `rel_est_relatif_a_la_racine_et_normalise`).
  - **L3 — UI (`src/components/ai/ContextMenu.tsx`, nouveau) :**
    `ContextTypeMenu` (menu des 6 types), `RulePicker` (règles `.mira/rules`),
    et `FolderPicker` — dérive l'arborescence des dossiers depuis
    `list_workspace_files` (remontée de chaque ancêtre, dédoublonnage `Map`, tri
    `localeCompare`, recherche label **ou** path, navigation clavier). Le stub
    historique du picker dossier (un `MentionDropdown` à `onSelect` vide) est
    supprimé au profit de `FolderPicker`.
  - **L4 — ChatBox (`src/components/ai/ChatBox.tsx`) :** déclencheur `#`
    (`handleKeyDown` → `getHashQuery`), ouverture du `ContextTypeMenu`, chips de
    contexte rendues dans l'aperçu du message en file (`queued.contextRefs`).
    `handleSend`/`handleQueue` reçoivent un 7ᵉ paramètre `contextRefs`.
    `QueuedMessage` (`src/lib/aiTypes.ts`) étendu avec `contextRefs?: string[]`
    (sérialisé → survit à la file via `messageQueue.ts`).
  - **L5 — AiPanel (`src/components/ai/AiPanel.tsx`) :** résolution des refs
    **au moment de l'envoi**, injectée dans `apiText` (même canal que les
    `@mentions`, aucun changement de protocole NDJSON). `resolveContextRefs`
    (useCallback) dispatche : `workspace`→`expand_context_workspace`,
    `folder`→`expand_context_folder`, `file`→`readFile`, `rule`→`read_rule`
    (split `scope:rel`), `problems`→`formatDiagnostics(useDiagnostics().byFile)`,
    `code`→`buildContextPrefix`. Helpers module-level `FENCE_MAP`, `formatExpansion`
    (blocs `[File: rel]` + fence, ignore `skipped`), `formatDiagnostics`
    (`rel:line:col severity[ code] message`). Toute ref en échec est **ignorée
    silencieusement** (jamais bloquante).
  - **L6 — Validation :** `tsc --noEmit` **0 erreur**, `eslint` clean sur les
    fichiers touchés, `cargo build` OK, `cargo test context::` **9/9**, `vitest run`
    **640/640**.

- **Décisions techniques :**
  - **Expansion des refs lourdes côté `AiPanel`, pas dans le protocole** : les
    `#Folder`/`#Workspace` sont volumineux et spécifiques à l'UI ; les injecter à
    l'envoi évite de polluer le sidecar/NDJSON et garde le protocole stable.
  - **Dériver les dossiers depuis `list_workspace_files`** plutôt que d'ajouter
    une command IPC dédiée : une seule source de vérité des fichiers, pas de
    nouvel aller-retour backend ni de risque de désynchronisation.
  - **Sécurité backend à plusieurs ceintures :** confinement workspace
    (`assert_in_workspace_public` / `ensure_within`), bornes fichier/total/nombre,
    sniff binaire ; les chemins exposés au prompt sont **relatifs** (`rel`), donc
    pas de fuite du chemin absolu utilisateur.
  - **`kind:path` avec coupe au premier `:`** : robuste aux lecteurs de disque
    Windows (`C:\...`) sans échappement.

- **Impacts & dépendances :**
  - Fichiers créés : `contextMentions.ts`, `context.rs`, `ContextMenu.tsx`,
    `__tests__/contextMentions.test.ts`.
  - Fichiers modifiés : `ChatBox.tsx`, `AiPanel.tsx`, `aiTypes.ts`, `lib.rs`.
  - `context.rs` expose 2 commands IPC ; tout futur picker (`#Doc`, `#Web`) doit
    réutiliser `ContextRef`/`ContextTypeMenu` et non dupliquer la logique.
  - `AiPanel` dépend désormais de `DiagnosticsContext` (déjà monté dans
    `main.tsx`) pour `#Problems`.

- **Prochaines étapes :**
  - **Différé (validé)** : hooks **fonctionnels** (`hooks.json` sous `.mira` +
    pont sidecar), pages **Rules** & **Memories**, nesting 3 niveaux
    (commands/rules), `#Doc` / `#Web` (crawl + index), CUE, Agent Review,
    Refactoring Insights.

---

### [2026-10-17T22:40] | Chantier Settings — pages About, MCP, Skills, Commands, Hooks

- **Contexte :** l'écran Settings ne proposait que des pages « à venir » pour la
  gestion des extensions. Objectif : reproduire le modèle Trae (Skills séparés
  des **slash-commands**, MCP, Hooks, About) tout en respectant deux contraintes
  fortes : (1) le client ne doit **jamais** voir l'infrastructure `Cline`/`.cline` ;
  (2) Skills ≠ Commands — les Commands sont les **slash-commands** `/nom`, pas la
  palette d'actions VS Code (les raccourcis clavier restent une page distincte).

- **Modifications effectuées :**
  - **Backend Rust — `src-tauri/src/extensions_store.rs` (nouveau, ~880 lignes) :**
    accès disque direct aux artefacts sous `.mira`, **indépendant d'une session
    agent** (l'UI peut lister/éditer sans agent connecté). Racines `~/.mira`
    (global) et `<ws>/.mira` (projet). Sécurité : `validate_name` (slug `[A-Za-z0-9._-]`,
    max 64, refuse `.`/`..`/préfixe `.`/`-`), `ensure_within` + `normalize_lexical`
    (confinement anti-traversal), `validate_content` (max 256 Kio), écriture
    atomique `tmp` + `rename`. Types `ArtifactInfo`, `HookInfo`, `McpServerInfo`.
    17 commands Tauri : `list_skills`/`read_skill`/`write_skill`/`delete_skill`,
    `list_commands`/`read_command`/`write_command`/`delete_command`,
    `list_rules`/`read_rule`/`write_rule`/`delete_rule`, `list_hooks`,
    `list_mcp_servers`/`write_mcp_server`/`set_mcp_server_disabled`/`delete_mcp_server`.
    8 tests unitaires (tous verts).
  - **`src-tauri/src/lib.rs` :** `mod extensions_store;` + enregistrement des 17
    commands dans `generate_handler!`.
  - **Sidecar `cline-sidecar/src/instructions.ts` :** nouveau type `CustomCommand`
    + champ `customCommands` dans `SessionExtensions` ; loader `loadCustomCommands`
    lisant `.mira/commands/*.md` (1er niveau, `.md` uniquement, max 64 Kio/fichier,
    max 200 commands, jamais bloquant). **`src/index.ts` :** `start` renvoie
    `customCommands` ; `expandRuntimeSlashCommand` résout d'abord les commands
    custom (regex `^\/name args$`) puis retombe sur le SDK.
  - **Front — `src/components/settings/ui.tsx` (nouveau) :** primitives partagées
    (boutons, champs, `Switch`, `ListRow`, `Badge`, `ScopeTabs` global/projet,
    `KeyValueEditor`, états vides/chargement/erreur).
  - **5 pages (nouvelles) :** `AboutSection` (version via `getVersion`, MAJ via
    plugin-updater + relaunch, liens), `McpSection` (CRUD serveurs, transports
    stdio/SSE/HTTP, toggle), `SkillsSection` (global/projet, édition Markdown,
    enable/disable), `CommandsSection` (slash-commands `.mira/commands`, édition),
    `HooksSection` (**read-only**, libellés lisibles, jamais d'exposition `.cline`).
  - **`SettingsPanel.tsx` :** nav réorganisée — ajout `commands` (« Commands ») et
    `shortcuts` (« Keyboard Shortcuts », ex-slot skills) ; Skills désormais dédié.
    `workspace` chargé via `getSetting("workspace.folder")`.

- **Décisions techniques :**
  - **Un seul socle disque côté Rust** plutôt que de passer par le SDK pour les
    listes/éditions : évite d'exiger une session agent et garde l'UI réactive.
  - **Commands custom côté sidecar** : le SDK n'expose **aucun** dossier `commands/`
    (`RuntimeCommandKind` = `skill | workflow` seulement) ; on construit donc
    `.mira/commands/*.md` et on les injecte dans la résolution des slash-commands.
  - **Hooks en lecture seule** : le SDK ne lit que `~/.cline/hooks` et
    `<ws>/.cline/hooks`. On **affiche** ces hooks (utile) mais on ne présente
    jamais le chemin `Cline`/`.cline` à l'utilisateur — conformité à la règle de
    marque et à la règle « le client ne doit pas voir `.cline` ».

- **Impacts & Dépendances :** `SettingsPanel` consomme 5 nouveaux composants et
  `getSetting` (async). Les commands custom transitent par le même canal que les
  skills (`ChatBox` autocomplete `/`). Le module Rust est autonome (pas de
  dépendance à `extensions.rs`).

- **Validation :** `cargo check` **0 erreur / 0 warning** ; `cargo test
  extensions_store` **8/8** ; `tsc --noEmit` **0 erreur** ; `eslint
  src/components/settings/` **0 erreur / 0 warning** ; `vitest run` **608/608**
  (47 fichiers).

- **Prochaines étapes :** absorption de la documentation Trae (context, indexing,
  memories, hooks config, cue, code review, refactoring, chat) pour aligner le
  comportement produit ; éventuellement exposer l'édition des Rules côté UI.

---

### [2026-10-17T22:05] | Poursuite du renommage : README + manifeste sidecar

- **Contexte :** après la purge des libellés UI, il restait des occurrences de la
  marque « Origin » visibles au client (documentation publique du dépôt,
  métadonnée de package).

- **Modifications effectuées :**
  - `README.md` : `alt` du wordmark, titres d'écran (`Origin IDE` → `Mira`),
    section « What is Mira? » et sa description, noms d'artefacts d'installation
    (`Mira_x.x.x_*.exe/.msi/.dmg/.deb`, `mira.exe`), phrase « Mira supports any
    provider… », chemin AppData **corrigé** en `~/Library/Application Support/
    com.mira.ide/` (l'ancien `AppData\Roaming\com.originide.ide\` ne
    correspondait plus à l'`identifier` réel `com.mira.ide`).
  - `media/origin-{1,2,3}-ss.png` → `media/mira-{1,2,3}-ss.png` (+ références
    README), pour que l'URL publique de l'image porte la marque.
  - `src-tauri/cline-sidecar/package.json` : description → « moteur d'agent
    Mira » (retrait de « Cline SDK (Origin) », conforme à la règle de marque).

- **Décisions techniques :** **ne pas** renommer l'infrastructure de distribution
  — URLs `https://github.com/Origin-AI-IDE/origin*` (badges, releases, star
  history), `git clone …/origin.git`, `cd origin`, `"name": "origin"` du
  `package.json`, `origin-cline-sidecar`. Ce sont des identifiants réels :
  les renommer casserait les liens/téléchargements et la CI. À traiter le jour
  où le **dépôt distant** est renommé (lot DevOps distinct).

- **Impacts & Dépendances :** documentation désormais cohérente avec
  l'`identifier` réel ; aucun impact runtime. `tsc --noEmit` 0 erreur.

- **Prochaines étapes :** renommage du dépôt GitHub + mise à jour groupée des
  URLs ; éventuellement régénérer `media/wordmark.svg` si le logotype dessiné
  contient encore « Origin » (à vérifier visuellement — le SVG n'expose aucun
  texte détectable).

---

### [2026-10-17T21:52] | Correctif : impossible de fermer Settings en mode IA

- **Contexte :** en mode IA, Settings s'ouvre comme **onglet** de la barre d'outils
  (browser/terminal/settings/…). Le bouton « fermer » et la touche Échap ne
  faisaient rien : l'utilisateur restait bloqué sur l'onglet Settings.

- **Cause racine :** `AgentModeView` montait `<SettingsPanel onClose={() => {}} />`
  avec un callback **no-op**. `SettingsPanel` est conçu en surcouche plein écran :
  il déclenche `onClose` au clic sur le bouton, sur le fond, et sur Échap. Ici il
  est intégré comme panneau d'un onglet, donc `onClose` doit **fermer l'onglet**.

- **Modifications effectuées :**
  - `src/components/ai/AgentModeView.tsx` (l.578) : `onClose={() => {}}` →
    `onClose={() => closeToolTab("settings")}`. `closeToolTab` est déjà défini
    dans le même composant (l.162).

- **Décisions techniques :** ne pas toucher à `SettingsPanel` (réutilisé tel quel
  en mode IDE via `settingsOpen` dans App.tsx) ; la différence de comportement
  (surcouche vs onglet) est portée par le **callback** de l'appelant — le
  composant reste agnostique.

- **Impacts & Dépendances :** le mode IDE (surcouche) est inchangé. Fermer
  l'onglet Settings retombe sur l'état vide ou l'onglet suivant, comme les autres
  onglets. `tsc --noEmit` 0 erreur.

- **Prochaines étapes :** envisager de remplacer le montage « plein écran dans un
  onglet » par un rendu « encarté » (le `position: fixed; inset: 0` du panneau
  sort du flux de l'onglet) lors d'un lot de finition visuelle.

---

### [2026-10-17T21:40] | Launchpad actif + purge des dernières marques « Trae » visibles

- **Contexte :** deux retours client :
  1. le bouton **Launchpad** de la barre de statut ne faisait rien (élément inerte) ;
  2. le panneau **Settings** affichait encore des libellés de marque « Trae ».

- **Modifications effectuées :**
  - `src/components/StatusBar.tsx` : nouvelle prop `onOpenLaunchpad` ; le
    `StatusItem` « Launchpad » devient cliquable (curseur + hover gérés par le
    composant existant).
  - `src/App.tsx` : `onOpenLaunchpad` câblé sur l'ouverture de la **palette de
    commandes** (`setPaletteMode('command')` + `setPaletteOpen(true)`).
  - `src/components/settings/SettingsPanel.tsx` : `TRAE Mobile` → `Mira Mobile`
    (id technique `trae-mobile` → `mira-mobile`, union `Section` mise à jour) ;
    `About TraeCode` → `About Mira`.

- **Décisions techniques :** comportement « à la VS Code » = barre de statut
  cliquable ouvrant un sélecteur rapide ; ici la palette de commandes est
  l'équivalent le plus proche de la fonctionnalité déjà présente. Le renommage
  d'`id` (en plus du `label`) évite une dette d'identifiant trompeur.

- **Audit de marque (résultat) :** un balayage exhaustif confirme qu'il ne
  restait que ces **2 chaînes affichées** contenant « Trae ». Tout le reste
  (« Trae » dans ~60 commentaires, tokens CSS `--origin-*`, clés de stockage,
  identifiants techniques) est **non visible par l'utilisateur** et
  volontairement conservé. `productName`, titre de fenêtre, menu macOS et
  textes d'onboarding sont déjà en « Mira ».

- **Impacts & Dépendances :** `StatusBar` gagne une prop optionnelle (aucun
  impact sur les autres appelants). Tests inchangés verts, `tsc --noEmit`
  0 erreur.

- **Prochaines étapes :** la section « Mira Mobile » reste un placeholder
  (ComingSoon), comme les autres sections non implémentées.

---

### [2026-10-17T21:25] | Correctif boucle infinie `useSyncExternalStore` (taskRuntime + swarmStore)

- **Contexte :** retour du runtime « Maximum update depth exceeded » avec une
  stack passant par `useSyncExternalStore` (`updateStoreInstance` →
  `forceStoreRerender`). Le garde-fou sur `onAgentSurface` (AiPanel) ne
  s'appliquait pas : le déclencheur est un **snapshot non stable** renvoyé par un
  store abonné.

- **Cause racine :** deux sélecteurs fabriquaient un **nouveau tableau à chaque
  appel** au lieu de réutiliser une référence stable :
  - `taskRuntime.listActiveTasks()` → `.filter(...)` ;
  - `swarmStore.listActiveSubAgents()` → `.filter(...)`.
  React compare le snapshot par identité à chaque rendu : une nouvelle
  référence ⇒ re-rendu ⇒ nouvel appel ⇒ nouvelle référence ⇒ boucle infinie.

- **Modifications effectuées :**
  - `src/lib/agent/taskRuntime.ts` : cache `cachedActive` + `activeCacheValid`,
    invalidés dans `emit()` ; `useActiveTasks` renvoie la **même référence**
    tant que la composition (identités + statuts) n'a pas changé.
  - `src/lib/agent/swarmStore.ts` : second cache `activeCache` (préfixe
    `active::`), vidé dans `emit()` ; `listActiveSubAgents` sert désormais une
    liste mémorisée.

- **Décisions techniques :** conserver le contrat « une nouvelle instance
  uniquement quand le contenu change » — déjà appliqué aux caches principaux
  (`cachedAll`, `cache`) et documenté dans les deux modules. La comparaison
  d'identité élément par élément suffit (snapshots immuables, taille courte).

- **Impacts & Dépendances :** `TaskProgressBar` (via `useActiveTasks`) et
  l'onglet Agents (via `useActiveSubAgents`) ne boucleront plus. Tests inchangés
  verts (`swarmStore` 11, `taskRuntime` 17), `tsc --noEmit` 0 erreur.

- **Prochaines étapes :** auditer au besoin les sélecteurs dérivés futurs
  (règle : tout `filter`/`map` exposé à `useSyncExternalStore` doit être mémorisé).

---

### [2026-10-17T21:10] | Menu projet dédié + clone Git + onglets mode IA « pro »

- **Contexte :**
  1. Le sélecteur « No project » de la TitleBar ouvrait la **palette de commandes**
     au lieu d'un menu projet. Attendu : un menu dédié fidèle à la capture
     (Open Folder / Clone Git Repository / Connect Remote Host + section
     « Recent » avec pastille à initiales, nom, chemin `~` et **coche verte** sur
     le projet courant).
  2. Le clone Git n'existait **pas** côté backend (aucune commande `git_clone`).
  3. En mode IA, la barre d'onglets (browser/terminal/…) manquait de finition :
     fond noir uni + onglet actif « légèrement éclairci ».

- **Modifications effectuées :**
  - **Rust — `src-tauri/src/git.rs` :** ajout de `git_clone(url, dest)` +
    helpers `validate_clone_url` (allowlist de transports http/https/ssh/git/
    git+ssh + notation scp-like ; rejet des schémas à exécution locale `ext::`,
    `file://`, `fd::`, `transport::` et des URL commençant par `-`) et
    `validate_clone_dest` (chemin absolu, sans `..`, refus d'écraser un dossier
    non vide). Le clone s'effectue dans un dossier temporaire voisin puis est
    **déplacé atomiquement** vers la destination (pas de clone partiel).
  - **Rust — `src-tauri/src/lib.rs` :** enregistrement de `git::git_clone` dans
    `generate_handler!`.
  - **Front — `src/components/ui/ProjectMenu.tsx` (nouveau) :** menu projet en
    portail (positionné sous l'ancre + clamp viewport), 3 actions en tête,
    séparateur, en-tête « Recent », liste des récents avec pastille colorée
    dérivée du nom (hachage stable), nom, chemin raccourci `~`, et coche verte
    sur le projet ouvert.
  - **Front — `src/components/TitleBar.tsx` :** le sélecteur ouvre désormais
    `ProjectMenu` (au lieu de la palette) ; `onOpenFolder`/`onCloneRepo`/
    `onOpenProject` consommés depuis les commandes ; `Connect Remote Host`
    affiche un toast « coming soon ».
  - **Front — `src/context/CommandContext.tsx` :** ajout de `onOpenProject(path)`
    et `onCloneRepo()` à `AppCommands` (+ defaults noop).
  - **Front — `src/App.tsx` :** `handleCloneRepo()` (choix du dossier parent via
    dialogue natif + saisie d'URL, nom de dépôt dérivé de l'URL, appel
    `invoke('git_clone')`, enregistrement en récent puis ouverture) ; câblage de
    `onOpenProject`/`onCloneRepo` dans le provider de commandes.
  - **Front — `src/components/ai/AgentModeView.tsx` :** barre d'onglets fond noir
    (`bg-editor`), hauteur 38 px, onglet actif légèrement éclairci (`bg-hover`)
    + **soulignement accent** (`--origin-accent-blue`), bouton de fermeture fondu
    pour les onglets inactifs, transitions douces.

- **Décisions techniques :**
  - **Sécurité clone :** `git clone` passe par `Command::args` (jamais de shell),
    donc pas d'injection shell ; le risque réel est l'**injection d'options**
    (URL en `-…`) et les **transports à exécution locale** (`ext::` = exécution
    de commande via remote-helper). Traités par une allowlist stricte plutôt
    qu'un simple filtre `-`.
  - **Atomicité :** cloner dans un dossier temporaire puis `rename` évite de
    laisser un dépôt partiel dans le dossier cible en cas d'échec réseau.
  - **Menu dédié** plutôt qu'étendre `DropdownMenu` (qui ne gère ni icônes, ni
    descriptions, ni coche) : évite de complexifier un composant partagé.
  - **Couleur d'onglet :** `--origin-accent` n'existe pas dans le thème (seules
    les variantes suffixées existent) → utilisation de `--origin-accent-blue`.

- **Impacts & Dépendances :**
  - `AppCommands` gagne deux membres : tout provider de commandes doit les
    fournir (les defaults couvrent le reste).
  - Le clone réutilise `pushRecentProject` + `setFolderPath` : le projet cloné
    apparaît immédiatement dans « Recent ».

- **Prochaines étapes :**
  - `Connect Remote Host` reste inerte (toast informatif) : chantier distinct.
  - Dialogues : `window.prompt` pour l'URL — à remplacer par un dialogue in-app
    (cohérence visuelle) dans un futur lot.

---

### [2026-10-17T20:05] | Onboarding : positionnement « alternative Cursor » + carrousel de modèles

- **Contexte :**
  Deux problèmes de positionnement produit :
  1. Le hero de l'accueil affichait « Open-source AI coding without lock-in. » +
     « Connect Claude, GPT… or your own infrastructure. » — un discours
     **open-source/self-host** qui ne correspond pas au produit : Mira est une
     **alternative à Cursor**, pas un projet open-source.
  2. L'écran de connexion (« Let's connect a provider » + formulaire de clé API)
     demandait une clé au premier lancement. Décision produit : **ne pas demander
     de clé ici** — simplement **montrer les modèles disponibles**.

- **Modifications effectuées :**
  - `WelcomePage.tsx` : hero → **« A Cursor-class AI code editor, your way. »** ;
    suppression du sous-titre listant les providers/« your own infrastructure ».
  - `ConnectAIPage.tsx` : **réécrit intégralement**. Le formulaire (clé API,
    sélecteur de modèle, recherche, skeleton) est **supprimé**. La page devient
    purement informative : **deux rangées en carrousel infini** affichant les
    logos des providers (`PROVIDERS` de `data.ts`), sens opposés, masque en
    dégradé sur les bords. Titre « Any model, on your terms ».
  - `index.css` : ajout des keyframes `mira-marquee` / `mira-marquee-rev`
    (translateX 0→-50% et inverse) pour la boucle sans couture.

- **Décisions Techniques :**
  - **Marquee sans JS** : liste dupliquée (`[...providers, ...providers]`) +
    translation de -50%. La 2ᵉ copie se superpose exactement à la 1ʳᵉ au terme de
    l'animation → boucle continue. Coût CPU minimal (une seule propriété animée,
    composited), aucun `setInterval`, aucune dépendance.
  - **Aucune sélection, aucune clé** : l'écran est informatif (exigence
    utilisateur). Le stockage/gestion des clés est **laissé inchangé** (keychain
    OS `mira-ide`) ; la gestion « façon Cursor » fera l'objet d'un **chantier
    séparé**.
  - **Props `onBack/onNext/onSkip` conservées** : le flux d'onboarding
    (`Onboarding.tsx`, pages 0→1→2) reste intact, zéro régression de navigation.

- **Impacts & Dépendances :**
  - Fichiers : `src/components/onboarding/{WelcomePage.tsx, ConnectAIPage.tsx}`,
    `src/index.css`.
  - `data.ts` : les champs `keyLabel` / `keyPlaceholder` / `models` /
    `customModels` / `docs` ne sont **plus référencés** (seuls `id/label/icon/
    invert` servent au carrousel). Conserves volontairement : ils seront
    réutilisés par le chantier « gestion des clés ».
  - Les providers sans icône (LM Studio, vLLM) tombent sur un badge à initiales.

- **Prochaines étapes :**
  - **Chantier séparé** : gestion des clés API « comme Cursor » (stockage,
    validation, bascule de modèle) — non traité ici.

---

### [2026-10-17T19:40] | Garde-fou workspace : l'agent exige un répertoire de travail

- **Contexte :**
  À l'ouverture de Mira, aucun dossier de travail n'est forcément sélectionné.
  Or l'agent (moteur Cline partagé par TOUS les modes) démarrait alors avec
  `workspace: "."` — le **cwd du process sidecar Node**, pas un vrai projet. Le
  client pouvait donc lancer l'agent qui écrivait dans un dossier arbitraire,
  hors de tout contrôle. Exigence produit : **le client doit toujours choisir le
  répertoire de travail avant de lancer l'agent**.

- **Modifications effectuées :**
  - `ChatBox.tsx` : nouvelle prop `onSelectFolder`. Dans `handleSend`, garde en
    tête : si `!folderPath`, on ouvre le sélecteur natif et on **n'envoie rien**
    (le message reste dans l'input). Le bouton d'envoi s'estompe (`opacity 0.5`)
    et son libellé d'infobulle devient « Select a working directory to start ».
  - `AiPanel.tsx` : nouvelle prop `onOpenFolder`, transmise aux **deux**
    instances de `ChatBox` (mode sidebar IDE + mode Agent) via `onSelectFolder`.
    **Défense en profondeur** : même garde dans `handleSend` du panneau (avant
    toute écriture DB / tout run Cline), avec un toast explicatif.
  - `App.tsx` : `<AiPanel>` reçoit `onOpenFolder={handleOpenFolder}` (réutilise
    le sélecteur natif existant, avec `pushRecentProject`).

- **Décisions Techniques :**
  - **Garde à DEUX niveaux** (ChatBox = UX immédiate ; AiPanel = barrière
    structurelle côté moteur). Le ChatBox peut être contourné (multi-instances,
    futurs appelants) : la vraie garantie est dans `AiPanel.handleSend`, au plus
    près du lancement de l'agent.
  - **Aucune modification de l'UI existante** (hors l'estompage du bouton
    d'envoi) : on réutilise le sélecteur de dossier natif déjà présent dans
    l'outil, pour ne pas introduire un second chemin d'ouverture de projet.
  - **Pas de hard-code de chemin par défaut** : on ne devine jamais un workspace ;
    c'est l'utilisateur qui décide. Cohérent avec la règle « zéro travail
    implicite » et la contrainte d'isolation (pas d'accès filesystem arbitraire).

- **Impacts & Dépendances :**
  - Fichiers : `src/components/ai/{ChatBox.tsx, AiPanel.tsx}`, `src/App.tsx`.
  - Nouvelle dépendance d'API : `AiPanel` attend désormais `onOpenFolder`
    (optionnel — sans lui, l'envoi est simplement bloqué sans ouverture).
  - Validé : `tsc --noEmit` 0 erreur, `vitest` **608/608**.

- **Prochaines étapes :**
  - Évaluer l'affichage d'une carte « Choisir un répertoire » dans le chat vide
    si l'on veut un guidage plus visible (l'utilisateur a préféré garder l'UI
    actuelle : simple blocage + sélecteur).

---


### [2026-10-17T19:25] | Renommage de marque Origin → Mira + masquage total de Cline (client)

- **Contexte :**
  L'outil n'est plus « Origin » mais **Mira**. Deux contraintes produit fortes :
  (1) l'identité produit et les textes **visibles** doivent dire Mira ;
  (2) le client ne doit **jamais** voir le mot « cline » ni savoir qu'un SDK tiers
  est utilisé en interne. Travail livré **par lots** (masquage d'abord, rename ensuite).

- **Modifications effectuées :**
  - **Lot 5a — Masquage Cline (défense en profondeur) :**
    - **Sidecar :** nouveau module `src-tauri/cline-sidecar/src/brand.ts` (`neutralizeBrand`/`neutralizeForClient`) qui réécrit toute chaîne sortante (`.clinerules`→`.mira`, `Documents/Cline`→`Documents/Mira`, `cline_mcp_settings.json`→`mira_mcp_settings.json`, puis règle générique `cline`→`Mira`). Câblé sur **le point unique** `serializeError` (`index.ts`) et sur `describe` (`instructions.ts`) ; `extensionIssues` neutralisés.
    - **Front (défense en profondeur) :** miroir `src/lib/brand.ts` + neutralisation au rendu des toasts (`AiPanel.tsx`) et des textes skills vides (`ChatBox.tsx`).
    - **Tests :** `brand.test.ts` côté sidecar (node:test, 8 tests) et côté front (vitest, 8 tests).
  - **Lot 5b — Identité produit + binaire :** `tauri.conf.json` (`productName`/`title` = Mira, `identifier` = `com.mira.ide`) ; menu macOS `"Mira"` (`lib.rs`) ; `Cargo.toml` (`name = "mira"`, `mira_lib`) ; `main.rs` (`mira_lib::run()`) ; test e2e `origin_lib::`→`mira_lib::` ; `keychain.rs` `SERVICE = "mira-ide"` ; `ai.rs`/`downloader.rs` User-Agent `mira-ide`/`Mira` ; `log.rs` (`~/.mira/logs/mira.log`) ; `sidecar.rs` (`<app_data>/mira`).
  - **Lot 5c — `.mira/` projet :** `instructions.ts` ajoute `.mira/skills|rules|workflows` via `directories` (défauts SDK **réinjectés** via `resolveSkillsConfigSearchPaths`) et `.mira/plugins` à `pluginPaths`.
  - **Lot 5d — `~/.mira/` + migration :** nouveau module `migration.rs` (`migrate_legacy_data_dir`) qui **déplace** `~/.origin`→`~/.mira` (idempotent, best-effort, ne jamais écraser une cible existante) ; appelé au `setup()`, 3 tests unitaires.
  - **Textes UI visibles** passés à Mira : titre de fenêtre/webview, `index.html`, fallback de thèmes (`Mira Dark/Light`), theme.json, onboarding (`Enter Mira`), `alt` logos, titre LSP `clientInfo`, prompt système (`You are Mira AI`), `UnsupportedFilePane`.

- **Décisions Techniques :**
  - **Un seul point de neutralisation côté sidecar** (`serializeError`) : garantit qu'aucune erreur ne peut fuiter « cline », plutôt qu'un filtre au cas par cas.
  - **`directories` du SDK REMPLACE les défauts** (opérateur `??`) : on réinjecte donc explicitement les chemins officiels pour ne pas perdre la découverte des skills existants.
  - **Renommage des identifiants internes NON fait quand non visible** : IDs de commandes `origin.*`, clés localStorage (`origin-theme`, `origin-ui-density`), variables CSS `--origin-*`, namespace d'extension `origin`. Raison : aucun gain client, risque réel de régression (persistance, keybindings). Choix explicite « texte visible uniquement ».
  - **Migration par `rename`** (pas de copie) : atomique, sans état dupliqué ; on n'écrase jamais une cible existante.
  - **URLs de release GitHub laissées telles quelles** (`Origin-AI-IDE/origin`) : ce sont des endpoints réels de release ; les renommer casserait l'updater.

- **Impacts & Dépendances :**
  - Fichiers touchés : `src-tauri/{tauri.conf.json, Cargo.toml, src/{main.rs, lib.rs, keychain.rs, ai.rs, log.rs, sidecar.rs, downloader.rs, migration.rs}, cline-sidecar/src/{brand.ts, instructions.ts, index.ts, package.json}, tests/lsp_install_e2e.rs}` ; front `src/{App.tsx, index.html, lib/{brand.ts, lsp.ts}, lib/agent/prompts.ts, themes/*, components/**}`.
  - Nouveau module Rust `migration` (3 tests). Nouveaux tests brand (sidecar + front).
  - Validé : `cargo test --no-run` (binaire `mira`/`mira_lib`), `cargo test migration` (3/3), `tsc --noEmit` (front + sidecar) 0 erreur, `vitest` **608/608**, `node --test` sidecar 8/8.

- **Prochaines étapes :**
  - Renommer les identifiants internes (IDs de commandes, clés localStorage, `--origin-*`) **uniquement si** le produit l'exige — avec migration de persistance.
  - Hooks : `.mira/hooks` n'est pas lisible par `createHookConfigFileHooks` (dossiers figés) → évaluer un alias `~/.mira/hooks` → `~/.cline/hooks` ou un patch SDK.
  - Récupérer la migration `keychain` (`origin-ide`→`mira-ide`) si des secrets existants doivent être repris.

---

### [2026-10-17T17:15] | Exploitation complète de Cline — Skills / Plugins / Hooks+MCP câblés proprement

- **Contexte :**
  Après la parité SOLO (terminal + navigateur), il restait à **exploiter toute la puissance du Cline SDK** au lieu de réimplémenter côté maison : Skills, Plugins, Hooks et serveurs MCP existent dans le SDK mais n'étaient **pas câblés**. Objectif : discovery réelle + remontée UI des diagnostics, sans réinventer ce que le SDK fournit. Travail livré **par lots**.

- **Modifications effectuées :**
  - **Lot 4a — Skills :**
    - **Sidecar :** nouveau module `src-tauri/cline-sidecar/src/instructions.ts` (`resolveSessionExtensions`) qui résout, de façon **non fatale**, 4 surfaces : `UserInstructionConfigService` (Skills), `pluginPaths`, `hooks`, serveurs MCP. Dans `index.ts`, le `handle("start")` renvoie désormais `skills` (`listRecords<SkillConfig>("skill")` → `{name, description}`), `commands` (`listRuntimeCommands()` mappé explicitement → `{id, name, kind, description}`) et `extensionIssues`. **Le corps des skills (`instructions`) n'est jamais propagé au front.**
    - **Front :** typage + normalisation défensive dans `clineClient.ts` (`normalizeExtensions` : le sidecar est une frontière de processus) ; propagation via `clineHarness.ts` (`onExtensions`) ; état `sessionExtensions` dans `AiPanel.tsx` (reset sur session neuve, toasts d'erreur par issue). Dans `ChatBox.tsx` : sous-menu **Skills réel** dans le bouton `+` (liste les skills découvertes ou explique où déposer un `SKILL.md`) et **autocomplétion slash-commands** fusionnant catalogue intégré + commandes runtime.
    - **`inputCommands.ts` :** nouvelle action `insert` (insère `/xx ` sans envoyer), `mergeSlashCommands(runtime)` (les intégrées gagnent en cas de collision), `parseSlashCommand`/`filterSlashCommands` acceptent un catalogue.
  - **Lot 4b — Plugins :** les diagnostics plugins du SDK (`pluginIssues`, forme non typée) sont **fusionnés dans `extensionIssues`** côté sidecar (`String(issue)`) → le front n'a qu'**une seule forme bien définie** à afficher, robuste aux variations du SDK.
  - **Lot 4c — Hooks + MCP :** hooks (`createHookConfigFileHooks`, search paths `~/Documents/Cline/Hooks`, `~/.cline/hooks`, `<ws>/.cline/hooks`) et serveurs MCP (`InMemoryMcpManager` + `registerMcpServersFromSettingsFile` + `createMcpTools`, outils `mcp__<server>__<tool>`) câblés dans `resolveSessionExtensions`.
  - **Lot 4d — Cohérence outillage :** `clineApproval.ts` — en-tête corrigée (liste réelle d'outils, `submit_and_exit` inexistant retiré) + NB explicite : l'outil `skills` n'est dans **aucun** set d'auto-approbation (il peut injecter des instructions arbitraires → reste soumis à confirmation conservatrice). Dépendance fantôme `@cline/shared` épinglée en `0.0.93`.

- **Décisions Techniques :**
  - **Ne pas réimplémenter le SDK :** Skills/Plugins/Hooks/MCP sont fournis par Cline ; on les **résout** et on **expose** leurs diagnostics plutôt que de les recoder.
  - **Le corps des skills ne franchit jamais la frontière de processus :** seuls `{name, description}` sont transmis → pas de fuite du contenu d'instructions vers l'UI.
  - **Frontière de processus = frontière de confiance :** `normalizeExtensions` filtre champ par champ côté front (le sidecar est traité comme une source potentiellement malformée).
  - **Une seule forme de diagnostic :** fusion `pluginIssues` → `extensionIssues` (type aligné) au lieu d'exposer les variations non typées du SDK.
  - **Sécurité outillage :** `skills` non auto-approuvable (injection de contexte) ; `ask_question` confirmable ; cohérence des sets documentée.

- **Impacts & Dépendances :**
  - Fichiers touchés : `src-tauri/cline-sidecar/src/{instructions.ts, index.ts, package.json}`, `src/lib/agent/{clineClient.ts, clineHarness.ts, clineApproval.ts}`, `src/lib/{inputCommands.ts, __tests__/inputCommands.test.ts}`, `src/components/ai/{AiPanel.tsx, ChatBox.tsx}`.
  - Aucune dépendance npm ajoutée (une dépendance fantôme supprimée). Pas de changement Docker (app desktop).
  - Validé : `tsc --noEmit` **0 erreur** (front + sidecar), `eslint src` **0 erreur** (8 warnings préexistants hors périmètre), `vitest` **600/600** (dont 6 nouveaux sur `mergeSlashCommands`), `cargo test` **123/123**, `vite build` OK.

- **Prochaines étapes :**
  - Tests unitaires ciblés Rust sur `browser.rs` (file d'attente de résultats).
  - Test terrain : déposer un `SKILL.md` sous `.cline/skills/<name>/`, vérifier l'apparition dans le menu `+` et l'autocomplétion `/`, et l'absence de doublon avec le global `~/.cline/skills`.

---

### [2026-10-17T17:00] | Parité Trae SOLO — Terminal agent (lecture seule) + Navigateur piloté + budget de prompt

- **Contexte :**
  Objectif de parité avec le **mode SOLO de Trae** (= notre mode IA) : l'agent doit pouvoir (1) **piloter le terminal** dont l'utilisateur n'a qu'un accès **lecture seule**, (2) **piloter un navigateur embarqué** (navigation, DOM, clic, capture) comme dans Trae SOLO. S'ajoutait un **nettoyage ciblé** du code mort `subagentRoles`/`spawn_agent`. Le tout livré **par lots** avec validation à chaque étape.

- **Modifications effectuées :**
  - **Lot 1 — Terminal agent lecture seule :** `src/lib/agent/terminalAgentStore.ts` (état du terminal contrôlé par l'agent, par session), bridge dans `clineClient.ts`, composant xterm en **lecture seule stricte** avec **icône agent** (`Bot`) au-dessus, badge de statut. L'utilisateur voit la sortie en direct sans pouvoir saisir.
  - **Lot 2 — Navigateur piloté par l'agent :**
    - **Modèle (sidecar) :** nouvel extraTool `browser` — `src-tauri/cline-sidecar/src/browserTool.ts` + câblage `index.ts`. Le front n'envoie qu'un `kind` (chaîne fermée) ; le sidecar résout vers des outils codés en dur (`browser_navigate/query/read_text/read_dom/click/type/press_key/screenshot/status/reload`).
    - **Backend Rust :** `src-tauri/src/browser.rs` (commandes `async fn` : `browser_eval`/`navigate`/`dom`/`click`/`screenshot`… + **file d'attente de résultats**), `lib.rs` (module + `BrowserState` + enregistrement). **`browser_screenshot` réécrit** : la capture se fait **depuis la page** (SVG `foreignObject` → canvas → `toDataURL('image/png')`) — il n'existe **aucune API de capture de webview** (ni JS ni Rust).
    - **Front :** `flow.ts` (9 outils `browser_*` → onglet `browser`), `toolPresentation.ts` (contrats navigateur act + read-only), `WebPreviewPane.tsx` (badge **Agent** `Bot`, `PREVIEW_PANEL_ID` exporté), `AiPanel.tsx` (injection de l'extraTool `browser` + `panelId`).
    - **Canal de retour :** `Webview::eval_with_callback` — la **dernière expression** du JS est sérialisée JSON et renvoyée au callback (ne dépend pas de `__TAURI__` côté page externe). Allowlist **à deux niveaux** : `BROWSER_COMMANDS` (sidecar) + `INVOKE_ALLOWLIST` (front).
    - **Garde-fou :** confirmation utilisateur **avant navigation externe** (hors localhost).
  - **Lot 3 — Nettoyage ciblé :** retrait de l'hôte `spawn_agent` non branché (`spawnRuntime.ts`) et du code mort `subagentRoles`. En mode IA, seule l'**équipe** `team_*` est exposée (`enableAgentTeams`) ; `spawn_agent` détaché n'émet aucun `team_progress` (invisible UI) → jamais activé.
  - **Budget de prompt :** compactage des contrats (`EDIT_RULES_FULL` dé-dupliqué vs `TOOL_CONTRACT_FULL`, `BROWSER_CONTRACT_ACT`, `DELEGATION_GUIDANCE`) pour repasser **sous 6000 caractères**.

- **Décisions Techniques :**
  - **Capture in-page plutôt qu'API webview :** aucune API `capture()` n'existe (ni `@tauri-apps/api/webview` ni `Webview` Rust). La seule voie fiable est la rasterisation **depuis la page** ; `eval_json` sert de canal de retour sans dépendance au contexte de la page.
  - **`extraTools` déclaratif (kind fermé) :** le front ne peut pas dicter un outil arbitraire — il choisit un `kind` dans une liste fermée, résolu côté sidecar vers du code en dur. Réduit la surface d'abus (pas d'outil injectable par le front).
  - **Terminal lecture seule strict :** l'agent contrôle le process, l'utilisateur observe. Aucun accès en écriture côté UI → pas d'élévation de privilège via l'UI.
  - **Nettoyage plutôt que conservation de `spawn_agent` :** un chemin non branché qui n'émet rien dans l'UI est une source de confusion et de dette ; on garde le mécanisme RÉELLEMENT observable (`team_*`).

- **Impacts & Dépendances :**
  - Fichiers touchés : `src-tauri/src/{browser.rs, lib.rs}`, `src-tauri/cline-sidecar/src/{browserTool.ts, index.ts}`, `src/lib/agent/{clineClient.ts, clineBridge.ts, clineHarness.ts, flow.ts, toolPresentation.ts, prompts.ts}`, `src/components/{editor/WebPreviewPane.tsx, ai/AiPanel.tsx}`, tests `prompts.*`.
  - Aucune dépendance npm ajoutée. `.dockerignore`/Docker non concernés (app desktop Tauri).
  - Validé : `cargo check` **0 erreur / 0 warning**, `npx tsc --noEmit` **0 erreur** (front + sidecar), `eslint` **0 erreur**, `vitest` **594/594**, `vite build` OK. Budget de prompt : `agent/max` 6143 → **5839** (< 6000), 6/6 presets conformes.

- **Prochaines étapes :**
  - Test terrain du pilotage navigateur (navigation dev server, clic/type sur apps React, capture) et affinage des sélecteurs `ref` si nécessaire.
  - Exploiter pleinement Cline (plugins, skills) de façon propre et efficace.

---

### [2026-10-16T23:55] | Notifications — Remplacement de la synthèse par de vrais sons libres de droit

- **Contexte :**
  La première version jouait des sons **synthétisés** (Web Audio, oscillateurs). Rendu trop « bip » et peu satisfaisant : un son de notification doit ressembler à un vrai `ding` produit, pas à un test de tonalité. L'utilisateur a demandé des **sons par défaut libres de droit** (comme Trae).

- **Modifications effectuées :**
  - **`src/assets/sounds/{finish,question,error,stop}.mp3`** *(créés)* : 4 fichiers MP3 (128 kbps, 44,1 kHz) issus de la banque **Mixkit** (licence gratuite, **sans attribution requise**) :
    - `finish` ← « Positive notification » (carillon positif, fin de tâche) ;
    - `question` ← « Confirmation tone » (interpellation pour l'« ask user ») ;
    - `error` ← « Wrong answer fail notification » (négatif, distinct) ;
    - `stop` ← « Software interface back » (neutre et discret pour l'arrêt volontaire).
  - **`src/lib/notify/sound.ts`** *(réécrit)* : abandon de la synthèse Web Audio au profit de **`HTMLAudioElement`**. Un élément **préchargé par son** est réutilisé ; si le son joue déjà, un **clone éphémère** est créé pour ne pas couper la lecture en cours (superposition sûre en multitâche). Volume appliqué en scalaire `[0, 1]`. Les URLs sont résolues via `new URL("../../assets/sounds/x.mp3", import.meta.url).href` → Vite les hache et les émet dans `dist/assets/` en build. **API publique inchangée** (`playSound`, `primeSound`, `isSoundEnabled`, `getSoundVolume`, clés de préférence).

- **Décisions Techniques :**
  - **Fichiers réels plutôt que synthèse** : timbre, réverbération et production d'un vrai enregistrement — c'est exactement ce que fait Trae, et c'est ce qui faisait défaut.
  - **`HTMLAudioElement` plutôt que l'API Web Audio** : le fichier est déjà produit et encodé ; on n'a plus besoin d'un graphe d'oscillateurs. Le volume devient un simple scalaire et le clone de nœud offre la superposition. Moins de code, moins de surface d'erreur.
  - **Mixkit plutôt que Pixabay / Google Sound Library** : Pixabay renvoie `403` aux requêtes hors navigateur et la Google Sound Library est **réservée aux Actions Google** (redistribution interdite). Mixkit est explicitement libre et sans attribution.
  - **Assets embarqués (bundlés), jamais distants** : un IDE doit fonctionner **hors ligne** ; dépendre d'un CDN tiers pour un son serait une régression. Les 4 MP3 sont dans le bundle (≈ 237 ko au total).

- **Impacts & Dépendances :**
  - Nouveau dossier `src/assets/sounds/` (4 MP3, ~237 ko). `sound.ts` réécrit (même surface d'import, aucun changement chez les appelants : `AiPanel.tsx`, `SettingsPanel.tsx`). Aucune dépendance npm ajoutée.
  - Validé : `tsc` EXIT 0, `eslint` 0 erreur, `vitest` **584/584**, `vite build` OK — les 4 MP3 sont bien émis dans `dist/assets/` avec hachage.

- **Prochaines étapes :**
  - Évaluer le rendu sonore à l'usage et, si besoin, ajuster le choix des fichiers par événement.
  - Vigilance sur la reprise de lecture après suspension OS (fenêtre en arrière-plan prolongée).

---

### [2026-10-16T23:30] | Parité Trae — Notifications (toast de fin + sons : question / erreur / stop)

- **Contexte :**
  Trae émet un **signal visuel (toast) et sonore** aux moments clés du cycle de l'agent : **fin de tâche**, **question posée** (« ask user »), **erreur**, **arrêt**. Chez Origin, l'infrastructure toast existait (`Toast.tsx`) mais était **mono-toast** (un nouveau message écrasait le précédent) et **aucun système audio** n'existait (pas d'assets, pas d'`AudioContext`). Avec le multitâche (F6), une tâche qui se termine **en arrière-plan** passait totalement inaperçue. Objectif : notifier à parité Trae, sans spammer, en respectant les préférences utilisateur.

- **Modifications effectuées :**
  - **`src/lib/notify/sound.ts`** *(créé)* : sons **synthétisés via Web Audio** (zéro asset binaire). 4 motifs : `finish` (do→sol sinus montant), `question` (double la triangle), `error` (notes basses sawtooth), `stop` (note descendante triangle). Contexte audio **paresseux** (créé au premier son, `resume()` si suspendu), enveloppe anti-clic (attaque 12 ms + `exponentialRampToValueAtTime`), nettoyage `osc.onended`. `playSound(name, {force?})` **best-effort** (jamais d'exception). Préférences : `SOUND_PREF_KEY` (`origin-notifications-sound`, défaut activé), `SOUND_VOLUME_KEY` (`origin-notifications-volume`, défaut 60 %). `primeSound()` débloque l'`AudioContext` sur interaction utilisateur.
  - **`src/lib/notify/notify.ts`** *(créé)* : orchestrateur **pur** (aucune dépendance React). `planNotification(kind, ctx)` décide toast+son selon le contexte. Règles anti-bruit : `finish` → **rien** si la tâche est affichée (déjà visible dans le fil), sinon son + toast `success` ; `question` → **toujours** son + toast `info` ; `error` → **toujours** son + toast `error` ; `stop` → **son seul** (action volontaire, pas de toast). Préférence toast : `TOAST_PREF_KEY` (`origin-notifications-toast`, défaut activé) + helper `isToastEnabled()`.
  - **`src/lib/notify/__tests__/notify.test.ts`** *(créé)* : **11 tests** sur `planNotification` (finish affichée/arrière-plan, sons/toasts coupés par préférence, question, error avec/sans message, stop sans toast, libellé vide → « Task »).
  - **`src/components/ui/Toast.tsx`** *(réécrit)* : passage **mono-toast → pile de toasts**. `ToastType` étendu à `warning`. File limitée à `MAX_TOASTS = 4` (les plus anciens évincés), auto-dismiss 3 s (erreurs : 5 s), `flexDirection: column-reverse` (les nouveaux apparaissent au-dessus de l'input). **API publique inchangée** (`showToast(text, type)`), donc aucun impact sur les consommateurs existants.
  - **`src/components/ai/AiPanel.tsx`** : helper `notifyTask(kind, sessionId, opts?)` (useCallback) qui résout le libellé de la tâche, construit le `NotificationContext` (`isDisplayed = activeSessionIdRef.current === sessionId`) et applique le plan. Branché aux **4 points** : `case "finish"` → `notifyTask("finish", sid)` ; `case "approval-required"` (après traitement `ask_user`/`edit`/`write_file`) → `notifyTask("question", …)` ; `case "error"` → `notifyTask("error", …, {errorMessage})` ; `handleStop` → `notifyTask("stop", …)`. `primeSound()` appelé en tête de `handleSend` (geste utilisateur).
  - **`src/components/settings/SettingsPanel.tsx`** : nouvelle section **Notifications** (`NAV_ITEMS` + `Section` + rendu) : toggle « Show notifications », toggle « Notification sound » (rejoue `finish` à l'activation pour retour immédiat), slider de volume (0–100 %, grisé si son coupé, aperçu au relâchement). Icône `Bell` (lucide).
  - **`ENGINEERING_LOG.md`** : présente entrée.

- **Décisions Techniques :**
  - **Synthèse WebAudio plutôt que fichiers `.mp3`** : zéro asset à versionner (ni poids, ni licence), latence nulle (pas de décodage), paramétrable (fréquence/durée/enveloppe). Un son de notification doit être **instantané** et **non bloquant**.
  - **Logique de décision isolée dans une fonction pure (`planNotification`)** : la règle « faut-il notifier ? » (anti-spam, préférences) est **testable seule**, hors React et hors Web Audio. `AiPanel` ne fait qu'**appliquer** le plan.
  - **`stop` = son seul, `finish` = silence si tâche affichée** : évite le bruit inutile — on ne bipe pas pour une action que l'utilisateur vient de déclencher, ni pour un résultat qu'il a déjà sous les yeux. Le son « finish » est réservé au cas **arrière-plan**, qui est précisément le gain du multitâche F6.
  - **Préférences en clés localStorage plates** (pattern `ConversationSection`) : les modules `notify.ts`/`sound.ts` les lisent directement, sans état React partagé ni contexte.
  - **`Toast.tsx` en pile avec API inchangée** : aucun changement requis chez les consommateurs (`App.tsx`, `AiPanel.tsx`), et plusieurs notifications simultanées (multitâche) ne s'écrasent plus.

- **Impacts & Dépendances :**
  - Nouveaux modules `src/lib/notify/*` (purs, sans couplage moteur). `Toast.tsx` étendu (rétrocompatible). `AiPanel.tsx` : 4 points de branchement + `primeSound`. `SettingsPanel.tsx` : nouvelle section autonome.
  - Aucune dépendance ajoutée. Aucun asset binaire. Validé : `tsc` EXIT 0, `eslint` 0 erreur, `vitest` **584/584**, `vite build` OK.

- **Prochaines étapes :**
  - Son des notifications **en arrière-plan d'application** (fenêtre non focalisée) : Restart de l'`AudioContext` après suspension OS à surveiller en usage réel.
  - Envisager un **niveau de son par type** (distinguer fin de tâche / question) si l'usage le demande.

---

### [2026-10-16T22:25] | Parité Trae — F6 : Multitasking (tâches parallèles)

- **Contexte :**
  Dans Trae, plusieurs tâches peuvent **travailler en parallèle** dans un même projet : on lance un run, on bascule sur une autre tâche, et le premier **continue en arrière-plan**. Chez Origin, l'état d'un run vivait **entièrement dans les refs locales d'`AiPanel`** (`runSeq`, `cleanup`, `AbortController`) : une seule tâche pouvait tourner, et `handleSessionSelect` **interrompait systématiquement** le stream courant. Basculer de tâche revenait donc à tuer le travail en cours. Le rail affichait en outre un « Completed » codé en dur. Objectif : permettre **plusieurs tâches actives simultanément**, un run qui **continue en arrière-plan**, et un **statut réel** visible partout (rail + bandeau).

- **Modifications effectuées :**
  - **`src/lib/agent/taskRuntime.ts`** *(créé)* : registre **module-level** clé par `sessionId`. `TaskRunStatus = idle | running | waiting | completed | interrupted`. API : `beginTaskRun(sessionId): RegisterRunHandle {setAbort, complete, interrupt}`, `markTaskWaiting`, `markTaskRunning`, `abortTaskRun`, `isTaskActive`, `listActiveTasks`, `listTaskSnapshots` (tri stable par compteur monotone `seq`, snapshot mémoïsé pour `useSyncExternalStore`), `forgetTask`. Hooks : `useTaskStatus`, `useTaskSnapshots`, `useActiveTasks`. **Pur côté données** (aucune dépendance React hors hooks, aucun couplage au moteur Cline).
  - **`src/lib/agent/__tests__/taskRuntime.test.ts`** *(créé)* : **17 tests** (transitions, non-émission si statut inchangé, stabilité de référence du snapshot, tri, abort, purge).
  - **`src/lib/agent/runState.ts`** *(créé en F6.3, complété ici)* : état de run **clé par session** (miroir `run.messages`, `seq`, `cleanup`, `pendingAssistantDbId`), avec un champ structurel `task` (sans import de `taskRuntime`, pour éviter la dépendance circulaire) permettant à `AiPanel` de tenir le handle de statut (`setAbort`/`complete`/`interrupt`).
  - **`src/components/ai/AiPanel.tsx`** : `handleSend` ouvre désormais un run via `beginTaskRun(sessionId)` ; le fil du run est **ancré explicitement** (`run.messages = [...runSeed, userMsg, assistantVide]`) pour ne pas dépendre de l'effet de sync de `messagesRef` ; helper interne `updateThread(updater)` qui **mute le fil du run** et ne pousse vers React (`setMessages`) **que si la session est affichée** — les 14 `setMessages` internes à `handleEvent` ont été migrés vers ce helper, ce qui **isole le fil de chaque run** ; `case "tool-call"` → `markTaskWaiting(sessionId, toolName)`, `case "tool-result"` → `markTaskRunning(sessionId)` ; `finish`/`error`/`handleStop`/`handleUndoAll` → `taskRun.complete()/interrupt()` ; changement de projet → `interrupt()` de **tous** les runs vivants ; `handleNewChat` **ne fige plus** le message assistant en « interrupted » (le run d'arrière-plan doit pouvoir **finaliser son écriture DB**) ; `handleSessionSelect` reprend l'affichage d'une tâche en cours en **flux direct** (`getRunMessages` + `getRun(sessionId).cleanup !== null`).
  - **`src/lib/agent/swarmStore.ts`** + **`src/lib/agent/projectContext.ts`** : clé **par session** (isolation des sous-agents/équipes et du contexte projet entre tâches parallèles).
  - **`src/components/ai/TaskRail.tsx`** : statut **réel** par tâche via `useTaskSnapshots` + helper `statusVisual(status, waitingTool)` → icône/couleur/libellé (`Running` / `Waiting · {outil}` / `Interrupted` / `Completed` / `Idle`). Le calcul `completed` (auto-fold) se déduit du statut réel : une tâche running/waiting en arrière-plan n'est **jamais** repliée.
  - **`src/components/ai/TaskProgressBar.tsx`** *(créé)* : **bandeau de progression multitâche** au-dessus de la barre d'onglets (`AgentModeView`). Affiche le nombre de tâches actives, `N en cours · M en attente`, et une **puce cliquable par tâche** (titre + outil attendu) pour basculer l'affichage. **No-op** (ne rend rien) tant qu'une seule tâche est active → aucune pollution visuelle en mono-tâche.
  - **`src/components/ai/AgentModeView.tsx`** : branchement de `TaskProgressBar` (`activeSessionId` + `handleSelectTask`).
  - **`src/index.css`** : ajout du keyframe `@keyframes origin-spin` (rotation du spinner de statut ; il n'existait pas).

- **Décisions Techniques :**
  - **Registre module-level plutôt que Context/store global** : un run doit survivre à l'**affichage** du composant. Sortir l'état d'`AiPanel` (refs locales) vers un registre observable découple **possession de l'état** et **montage UI** : l'UI s'abonne/se désabonne à l'affichage, le run continue. C'est le mécanisme qui débloque le vrai multitâche.
  - **`updateThread` (mutation du fil de run) au lieu de `setMessages` inconditionnel** : un run d'arrière-plan ne doit **jamais** écraser le fil de la session affichée. On mute `run.messages` (source de vérité du run) et on ne publie vers React que si `activeSessionIdRef.current === sessionId`. C'est le point le plus délicat de F6 (un `setMessages` inconditionnel écrasait le fil affiché).
  - **Reprise en « flux direct »** : reprendre l'affichage d'une tâche running montre son **miroir vivant** (`run.messages`) et continue sur le même flux — pas de re-seed, pas de coupure. (La reprise par `initialMessages` reste utilisée pour les sessions **non vivantes** dans ce process.)
  - **`handleNewChat` non destructif** : en multitâche, quitter une conversation ne doit pas la « terminer ». On ne pousse que le miroir ; le run d'arrière-plan conserve la main sur son écriture DB.
  - **Statut « dérivé quand affiché, réel quand actif »** : le registre ne connaît que les `sessionId` ; les titres sont lus depuis les métadonnées persistées. Le bandeau reste **volontairement** discret (masqué en mono-tâche) pour ne rien changer au flux de travail courant.
  - **Tri stable par compteur `seq`** : deux transitions dans la même milliseconde ne doivent pas produire d'ordre instable (contrainte `useSyncExternalStore`).
  - **`task` typé structurellement dans `RunState`** : évite un cycle d'imports `runState ↔ taskRuntime` tout en gardant le handle de statut disponible dans `AiPanel`.

- **Impacts & Dépendances :**
  - Fichiers : `taskRuntime.ts` (+tests), `runState.ts`, `swarmStore.ts`, `projectContext.ts`, `AiPanel.tsx`, `TaskRail.tsx`, `TaskProgressBar.tsx`, `AgentModeView.tsx`, `index.css`.
  - Effet : lancer une tâche, basculer sur une autre, la relancer → **deux runs en parallèle** ; le rail et le bandeau reflètent le **statut réel** de chacun ; « Stop » / changement de projet / suppression interrompent proprement (abort SDK + statut `interrupted`).
  - Sécurité / robustesse : le registre **isole** les runs (un run ne peut plus écrire dans le fil d'une autre session) ; `forgetTask` **abort** systématiquement un run avant purge (pas de listener orphelin) ; aucune nouvelle surface réseau — orchestration d'état côté client uniquement.
  - Dette résolue : suppression du « Completed » codé en dur (F5) et de l'interruption intempestive à la bascule.

- **Validation :**
  - `npx tsc --noEmit` → **EXIT 0** (seul le faux positif `RevertConfirmDialog` connu, ignoré).
  - `npx eslint src` → **0 erreur** (8 warnings préexistants sur d'autres fichiers, hors périmètre F6).
  - `npx vitest run` → **573/573** (dont 17 sur `taskRuntime`).
  - `npx vite build` → **built in ~4s**, aucune erreur.

- **Prochaines étapes :**
  - Notification discrète à la **fin d'une tâche d'arrière-plan** (toast), si l'utilisateur est sur une autre tâche.
  - Persistance du statut de tâche au reload (aujourd'hui `idle` au redémarrage, par conception).

---

### [2026-10-16T22:05] | Parité Trae — F5 : auto-fold des conversations terminées

- **Contexte :**
  Dans Trae, la liste des tâches (équivalent de notre `TaskRail`) regroupe les conversations par période (Today / Yesterday / …) et **replie automatiquement les groupes dont toutes les tâches sont terminées** (réglage « To-Do List »). Chez Origin, le rail affichait une liste plate, sans groupement ni repli, et chaque tâche était badgée « Completed » en dur.

- **Modifications effectuées :**
  - **`src/lib/agent/taskGrouping.ts`** *(créé)* : logique **pure** — `taskGroupFor(updatedAt, now)` (bucket par jour calendaire local : today / yesterday / last7days / last30days / older), `groupTasks(tasks, now)` (groupes non vides, tri intra-groupe décroissant, ordre chronologique), `isGroupFolded(group, autoFold)` (repli seulement si auto-fold actif **et** groupe entièrement terminé).
  - **`src/lib/agent/__tests__/taskGrouping.test.ts`** *(créé)* : 15 tests (bornes exactes des buckets, frontière 7/8 et 30/31 jours, tri, omission des groupes vides, règle de repli).
  - **`src/components/settings/SettingsPanel.tsx`** : la section `conversation` (jusqu'ici `ComingSoonSection`) devient une vraie `ConversationSection` (toggle « Auto-fold completed tasks », clé `origin-conversation-auto-fold`) ; constante `AUTO_FOLD_KEY` exportée ; la section est branchée dans le routeur de sections et retirée de la liste `ComingSoon`.
  - **`src/components/ai/TaskRail.tsx`** : dérivation mémoïsée des groupes (la tâche active est marquée `completed: false`), en-têtes de groupe repliables (chevron + compteur), état `openGroups` pour l'override manuel, et écoute de l'événement `origin:conversation-prefs` pour réagir au réglage sans rechargement.

- **Décisions Techniques :**
  - **Regroupement par jour calendaire local**, pas par fenêtre glissante de 24 h : une tâche de 23 h 50 est « Aujourd'hui » le jour même, « Hier » le lendemain — comportement attendu par l'utilisateur et aligné sur Trae.
  - **Règle de repli conservatrice** : on ne replie **jamais** un groupe contenant une tâche active. Le travail en cours reste toujours visible, même si l'auto-fold est activé.
  - **`now` en state, pas d'appel à `Date.now()` dans le rendu** : la règle React « composants purs » interdit les fonctions impures pendant le rendu (lint bloquant). `now` est rafraîchi dans l'effet de (re)chargement de la liste.
  - **Synchronisation cross-composant par événement DOM** (`origin:conversation-prefs`) plutôt que par remontée de props : SettingsPanel et TaskRail vivent dans deux arbres distincts (portail vs vue AI) ; un événement évite un prop-drilling artificiel et une refonte du store.
  - **Statut dérivé, pas stocké** : `completed` est calculé à partir de `activeSessionId` (une seule tâche active à la fois), ce qui évite d'introduire une nouvelle source de vérité en base.

- **Impacts & Dépendances :**
  - Fichiers : `taskGrouping.ts` (+tests), `SettingsPanel.tsx`, `TaskRail.tsx`. Aucune dépendance ajoutée.
  - Effet : le Rail affiche des sections temporelles repliables ; le comportement par défaut (auto-fold ON) replie l'historique terminé et laisse les tâches actives ouvertes.
  - Limite connue : le statut « Completed » reste codé en dur pour l'affichage (« Completed · HH:MM ») ; seul le **repli** exploite le statut dérivé. Introduire un vrai statut de tâche (pending/running/completed) est hors périmètre de F5.
  - Sécurité : aucune surface nouvelle — regroupement d'affichage côté client.

- **Validation :**
  - `tsc` EXIT 0 ; `eslint` (fichiers modifiés) 0 erreur (1 warning préexistant `set-state-in-effect` sur le `setSessions` d'origine) ; `vitest run` → **526/526** (dont 15 sur `taskGrouping`).

- **Prochaines étapes :**
  - F6 (multitasking : tâches parallèles dans un même projet).

---

### [2026-10-16T21:40] | Parité Trae — F4 : Flow (bascule automatique d'onglet)

- **Contexte :**
  Trae dispose du « Flow » : pendant qu'un tour d'agent s'exécute, le panneau d'outils suit automatiquement l'étape en cours (l'agent lit → onglet Editor, écrit → DiffView, lance une commande → Terminal, va sur le web → Browser). Origin n'avait rien d'équivalent : l'onglet restait figé sur « Editor ».

- **Modifications effectuées :**
  - **`src/lib/agent/flow.ts`** *(créé)* : logique **pure** — `flowTargetFor(toolName)` (mapping outil→onglet, aligné sur les outils canoniques de `toolPresentation.ts`), `activeFlowTab(runningTools)` (dernier tool-call pilotable), `shouldFlow(isRunning)` (garde : actif seulement pendant un run).
  - **`src/lib/agent/__tests__/flow.test.ts`** *(créé)* : 11 tests (mapping, priorité au dernier tool-call, outils silencieux ignorés, garde de run).
  - **`src/components/ai/AiPanel.tsx`** : `AgentSurfaceState` étendu (`runningTools`, `isRunning`) ; dérivation mémoïsée des tool-calls `running` + `isStreaming`, poussée au parent.
  - **`src/components/ai/AgentModeView.tsx`** : effet de Flow (active l'onglet cible + s'assure qu'il est ouvert) ; `flowPausedRef` met le Flow en pause dès un clic utilisateur, `prevRunningRef` détecte le front montant d'un run pour le réactiver au tour suivant.

- **Décisions Techniques :**
  - **Décision isolée dans une fonction pure** (`flow.ts`) plutôt qu'en logique de rendu : testable sans DOM, lisible, et le composant ne fait qu'appliquer le résultat.
  - **Mapping conservateur** : seuls les outils ayant un panneau dédié changent d'onglet (`editor`, `read_files`, `run_commands`, `fetch_web_content`). Les outils silencieux (`search_codebase`, `todo_write`, `ask_question`, `skills`) ne basculent rien → évite tout clignotement.
  - **Respect de l'utilisateur** : le Flow ne vole jamais la main en dehors d'un run, et un clic manuel le suspend jusqu'au tour suivant (comportement Trae).
  - **Updaters no-op** (`prev === target ? prev : target`) : aucune cascade de rendu tant que la cible ne change pas.

- **Impacts & Dépendances :**
  - Fichiers : `flow.ts` (+tests), `AiPanel.tsx`, `AgentModeView.tsx`. Aucune dépendance ajoutée.
  - Effet : le panneau d'outils suit désormais l'agent en mode AI ; le mode IDE (sidebar) n'est pas concerné (`onAgentSurface` non fourni).
  - Sécurité : aucune surface nouvelle — dérivation d'état côté client uniquement.

- **Validation :**
  - `tsc` EXIT 0 ; `eslint` (fichiers modifiés) 0 erreur ; `vitest run` → **511/511** (dont 11 sur `flow`).

- **Prochaines étapes :**
  - F5 (auto-fold des conversations terminées), F6 (multitasking).

---

### [2026-10-16T21:15] | Parité Trae — F3 : tool panels réels (DiffView + DocView)

- **Contexte :**
  En mode Agent, les onglets `docview` et `diffview` de la barre de tools n'étaient que des stubs « Coming soon » ([AgentModeView.tsx](file:///Users/user/code/orvyx-desktop/origin/src/components/ai/AgentModeView.tsx)). Or Trae expose dans SON mode tour deux panneaux réels : une vue Diff (fichiers modifiés par la tâche courante, cliquables vers le diff) et une vue Doc (document produit par l'agent). On les rend réels sans dupliquer l'état.

- **Modifications effectuées :**
  - **`src/components/ai/DiffViewPanel.tsx`** *(créé)* : bandeau de synthèse « N files changed » + delta cumulé `+A −R`, liste cliquable des fichiers du tour (icône créer/modifier, chemin, delta) et actions « Undo all » / « Keep all ». Réutilise `sumDelta` de `TurnReviewCard`.
  - **`src/components/ai/DocViewPanel.tsx`** *(créé)* : rendu Markdown du dernier artefact assistant substantiel + bloc « Plan » (étapes structurées) si un plan est en attente. Réutilise `MarkdownMessage`.
  - **`src/components/ai/AiPanel.tsx`** : nouvelle prop `onAgentSurface?: (state: AgentSurfaceState) => void` + état dérivé mémoïsé (`docMarkdown` = dernier texte assistant ≥ 40 car. ; `pendingPlan` = dernier `plan-card` pending) ; un `useEffect` pousse `{ reviewFiles, undoAll, keepAll, openDiff, docMarkdown, plan }` au parent.
  - **`src/components/ai/AgentModeView.tsx`** : consomme `onAgentSurface` (état `surface`) et remplace les stubs par `DiffViewPanel` / `DocViewPanel`.

- **Décisions Techniques :**
  - **Un seul propriétaire de l'état** : AiPanel reste la source de vérité (revue, tours, plan). Les panneaux sont **purement présentationnels** ; le parent ne fait que relayer — aucune duplication de logique ni risque de désynchronisation, exactement le modèle Trae.
  - **Canal explicite typé** (`AgentSurfaceState`) plutôt que contexte global : évite un re-render de l'arbre, garde le couplage visible et testable.
  - **DocView choisit le dernier texte substantiel** (seuil 40 car.) pour écarter les bulles vides/outillage : le panneau montre un « document », pas un fragment de log.

- **Impacts & Dépendances :**
  - Fichiers : `AiPanel.tsx` (+prop), `AgentModeView.tsx` (câblage), 2 nouveaux composants. Aucune dépendance ajoutée.
  - Effet : les onglets DiffVic/DocView deviennent fonctionnels en mode Agent ; le mode IDE n'est pas touché (`onAgentSurface` non fourni).
  - Sécurité : lecture seule côté rendu ; l'ouverture de diff réutilise le chemin d'approbation existant (`onOpenDiffTab`). Rien d'exposé au modèle.

- **Validation :**
  - `tsc` EXIT 0 ; `eslint` (fichiers modifiés) 0 erreur ; `vitest run` → **500/500**.

- **Prochaines étapes :**
  - F4 (Flow : bascule auto d'onglet selon l'étape de l'agent), F5 (auto-fold), F6 (multitasking).

---

### [2026-10-16T20:10] | Parité Trae — F1 « le mode suit la conversation » + F2 todo persistant

- **Contexte :**
  Parcours de la doc Trae (IDE mode ↔ SOLO mode, le nôtre étant « AI mode »). Exigence : on doit pouvoir **basculer librement d'un mode à l'autre dans la MÊME conversation sans rien perdre**. Or deux bugs structurels l'empêchaient : (1) le mode applicatif (`ide`/`ai`) n'était hydraté que depuis `localStorage`, jamais depuis le store Tauri ; (2) la capacité d'agent (`enableTeams`, contexte projet, prompt système) était dérivée du **layout courant** (`renderMode`) et non du **mode de création de la conversation** → une conv ouverte en AI perdait ses sous-agents si on la relisait en IDE. En outre la **todo list** vivait en mémoire seule et disparaissait au reload/bascule.

- **Modifications effectuées :**
  - **`src/lib/db.ts`** : migration `ALTER TABLE sessions ADD COLUMN app_mode TEXT` ; `DbSession.app_mode` ; `createSession(..., appMode?)` ; helpers `getSessionAppMode` / `setSessionAppMode`.
  - **`src/components/ai/AiPanel.tsx`** : `sessionAppModeRef` (source de vérité) + `setSessionAppMode` / `loadSessionAppMode` ; le mode effectif de la conv (`effAppMode`, `convIsAgent`) est dérivé du mode **mémorisé**, plus du layout — il pilote `enableTeams`, `contextStatus` et `buildSystemPrompt("agent", …, convIsAgent)`. `appMode` figé à la création (ligne `createSession`) ; réhydraté à la reprise (restore, `handleSessionSelect`, sélecteur de session) ; réinitialisé sur nouvelle conv / changement de dossier ; purge de la todo à la suppression.
  - **`src/hooks/useWorkspacePersistence.ts`** : clé store `app.mode` hydratée au mount (repli `localStorage`) et persistée à chaque bascule ; appel `hydrateAllTodos()` au démarrage.
  - **`src/lib/settings.ts`** : clés typées `'app.mode'` et `'todo.list'` (+ défauts) et helper `deleteSetting`.
  - **`src/lib/agent/todoStore.ts`** : persistance par conversation dans le store Tauri (clé `todo.list`, map `sessionId → TodoItem[]`), écritures **best-effort non bloquantes**, `hydrateAllTodos` (n'écrase jamais une session en mémoire), `pruneTodos`, `clearTodos` purge aussi le disque. API publique inchangée (synchrone).
  - **Tests** (`src/lib/agent/__tests__/todoStore.test.ts`) : +4 cas de persistance/réhydratation (mock du store Tauri).

- **Décisions Techniques :**
  - **Le mode de création fait foi** (décision utilisateur « le mode suit la conversation ») : `renderMode` reste purement présentationnel ; toute la capacité d'agent se dérive du mode de conv mémorisé en base. Dégradation gracieuse : `app_mode NULL` (sessions héritées) retombe sur le mode courant, puis est figé au premier usage.
  - **Ref plutôt que state React** pour le mode de conv : la valeur n'est relue qu'au prochain envoi (pas de rendu requis) — évite tout churn de re-render.
  - **Todo persistée par conversation** : c'est un artefact de la tâche, pas du layout → elle doit survivre reload **et** bascule (parité Trae).
  - **Persistance todo non bloquante** : l'API reste synchrone (fire-and-forget) pour ne pas perturber la boucle d'événements de l'agent ; `hydrateAllTodos` comble les sessions absentes sans jamais écraser un run en cours.

- **Impacts & Dépendances :**
  - Fichiers : `src/lib/db.ts`, `src/lib/settings.ts`, `src/lib/agent/todoStore.ts`, `src/lib/agent/__tests__/todoStore.test.ts`, `src/components/ai/AiPanel.tsx`, `src/hooks/useWorkspacePersistence.ts`.
  - Effet : bascule IDE↔AI **sans perte** de capacités ni de todo, dans le même fil ; le mode global survit au reload via le store Tauri.
  - Sécurité : aucune surface nouvelle — lecture/écriture de réglages locaux, valeurs bornées (`'ide'|'ai'`, tableau de todo typé). Rien d'exposé au modèle.

- **Validation :**
  - `tsc` EXIT 0 ; `eslint src` → **0 erreur** (8 warnings préexistants hors périmètre) ; `vitest run` → **500/500** (dont 7 sur `todoStore`).

- **Prochaines étapes :**
  - F3 (tool panels réels : diffview + docview), F4 (Flow), F5 (auto-fold), F6 (multitasking) — voir plan de parité Trae.
  - Test UI : ouvrir une conv en AI, basculer en IDE, vérifier que les sous-agents restent disponibles et que la todo est toujours là après reload.

---

### [2026-10-16T19:45] | Keep all / Undo all : le DISQUE devient la source de vérité

- **Contexte :**
  Le système « Keep all / Undo all » (checkpoints par tour) existait déjà et était mûr côté Rust, mais l'**état de revue** vivait **uniquement en mémoire React** (`turnIdsByUserIndexRef`, `keptReviews`, `revertableIndexes`) alors que les checkpoints sont **persistés sur disque**. Résultat, lot de 4 symptômes signalés : (1) perte totale de la revue au rechargement, (2) « Keep all » qui ne fige pas / « Undo » qui vise la mauvaise cible, (3) bannière instable, (4) éditeur désynchronisé après un undo.

- **Cause racine :**
  1. **Persistance** — l'état React ne survivait pas au reload, les tours encore annulables disparaissaient.
  2. **Tours fantômes** — `handleKeepAll` (hors run) et `handleMessageAction` purgaient le checkpoint sur disque mais **pas** `turnIdsByUserIndexRef` : le message restait marqué « annulable » alors que son checkpoint n'existait plus → « Undo » visait un tour inexistant.
  3. **Mauvaise cible** — `revertableIndexes` filtrait sur l'index exact (`idx !== userIndex`) au lieu de `idx < userIndex`, laissant les index suivants « fantômes ».
  4. **Éditeur désynchronisé** — seul `handleConfirmRevert` resynchronisait l'éditeur ; les autres chemins non.

- **Modifications effectuées :**
  - **Rust** (`src-tauri/src/checkpoint.rs`) : nouvelle commande `checkpoint_list_turns` → renvoie les tours encore présents sur disque (`TurnInfo { turn_id, count, paths }`), factorisée dans une fonction pure `list_turns_at(root)` (tri déterministe, ignore dossiers sans manifeste et noms non conformes, racine absente = vide, pas erreur). Enregistrée dans `lib.rs`. **+3 tests** (11/11).
  - **Façade** (`src/lib/turnCheckpoint.ts`) : `listTurnCheckpoints()` + type `TurnCheckpointRecord` (mappe `turn_id` → `turnId`).
  - **Logique pure extraite** (`src/lib/agent/reviewState.ts`, **nouveau**) : `collectTurnIdsFrom`, `keepFrom`, `revertableIndexesAfterKeep`, `hydrateTurns`, `keptReviewsBefore`. Toute l'orchestration de revue est ainsi **testable sans monter le composant**.
  - **AiPanel** : (a) `hydrateReviews()` rejoue `listTurnCheckpoints` au montage et à chaque changement de dossier → reconstruit le suivi et les index annulables, réaffiche la bannière du dernier tour ; (b) marqueurs « gardé » **persistés** dans `localStorage` par dossier ; (c) tous les chemins Keep (`handleKeepAll`, `handleKeepMessage`, `handleMessageAction`, `handleConfirmRevert`) utilisent `keepFrom` → plus de tours fantômes ; (d) purge des marqueurs « gardé » après undo.
  - **Tests** (`src/lib/agent/__tests__/reviewState.test.ts`, **nouveau**) : 14 cas couvrant collecte multi-messages, purge `≥ index`, immuabilité, reconstruction disque, filtrage des marqueurs.

- **Décisions Techniques :**
  - **Le disque est la source de vérité** : plutôt que de re-persister toute la corrélation tour ↔ message (coûteux et fragile), on relit l'état minimal (`checkpoint_list_turns`) et on rattache les tours survivants au **dernier message utilisateur** — seul ancrage fiable après reload. « Undo all » agit alors sur tout le run restant, ce qui reste le comportement attendu.
  - **Extraction d'un module pur** plutôt que de tester le composant : `AiPanel` exige Tauri + DOM, intestable en isolation. Les fonctions pures couvrent précisément les cas à risque de régression.
  - **Helpers réutilisés dans le composant** : le code testé est exactement le code qui tourne (pas de duplication).

- **Impacts & Dépendances :**
  - Fichiers : `src-tauri/src/checkpoint.rs`, `src-tauri/src/lib.rs`, `src/lib/turnCheckpoint.ts`, `src/lib/agent/reviewState.ts`, `src/components/ai/AiPanel.tsx`, `src/lib/agent/__tests__/reviewState.test.ts`.
  - Effet : la revue « Keep/Undo » survit au rechargement ; plus de tours fantômes ; éditeur resynchronisé après undo. Aucune surface de sécurité nouvelle (lecture locale de l'app data dir, chemins validés par `assert_safe_turn_id` et `assert_in_workspace`).

- **Validation :**
  - `tsc` front EXIT 0 ; `vitest run` → **496/496** (dont 14 nouveaux) ; `cargo test --lib checkpoint` → **11/11** ; `eslint` EXIT 0.

- **Prochaines étapes :**
  - Test UI réel : provoquer un Keep/Undo, recharger la fenêtre, vérifier que la bannière et les boutons par message réapparaissent correctement.

---

### [2026-10-16T19:19] | Continuité de session RÉPARÉE : reprise par re-seed (`initialMessages`)

- **Contexte :**
  Log UI : `resume: updateModel ignoré: {"code":"session_not_found","message":"session not found: 1792147973864_9g9ts"}`. La continuité multi-tours était **cassée en silence** : chaque reprise échouait, la conversation perdait son contexte.

- **Cause racine (analysee dans `@cline/core/dist/index.js`) :**
  - `send` → `runTurn` → `getSessionOrThrow(sessionId)` ; `updateSessionModel` → `updateSessionConnection` → `getSessionOrThrow`. Les deux **jettent `SessionNotFoundError`** si la session n'est pas dans `this.sessions` (Map **en mémoire vive**).
  - Le SDK ne persiste pas les sessions *résidentes* : après un redémarrage du sidecar (ou éviction), la session existe **sur disque (SQLite)** mais **plus en mémoire**. Notre reprise réutilisait le même `sessionId` (`updateModel` + `send`) → `session_not_found` systématique.
  - `restore` N'EST PAS la solution : il **fork** la session (nouvel id) et sert au rollback checkpoint/git (`RestoreOptions.workspace`).

- **Solution retenue (chemin OFFICIEL du SDK) :**
  `StartSessionInput.initialMessages` (`LlmsProviders.MessageWithMetadata[]`), documenté dans le SDK : « used by **resume**, fork, and compaction ». On lit l'historique persisté via `readMessages` (lecture **disque**, pas via `getSessionOrThrow`) et on le réinjecte dans un `start` neuf. La continuité ne dépend plus de la survie du process ; le nouvel id SDK est repersisté côté front (`setClineSessionId`, déjà en place).

- **Modifications effectuées :**
  - `src-tauri/cline-sidecar/src/index.ts` : `StartCommand.initialMessages?: unknown[]` (transporte tel quel — transport passif, pas d'interprétation) ; `case "start"` le passe à `engine.start({ initialMessages })`.
  - `src/lib/agent/clineClient.ts` : sur `resumeSessionId`, on appelle la commande `messages` (`readMessages`), puis on **démarre une session neuve** avec `initialMessages`. Suppression de l'ancien chemin `updateModel` + réutilisation d'id (source du bug). Historique vide/introuvable → session neuve propre (dégradation gracieuse).

- **Décisions Techniques :**
  - `initialMessages` typé `unknown[]` côté sidecar : il ne fait que **transporter** la sortie de `readMessages` (elle-même `MessageWithMetadata[]`), donc aucun risque de désalignement de schéma et aucune surface d'injection nouvelle (le front fournit déjà prompt système, clé API et mode).
  - Bornes existantes suffisantes : commande entrante plafonnée à 8 Mio (`MAX_COMMAND_LINE_BYTES`) — largement au-dessus d'un historique conversationnel ; pas de garde redondante ajoutée (éviter la sur-ingénierie).

- **Impacts & Dépendances :**
  - Fichiers : `cline-sidecar/src/index.ts`, `src/lib/agent/clineClient.ts`. `clineHarness.ts`/`AiPanel.tsx` inchangés (l'id remappé est déjà repersisté).
  - Effet : la conversation garde son contexte entre tours, même après redémarrage du sidecar. Coût : l'historique est re-transmis au `start` (comportement identique à une session vivante qui rejoue son historique).

- **Validation :**
  - `tsc` front EXIT 0 ; `tsc` sidecar EXIT 0 ; `vitest run` → **482/482** ; `eslint` EXIT 0 ; build sidecar (`esbuild`) OK.

- **Prochaines étapes :**
  - Test UI réel : enchaîner ≥ 3 tours et vérifier dans les logs `reprise: N message(s) re-seedés` + absence de `session_not_found`, et que l'agent se souvient du contexte.

---


### [2026-10-16T19:05] | `editor` SDK décortiqué : 3 formes distinctes + « Written: undefined » corrigé

- **Contexte :**
  Nouvelle remontée utilisateur, toujours sur `editor` : `Editor input too large: new_text was 7795/16971 characters`, puis `Editor operation failed: No replacement performed: text not found in /Users/.../script.js`, puis la carte de tool affichant `Written: undefined`. Analyse du bundle réel `@cline/core/dist/index.js` (fonctions `wa`, `mk`, `EW`, `xW`, `va`, `PW`) pour établir le comportement EXACT de l'outil, invisible dans les `.d.ts` (stubs).

- **Découvertes (comportement réel de `editor`) :**
  - Fichier ABSENT → l'outil **crée** le fichier avec `new_text` et **ignore `old_text`** (`if(!await AW(a)) return RW(a,o.new_text)`).
  - Fichier PRÉSENT, `old_text` **omis** → erreur `already exists, but \`old_text\` was omitted`.
  - Fichier PRÉSENT, `old_text` non trouvé (0 occurrence) → `No replacement performed: text not found in <path>`.
  - `old_text` trouvé 2+ fois → `No replacement performed: multiple occurrences of text found`.
  - `insert_line` (one-based, borné à `1..line_count+1`) → insère AVANT la ligne ; **`line_count + 1` = ajout en fin (EOF)**.
  - `old_text`/`new_text` plafonnés à **6000 caractères chacun** (`mk`), limite dure.
  - La comparaison est EXACTE (après normalisation des fins de ligne seulement) : aucune tolérance d'indentation/espaces.
  - Le résultat est une **string** (`File created successfully at: …`, `Edited …`, `Inserted content at line N in …`) ; le `execute` du SDK renvoie `{ query, result, success }`.

- **Cause racine du `Written: undefined` :**
  `ToolCallCard.resultSummary` testait `obj.success` puis lisait `obj.path` — champ de l'ANCIEN harness front, absent du SDK. Sur un résultat SDK `{ success:true, result:"..." }`, `obj.path` valait `undefined` → carte « Written: undefined ».

- **Modifications effectuées :**
  - `src/lib/agent/toolPresentation.ts` : puces `editor` du `TOOL_CONTRACT_FULL` réécrites en 3 formes distinctes (CREATE sans `old_text` / REPLACE avec `old_text` / APPEND via `insert_line = line_count + 1`), + rappel limite 6000 et règle « match exactement UNE fois ». En-tête documentant le comportement réel (`wa`/`mk`).
  - `src/lib/agent/prompts.ts` : `EDIT_RULES_FULL`/`EDIT_RULES_LITE` recentrés sur la STRATÉGIE (découpage en chunks, re-lecture sur « text not found ») pour ne pas dupliquer le contrat d'outil.
  - `src/components/ai/ToolCallCard.tsx` : `resultSummary` lit d'abord `obj.result` (forme SDK) avant `obj.success`/`obj.path` (forme historique) → plus jamais « Written: undefined ». `TOOL_LABELS`/`argsPreview` connaissent les noms Cline (`read_files`, `search_codebase`, `editor`, `run_commands`, `fetch_web_content`, `skills`, `ask_question`) tout en gardant les alias historiques.
  - `src/lib/agent/__tests__/prompts.test.ts` : +2 invariants (CREATE/REPLACE/APPEND + `line_count + 1` présents ; rappel « 6000 » présent en agent max ET normal).

- **Décisions Techniques :**
  - Le contrat d'outil (mécanique EXACTE du SDK) vit dans `TOOL_CONTRACT_FULL` ; les `EDIT_RULES` ne portent que le comportement (stratégie, récupération après échec). Évite la redite — surveillée par `prompts.metrics.test.ts`.
  - Budget de prompt maintenu < 6000 caractères/preset (test de garde) : l'ajout de précision a exigé de CONDENSER, pas d'empiler.

- **Impacts & Dépendances :**
  - Fichiers : `toolPresentation.ts`, `prompts.ts`, `__tests__/prompts.test.ts`, `components/ai/ToolCallCard.tsx`. Aucune modification du moteur ni du sidecar.
  - Effet attendu : le modèle choisit la bonne forme d'`editor` du premier coup (moins d'échecs « text not found ») ; l'UI affiche le vrai message de résultat/erreur.

- **Validation :**
  - `npx tsc --noEmit` → EXIT 0 ; `npx vitest run` → **482/482** (37 fichiers) ; `npx eslint` sur les 4 fichiers → EXIT 0.

- **Prochaines étapes :**
  - Test UI réel : demander un « gros fichier » et vérifier (a) plusieurs `editor` enchaînés (create + appends), (b) aucun « Written: undefined », (c) les cartes affichent le message d'erreur réel en cas d'échec.

---


### [2026-10-16T12:50] | Prompt système réaligné sur les outils Cline réels (+ limite editor 6000)

- **Contexte :**
  Symptôme rapporté : le modèle tente d'écrire un gros fichier (jeu Bomberman, 17802 car.) via `editor` et l'appel échoue : « Editor input too large: new_text was 17802 characters, exceeding the recommended limit of 6000 ». Analyse : ce message est émis par le SDK Cline lui-même (`@cline/core`, fonction `mk`) — `editor` REFUSE tout `old_text`/`new_text` > **6000 caractères** (limite dure, non configurable). Cause racine côté Origin : après la bascule vers le SDK, le prompt système décrivait encore les ANCIENS outils du harness front (`read_file`, `write_file`, `edit`, `multi_edit`, `bash_run`, `ask_user`) au lieu des outils Cline réellement exposés (`read_files`, `search_codebase`, `run_commands`, `fetch_web_content`, `apply_patch`, `editor`, `skills`, `ask_question`, `submit_and_exit`). Le modèle ne connaissait donc ni ses vrais noms d'outils ni la stratégie de découpage.

- **Modifications effectuées :**
  - `src/lib/agent/toolPresentation.ts` : `FULL_TOOLS_LIST` / `READ_ONLY_TOOLS_LIST` réalignés sur les outils Cline ; `ASK_MODE_FILES_NOTE` référence `editor`/`apply_patch`.
  - `src/lib/agent/prompts.ts` : `EDIT_RULES_FULL` / `EDIT_RULES_LITE` réécrits pour `editor`/`apply_patch` + consigne EXPLICITE de découpage (< 6000 car. par appel, création + ajouts via `insert_line` ou ancrage `old_text` court et unique) ; `ASK_USER_RULES` : `ask_user` → `ask_question`.

- **Décisions Techniques :**
  - On ne contourne PAS la limite du SDK (elle est volontaire, anti-timeout) : on aligne le prompt pour que le modèle écrive par blocs, comme Cline l'attend.
  - Le prompt système Origin doit décrire EXACTEMENT les outils du SDK : un nom inexistant fait échouer l'agent.

- **Impacts & Dépendances :**
  - Fichiers : `toolPresentation.ts`, `prompts.ts`. Aucune modification moteur. Les tests de prompts comptent des concepts par regex → restent verts.

- **Validation :**
  - `npm run typecheck` → EXIT 0 ; `npm test` → 478/478 ; `npm run lint` → 0 erreur sur les fichiers touchés (1 erreur préexistante `scripts/ttft-probe.ts`).

- **Prochaines étapes :**
  - Vérifier en UI réelle qu'une demande de « gros fichier » produit bien plusieurs appels `editor` enchaînés.

---


### [2026-10-16T08:25] | Cline SDK partout (plan/ask compris) + todo tools + continuité de session

- **Contexte :**
  Demande utilisateur : « utiliser Cline SDK partout, même la boucle agent », « ajouter le système de todo comme sur Trae », « la structuration des sessions et l'évolution dans la session pour avoir une continuité et une fluidité de la conversation », « envoyer tous les events de Cline à l'UI proprement ». Avant : seuls les modes IDE/IA utilisaient le SDK Cline ; `plan` et `ask` passaient encore par l'ancien harness `runAgent` (front), avec reconstruction complète des messages à chaque tour → pas de continuité, pas de todo list, divergence de comportement entre modes.

- **Modifications effectuées :**
  - **Outils todo custom** (`cline-sidecar/src/todoTool.ts`, créé) : `todo_write` / `todo_read` via `createTool` de `@cline/core` + `zod` ; `buildTodoTools(uiSessionId, emit)` renvoie `{ tools, onEmit }` (mémoire `lastTodos`).
  - **Sidecar** (`cline-sidecar/src/index.ts`) : `buildExtraTools(specs)` résout les specs déclaratives → outils todo, câble l'émission `{ kind:"tool_event", tool:"todo", sessionId, todos }` ; `start` passe `localRuntime.extraTools` ; `TOOL_POLICIES` : `todo_write`/`todo_read` auto-approuvés.
  - **Traduction d'events** (`src/lib/agent/clineBridge.ts`) : `content_update` texte/reasoning → `token`/`reasoning` ; `chunk` (stderr → `notice`) ; `ended` anormal → `finish` ; routage `chunk`/`ended` ajouté.
  - **Client** (`src/lib/agent/clineClient.ts`) : `resumeSessionId`, `extraTools`, `send(prompt, mode?)`, `onToolEvent` ; `extractToolEvent` (validation stricte, statuts whitelistés) ; `updateModel` best-effort sur reprise.
  - **Harness** (`src/lib/agent/clineHarness.ts`) : `resumeSessionId`, `extraTools`, `onToolEvent` propagés.
  - **AiPanel** (`src/components/ai/AiPanel.tsx`) : **moteur Cline unifié** pour TOUS les modes via un helper `runCline` factorisé. `plan` → `mode:"plan"` (lecture seule), phase 2 (après approbation) rejoue sur la **même session** en `send(..., "act")` ; `ask` → `mode:"plan"` (lecture seule) ; IDE/IA → `mode:"act"`. Continuité via colonne DB `cline_session_id` (`getClineSessionId`/`setClineSessionId`). Todos branchés sur `todoStore` (`setTodos` via `onToolEvent`). Code mort supprimé : cascade de modèles + `makeFullTools` + consts `TOOL_TIMEOUT_MS`/`TTFT_BUDGET_MS` (désormais gérés par le SDK).

- **Décisions Techniques :**
  - **Un seul moteur pour tous les modes** : la boucle agent est le SDK Cline ; le front ne fait plus que router events/approbations/checkpoints. Supprime la divergence plan/ask et le coût de reconstruction d'historique.
  - **Mode SDK = périmètre d'action** : `plan`/`ask` mappés sur `plan` (lecture seule) ; l'écriture est impossible par design, en plus du verdict `decideApproval` (défense en profondeur).
  - **Continuité par session persistée** : on stocke l'id SDK en DB et on le repasse en `resumeSessionId` ; les outils custom ne sont injectés qu'à la CRÉATION (sur reprise, le SDK les possède déjà).
  - **Specs d'outils déclaratives** (jamais de code exécutable venant du front) : le front n'envoie que `{ kind:"todo", sessionId }`.

- **Impacts & Dépendances :**
  - Fichiers : `todoTool.ts` (créé), `cline-sidecar/src/index.ts`, `clineBridge.ts`, `clineClient.ts`, `clineHarness.ts`, `AiPanel.tsx`, `db.ts` (colonne `cline_session_id`, tours antérieurs).
  - Effet : `runAgent`/`createTools` ne sont plus utilisés par AiPanel (l'ancien harness reste présent pour d'autres usages éventuels).

- **Validation :**
  - `npm run typecheck` → EXIT 0 ; `npm run build:sidecar` → OK (11.6mb) ; `npm test` → 478/478 ; `npm run lint` → 0 erreur sur les fichiers touchés (1 erreur préexistante `scripts/ttft-probe.ts`).

- **Prochaines étapes :**
  - Test bout-en-bout UI : enchaîner plusieurs tours et vérifier la continuité (même `cline_session_id`), l'apparition live de la todo list, la phase 2 du plan.

---

### [2026-10-16T07:45] | Undo/Keep par message + instrumentation de latence complète

- **Contexte :**
  Deux demandes : (1) « le système de keep all / undo all n'est pas encore à proprie comme sur Trae » ; (2) « pas assez de log pour voir où améliorer → ajoute tous les logs avec les latences dans le terminal ». Diagnostic des 4 problèmes Undo/Keep : bannière muette, Undo all ne restaure pas, pas de bouton par message, Keep all ne marque rien visuellement.

- **Analyse (cause racine) :**
  - **Bannière muette** : la détection d'écriture côté front était **codée en dur** sur `write_file|edit|multi_edit` (AiPanel L1038/L1088) alors que le SDK Cline émet **`editor` / `apply_patch`**. Aucune écriture n'était reconnue → `touchTurn`/`refreshReview` jamais déclenchés → ni bannière live, ni checkpoint UI.
  - **Boutons par message absents** : aucun chemin UI ne reliait un message utilisateur à ses tours ; et `turnIdsByUserIndexRef` est une **ref** (mutation sans re-render), donc un affichage dérivé de la ref serait resté invisible.
  - **Keep sans marqueur** : le seul retour était un toast éphémère.

- **Modifications effectuées :**
  - `src/lib/agent/clineBridge.ts` : **source unique** `WRITE_TOOL_NAMES` (`editor`, `apply_patch`, `write_to_file`, `write_file`, `edit`, `multi_edit`) + `isWriteTool(name)`.
  - `src/components/ai/AiPanel.tsx` : détection d'écriture unifiée via `isWriteTool()` (flux live + refresh) ; nouvel état `keptReviews` (marqueurs persistants) et **`revertableIndexes`** (state réactif, alimenté dans `beginTurn`, purgé dans `truncateFrom`/`handleConfirmRevert`/`handleKeepAll`/`handleKeepMessage`/`handleMessageAction`) ; handlers `handleKeepMessage`, `handleUndoMessage`, `messageReviewState`.
  - `src/lib/turnCheckpoint.ts` : `keepTurnCheckpoint(turnId)` (fige le résumé puis purge).
  - `src/components/ai/MessageBubble.tsx` + `MessageActionsBar.tsx` : `UserMessageActions` gagne `onUndo`/`onKeep` (icône `CheckCheck`) ; au survol, soit les boutons Undo/Keep, soit l'indicateur persistant « N kept ».
  - **Logs de latence** (4 niveaux demandés) :
    - `clineClient.ts` : `start`, contrôle bloquant, **1er événement `@+Nms` (TTFT canal)**, **un log debug par événement traduit (type + `@+Nms` + gap)**, sidecar prêt, session établie, ack `send`, bilan `dispose` (lignes/agent/contrôles/1re ligne/1er evt/silence max).
    - `checkpoint.rs` : durées sur `begin`/`touch_file`/`undo`/`discard`/`summary`/`revert_preview`/`undo_many`.
    - `sidecar.rs` : round-trip Rust↔Node par commande (`cmd=… id=… ok=… en Nms`).
    - `log.rs` : helper `log_line(level, target, message)` pour instrumenter le Rust interne.

- **Décisions Techniques :**
  - **Une seule liste d'outils d'écriture** (clinBridge) consommée partout : plus de divergence front/sidecar.
  - **Réactivité par state, pas par ref** : `revertableIndexes` en `useState` car une `Map` en `useRef` ne re-render pas — sinon le marqueur « kept » durait exactement le temps d'un toast (le bug signalé).
  - **Logs best-effort et bornés** : buffer+flush 150 ms côté front, redaction de secrets et rotation 5 Mio côté Rust. Rien de bloquant.
  - Le faux positif LSP `Cannot find module './RevertConfirmDialog'` est **confirmé inexistant** (`npx tsc --noEmit` → EXIT 0) : le fichier existe bien, créé par une task parallèle.

- **Impacts & Dépendances :**
  - Fichiers : `clineBridge.ts`, `AiPanel.tsx`, `turnCheckpoint.ts`, `MessageBubble.tsx`, `MessageActionsBar.tsx`, `clineClient.ts`, `checkpoint.rs`, `sidecar.rs`, `log.rs`.
  - Effet de bord : l'action « copier » sur un message vaut désormais « Keep all » du tour courant (le tour n'est plus revertable) — comportement voulu, aligné sur Trae.

- **Validation :**
  - `npx tsc --noEmit` → EXIT 0.
  - `npx eslint` (fichiers touchés) → 0 erreur (warnings fast-refresh/refs préexistants).
  - `npx vitest run` → **478/478**.
  - `cargo test` → **114/114** (1 ignoré réseau).

- **Prochaines étapes :**
  - Vérification UI manuelle (relancer `tauri dev`) : bannière live, Undo ciblé, marqueur « kept ».

---

- **Contexte :**
  Dans l'Explorer, sélectionner des fichiers puis supprimer (touche Suppr/Backspace ou menu contextuel) **supprimait réellement les fichiers avant/indépendamment** de l'acceptation de la boîte de confirmation.

- **Analyse (cause racine) :**
  `FileTree.requestDelete` utilisait `window.confirm(...)` avec un test **synchrone** : `if (!window.confirm(...)) return;`. Or **sous Tauri, `window.confirm` est asynchrone** — il renvoie une `Promise<boolean>`, pas un booléen. En JS, une `Promise` est **toujours truthy** → `!Promise` vaut toujours `false` → **la garde était court-circuitée à chaque appel**. La suppression s'exécutait donc immédiatement, la boîte native s'affichant en parallèle sans jamais conditionner l'action. Bug **invisible en dev navigateur** (où `confirm` est synchrone) mais systématique dans l'app Tauri.

- **Modifications effectuées (`src/components/FileTree.tsx`) :**
  - `requestDelete(paths)` : ne supprime plus rien — il se contente d'**ouvrir la modale** (`setPendingDelete(paths)`).
  - Nouveau `performDelete(paths)` : contient la logique destructive (appel `deleteEntries`, gestion d'erreurs, `pruneSelection`, `refresh`) et n'est appelé **qu'après acceptation explicite**.
  - Nouveau composant interne `DeleteConfirmDialog` : modale React in-app (fond cliquable = annuler, Échap = annuler, bouton « Delete » = confirme), bouton désactivé pendant l'opération. **Remplace entièrement `window.confirm`.**
  - État `pendingDelete: string[] | null` portant les chemins à confirmer.

- **Décisions Techniques :**
  - **Zéro dépendance à `window.confirm`** : son comportement diffère entre navigateur (sync) et Tauri (async/Promise) — non portable par construction. Une modale React est **déterministe et cross-platform**.
  - **Séparer « demander » et « exécuter »** : `requestDelete` (intention) vs `performDelete` (effet). Rend impossible l'exécution sans confirmation, quel que soit l'appelant (raccourci clavier, menu contextuel).
  - **Cohérence visuelle** avec `RevertConfirmDialog` (mêmes tokens, même ergonomie).

- **Impacts & Dépendances :**
  - Fichier touché : `src/components/FileTree.tsx` uniquement. Aucune signature publique modifiée.
  - **Dette identifiée (hors périmètre)** : `SourceTreePanel.tsx:288` (drop de stash) et `SettingsPanel.tsx:1144` (suppression de serveur MCP) utilisent le **même** `window.confirm` asynchrone → **même bug latent**. À migrer vers le même pattern de modale.

- **Validation :** `tsc` OK · `eslint` 0 erreur / 8 warnings · `vitest` **478/478** · `vite build` OK.

- **Prochaines étapes :**
  - Test manuel : sélectionner un/plusieurs fichiers → Suppr → **rien** ne doit être supprimé tant que « Delete » n'est pas cliqué ; « Cancel » / Échap / clic sur le fond → aucun changement.
  - Planifier la migration des deux autres `window.confirm` (stash, MCP) vers une modale commune.

### [2026-10-16T07:20] | FIX — Mode IA : le root ne déléguait JAMAIS (0 `team_progress`) — le prompt ignorait les outils `team_*`

- **Contexte :**
  Signalement utilisateur : « les sous-agents ne marchent pas, ils ne se coordonnent pas, il n'y a rien pour le suivi en mode IA ». Le pont UI (Lot 6) traduisait déjà `team_progress`/`teamAgentId`, mais **aucun** événement d'équipe n'arrivait.

- **Diagnostic (reproduction réelle au terminal) :**
  Banc reproduisant le protocole Rust→sidecar avec un **vrai appel réseau** (`deepseek-v4-flash-0731`) en mode teams. Résultat : 8 itérations, uniquement `read_files` + `run_commands`, **0 outil `team_*`, 0 `spawn_agent`, 0 `team_progress`** — même en ordonnant explicitement au modèle de déléguer.
  **Cause racine** : `DELEGATION_GUIDANCE` (dans `prompts.ts`) portait le titre *« only when you have the `spawn_agent` tool »* et ne mentionnait **jamais** les outils `team_*`. Or en mode IA Origin **désactive `spawn_agent`** (`enableSpawnAgent: !enableTeams` = false) et expose les outils `team_*`. La consigne était donc **inerté** (elle se référençait à un outil absent) et rien n'apprenait au modèle l'existence de ses coéquipiers. Second facteur : le bloc n'était inclus **que si `isMax`** (effort max), or l'effort par défaut est `normal` → bloc absent.

- **Modifications effectuées :**
  - **`src/lib/agent/prompts.ts`** :
    - nouveau bloc `DELEGATION_GUIDANCE_TEAMS` : motive la délégation **en nommant explicitement** `team_spawn_teammate`, `team_task`/`team_run_task`, `team_status`/`team_await_runs`, `team_shutdown_teammate` (les outils RÉELLEMENT exposés).
    - `buildSystemPrompt(mode, isMax, workspaceNote, withTeams)` : 4ᵉ paramètre ; quand `withTeams` est vrai, on injecte **toujours** `DELEGATION_GUIDANCE_TEAMS` (indépendamment de l'effort). Sinon comportement inchangé (variante `spawn_agent` à l'effort max uniquement).
    - `DELEGATION_GUIDANCE` (variante `spawn_agent`) conservée pour le cas non-teams.
  - **`src/components/ai/AiPanel.tsx`** : le prompt agent est construit avec `withTeams: isAgent` (mode IA uniquement ; IDE = 1 agent seul, pas de consigne de sous-agents).
  - **`src/lib/agent/__tests__/prompts.test.ts`** : test d'invariant — `withTeams` annonce `DELEGATION_GUIDANCE_TEAMS` à effort normal **et** max, et n'inclut pas la variante `spawn_agent`.

- **Décisions Techniques :**
  - **Parler du mécanisme réellement exposé**, pas d'un outil désactivé : une consigne conditionnée à un outil absent est silencieusement ignorée par le modèle.
  - **Délégation toujours annoncée en IA** : l'orchestration est la raison d'être du mode IA (gros dépôts) ; la lier à l'effort max la rendait inactive par défaut.
  - **Fix 100 % front** (prompt) : aucune modification du sidecar ni rebuild de bundle requis — le prompt est injecté par le front via `systemPrompt`.

- **Impacts & Dépendances :**
  - Fichiers : `src/lib/agent/prompts.ts`, `src/components/ai/AiPanel.tsx`, `src/lib/agent/__tests__/prompts.test.ts`.
  - Le mode IDE (sidebar) reste inchangé (aucun sous-agent, économie de tokens préservée).

- **Validation :** banc rejoué avec le prompt IA réel → **`team_spawn_teammate` ×8, `team_run_task` ×8, `team_await_runs` ×1, `team_progress` ×97, `teamAgentId` uniques `proto-rev`/`struct-rev`, `teamRole:"teammate"` ×137** (avant : tous à 0) · `vitest` **478/478** · `tsc` 0 erreur · `eslint` 0 problème sur les fichiers touchés.

- **Prochaines étapes :** observer en UI (mode IA) le rendu des cartes de coéquipiers alimentées par `team_progress`.

### [2026-10-16T07:05] | FIX — « le sidecar n'a pas renvoyé de sessionId » : `cline_sidecar_send` fire-and-forget → request/response corrélé

- **Contexte :**
  Après le fix bundle, l'UI loggait `le sidecar n'a pas renvoyé de sessionId` puis `Le moteur d'agent n'a pas démarré (sidecar indisponible)`.

- **Analyse (cause racine) :**
  `startClineRun` (front) attendait `{ sessionId }` de `cline_sidecar_send`. Or la commande Rust était **fire-and-forget** : elle renvoyait l'`id` (`u64`) de la commande sans attendre la réponse du sidecar. Le `sessionId`, émis plus tard par le sidecar (`{id, ok, result:{sessionId}}`), était simplement relayé comme un event lambda, jamais corrélé → le front recevait `undefined`.

- **Modifications effectuées :**
  - **`src-tauri/src/sidecar.rs`** :
    - `SidecarState.pending` : table `id → oneshot::Sender<Value>` pour corréler les réponses de commande.
    - `route_command_reply` : route les lignes `{id numérique, ok bool}` vers le `oneshot` correspondant ; les events de flux (`kind:"event"`), demandes d'approbation et lignes non-JSON ne sont **pas** consommés.
    - `cline_sidecar_send` : enregistre le résolveur **avant** d'écrire (anti-course), puis `await` la réponse sous `COMMAND_REPLY_TIMEOUT` (30 s) ; renvoie `result` (dont `sessionId`) ou une erreur structurée.
    - `cline_sidecar_stop` : vide `pending` pour débloquer les attentes.
    - `#[cfg(test)]` : 5 tests de routage (`#[tokio::test]`).
  - **`src-tauri/Cargo.toml`** : `[dev-dependencies] tokio = { features = ["macros"] }` pour les tests async.

- **Décisions Techniques :**
  - **Request/response corrélé** plutôt que fire-and-forget : le contrat front (`{sessionId}`) l'exige, et c'est le seul moyen de distinguer une réponse de commande d'un event sur le même canal stdout.
  - **Timeout borné** (30 s) + `oneshot` : pas de blocage définitif si le sidecar meurt.

- **Impacts & Dépendances :**
  - Fichiers : `src-tauri/src/sidecar.rs`, `src-tauri/Cargo.toml`.

- **Validation :** banc en isolation (dossier sans `node_modules`) → `ping`→`pong`, puis `start` → `{id:"c2", ok:true, result:{sessionId:"…"}}` en **673 ms** ✅ ; run complet avec vrai réseau : `send` → TTFT 796 ms, `done` reason=completed, exit 0 ✅ · `cargo test` **114/114** (5 nouveaux) · `vitest` **477/477**.

- **Prochaines étapes :** relancer `tauri dev` pour recopier la ressource après build.

### [2026-10-16T06:55] | FIX — `SIDECAR_EXITED_EARLY` : bundle non autonome (imports `--external`) + erreurs de démarrage désormais explicites

- **Contexte :**
  Au lancement de l'agent, l'UI loggait `{"code":"SIDECAR_EXITED_EARLY","message":"le sidecar s'est arrêté avant d'être prêt"}` — sans cause visible.

- **Analyse (cause racine) :**
  Le bundle `dist/index.mjs` était construit avec `--external:simple-git --external:jiti`. Or `tauri.conf.json` copie ce bundle **seul** comme ressource Tauri (en dev dans `target/<profile>/cline-sidecar/dist/`, en release dans `Resources/`). Node résout les imports **relativement au fichier** : depuis `src-tauri/cline-sidecar/dist/` il trouvait `node_modules/simple-git` (d'où un démarrage OK en CLI), mais depuis la copie **isolée** de `target/debug/…` il levait `ERR_MODULE_NOT_FOUND` → crash au chargement → `SIDECAR_EXITED_EARLY`.
  Compliqué par le fait que `resolve_sidecar_script` privilégie `resource_dir/…` (le bundle copié, cassé) avant le bundle de dev (sain). Second facteur aggravant : l'erreur ne portait **pas** la stderr du sidecar → diagnostic muet.

- **Modifications effectuées :**
  - **`src-tauri/cline-sidecar/package.json`** : suppression des flags `--external:simple-git --external:jiti` → le bundle embarque **tout** (`simple-git`, `jiti`). Taille 9.9 → 11.6 Mo.
  - **`scripts/build-sidecar.mjs`** : **garde-fou d'autonomie**. Après build, on vérifie qu'aucune **dépendance déclarée** (`pkg.dependencies`) n'apparaît en import externe nu (`from "x"` / `require("x")`). Échec = code non nul. Cible uniquement les dépendances directes (pas les `require()` conditionnels optionnels type `@aws-sdk/…`, qui ne cassent rien s'ils sont absents).
  - **`src-tauri/src/sidecar.rs`** :
    - stderr est désormais lu **dès le spawn** (avant le handshake), alimentant à la fois le log central et un **tampon borné** (`STDERR_TAIL_LINES = 50`).
    - sur échec de handshake (`SIDECAR_EXITED_EARLY`/`SIDECAR_READY_TIMEOUT`), la queue stderr est **jointe à l'erreur JSON** (champ `stderr`, lignes nettoyées + plafonnées) → l'échec devient auto-explicatif dans l'UI.

- **Décisions Techniques :**
  - **Bundle strictement autonome** plutôt que « copier aussi `node_modules` » : la ressource Tauri est un fichier unique ; garder des externes obligerait à embarquer et résoudre une arborescence `node_modules` — fragile et contraire au choix « A2 bundle esbuild single-file ».
  - **Garde-fou ciblé sur les dépendances déclarées** : évite les faux positifs des imports conditionnels du SDK tout en verrouillant la régression réellement survenue.
  - **Diagnostic d'échec dans l'erreur** : on ne dépend plus de la lecture du terminal `tauri dev` pour comprendre un crash de sidecar.

- **Impacts & Dépendances :**
  - Fichiers : `cline-sidecar/package.json`, `scripts/build-sidecar.mjs`, `src-tauri/src/sidecar.rs`.
  - **Toute modification future de `package.json` (nouvelle dép) doit rebuild** (`npm run build:sidecar`) ; le garde-fou échoue explicitement sinon.

- **Validation :** reproduction en isolation (dossier sans `node_modules`) → bundle autonome : `{"kind":"ready"}` ✅ (avant : `ERR_MODULE_NOT_FOUND`) · garde-fou testé (attrape `--external:simple-git`, passe sur le bundle sain) · bundle recopié dans `target/debug/cline-sidecar/dist/` et démarré ✅ · `cargo test` **109/109** · `vitest` **477/477**.

- **Prochaines étapes :**
  - **Relancer `tauri dev`** (pour que la ressource soit recopiée) puis retester le lancement de l'agent.

### [2026-10-16T06:45] | Moteur d'agent : bascule complète sur le Cline SDK (`@cline/core`) — sidecar Node supervisé par Rust, IDE + IA unifiés

- **Contexte :**
  Le harness d'agent TS maison plafonnait : TTFT irrégulier, orchestration de sous-agents inobservable en mode IA (« les sous-agents ne se coordonnent pas, rien pour le suivi »), et chaque nouveau comportement (compaction, reprise, outils) demandait de réimplémenter ce que le Cline SDK fournit déjà. Décision utilisateur : **basculer sur `@cline/core` 0.0.93** (et écarter `1jehuang/jcode-sdk` après comparaison), **sans embarquer Node** (réutiliser le Node du PC, sinon installer la version voulue), en portant **IDE + IA d'un coup**.

- **Modifications effectuées (Lots 1 → 7) :**
  - **Lot 1 — Runtime Node :** `src-tauri/src/node_runtime.rs` résout un Node ≥ 22 (PATH enrichi, gestionnaires nvm/`n`/fnm/volta/asdf) et déclenche une **installation silencieuse** si absent. `env_path.rs` construit un PATH enrichi via shell de login (script littéral figé, timeout, cache `OnceLock`).
  - **Lot 2/3 — Sidecar :** `src-tauri/cline-sidecar/` = bundle **esbuild single-file** (`dist/index.mjs`), hébergé par un **process Node lancé par Rust**, protocole **NDJSON sur stdio**. `sidecar.rs` (Rust) : spawn, handshake `ready` sous deadline, lecture stdout → webview (`cline://event`), stderr → journal, arrêt propre puis `kill`.
  - **Lot 4a/4c — Pont front :** `src/lib/agent/clineBridge.ts` traduit chaque `CoreSessionEvent` (`chunk`/`agent_event`/`team_progress`/`done`…) en `AgentEvent` d'UI. `clineClient.ts` gère le cycle de vie + le **canal d'approbation bloquant** (`tool_approval`/`tool_write`) ; `clineApproval.ts` route les décisions ; `onBeforeWrite` alimente le checkpoint (undo/keep).
  - **Lot 5 — Prompts/TTFT :** module central de prompts unifié IDE/IA, cascade de modèles avec bascule auto sur rate-limit.
  - **Lot 6 — Mode IA / équipes :** `index.ts` force **un seul chemin de sous-agents** — `enableSpawnAgent: !enableTeams` + `enableAgentTeams: enableTeams`. Raison (découverte empirique) : `spawn_agent` crée un sous-agent **détaché** qui n'émet **aucun** `TeamEvent` (donc invisible pour l'UI) ; seuls les outils `team_*` créent des coéquipiers **rattachés** qui émettent `team_progress` → seuls eux alimentent le suivi. `clineBridge.ts` traduit `team_progress` → `subagent-start/step/end` (clé `spawnId = lifecycle.agentId`) et route `teamAgentId`/`teamRole` ; le `done` d'un **coéquipier** est piégé pour **ne pas** clore le run global. `AiPanel.tsx` rattache les cartes de coéquipiers au dernier tool-call `team_*` (fallback) et enrichit la tâche au `run_started`.
  - **Lot 7 — Durcissement (`sidecar.rs`) :** `env_clear()` + **réinjection minimale** (`PATH`, `HOME`, `CLINE_DIR`, `CLINE_DATA_DIR`) → le sidecar ne voit plus les jetons/proxys/clés cloud du process parent ; la clé API du provider passe **par commande NDJSON**, jamais par l'env. Ajout d'un plafond `MAX_EVENT_LINE_BYTES` (4 Mio) sur les lignes stdout relayées (au-delà : événement d'erreur borné `SIDECAR_EVENT_TOO_LARGE`) → fermeture d'un vecteur DoS par ligne géante.

- **Décisions Techniques :**
  - **Sidecar plutôt que portage Rust** : le SDK est un paquet Node ; le réhéberger serait une réécriture sans fin et fragile. Un process supervisé garde un **moteur unique** pour les deux modes.
  - **NDJSON stdio, aucun port réseau** : inaccessible depuis l'extérieur, le webview ne parle jamais directement au sidecar.
  - **Traduction des événements dans le front** (Rust relaie brut) : la logique Cline reste typée/testable en TS, Rust reste un simple transport.
  - **Un seul chemin de sous-agents** (teams en IA, spawn en IDE) : déterministe et observable.
  - **Approbations bloquantes sur canal dédié** : les outils sensibles (`editor`/`apply_patch`/`run_commands`/`skills`) ne sont **pas** auto-approuvés ; les outils `team_*` (contrôle, pas écriture) le sont à dessein.

- **Impacts & Dépendances :**
  - Fichiers clés : `src-tauri/src/{node_runtime,env_path,sidecar,lib}.rs`, `src-tauri/cline-sidecar/{src/index.ts,dist/index.mjs}`, `src/lib/agent/{clineBridge,clineClient,clineApproval,clineHarness,run}.ts`, `src/components/ai/{AiPanel,AgentPanel}.tsx`.
  - **Build requis** : `npm run build:sidecar` (esbuild) avant `tauri dev`/`tauri build` — le bundle `dist/index.mjs` est la ressource embarquée.
  - **Dépendance runtime** : un Node ≥ 22 doit être présent (ou installable sans intervention).

- **Validation :** `cargo check --tests` OK · `tsc` OK (0 erreur) · `eslint` 0 erreur / 8 warnings préexistants · `vitest` **477/477** (dont 21 dans `clineBridge.test.ts`).
  - **Banc empirique Lot 6 (run réel)** : `team_spawn_teammate ×1`, `team_run_task ×1`, `team_await_runs ×1` → `team_progress` **13 samples** / **41 `agent_event`** coéquipier, `lifecycle.agentId="explorer"`, eventTypes `[teammate_spawned:1, run_queued:1, run_started:1, task_start:1, agent_event:41, run_progress:8, team_mission_log:1]`, identités `teamRole=lead` (root) vs `teamAgentId=explorer teamRole=teammate` (coéquipier), `done` coéquipier = signal de fin. `TTFT 17 149 ms` (orchestration multi-agents).

- **Prochaines étapes :**
  - Test manuel UI : mode IA → vérifier le suivi (onglet Agents + cartes enfants), l'undo/keep par tour, et les approbations d'outils sensibles.
  - Surveiller le TTFT en mode IDE (mono-agent) vs IA (orchestration).

### [2026-10-16T02:15] | Ctrl+A macOS — menu natif « Select All » retiré (cause racine du bypass persistant) + gestion cross-OS

- **Contexte :**
  Malgré le scoping DOM, le bypass persistait : **sélection souris puis Cmd+A** sélectionnait encore toute l'UI. Utilisateur sur **MacBook** — demande explicite : gérer macOS, Windows ET Linux.

- **Analyse (cause racine, spécifique macOS) :**
  Sur macOS, Tauri ajoute **automatiquement un menu applicatif par défaut** (équivalent à `Menu.default()`). Ce menu contient **Edit ▸ Select All** lié à **Cmd+A**. Ce raccourci déclenche une action **native au niveau OS**, **avant** la webview : le `keydown` n'arrive jamais au DOM, donc **aucun `preventDefault()` JS ne peut l'empêcher**. C'est la raison pour laquelle toutes les corrections côté front étaient sans effet sur Mac. (Windows/Linux : pas de menu par défaut équivalent, le DOM voyait bien Ctrl+A — d'où une gestion par OS indispensable.)

- **Modifications effectuées :**
  - **`src-tauri/src/lib.rs`** :
    - Nouvelle fonction `build_app_menu(app)` + branchement via `.setup(|app| { build_app_menu(app)?; Ok(()) })`.
    - **Menu explicite par OS**, construit avec `MenuBuilder`/`SubmenuBuilder`, **délibérément SANS l'item natif `SelectAll`** → le raccourci retombe dans la webview et repasse sous notre logique DOM.
      - **macOS** : sous-menu applicatif (À propos / Quitter) + **Edit** (Cut/Copy/Paste) + **Window** (Minimize/Maximize/Close).
      - **Windows/Linux** : **File** (Quit) + **Edit** (Cut/Copy/Paste).
    - `Undo/Redo` natifs non inclus (non supportés par le menu natif sur Windows/Linux) : ils restent gérés par CodeMirror / le DOM.

- **Décisions Techniques :**
  - **Retirer l'item natif plutôt que tenter de le neutraliser** : sur macOS il n'existe aucun moyen JS de bloquer une action de menu native. La seule solution fiable est de **ne pas l'avoir**.
  - **Menu par OS via `#[cfg(target_os = "macos")]`** : macOS exige un premier sous-menu « app », Windows/Linux non — un menu unique ne convient pas aux deux.
  - **Conserver Cut/Copy/Paste** : utiles et sûrs ; ils agissent sur le focus, sans effet de bord global.
  - Côté DOM (tours précédents) : `matchesEvent` traite déjà `(ctrlKey || metaKey)` → le même code couvre Cmd (mac) et Ctrl (Win/Linux).

- **Impacts & Dépendances :**
  - Fichiers touchés : `src-tauri/src/lib.rs` (nouveau menu). Front inchangé depuis le tour précédent.
  - **Redémarrage de l'app requis** (`tauri dev`) : le menu est construit au démarrage côté Rust — un simple reload de la webview ne suffit pas.

- **Validation :** `cargo check` OK (Rust, exist 0) · `tsc` OK · `eslint` 0 erreur / 8 warnings · `vitest` **456/456** · `vite build` OK.

- **Prochaines étapes :**
  - **Redémarrer `tauri dev`** puis tester sur macOS : (a) sélection souris dans le chat puis Cmd+A → seule la zone chat est sélectionnée, jamais les noms de fichiers ; (b) Cmd+A hors éditeur/champ → rien de l'UI ; (c) Cmd+A dans un input natif → texte du champ ; (d) Cmd+A dans l'éditeur → fichier.
  - Vérifier sur Windows/Linux que Ctrl+A suit le même comportement (menu File/Edit sans SelectAll).

### [2026-10-16T01:45] | Ctrl+A — suite : le `contenteditable` laissait filer le Ctrl+A natif (bypass « souris puis Ctrl+A »)

- **Contexte :**
  Malgré le scoping précédent, un bypass subsistait : **sélection à la souris puis Ctrl+A** sélectionnait encore toute l'UI (noms de fichiers inclus). La sélection souris elle-même doit rester possible — ce n'est pas elle qu'il faut bloquer, c'est le Ctrl+A.

- **Analyse (cause racine) :**
  Le scoping v1 classait tout `contenteditable` comme « champ de saisie texte » et **laissait donc filer le Ctrl+A natif** (`if (!isTextInputFocused()) e.preventDefault();` → pas de `preventDefault`). Or dans le composer du chat (`contenteditable`), le Ctrl+A natif d'un moteur comme Chromium/WebKit **déborde sur le document** et sélectionne tout (chrome de l'IDE). Après une sélection souris, le focus retombe souvent sur ce `contenteditable` (ou `body`) → le natif reprenait la main.

- **Modifications effectuées :**
  - **`src/lib/commands/editorBridge.ts`** :
    - `isTextInputFocused` **remplacé** par `isNativeTextInputFocused` — ne couvre plus que `<input>`/`<textarea>` **natifs** (Ctrl+A natif fiable et scopé). Les `contenteditable` sont **exclus**.
    - Ajout `isContentEditableFocused()` (contenteditable hors `.cm-editor`) et `selectContentEditable(el)` (sélection **scopée** au contenu de la zone via `Range.selectNodeContents`).
  - **`src/hooks/useGlobalKeybindings.ts`** : hors éditeur, pour une commande `EDITOR_SCOPED_COMMANDS`, on distingue désormais trois cas — (1) input natif → on laisse filer le natif ; (2) `contenteditable` → `preventDefault` **et** sélection « tout » gérée par nous, **confinée au composer** ; (3) tout le reste (focus `body` après sélection souris, arbre, chrome) → `preventDefault` pur, rien de l'UI n'est sélectionné.

- **Décisions Techniques :**
  - **Ne jamais dépendre du Ctrl+A natif hors input natif** : son périmètre varie selon le moteur et n'est pas garantissable. Pour les `contenteditable`, on **impose** la sélection nous-mêmes → résultat déterministe et strictement confiné.
  - **Séparer « input natif » et « contenteditable »** : deux comportements distincts, deux helpers distincts — plus de classification fourre-tout.
  - **La sélection souris reste intacte** : on n'intercepte que le clavier (keystroke), jamais le `mousedown`/drag.

- **Impacts & Dépendances :**
  - Fichiers touchés : `editorBridge.ts`, `useGlobalKeybindings.ts`. `isTextInputFocused` (ancien nom) n'est plus exporté — vérifié : aucun autre appelant.
  - Comportement Ctrl+A **dans** l'éditeur et dans les `<input>`/`<textarea>` natifs : inchangé.

- **Validation :** `tsc` OK (exit 0) · `eslint` 0 erreur / **8 warnings préexistants** · `vitest` **456/456** · `vite build` OK.

- **Prochaines étapes :**
  - Test manuel : (a) sélection souris dans le chat puis Ctrl+A → seule la zone chat est sélectionnée (jamais les noms de fichiers) ; (b) sélection souris sur le chrome puis Ctrl+A → rien de l'UI ; (c) Ctrl+A dans un `<input>` (renommage, recherche) → texte du champ ; (d) Ctrl+A dans l'éditeur → fichier.

### [2026-10-16T01:10] | Ctrl+A : sélection limitée à l'éditeur (fin de la sélection de toute l'UI)

- **Contexte :**
  `Ctrl+A` / `Cmd+A` sélectionnait **tout le texte de l'application** — noms de fichiers, chat, chrome de l'IDE — au lieu de ne sélectionner que le contenu de l'éditeur.

- **Analyse (causes racines) :**
  1. **Listener global non scopé** — le handler `window` de `useGlobalKeybindings` intercepte `ctrl+a` → `origin.editorSelectAll` **quelle que soit la position du focus**. Quand le focus n'est pas dans l'éditeur, la commande visait une vue CodeMirror non focalisée tandis que le **Ctrl+A natif du navigateur** sélectionnait le document entier (l'app n'a aucun `user-select: none`).
  2. **Ctrl+A « tout sélectionner » dans l'arbre** — `FileTree.handleKeyDown` avait sa propre branche `Ctrl/Cmd+A` qui sélectionnait **toutes les lignes** de l'arbre : comportement contraire à l'attente (« Ctrl+A ne doit agir que dans l'éditeur »).

- **Modifications effectuées :**
  - **`src/lib/commands/editorBridge.ts`** : deux helpers de portée clavier — `isEditorFocused()` (focus dans un `.cm-editor`) et `isTextInputFocused()` (focus dans un input texte / textarea / `contenteditable`, y compris le composer du chat) ; inputs non textuels exclus.
  - **`src/hooks/useGlobalKeybindings.ts`** : ensemble `EDITOR_SCOPED_COMMANDS` (`origin.editorSelectAll`). Avant le dispatch, si une de ces commandes matche alors que **l'éditeur n'a pas le focus**, on **neutralise l'action native** (`preventDefault` → plus de sélection de toute l'UI) et on sort — **sauf** si le focus est dans un champ de saisie, auquel cas on laisse le Ctrl+A natif sélectionner le texte **de ce champ**.
  - **`src/components/FileTree.tsx`** : suppression de la branche `Ctrl/Cmd+A` (et de la dépendance `setSelected` devenue inutile). La sélection multiple reste accessible au clic (Maj / Ctrl-clic).

- **Décisions Techniques :**
  - **Portée par le focus réel du DOM** (`document.activeElement.closest('.cm-editor')`) plutôt que par le registre `activeView` : ce dernier est aussi renseigné à la création de la vue, pas uniquement au focus — il ne prouve pas que l'utilisateur écrit dans l'éditeur.
  - **Neutraliser sans exécuter** hors éditeur : on empêche le Ctrl+A natif global, mais on ne détourne pas le raccourci d'un champ de saisie (l'utilisateur doit pouvoir tout sélectionner dans un input).
  - **Ensemble de commandes** (plutôt qu'un `if` codé en dur) : extensible si d'autres raccourcis purement éditeur doivent être scopés de la même façon.

- **Impacts & Dépendances :**
  - Fichiers touchés : `editorBridge.ts`, `useGlobalKeybindings.ts`, `FileTree.tsx`. Aucun changement de contrat public.
  - Le comportement de Ctrl+A **dans** l'éditeur est inchangé (CodeMirror `selectAll`, pris en amont via `e.defaultPrevented`).

- **Validation :** `tsc` OK (exit 0) · `eslint` 0 erreur / **8 warnings préexistants** (retour à la baseline) · `vitest` **456/456** · `vite build` OK.

- **Prochaines étapes :**
  - Test manuel : (a) Ctrl+A dans l'éditeur → sélectionne le fichier ; (b) Ctrl+A sur l'arbre / le chat / hors champ → **rien** de l'UI n'est sélectionné ; (c) Ctrl+A dans un input (renommage, recherche, composer) → sélectionne le texte du champ.

### [2026-10-15T23:40] | Port Cline SDK — Lot 1 : résolveur du runtime Node (système → portable)

- **Contexte :**
  Bascule du harness d'agent maison vers le **Cline SDK** (`@cline/sdk` 0.0.93, JS pur). Le moteur tourne dans un **sidecar Node** lancé par Rust. Décision produit : **on n'embarque PAS Node** dans l'installeur — on utilise le Node **déjà présent** sur le PC, et seulement s'il est absent (ou < 22) on installe une version portable **silencieusement** dans l'app-data. Contrainte méthode : port **lot par lot**.

- **Modifications effectuées :**
  - **`src-tauri/src/node_runtime.rs`** (nouveau) :
    - `MIN_MAJOR = 22` (exigence Cline SDK) et version portable épinglée **v24.21.0**.
    - Empreintes SHA-256 **figées à la compilation** pour les 5 plateformes (darwin-arm64/x64, linux-arm64/x64, win-x64) — issues du `SHASUMS256.txt` officiel de nodejs.org.
    - `select_artifact(os, arch)` : sélection pure de l'artefact par plateforme (`None` si non supportée → message propre, jamais de panic).
    - `probe_node(path)` : exécute `node --version` **borné** (timeout 1500 ms) — un binaire doit **prouver** qu'il est un vrai Node avant d'être adopté.
    - `find_system_node()` : scanne le **PATH enrichi** (`env_path`, qui couvre déjà nvm/`n`/fnm/volta/asdf) et retient le premier Node ≥ 22.
    - `find_portable_node()` : réutilise un Node portable déjà extrait (pas de re-téléchargement aux démarrages suivants).
    - `install_portable_node(app)` : `downloader::fetch_verified` (checksum obligatoire) → `extract_tar_gz` (Unix) / `extract_zip` (Windows) → `make_executable` → re-probe. Émet `node://install-progress` (`download`/`extract`/`done`).
    - Commande Tauri `resolve_node_runtime` : ordre **système → portable existant → installation silencieuse**.
  - **`src-tauri/src/lib.rs`** : `mod node_runtime;` + enregistrement de `resolve_node_runtime` dans l'`invoke_handler`.
  - **`src-tauri/src/downloader.rs`** : retrait du `#[allow(dead_code)]` sur `extract_tar_gz` — il est désormais réellement utilisé par le runtime Node.

- **Décisions Techniques :**
  - **URL + hash figés en dur** (comme `lsp_index`) plutôt qu'un manifeste distant : supprime tout vecteur RCE/SSRF par manifeste compromis. Le webview ne fournit **jamais** d'URL.
  - **Sonde `--version` obligatoire** : on ne fait pas confiance à la simple présence d'un fichier `node` dans le PATH (un faux binaire ne peut pas être adopté silencieusement) ; la sonde est bornée pour éviter qu'un binaire exotique gèle le démarrage.
  - **Réutilisation de l'infra existante** (`downloader`, `env_path`) plutôt que duplication : la découverte Node de `env_path` existait déjà, `extract_tar_gz` avait été écrit en prévision de Node.
  - **Node système prioritaire** : coût réseau nul dans le cas nominal.

- **Impacts & Dépendances :**
  - Fichiers touchés : `node_runtime.rs` (nouveau), `lib.rs`, `downloader.rs`.
  - Nouvelle commande `resolve_node_runtime` + event `node://install-progress` : le frontend du sidecar (Lot 2) les consommera.
  - **Sécurité** : aucune URL fournie par le webview ; checksum obligatoire ; extraction confinée (anti zip-slip) ; exécution vérifiée par sonde.

- **Prochaines étapes :**
  - **Lot 2** : sidecar Node lancé par Rust (`start`/`stop`/stdin/signal + pont d'events Tauri, `CLINE_DIR` dans l'app-data, `backendMode: "local"`).
  - Lots suivants : moteur `ClineCore` (Lot 3), pont d'outils + approbations (Lot 4), mode IDE (Lot 5), mode IA/teams (Lot 6), durcissement (Lot 7), validation + mesure (Lot 8).

### [2026-10-15T23:10] | Keep all / Undo all : suppression du « bypass » et de l'instabilité en éditeur

- **Contexte :**
  Le système « Keep all / Undo all » était instable : après un « Undo all » on pouvait encore « bypasser » l'annulation depuis l'éditeur, et « Undo all » déclenché **pendant un run** ne faisait rien (action silencieusement ignorée).

- **Analyse (causes racines) :**
  1. **Bypass éditeur** — après `revertTurns`, l'éditeur continuait d'afficher (et `fileContents` de mémoriser) le contenu **d'avant** l'annulation. Toute réédition puis sauvegarde **réécrivait par-dessus** le contenu annulé.
  2. **Portée « Undo all » fragile** — la portée était **déduite** du « dernier index » connu (`turnIdsByUserIndexRef`), ce qui pouvait viser un **autre run** que celui affiché par la bannière.
  3. **Undo all pendant un run ignoré** — `handleRevertUserMessage` gardait `if (isStreaming) return;`. Or `handleUndoAll` **avorte d'abord** le run puis appelle cette fonction ; `isStreaming` (dérivé des messages) **n'est pas encore retombé** → l'annulation était abandonnée sans rien dire.
  4. **Undo all pendant un run défait aussitôt** — une écriture encore « en vol » recréait le fichier juste après la restauration.
  5. **Keep all pendant un run** — purgeait le checkpoint et masquait la bannière inconditionnellement, cassant la possibilité d'annuler les écritures suivantes.

- **Modifications effectuées :**
  - **`src/hooks/useTabs.ts`** : nouvelle fonction `applyExternalFileChanges(paths)` — resynchronise l'éditeur sur l'état réel du disque après une action externe (Undo all / revert). Pour chaque chemin : relecture disque si ouvert/chargé ; fichier supprimé ou illisible → fermeture de l'onglet + purge de `fileContents`/`fileErrors` ; on **n'écrase jamais** un onglet `isDirty` ; termine par `setFileTreeVersion(v => v + 1)`.
  - **`src/App.tsx`** : destructure `applyExternalFileChanges` et le passe en `onExternalFileChanges` au `AiPanel` (mode IDE).
  - **`src/components/ai/AgentModeView.tsx`** : prop `onExternalFileChanges` ajoutée à l'interface et retransmise à `AiPanel`.
  - **`src/components/ai/AiPanel.tsx`** :
    - `reviewBanner` porte désormais `{ turnId, userIndex, files }` ; nouveau ref `activeTurnUserIndexRef` — la **portée** d'un Undo all est consignée dans la bannière, plus aucune déduction.
    - `refreshReview` lit `activeTurnUserIndexRef` ; nouveau `refreshReviewNow` (rafraîchit sans annuler le timer de fond).
    - `handleRevertUserMessage(userIndex, force = false)` : `force` court-circuite la garde `isStreaming` **stale** après abort ; garde `streamCleanupRef.current` conservée comme « digue » (on ne rejoue jamais un revert tant qu'un run tourne).
    - `handleUndoAll` : abort propre du run (`runSeqRef++`, `streamCleanupRef()`, retombée du flag `streaming`, `setPendingQuestion(null)`) **puis** `handleRevertUserMessage(userIndex, true)`.
    - `handleConfirmRevert` : après `revertTurns`, `void externalFileChangesRef.current?.(applied.map(p => p.path))` → l'éditeur est resynchronisé (fin du bypass).
    - `handleKeepAll` : si run en cours → masque la bannière **sans purger** le checkpoint et `refreshReviewNow` (retour visuel immédiat) ; sinon purge + toast « Changes kept ».

- **Décisions Techniques :**
  - **La portée dans la bannière** (plutôt qu'une déduction sur le dernier index) : une bannière est un **fait** (ce run-là), pas une heuristique.
  - **`force` explicite** plutôt qu'un `setTimeout` d'attente de retombée de `isStreaming` : déterministe, sans course, et l'annulation est appliquée **dans le même tick** que l'abort.
  - **Resynchronisation disque → éditeur** (et non l'inverse) : la source de vérité après un revert est le **disque** ; l'éditeur ne doit jamais pouvoir réécrire un contenu annulé. Un onglet non sauvegardé n'est pas écrasé (pas de perte silencieuse).
  - **Purge conditionnelle du checkpoint** dans Keep all : conserver la possibilité d'annuler les écritures **à venir** du même tour.

- **Impacts & Dépendances :**
  - Fichiers touchés : `useTabs.ts`, `App.tsx`, `AgentModeView.tsx`, `AiPanel.tsx`. Contrats d'events inchangés.
  - `applyExternalFileChanges` est **réutilisable** : tout flux externe modifiant le disque (restauration, outil hors éditeur) peut le consommer via `onExternalFileChanges`.

- **Validation :** `tsc` OK (exit 0) · `eslint` 0 erreur / 8 warnings préexistants · `vitest` **456/456** · `vite build` OK.

- **Prochaines étapes :**
  - Test manuel ciblé : (a) Undo all **pendant** un run → le run s'arrête, les fichiers sont restaurés/supprimés, l'éditeur se resynchronise, une sauvegarde ensuite n'écrase **jamais** le contenu annulé ; (b) Keep all **pendant** un run → la bannière réapparaît dès l'écriture suivante et reste annulable ; (c) Undo all **hors** run → confirmation + resynchronisation.

### [2026-10-15T22:55] | Approbation « Run command » : boutons manquants + carte en double

- **Contexte :**
  Deux défauts bloquants sur l'approbation d'un `bash_run` :
  1. **Aucun bouton autoriser / refuser** — le run restait bloqué indéfiniment, l'utilisateur n'avait aucun moyen de décider.
  2. **La commande s'affichait deux fois** — une carte d'approbation en haut + une seconde carte « running » en bas.

- **Analyse (causes racines) :**
  1. `ToolCallCard`, dans la branche `approval-required`, ne rendait que le texte « Review in the diff tab → ». C'est correct pour `write_file` / `edit` (l'approbation se fait dans l'onglet diff), mais **`bash_run` n'a PAS d'onglet diff** → aucune action possible.
  2. Le doublon venait de l'ordre **non déterministe** des events `tool-call` et `approval-required` : l'approbation démarre dès que l'appel est parsé, donc `approval-required` peut précéder le `tool-call` consommé du flux. Chaque handler **ajoutait une carte sans vérifier l'existence préalable de l'id** → deux cartes pour un seul appel. Aggravé si le `tool-call` avait été flushé de `pendingParts` vers `messages` entre-temps (le test d'unicité ne regardait qu'un seul des deux conteneurs).

- **Modifications effectuées :**
  - **`src/components/ai/ToolCallCard.tsx`** : la branche `approval-required` porte désormais, **pour `bash_run`**, les boutons **Reject** / **Approve** (câblés sur `tc.reject` / `tc.approve`). Pour `write_file` / `edit`, on conserve le renvoi vers l'onglet diff (pas de boutons redondants).
  - **`src/components/ai/AiPanel.tsx`** :
    - `case "tool-call"` : rendu **idempotent** — si une part avec le même id existe déjà dans `pendingParts`, on la met à jour au lieu d'en ajouter une seconde.
    - `case "approval-required"` : le test d'existence de l'id couvre **`pendingParts` ET le dernier message** (`messagesRef`). Si la carte a déjà été flushée vers `messages`, on ne recrée pas de part pending (qui aurait produit un doublon au prochain flush).

- **Décisions Techniques :**
  - **Dédup par id sur les deux conteneurs** plutôt que sur un seul : `pendingPartsRef` (snapshot persistant du tour) et `messages` (rendu) sont mis à jour en parallèle ; un ordre d'events inversé dans l'un ne doit jamais créer une carte dans l'autre.
  - **Boutons conditionnels au type d'action** : on ne duplique pas les actions d'écriture (déjà gérées par le diff), on ne comble le vide que là où il n'existe aucune UI d'approbation (commandes shell).
  - **Sûreté double-clic** : les resolvers `approve`/`reject` reposent sur des `Promise` résolues une seule fois → un second clic est inoffensif.

- **Impacts & Dépendances :**
  - Aucun changement de schéma ni de contrat d'event : on exploite `tc.approve` / `tc.reject`, déjà présents dans `ToolCallDisplay`.
  - Le rendu des approbations d'écriture est inchangé.

- **Prochaines étapes :**
  - Test manuel : provoquer un `bash_run` → la carte doit montrer Reject/Approve, **une seule** carte doit apparaître, et cliquer Approve doit exécuter la commande puis basculer la carte en « complete ».

### [2026-10-15T22:40] | Routage ADAPTATIF de la cascade — circuit breaker 429 + tri par vivacité (TTFT)

- **Contexte :**
  `buildModelChain(primary, allowed)` ordonnait la cascade de façon **statique** : modèle UI en tête, puis `ORVYX_ALLOWED_MODELS`. Or les mesures montrent que le 1ᵉʳ de la liste autorisée (`deepseek-v4.1-flash`) a un **débit très faible** (~234 s pour 89 chunks) et que `glm-5.3-flash` / `deepseek-v4-flash` renvoient `429 Model busy`. Résultat : chaque tour recommençait par un modèle **saturé ou lent**, gaspillait un aller-retour, et la cascade n'« apprenait » rien d'un tour à l'autre.

- **Modifications effectuées :**
  - **`src/lib/agent/modelHealth.ts`** (NOUVEAU) : registre de santé PAR MODÈLE, en mémoire (aucune persistance, aucun réseau) :
    - `noteRateLimit(id)` → cooldown `RATE_LIMIT_COOLDOWN_MS = 60_000` (jamais raccourci) ;
    - `noteTtft(id, ms)` → moyenne glissante bornée à `TTFT_SAMPLES = 5` ; TTFT ≤ 0 / non fini ignoré ;
    - `ttftScore(id)` → moyenne observée ou `UNKNOWN_TTFT_MS = 4_000` (neutre) ;
    - `rankModelChain(chain, health, now)` — logique PURE, horloge injectable : sains avant ceux en cooldown, puis TTFT croissant, tri **stable** ; `primary` remonte en tête **s'il est sain** (on ne contredit pas un choix UI explicite), sinon il est rétrogradé comme les autres.
  - **`src/lib/agent/run.ts`** : import `modelHealth` ; `noteTtft(currentModelId(), ttft)` au premier-chunk ; `noteRateLimit(currentModelId())` quand `classifyFailure` retourne `rate-limited`.
  - **`src/components/ai/AiPanel.tsx`** : `chainIds = rankModelChain(buildModelChain(modelId, allowedIds))`.
  - **`src/lib/agent/__tests__/modelHealth.test.ts`** (NOUVEAU) : 12 tests — moyenne glissante bornée, cooldown non raccourci, stable, non-mutation, et contrat d'intégration « 429 enregistré ⇒ modèle dépriorisé au tour suivant ».

- **Décisions techniques :**
  - Mémoire **en process** (singleton) et non persistée : la fenêtre de pertinence d'un `429` (60 s) et d'un TTFT est de l'ordre de la session ; persister introduirait un état à invalider sans bénéfice.
  - `primary` **prioritaire seulement s'il est sain** : on respecte le choix de l'utilisateur, mais on refuse de tenter en premier un modèle qu'on SAIT saturé (gaspillage d'un aller-retour systématique).
  - Logique pure + horloge injectable : testable sans `fake timers` ni réseau.

- **Impacts & Dépendances :**
  - Aucune signature publique modifiée ; `runAgent` inchangé côté appelant. Le comportement observable : les tours suivants évitent les modèles en cooldown et démarrent par le plus réactif observé.
  - Dépend de `classifyFailure` (marqueur `rate-limited`) et de `currentModelId()`.

- **Validation :** `tsc --noEmit` 0 erreur ; `eslint` 0 erreur sur les 4 fichiers ; `vitest` **456/456** (36 fichiers).

- **Prochaines étapes :**
  - Mesurer un vrai run UI multi-tours (`~/.origin/logs/origin.log`, ligne `ai/panel timing model=… ttft=… tok/s=… fallbacks=…`) pour chiffrer l'apport du routage.
  - i18n des chaînes EN hardcodées (messages d'abandon + statut sous-agents).

---

### [2026-10-15T22:25] | Garde d'INACTIVITÉ du flux — fin des tours figés à vie (symptôme « 10 min bloqué »)

- **Contexte :**
  Symptôme terrain (capture + logs) : un prompt simple (« crée le jeu bomberman en 3 fichiers ») affiche *« I'll start by checking the workspace… »* puis deux `list_directory`, et **plus rien pendant 10 minutes**. Logs : `call-start msgs=2` → `first-chunk après 1896 ms (type=text-delta)` → **aucune ligne ensuite** (ni `stream-end`, ni `timing`). Le TTFT est bon (1896 ms) : le problème n'est PAS le démarrage mais le flux qui **ne se ferme jamais**. Autre run observé : `stream-end chunks=28 après 60540 ms` — un step de 60 s.

- **Cause racine :**
  Le garde existant `firstChunkMs` (45 s) est **annulé dès le premier chunk de contenu**. Après cela, AUCUN garde ne surveille l'activité : si le provider émet un delta puis laisse le socket ouvert sans le fermer (cas réel observé), la boucle `for await` attend indéfiniment. De plus, même une fois coupé, l'abort interne ne levait pas → la cascade ne s'appliquait jamais (corrigé à l'entrée précédente, généralisé ici à `stalled`).

- **Modifications effectuées :**
  - **`src/lib/agent/run.ts`** :
    - Constante `DEFAULT_STALL_TIMEOUT_MS = 90_000` + option `stallTimeoutMs` (0 = désactivé).
    - Flag `stalled` (distinct de `firstChunkTimedOut` et `ttftTooSlow`), remis à `false` à chaque tentative.
    - `armStall()` : timer réarmé sur le **progrès réel** (`text-delta`, `reasoning-delta`, `tool-call`, `tool-input-start`, `tool-result`, `finish-step`) — PAS sur les parts d'échafaudage ni les heartbeats. Un flux qui n'émet que des pings est donc coupé, pas bercé.
    - Bascule premier-chunk → inactivité au premier contenu (`armStall()` dans le bloc `isContent`).
    - `stalled` inclus dans le `throw` final (message `"Model stream stalled mid-response (inactivity timeout)"`) **et** dans le bloc de reprise qui recrée le `AbortController` — sans quoi la tentative suivante hériterait d'un signal déjà avorté et sortirait sans rien produire.
    - Nettoyage du `stallTimer` dans le `finally`.
  - **`src/lib/agent/__tests__/retry.test.ts`** : nouveau test verrouillant le contrat silencieux run↔retry — les 3 messages d'abandon interne (`stalled` / `TTFT` / `no output`) DOIVENT être classés `transient`. Si quelqu'un reformule un message, le test casse (sinon un tour figé repartirait en échec permanent silencieux).

- **Mesures (banc `model-compare`, réseau réel, 2 passes) :**
  - `deepseek-v4-flash-0731` : TTFT médian **1373 ms** (le plus rapide).
  - `deepseek-v4.1-flash` : TTFT médian **2213 ms**.
  - `glm-5.3-flash` : **HTTP 429 « Model busy, retry later »** (saturé, inutilisable).
  - `deepseek-v4-flash` : **HTTP 429 « Model busy »** (saturé).
  - ⇒ Deux des quatre modèles autorisés sont actuellement saturés, et le plus lent mène la cascade car il est en tête de `ORVYX_ALLOWED_MODELS`.

- **Décisions Techniques :**
  - **Garde d'inactivité, pas un timeout global** : un tour multi-étapes avec outils est légitimement long (plusieurs allers-retours). On ne borne donc PAS la durée totale — on borne le **silence entre deux progrès**. Un modèle qui réfléchit 30 s entre deux tokens reste valide ; un socket mort est coupé.
  - **Seuil large (90 s)** : au-dessus d'un silence « normal » (raisonnement, long appel d'outil), pour ne jamais couper un tour valide.
  - **Réarmement sur progrès, pas sur tout chunk** : ferme la porte au flux qui n'émet que de l'échafaudage/heartbeats.
  - **Réutilisation du chemin de classification existant** plutôt qu'un statut dédié : zéro duplication, cascade et reprise acquises gratuitement.

- **Impacts & Dépendances :**
  - `run.ts` : nouveau comportement sur un flux muet APRÈS le premier chunk — coupé à 90 s puis repris/basculé au lieu de rester figé. Aucun changement sur les flux sains.
  - Défaut appliqué à tous les appels (l'UI ne passe pas `stallTimeoutMs`) ; sous-agents inclus.
  - Tests : **444/444**, tsc 0 erreur, eslint 0 erreur.

- **Prochaines étapes :**
  - **Circuit breaker de modèle** : un modèle qui renvoie 429 doit être dépriorisé temporairement (cooldown), sinon chaque tour recommence par un modèle saturé et gaspille un aller-retour. Mesuré : 429 constants sur `glm-5.3-flash` et `deepseek-v4-flash`.
  - Réordonner/recommander la cascade selon la santé observée plutôt qu'un ordre statique.

---

### [2026-10-15T22:05] | Performance du harness : ports Cline + correction de la garde TTFT (débloque réellement la cascade)

- **Contexte :**
  « améliore la vitesse de génération et de travail… le problème n'est pas que le modèle, il faut aussi voir le harness ». Diagnostic confirmé par banc : le TTFT des prompts système réels (729–1201 ms) est **inférieur au plancher réseau** (1435 ms) → **la taille du prompt n'est PAS le facteur limitant**. Les vraies causes : historique entier re-payé à chaque tour (coût quadratique), résultats d'outils géants conservés, prompt non optimisé cache. Référence : Cline SDK (`output-limits.ts`, `message-builder.ts`, `act.ts`).

- **Modifications effectuées (ports Cline) :**
  - **NOUVEAU `src/lib/agent/outputLimits.ts`** : `truncateMiddle` (garde tête+queue, élide le milieu, notice placée DANS les zones conservées) + `clampToolResult` (chaîne → troncature ; objet → ne tronque que les champs texte longs, structure intacte). Plafonds : read/grep/glob/bash 48 K car., résultat d'outil 8 K car.
  - **`run.ts`** : `result: clampToolResult(...)` sur `case "tool-result"` → point d'étranglement unique de TOUS les résultats d'outils ; `maxOutputTokens: resolveMaxOutputTokens(...)` (fraction 0.3 de la fenêtre, réserve 1024, plancher 2000) ; cache préfixe généralisé (`markCacheable` : `anthropic.cacheControl` + `openai.promptCacheKey`) sur le dernier message.
  - **`compactHistory.ts`** : stale-read rewriting **à chaque tour** (suppression du gate 80 %) + fenêtre de préservation des 20 K derniers tokens (`preserveFromIndex`).
  - **`tokenBudget.ts`** : `COMPACTION_THRESHOLD = 0.90` (au lieu de 0.80, aligné Cline) + `PRESERVE_RECENT_TOKENS = 20_000`.
  - **`prompts.ts`** : bloc `BATCHING_RULES` (émettre tous les appels indépendants en UNE réponse → N latences → 1).
  - **`AiPanel.tsx`** : `cacheSystem: true` sur les 5 sites d'appel (plus seulement Anthropic).

- **Correction critique de la garde TTFT (vrai bug, pas un réglage) :**
  - **Cause 1** : `firstChunkLogged` passait à `true` sur **n'importe quel** `part.type`. Or le SDK `ai@6` émet des parts d'échafaudage (`start`, `start-step`, `text-start`, `reasoning-start`…) **avant tout contenu**, quasi instantanément → le TTFT était mesuré à ~2 ms, le timer anti-flux-muet annulé, et la garde `shouldFallbackOnSlowTtft` **ne se déclenchait jamais**. Fix : ne compter comme premier signe de vie que les parts de **contenu réel** (`text-delta`, `reasoning-delta`, `tool-call`, `tool-input-start`).
  - **Cause 2** : après l'abort interne (`ttftTooSlow`), le `break` sortait du `for await` **sans lever** ; `attemptRun` se terminait normalement → la boucle voyait `cancelled` → **aucune cascade**. Fix : lever une erreur transiente après le `finally` quand `ttftTooSlow || firstChunkTimedOut`.

- **Mesures (banc `cascade-probe`, réseau réel) :**
  - Avant : `deepseek-v4-flash` TTFT **10 432 ms** → a répondu, **pas de bascule** malgré budget 4 s (garde cassée).
  - Après : `deepseek-v4-flash` premier contenu à **12 456 ms** → bascule détectée → `deepseek-v4.1-flash` TTFT **1 772 ms**, statut `completed`, `fallbacks=1`.
  - Banc `ttft-probe` (2 passes) : agent/max 867 ms, agent/norm 729 ms, plan/max 735 ms, ask/max 957 ms, agent/max+code 1201 ms — **tous < plancher réseau** (1435 ms) → le prompt n'explique pas la lenteur ; c'est bien le **modèle + le harness**.

- **Décisions Techniques :**
  - **Mesure avant croyance** : le banc a montré que réduire le prompt système n'aiderait pas ; le levier réel est la **borne des sorties d'outils** (gain quadratique) et la **cascade sur TTFT** (gain de latence perçue).
  - **`isContent` explicite** plutôt que « premier part » : robuste aux changements de framing du SDK, et évite les faux TTFT.
  - **Lever après `finally`** plutôt que de retourner un statut : réutilise le chemin de classification/cascade existant (aucune logique dupliquée).

- **Impacts & Dépendances :**
  - `isContent` change uniquement quand le timer anti-flux-muet est annulé et quand la garde TTFT évalue : **comportement voulu**, mais tout flux ne produisant QUE des parts d'échafaudage (anormal) serait désormais coupé par le garde-flux-muet à `firstChunkMs`.
  - `clampToolResult` peut élider la queue d'un résultat volumineux : la notice indique comment récupérer (relecture ciblée) — les outils gardent leurs bornes d'entrée.
  - Tests : **432/432**, tsc 0 erreur, eslint 0 erreur.

- **Prochaines étapes :**
  - Vérifier en usage UI réel que `origin-ai-model` (localStorage) suit bien `ORVYX_ALLOWED_MODELS` (le modèle UI peut rester figé).
  - Instrumenter un vrai run UI multi-tours pour confirmer l'effet du cache préfixe sur le TTFT au 2ᵉ tour.

---

### [2026-10-15T22:12] | Banc multi-tours : cache préfixe PROUVÉ (-53 % de TTFT au 2ᵉ tour) + tests de la borne d'outils

- **Contexte :**
  Le banc `ttft-probe` mesure des appels ISOLÉS : il ne peut PAS montrer l'effet du cache préfixe (le préfixe doit être réémis à l'identique d'un tour à l'autre). Il fallait un banc jouant N tours successifs sur la MÊME histoire persistée, comme l'app.

- **Modifications effectuées :**
  - **NOUVEAU `scripts/turn-probe.ts`** : joue 3 tours successifs via le VRAI `runAgent` sur un historique persistant (tour 1 froid, tour 2 = préfixe identique → cache attendu, tour 3 = historique gonflé par un faux résultat d'outil de 120 K car.). Lit l'usage réel (`finish`) : `inputTokens`, `cacheReadTokens`, TTFT, total.
  - **NOUVEAU `src/lib/agent/__tests__/outputLimits.test.ts`** : 11 tests déterministes de `truncateMiddle` / `clampToolResult` (borne jamais dépassée, tête+queue conservées, notice dans une zone conservée, structure d'objet préservée, champs longs seuls élidés, tableau sérialisé borné).

- **Mesures (banc `turn-probe`, réseau réel, `glm-5.3-flash`) :**
  - **Cache préfixe PROUVÉ** : tour 1 TTFT **2109 ms** → tour 2 TTFT **1000 ms** (**−1109 ms, −53 %**), `cacheRead 768 tok`. Le provider sert bien le préfixe depuis son cache grâce à `cacheSystem: true` généralisé.
  - **Clamp** : au tour 3, l'entrée brute injectée (33 064 tok) n'est pas bornée — **c'est attendu** : le clamp agit sur les résultats ÉMIS par le SDK pendant un run, jamais sur un historique déjà constitué (on ne tronque pas a posteriori une réponse déjà en contexte). La borne réelle est couverte par les 11 tests unitaires.
  - Observation provider : au tour 3, un premier appel a « muet » 45 s (garde anti-flux-muet), puis la reprise a répondu en 5,1 s — le garde a bien joué son rôle (aucun tour figé).

- **Décisions Techniques :**
  - **Mesurer le cache là où il se voit** : un banc multi-tours, pas un banc d'appels isolés. Le cache est un effet de PRÉFIXE stable, pas d'un prompt court.
  - **Ne pas tronquer l'historique déjà présent** : le clamp est une porte à l'ENTRÉE des résultats (au moment de l'émission), pas un filtre rétroactif — sinon on détruirait du contexte déjà payé et exploité par le modèle.
  - **Tests déterministes pour la borne** : le réseau ne peut pas prouver le clamp (les résultats SDK sont émis côté provider) ; l'unitaire le prouve à coût nul et de façon reproductible.

- **Impacts & Dépendances :**
  - `scripts/turn-probe.ts` est un banc HORS vitest (réseau + `.env`) : il ne tourne jamais en CI. `outputLimits.test.ts` intégré à la suite : **35 fichiers, 443 tests, tous verts**. tsc 0 erreur, eslint 0 erreur.
  - Aucune modification de code de production dans cette entrée : uniquement instrumentation et tests.

- **Prochaines étapes :**
  - Confirmer en UI que `cacheSystem: true` est bien propagé sur les 5 sites (fait) et suivre `cacheReadTokens` dans les logs d'un vrai run pour valider le gain in situ.
  - Étudier une passe de compaction DÉCLENCHÉE quand l'historique porte encore de gros résultats d'outils hérités (les résultats émis avant ce correctif ne sont pas clippés).

---


### [2026-10-15T21:35] | Logger central persistant + borne de timeout d'outil (fin des blocages silencieux)

- **Contexte :**
  « gros problème on ne voit même pas les logs pour savoir où arranger, où ça casse ». Deux causes distinctes :
  1. **Logs invisibles** : `console.info` du front n'apparaît que dans la console DevTools, jamais en usage normal. Aucun canal exploitable.
  2. **Blocage réel** : capture d'écran montrant un run figé sur « Write file » sans fin ni erreur. Cause identifiée : `runAgent` reçoit `toolTimeoutMs = 0` par défaut (pas de limite) et AiPanel ne le passait pas → un `write_file` bloqué suspend le tour **à vie**, en silence.

- **Modifications effectuées :**
  - **NOUVEAU `src-tauri/src/log.rs`** : commande `origin_log(level, target, message)`. Écrit sur **stderr** (visible dans `tauri dev`) + **fichier append** `~/.origin/logs/origin.log` (utile en release sans terminal). Rotation simple à 5 Mio (`.log` → `.log.1`). **Redaction** défensive (`oryx_`, `sk-`, `Bearer `, `api_key=`) : un secret ne peut pas finir sur disque. Best-effort : toute erreur d'I/O est avalée (un log ne casse jamais une fonctionnalité). 5 tests.
  - **NOUVEAU `src/lib/logger.ts`** : API front `log.debug/info/warn/error/flush`. **Buffer + flush par lots** (150 ms ou 50 lignes) → ne sature pas l'IPC d'un long run ; réplique console en dev ; best-effort (hors contexte Tauri, aucune erreur).
  - **`run.ts`** : traces à chaque étape clé : `call-start` (modèle, nb messages, retry), `timing` (ttft/total/gen/tok-s/fallbacks/finishReason), `retry` (attempt, kind, retryAfter, produced, model, erreur tronquée), `cascade` (bascule X→Y, épuisement), `échec définitif` (avec `log.flush()`).
  - **`AiPanel.tsx`** : `case "error"` → `log.error` + `flush` (LE point où un tour casse) ; `case "timing"` → logger central ; **`toolTimeoutMs: TOOL_TIMEOUT_MS` (120 s)** ajouté aux 4 appels `runAgent` + constante module.
  - **Cascade héritée par les sous-agents** : `spawnRuntime` / `subagent` / `runPass` propagent `modelChain`/`modelIds` (un 429 côté sous-agent bascule au lieu de tuer la passe).

- **Décisions Techniques :**
  - **Log file + stderr, pas seulement console** : en release il n'y a aucun terminal — le fichier est le seul canal post-mortem.
  - **Flush par lots** : un log par token saturerait l'IPC ; le batching garde la latence négligeable.
  - **`log.flush()` sur les erreurs fatales** : garantit que la trace est écrite avant que le tour ne s'arrête.
  - **120 s de timeout outil** : large pour de l'I/O local, mais transforme un blocage muet en erreur visible que le modèle peut traiter.
  - **Redaction côté Rust (pas front)** : la dernière ligne de défense est au plus près du disque.

- **Impacts & Dépendances :**
  - `origin_log` est une commande **additive** (aucun consommateur existant cassé). `modelChain`/`modelIds` sur `subagent`/`spawnRuntime` sont **optionnels** → no-op si absents.
  - **Validation** : `tsc --noEmit` exit 0 ; ESLint silencieux ; **vitest 426/426** ; **cargo test 100/100** (dont 5 nouveaux sur `log.rs`).
  - Le log est écrit dans `~/.origin/logs/origin.log` — **hors du repo**, jamais committé.

- **Prochaines étapes :**
  - Observer en réel : lancer `npm run dev`, envoyer un prompt, lire le terminal (lignes `[epoch][info][agent/run] …`).
  - Réévaluer le timeout outil si un outil légitime (gros patch, LSP) dépasse 120 s.

---

### [2026-10-15T21:20] | Cascade de modèles + instrumentation TTFT (anti rate-limit)

- **Contexte :**
  Demande : « mesure le TTFT réel et le temps pour une tâche simple vs compliquée — c'est super lent, je pense que c'est trop surchargé ». Bancs réels (`scripts/ttft-probe.ts`, `scripts/model-compare.ts`) : le prompt système n'est PAS la cause (526 tok → TTFT 13 460 ms sur `deepseek-v4-flash`). Le vrai problème : `deepseek-v4-flash` renvoie souvent **`429 Model busy` sans header `Retry-After`**, et le retry existant (`retryDelayMs("rate-limited", n, null) === null`) **n'insiste jamais** → le tour échoue. Comparateur : `deepseek-v4-flash-0731` TTFT **1 129 ms** vs `deepseek-v4-flash` **10 142 ms** (9× plus rapide, sans 429).

- **Modifications effectuées :**
  - **NOUVEAU `src/lib/agent/modelCascade.ts`** (logique pure, testable en node) : `parseAllowedModels` (découpe/dédup ordonnée de `ORVYX_ALLOWED_MODELS`), `buildModelChain` (primary toujours en tête, filets ensuite), `nextModelIndex` (avance stricte, jamais de retour), `shouldFallback` (rate-limit/transient oui, permanent non, jamais après contenu produit).
  - **`run.ts`** : option `modelChain`/`modelIds` ; bascule **immédiate sans backoff** vers le modèle suivant dans la boucle de retry quand `shouldFallback` est vrai ; event `timing` (ttftMs, totalMs, genMs, outputChars, tokPerSec, model, fallbacks) émis juste avant `finish`.
  - **`AiPanel.tsx`** : construction de la chaîne dans `handleSend` (via `resolveAllowedModels` + `parseAllowedModels` + `buildModelChain`), passée aux **4** appels `runAgent` (plan phase 1/2, ask, agent/IA) ; un id non constructible est ignoré silencieusement ; `case "timing"` → `console.info("[origin][timing] …")`.
  - **`secrets.ts`** : champ `allowedModels` dans `DevAiConfig` + `resolveAllowedModels()` (priorité localStorage > `.env`).
  - **`ai_env.rs`** : clé `ORVYX_ALLOWED_MODELS` + `allowed_models` exposée par `dev_ai_config`.
  - **`providers.ts`** : ajout des modèles de la cascade + flash rapides (`deepseek-v4-flash-0731`, `deepseek-v4.1-flash`, `gemini-3.1-flash-lite`, `gemini-3.5-flash`, `glm-5.3-flash`).
  - **`.env`** : `ORVYX_AI_MODEL=deepseek-v4-flash-0731` (plus rapide mesuré) + `ORVYX_ALLOWED_MODELS=deepseek-v4.1-flash,glm-5.3-flash,deepseek-v4-flash-0731,deepseek-v4-flash`.
  - **NOUVEAU `modelCascade.test.ts`** (17 tests).

- **Décisions Techniques :**
  - **Bascule sans backoff** : attendre sur un modèle déjà saturé ne fait que dégrader le TTFT ; un autre modèle flash répond immédiatement.
  - **Jamais de bascule après du contenu produit** : rejouer un tour partiellement écrit dupliquerait des éditions de fichiers. La cascade ne s'active qu'avant le premier signal (token/raisonnement/outil).
  - **Jamais sur `permanent`** : une clé invalide ou une requête malformée ne se corrige pas en changeant de modèle ; masquer l'erreur réelle serait nuisible.
  - **`primary` toujours en tête** : le choix UI de l'utilisateur prime ; la liste blanche n'est qu'un filet.

- **Impacts & Dépendances :**
  - `timing` est un event `AgentEvent` **additif** : aucun consommateur existant n'est cassé ; le log est discret (console).
  - La cascade est **no-op** si `ORVYX_ALLOWED_MODELS` est absent (chaîne = modèle unique) → zéro régression.
  - **Validation** : `tsc --noEmit` exit 0 ; ESLint silencieux sur les 6 fichiers touchés ; **vitest 426/426 (34 fichiers)** ; `cargo test ai_env` 7/7.

- **Prochaines étapes :**
  - La répartition de charge des modèles orvyx est **variable dans le temps** : ré-évaluer périodiquement le classement TTFT (`npx tsx scripts/model-compare.ts`) et réordonner `ORVYX_ALLOWED_MODELS` si besoin.
  - Branchage ultérieur possible : exposer une UI de réglage de la cascade (aujourd'hui pilotée par `.env` + localStorage).

---

- **Contexte :**
  Demande : « tout ce qui est pilotable par l'input doit marcher proprement — le plan, les skills, ctrl+z / ctrl+y — teste tout dans le terminal ». Audit de tout ce qui part de `ChatBox` avant d'écrire les tests : plusieurs fonctions étaient **module-privées** de `ChatBox.tsx` (non testables en environnement `node`) et trois défauts d'input ont été trouvés.

- **Défauts trouvés (input) :**
  1. **`plan` absent du menu d'agent.** `AGENTS` ne contenait que `ask` et `agent` alors que `handleSend` accepte `mode: "plan"` → le plan mode était **inatteignable par l'UI** (seule la commande palette y menait).
  2. **Mode non persisté.** `useState<Mode>("agent")` : le mode choisi était perdu à chaque reload.
  3. **Slash-command = décor mort.** Le menu « / for commands & skills » et « Skills » avait `onClick={onClose}` : taper `/plan` n'avait **aucun effet**, aucun parsing du `/`.
  4. **`parsePlan` cassait sur un ordre d'attributs différent.** La regex exigeait `file` AVANT `action` : un `<step action="edit" file="…">` (ordre non garanti par le modèle) renvoyait `null` → **plan-card jamais affichée, approbation impossible** (échec silencieux en production). Un `<step …/>` non fermé « avalait » aussi le step suivant.

- **Modifications effectuées :**
  - **NOUVEAU `src/lib/inputCommands.ts`** : logique *pure* extraite du composant — `AGENTS` (3 modes, `plan` inclus), `isMode`, `agentLabel`, `readStoredMode`/`writeStoredMode` (clé `origin-ai-mode`), `parseSlashCommand`, `filterSlashCommands`, `getSlashQuery`, catalogue `SLASH_COMMANDS`.
  - **`ChatBox.tsx`** : `AGENTS` dérivés du module (mapping icône `AgentIcon`→lucide) ; mode initialisé via `readStoredMode()` ; `handleModeSelect` persiste ; `handleSend` parse les slash-commands (`/plan …` bascule le mode et envoie le reste ; `/plan` seul bascule sans envoyer).
  - **`planTypes.ts`** : `parsePlan` accepte les attributs dans **n'importe quel ordre** (capture indépendante de `file` et `action`) ; regex durcie pour ne pas confondre `<step …/>` avec un ouvrant ni avaler le step suivant.
  - **NOUVEAUX tests** : `inputCommands.test.ts` (23), `commandsRegistry.test.ts` (12), `keybindings.test.ts` (18), `planTypes.test.ts` (+7 → 17).

- **Décisions Techniques :**
  - **Extraire la logique d'input dans un module pur** plutôt que de tester le composant : vitest tourne en `environment: "node"` (pas de DOM) ; la logique testable (parsing, catalogue, persistance) n'a pas besoin de React. Les fonctions purement DOM (`parseContent`, `getMentionQuery`) restent privées et sont validées côté UI par l'utilisateur.
  - **Ne pas inventer le comportement des « Skills »** : l'audit montre qu'il n'existe **aucun runtime de skills** dans le code (seuls les réglages clavier sont branchés sous l'onglet « Skills & Commands »). Documenté comme décor à part, non câblé, plutôt que de fabriquer une feature non demandée.
  - **Anti-régression sur `parsePlan`** : les cas limites (ordre inversé, attributs manquants, self-closing, bloc non fermé) sont désormais assertés.

- **Impacts & Dépendances :**
  - `ChatBox` importe `inputCommands` ; `Mode` y est importé (plus de type local dupliqué). Toute évolution du catalogue d'agents/slash se fait dans le module, pas dans le composant.
  - `parsePlan` est partagé par `sessionStore.ts` et `AiPanel.tsx` : tous deux bénéficient de l'acceptation d'ordre libre — aucun changement d'API.
  - **Validation** : `tsc --noEmit` exit 0, ESLint silencieux sur les 7 fichiers touchés, **vitest 409/409 (33 fichiers)**.

- **Prochaines étapes :**
  - **Non câblé (signalé, hors périmètre de ce lot)** : le menu « / commands & skills » et l'entrée « Skills » de l'AttachMenu sont toujours `onClick={onClose}`. Le parsing slash existe désormais côté `handleSend`, mais l'autocomplétion visuelle du `/` dans l'éditeur reste à brancher (dropdown dédié type mention `@`).
  - Tests UI manuels (l'utilisateur) : basculer Agent/Plan/Chat, taper `/plan …`, vérifier la persistance du mode au reload, Ctrl+Z / Ctrl+Y dans l'éditeur.

---


- **Contexte :**
  Après le dump, besoin de NOMBRES pour piloter les décisions d'édition plutôt que des impressions. Ajout d'un instrument de mesure (`prompts.metrics.test.ts`) qui calcule, par preset : taille (car. + ~tokens), nombre de sections/puces, puces par section, **redites inter-sections** (lignes normées présentes dans plusieurs sections) et **couverture des concepts** (outils, édition, todos, question, style, délégation).

- **Anomalies détectées par la mesure (factuelles, non subjectives) :**
  1. **`ask/max` et `ask/normal` étaient IDENTIQUES au caractère près** (1375 = 1375). Depuis le retrait d'`EDIT_RULES` en ASK, le paramètre `isMax` n'avait plus AUCUN effet sur ce mode : on exposait deux presets rigoureusement identiques.
  2. **Le mode ASK ne disait rien sur COMMENT répondre** (couverture `ask = 0`, `todos = 0`). C'est pourtant le mode des questions : il ne cadrait que le traitement des fichiers, pas la réponse elle-même.

- **Modifications effectuées :**
  - **NOUVEAU bloc `ASK_ANSWER_RULES`** dans `prompts.ts` : citer le code par chemin + ligne, distinguer le vérifié de l'inféré, expliquer le pourquoi, ne pas inventer. Injecté en mode ASK après `CONCISION`.
  - **`buildSystemPrompt` mode ASK** : `isMax` fait désormais varier le niveau de détail (`EDIT_RULES_FULL` en max uniquement). Les deux presets ASK redeviennent distincts.
  - **NOUVEAU `src/lib/agent/__tests__/prompts.metrics.test.ts`** (6 tests) : rapport de métriques + invariants objectifs (0 redite, `max >= normal`, budget < 6000 car., couverture par mode, délégation seulement en agent/max).
  - **`prompts.test.ts`** : test ASK réaligné + test « `isMax` a un effet réel » (les deux presets ASK diffèrent).

- **Décisions Techniques :**
  - **Instrument de mesure séparé du dump** : le dump sert à LIRE, les métriques à DÉCIDER. Les invariants assertés sont uniquement objectifs et non arbitraires ; aucun seuil « magique » là où il n'y a pas de fait (le budget 6000 car. est un garde-fou de prompt système, pas une vérité).
  - **Faire varier `isMax` en ASK par le niveau de détail** plutôt que par un texte différent : cohérent avec l'agent (full/lite) et évite d'inventer deux comportements pour un même mode.
  - **Anti-biais** : on ne compare pas les tailles entre modes (un mode n'est pas « mieux » parce que plus long) ; on vérifie seulement la monotonie interne max ≥ normal.

- **Impacts & Dépendances :**
  - Contenu des presets ASK modifié (nouvelle section « Answering », variante full/lite). Le test qui assertait l'absence de mécanique d'édition est réécrit : c'était une hypothèse devenue fausse après mesure.
  - Métriques après correction : agent/max 3824 car. (7 sect.), agent/normal 2102 (6), ask/max 2288 (5), ask/normal 1734 (4), plan/max 1678 (4), plan/normal 1356 (4). **0 redite inter-sections** sur les 6 presets.

- **Prochaines étapes :**
  - Rejouer `prompts.metrics.test.ts` après toute évolution de prompt : les redites et la couverture sont des signaux de dérive.
  - Surveiller `plan/normal` (1.5 puces/section, preset le plus maigre) si l'on veut l'enrichir — non bloquant.

### [2026-10-15T23:45] | Banc de lecture des prompts + réordonnancement (principes avant outils)

- **Contexte :**
  Les prompts venaient d'être centralisés, mais leur CONTENU n'avait jamais été relu ligne à ligne. Besoin d'un instrument pour imprimer chaque preset dans le terminal, repérer les défauts, itérer. La lecture a révélé 4 problèmes réels.

- **Défauts trouvés à la lecture (et corrigés) :**
  1. **Redites identité / outils / édition.** L'identité disait « investigate the code, then make the changes », `Available tools` répétait « Use them autonomously to complete the task », `Editing` répétait la mécanique. Chaque énoncé est désormais porté par UN seul bloc (économie de tokens du prompt système, donc TTFT).
  2. **Ordre sous-optimal.** `Editing` (détail d'outil) passait AVANT `Asking the user` et `Progress tracking` (principes). Réordonné façon Cline : principes comportementaux → détails d'outil.
  3. **`ask/max` trompeur.** Le mode ASK recevait `EDIT_RULES_FULL` (search/replace unique, contexte de 3-5 lignes) : c'est un détail d'implémentation de l'outil Agent, inutile pour un mode qui répond aux questions. ASK ne garde que le cycle de revue (`ASK_MODE_FILES_NOTE`).
  4. **PLAN pas assez verrouillé.** L'identité PLAN disait seulement « WITHOUT writing any code yet » ; elle affirme maintenant « You are READ-ONLY: you never write, edit, or run anything that changes the workspace ».

- **Modifications effectuées :**
  - **NOUVEAU `src/lib/agent/__tests__/prompts.dump.test.ts`** : instrument de revue (10 tests). Imprime les 6 presets complets + un prompt personnalisé habillé, encadrés et annotés (nombre de caractères, de sections), puis un RAPPORT d'ordre des sections par mode et un rapport d'uniformité du style. Assertions volontairement légères (structure), le contenu étant fait pour être LU.
  - **`src/lib/agent/prompts.ts`** : ordre du composeur revu (`identity → CONCISION → TODO_RULES → ASK_USER_RULES → [DEL] → toolsBlock → EDIT_RULES`), `toolsBlock` réduit à la seule liste factuelle, `EDIT_RULES_FULL/LITE` condensés (suppression de la mention d'implémentation « fuzzy 66%+ »), identité PLAN verrouillée « READ-ONLY ».
  - **`src/lib/agent/__tests__/prompts.test.ts`** : test PLAN réaligné sur « READ-ONLY » + 2 invariants ajoutés (ordre principes < outils ; ASK sans mécanique `edit`).

- **Décisions Techniques :**
  - **Instrument de dump plutôt que snapshot figé** : un snapshot verrouille le texte et empêche de le critiquer ; ici on veut LIRE et itérer. Les invariants forts restent dans `prompts.test.ts`.
  - **`isDump = true` constant plutôt que `process.env`** : évite une dépendance à `@types/node` et la friction de lancement — l'instrument doit toujours parler.
  - **Un énoncé, un bloc** : principe appliqué à la fois pour la lisibilité (le modèle hiérarchise mieux) et pour le coût (prompt plus court = pré-remplissage plus rapide).

- **Impacts & Dépendances :**
  - Les 6 presets changent de CONTENU (ordre + libellés) : tout consommateur qui assertait un texte littéral doit s'aligner — c'est le cas du test, corrigé.
  - `DEFAULT_*` restent cohérents (délèguent au composeur).
  - TTFT : le prompt système est légèrement plus court (blocs dédupliqués), effet marginal mais dans le bon sens.

- **Prochaines étapes :**
  - Lancer `npx vitest run src/lib/agent/__tests__/prompts.dump.test.ts` avant chaque évolution de prompt pour relire le rendu réel.
  - Envisager un mode « dump compact » (sans le corps, seulement titres + tailles) pour survoler les 6 presets d'un écran.

### [2026-10-15T23:15] | Chantier TTFT + prompts : module central unique et latence du premier token

- **Contexte :**
  Deux problèmes distincts traités dans un même chantier structuré :
  1. **Prompt système épars et dupliqué.** Les presets (`full`/`lite`) vivaient dans `ai.ts` avec du texte recopié (bloc « Editing rules » présent plusieurs fois, `DELEGATION_GUIDANCE` concaténée à la main dans deux constantes). Toute évolution risquait de diverger entre modes (IDE vs IA), donc de casser l'uniformité exigée.
  2. **TTFT trop lent.** Le clic utilisateur payait une série d'`await` SÉQUENTIELS avant le premier token : IPC keychain (clé API), 2 insertions DB, puis lecture des fichiers mentionnés en boucle série.

- **Modifications effectuées :**
  - **NOUVEAU `src/lib/agent/prompts.ts`** : module central des prompts.
    - Blocs nommés à responsabilité unique : `identity(mode)`, `CONCISION`, `EDIT_RULES_FULL/LITE`, `ASK_USER_RULES`, `TODO_RULES`, `STYLE_GUARDRAIL`, `DELEGATION_GUIDANCE`.
    - Composeur déclaratif `composeSystemPrompt({ blocks, style, extra })` qui filtre les blocs vides (aucun séparateur orphelin) et place le style en avant-dernière position, `extra` (ORIGIN.md) en dernier.
    - Presets par mode via `buildSystemPrompt(mode, isMax, workspaceNote)` : plus aucune duplication, une seule source de vérité.
    - Structure en sections titrées (`## Editing`, `## Progress tracking`…) inspirée de Cline/jcode : un modèle suit mieux une consigne organisée.
  - **NOUVEAU `src/lib/agent/toolPresentation.ts`** : `FULL_TOOLS_LIST`, `READ_ONLY_TOOLS_LIST`, `ASK_MODE_FILES_NOTE` — les noms d'outils cités dans le prompt sont centralisés (anti-dérive : renommer un outil casse le test d'invariant).
  - **`src/lib/ai.ts`** réduit à des **re-exports** du module central (compat des imports existants).
  - **`src/components/ai/AiPanel.tsx`** recâblé : `withOriginMd` = `composeSystemPrompt({ blocks:[base], style: STYLE_GUARDRAIL, extra: originMd })` ; sélection agent/ask/plan via `buildSystemPrompt` ; phase 2 idem. Les trois modes partagent donc EXACTEMENT le même habillage (style + ORIGIN.md).
  - **TTFT — cache clé API (`src/lib/secrets.ts`)** : `Map<providerId, string|null>` en mémoire, invalidée par save/delete. Le keychain n'est plus sondé à chaque tour (le clic ne paie plus l'IPC keychain).
  - **TTFT — `handleSend` (`AiPanel.tsx`)** : UI optimiste émise AVANT tout `await` (bulle user + bulle assistant « streaming »), `loadApiKey` et lecture des fichiers mentionnés lancés EN PARALLÈLE (`apiKeyPromise` / `mentionedFilesPromise`), `knownError` calculé sans `await` bloquant, inserts DB user + assistant parallélisés via `Promise.all`.
  - **TTFT — connexion HTTP durable (`src-tauri/src/ai.rs`)** : `reqwest::Client` partagé en `OnceLock` (au lieu d'être reconstruit par requête) avec `pool_idle_timeout(600s)`, `pool_max_idle_per_host(8)`, `tcp_nodelay(true)` (désactive Nagle, critique en SSE) et `tcp_keepalive(60s)`. `fetch_text` réutilise le même client.
  - **NOUVEAU `src/lib/agent/__tests__/prompts.test.ts`** : 19 tests (composeur, invariants par mode, uniformité du style, compat, anti-dérive des outils).

- **Décisions Techniques :**
  - **Un module central unique plutôt que patcher les constantes existantes** : élimine la classe entière de bugs par duplication et garantit l'uniformité IDE/IA demandée. Les presets sont obtenus par composition de blocs, pas par copie de texte.
  - **Style injecté PAR le composeur en avant-dernière position** : le garde-fou (pas d'emojis/tirets longs) prime sur un prompt personnalisé de l'utilisateur, sans l'écraser.
  - **`tcp_nodelay(true)` est central au TTFT SSE** : Nagle retenait les petits `text-delta` pour les coalescer, ce qui ajoutait directement au délai perçu. Idem `pool_idle_timeout` long : le vrai coût venait du handshake TLS refait après quelques secondes d'inactivité, pas du débit.
  - **UI optimiste sans attendre `runSeq`** : le feedback visuel ne doit jamais dépendre du réseau. La garde `runSeqRef` continue d'ignorer les events périmés, donc aucune régression de cohérence.
  - **Client partagé `OnceLock` plutôt qu'un `State` Tauri** : le client est global, sans état mutable lié à la session ; `OnceLock` évite d'alourdir la gestion d'état et reste thread-safe.

- **Impacts & Dépendances :**
  - `DEFAULT_SYSTEM_PROMPT` & co. restent exportés (délèguent au composeur) : aucun import externe cassé.
  - `ai.rs` : plus de `reqwest::Client` local dans `ai_stream_proxy` / `fetch_text` ; le pool est désormais partagé entre TOUTES les requêtes du proxy. Effet de bord positif : les étapes multiples d'un même tour d'agent réutilisent la même connexion.
  - Le comportement anti-SSRF (`PROXY_ALLOW_HOSTS`) est inchangé : l'allowlist est vérifiée avant toute utilisation du client.
  - Verrouillage par tests : les invariants de prompt (délégation seulement en agent-max, plan en lecture seule, etc.) ne peuvent plus régresser silencieusement.

- **Prochaines étapes :**
  - Mesurer le TTFT après ce lot (comparer avant/après sur un tour simple et un tour avec 3 fichiers mentionnés) ; le prochain levier serait le prompt caching étendu au-delà d'Anthropic.
  - Lot 2 (équipes d'agents) toujours en attente, non démarré.
  - Test manuel : mode IDE et mode IA doivent présenter un prompt uniforme (mêmes sections, même garde-fou de style).

### [2026-10-15T19:20] | Revue de fichiers « live » : Keep all / Undo all visibles pendant le run (pattern Trae)

- **Contexte :**
  La barre de revue « N files changed / Keep all / Undo all » n'apparaissait **qu'à la fin** du run (émise dans la branche `finish`), et — une fois repliée — **cachait** les deux boutons. Résultat : l'utilisateur ne voyait pas « Keep all » / « Undo all » pendant que l'agent travaillait, contrairement à Trae où ces actions sont accessibles en permanence.

- **Analyse (causes racines) :**
  1. `checkpointBanner` n'était posé que dans le handler `finish` → aucune visibilité pendant le run.
  2. Les boutons « Keep all » / « Undo all » vivaient **dans le bloc `expanded`** de `TurnReviewCard` → invisibles tant que la carte était repliée (`defaultExpanded` faux pour la vue dockée).

- **Modifications effectuées :**
  - **`src/components/ai/AiPanel.tsx`** :
    - `checkpointBanner` renommé **`reviewBanner`** (le nom ne présuppose plus « fin de tour »).
    - Nouvelle fonction `refreshReview(turnId, immediate?)` : interroge `summaryTurnCheckpoint(turnId)` (résumé Rust des deltas) et alimente `reviewBanner`. **Debounced à 120 ms** pour ne pas déclencher un aller-retour Rust par outil. Garde anti-obsolescence : un résumé dont le `turnId` ne correspond plus au tour actif est ignoré.
    - Alimentée **en continu** : appelée au `tool-result` de chaque outil d'écriture (`write_file` / `edit` / `multi_edit`) → la bannière apparaît dès la **première** écriture et se met à jour au fil du run.
    - Au `finish`, `refreshReview(turnId, true)` pour un état final exact.
    - Au `handleStop`, `refreshReview(turnId, true)` **après** l'abort : la bannière **reste affichée** avec Undo/Keep sur le travail interrompu.
    - `handleKeepAll` : pendant un run, **masque la revue sans purger le checkpoint** (sinon les écritures suivantes du même tour ne seraient plus annulables). Hors run, purge comme avant.
    - `handleUndoAll` / `handleOpenCheckpointDiff` : lisent désormais `reviewBanner`.
  - **`src/components/ai/TurnReviewCard.tsx`** : le pied d'actions (« N files to review » + « Undo all » / « Keep all ») est **sorti du bloc `expanded`** → il est **toujours visible, même replié**. Seule la liste détaillée des fichiers reste repliable. C'est le comportement de la barre de revue de Trae.
  - **Vue dockée** : `TurnReviewCard` rendu avec `defaultExpanded` → la liste part dépliée au-dessus de l'input.

- **Décisions Techniques :**
  - **Réutiliser `summaryTurnCheckpoint` (source Rust) plutôt que calculer les deltas côté front** : les snapshots sont déjà la source de vérité des checkpoints ; deviner les `+N/-N` depuis les arguments d'outil serait fragile (multi_edit, patchs partiels).
  - **Debounce sur `refreshReview`** : un run peut enchaîner plusieurs écritures ; on veut un coût Rust borné sans perdre la réactivité visuelle.
  - **Pas de purge du checkpoint par « Keep all » en cours de run** : préserve l'invariant « tout ce qui a été écrit dans ce tour reste annulable » jusqu'à la fin réelle du tour.
  - **Bannière conservée après Stop** : un tour interrompu a bien écrit des fichiers ; l'utilisateur doit pouvoir les annuler.

- **Impacts & Dépendances :**
  - Aucun changement côté Rust : `checkpoint_summary` existait déjà.
  - `reviewBanner` remplace `checkpointBanner` (renommage interne, aucun impact API).
  - Le masquage de la liste détaillée reste inchangé : seul le pied d'actions devient permanent.

- **Prochaines étapes :**
  - Test manuel : lancer une tâche qui écrit plusieurs fichiers → la bannière doit apparaître dès le 1er fichier, se mettre à jour à chaque écriture, et les boutons Keep all / Undo all doivent être cliquables **sans déplier** la carte, y compris pendant le run et après un Stop.

### [2026-10-15T19:05] | Stabilisation du run : stop réel, todo silencieuse, TTFT réduit (alignement Cline Focus Chain)

- **Contexte :**
  Trois symptômes signalés par l'utilisateur sur le mode agent :
  1. **TTFT très lent** — le premier token de réponse arrivait après un long silence.
  2. **La todo list n'est pas bonne** et l'agent *écrit* `todo_write` **dans le chat** (visible comme un tool-call `{"ok":true,"count":1}`), ce qui n'est pas pro.
  3. **Après un Stop, le run continue** — des events continuaient à muter le fil.

- **Analyse (causes racines) :**
  - **TTFT** : le prompt système imposait *« ALWAYS start any task that requires more than one tool call by calling todo_write FIRST »*. Ce « FIRST » obligatoire ajoutait **un aller-retour modèle complet** (génération du JSON de todo + exécution + **second** appel pour le vrai contenu) avant que l'utilisateur ne voie le moindre token. C'est exactement ce que Cline évite : dans son **Focus Chain**, la todo est un **état d'UI** (checklist markdown affichée dans l'en-tête de tâche, compteur « 3/8 »), pas un tool-call mis en avant ni une étape imposée à chaque tour.
  - **Bruit dans le fil** : `todo_write` / `todo_read` étaient rendus comme n'importe quel tool-call (accordéon + résultat JSON).
  - **Stop inefficace** : `handleEvent` n'avait **aucune garde d'annulation**. `runAgent.cancel()` fait bien `controller.abort()`, mais un outil déjà « en vol » au moment du stop pouvait encore résoudre et émettre un `tool-result` via le flux, qui continuait alors à `setMessages`.

- **Modifications effectuées :**
  - **`src/components/ai/AiPanel.tsx`** :
    - Nouvelle ref `runSeqRef` (numéro de génération). Incrémentée **au début de `handleSend`** (avant l'abort du run précédent) et **dans `handleStop`**. `handleEvent` capture son `runSeq` et **ignore tout event** dont le numéro ne correspond plus au courant. Un run annulé/remplacé ne peut plus toucher le fil.
  - **`src/components/ai/ToolCallCard.tsx`** : `todo_write` et `todo_read` sont **entièrement masqués** du fil (retour `null` en tête du composant). La checklist reste visible via la `PinnedTodoList` épinglée (pattern Focus Chain).
  - **`src/lib/ai.ts`** (`DEFAULT_SYSTEM_PROMPT` et `_LITE`) : la consigne devient **conditionnelle** (« For a task that will take several steps ») au lieu d'un « FIRST » obligatoire ; ajout « skip for a quick single-step request » et **« do not restate the list in your reply — the user already sees it »**. Objectif : supprimer le round-trip imposé (TTFT) et la redondance texte/UI.
  - **`src/lib/agent/tools.ts`** : description de `todo_write` alignée (usage pour tâche multi-étapes, jamais de répétition dans la réponse).
  - **`src/lib/agent/run.ts`** : nouvelle enveloppe `emit(event)` qui **n'émet plus aucun event après l'abort** (défense en profondeur, en plus de la garde côté AiPanel).

- **Décisions Techniques :**
  - **Garde de génération (`runSeq`) plutôt qu'un flag booléen** : un compteur couvre à la fois le *stop* et le *remplacement de run* (nouvel envoi pendant un run précédent), sans risque de course sur un booléen remis à zéro.
  - **Todo masquée, pas supprimée** : on garde l'outil (l'agent s'en sert pour raisonner) et l'état réactif (l'UI l'affiche), on retire seulement le bruit visuel — exactement la séparation « état d'UI vs tool-call » de Cline.
  - **Prompt conditionnel** : on ne force plus un tool-call de plan pour une tâche en une étape (coût TTFT inutile). La discipline « une seule tâche in_progress, cocher immédiatement » est conservée pour les vraies tâches multi-étapes.

- **Impacts & Dépendances :**
  - `runSeqRef` est local à AiPanel : aucun changement d'API publique. `handleEvent` reste synchrone.
  - `emit` dans `runAgent` remplace `onEvent` **uniquement dans le flux** ; les events de retry/erreur de la boucle externe conservent leur comportement (la boucle vérifie déjà `aborted`).
  - Le masquage UI ne change **pas** le message persisté : `buildModelHistory` continue d'inclure les `todo_write`/`tool-result` (le modèle garde sa mémoire de la checklist).

- **Prochaines étapes :**
  - Test manuel : (1) envoyer une demande simple → vérifier que le TTFT est court (pas de round-trip todo) ; (2) demander une tâche multi-étapes → vérifier la checklist épinglée qui progresse sans `todo_write` visible dans le fil ; (3) Stop en plein run → vérifier que le fil ne bouge plus.

### [2026-10-15T19:00] | Questions de l'agent dockées au-dessus de l'input (style Trae)

- **Contexte :**
  Demande utilisateur : *« pour les questions ça doit être au-dessus de l'input proprement, où l'utilisateur choisit parmi trois choix, et il y a "Other" à la fin comme sur Trae »*. Le `ask_user` existait mais sa carte s'affichait **dans le fil** : quand l'agent mettait le run en pause sur une question, l'utilisateur — qui regarde l'input — pouvait la manquer, surtout si elle était remontée par le scroll. L'objectif est de reproduire le pattern « Ask User » des agents modernes : options cliquables + échappatoire « Other » (réponse libre), au plus près de l'endroit où l'utilisateur agit.

- **Modifications effectuées :**
  - **`src/components/ai/QuestionPrompt.tsx`** (nouveau) : composant docké. Question courte, options numérotées cliquables (2–4), puis une entrée **« Other… »** toujours en dernier qui ouvre un champ de saisie libre (Entrée = envoyer, Échap = annuler). Une fois une option choisie, les autres se désélectionnent visuellement (état figé le temps que le run reprenne).
  - **`src/components/ai/AiPanel.tsx`** :
    - Nouvel état `pendingQuestion: { id, question, options, answer }`. Alimenté dans le handler `approval-required` **uniquement** pour `action.type === "ask_user"` ; la réponse invoque `event.reject(answer)` (chemin qui transmet la réponse au tool) puis purge l'état.
    - Nettoyage de `pendingQuestion` dans `approval-resolved` (si résolu par un autre chemin) et dans `handleStop` (une question sans run vivant n'a plus de sens).
    - Rendu `<QuestionPrompt>` **au-dessus de l'input**, dans les deux vues concernées : conversation active et écran « new chat ».
  - **`src/components/ai/ToolCallCard.tsx`** : pour une question **active**, la carte interactive dans le fil est **remplacée** par une simple ligne « Asked a question » (traçabilité, sans doublon). Une question **déjà répondue** conserve la carte figée question + réponse (historique lisible).
  - **`src/lib/agent/run.ts`** : le type de l'event `approval-required` exposait `reject: () => void` alors que le tool `ask_user` appelle `reject(answer)`. Corrigé en `reject: (answer?: string) => void` — le contrat réel (transmettre la réponse) est désormais typé, plus de cast.

- **Décisions Techniques :**
  - **Un seul point de saisie** : la question est rendue près de l'input et retirée du fil (remplacée par un marqueur) ⇒ pas d'ambiguïté sur « où répondre », pas de double rendu interactif du même tool call.
  - **`Other` toujours présent** : même quand l'agent propose des options, l'utilisateur n'est jamais enfermé. Correspond au pattern documenté par les toolkits « Ask User » (Odin AI : *« clickable suggestion chips plus a Custom free-text field at the bottom »*).
  - Le composant est **présentationnel** ; toute la logique de résolution (reject → resolve du tool → reprise du run) reste dans AiPanel, au même titre que les autres approbations.

- **Impacts & Dépendances :**
  - `AgentEvent["approval-required"].reject` gagne un paramètre optionnel : compatible avec tous les appelants existants (edit / write_file / bash passent `() => resolve(...)`, ce qui reste valide).
  - La carte `AskUserCard` reste utilisée pour l'état **répondu** dans le fil ; elle n'est plus le point de saisie.
  - Une question ne peut être posée qu'une à la fois (`ask_user` met le run en pause) ⇒ un unique `pendingQuestion` suffit, pas de file.

- **Prochaines étapes :**
  - Test manuel : provoquer un `ask_user` (intention ambiguë) → vérifier que la question apparaît juste au-dessus de l'input, que « Other… » ouvre bien la saisie libre, et qu'après réponse le run reprend et que le fil montre la question répondue.

### [2026-10-15T18:50] | Revert multi-tours + confirmation pro (liste des fichiers avant action)

- **Contexte :**
  Signalement utilisateur : *« l'icône revert ne marche pas, ça ne supprime pas tous les fichiers et dossiers créés »*. Deux défauts distincts : (1) **seul le dernier tour était annulé** — chaque `beginTurn` purgeait le checkpoint précédent (`discardTurnCheckpoint(prev)`), donc un run couvrant plusieurs envois laissait sur disque tout ce qui avait été créé avant le dernier message ; (2) **aucune visibilité** sur ce qu'un revert allait détruire : action destructive déclenchée sans confirmation.

- **Modifications effectuées :**
  - **`src-tauri/src/checkpoint.rs`** : nouvelles primitives multi-tours.
    - `RevertAction { Delete, Restore }` + `RevertPlanEntry { path, action, turns }`.
    - `collect_revert_plan(root, turn_ids, workspace_root)` : **fusionne les manifestes** de tous les tours, déduplique par chemin (**le premier snapshot gagne** → un chemin vu « créé » reste `Delete` même touché plus tard), compte les `turns` ayant touché chaque chemin. **Aucune écriture** (dry-run).
    - `prune_empty_dirs(path, workspace_root)` : remonte les parents, ne supprime que les dossiers **vides**, s'arrête à la racine du workspace (jamais supprimée).
    - Commandes `checkpoint_revert_preview` (dry-run) et `checkpoint_undo_many` (applique le plan : `Delete` → suppression + élagage ; `Restore` → copie du backup d'origine, puis purge des checkpoints consommés).
  - **`src-tauri/src/lib.rs`** : enregistrement des deux commandes.
  - **`src/lib/turnCheckpoint.ts`** : façade `previewRevertTurns()` / `revertTurns()` + types `RevertAction`, `RevertPlanEntry`.
  - **`src/components/ai/AiPanel.tsx`** :
    - `beginTurn(userIndex)` **ne purge plus** l'ancien checkpoint ; il associe chaque `turnId` à l'**index du message utilisateur** déclencheur (`turnIdsByUserIndexRef: Map<number, string[]>`).
    - `collectTurnIdsFrom(userIndex)` rassemble tous les tours générés depuis un message.
    - `handleRevertUserMessage` : `previewRevertTurns` → si le plan est vide, simple troncature ; sinon ouverture du dialogue de confirmation.
    - `handleConfirmRevert` : `revertTurns` (tous les tours) → purge de l'état local → toast → troncature du fil.
    - `handleUndoAll` (bannière) réécrit pour cibler **tous les tours du dernier run** via le **même** dialogue de confirmation.
  - **`src/components/ai/RevertConfirmDialog.tsx`** (nouveau) : dialogue présentant le plan groupé en « Will be deleted » (fichiers créés, en rouge) et « Will be restored » (fichiers modifiés), compteurs, liste bornée avec « + N more », rappel du risque, boutons Cancel / Revert.

- **Décisions Techniques :**
  - **Un plan, deux usages** : la prévisualisation et l'exécution partagent `collect_revert_plan` → garantie « ce que voit l'utilisateur = ce qui sera appliqué », sans divergence possible entre l'aperçu et l'action.
  - **Le premier snapshot gagne** : si un chemin a été créé puis remodifié dans un tour ultérieur du même run, le classer `Delete` est le seul comportement correct (sinon on restaure un fichier qui n'aurait jamais dû exister).
  - **Élagage prudent** : seuls les dossiers **vides** sont supprimés, et jamais la racine du workspace. Pas de `remove_dir_all`.
  - Dialogue rendu au niveau racine (`fixed`, z-index 60) plutôt qu'inline, pour rester au-dessus de tout le panneau.

- **Impacts & Dépendances :**
  - `undoTurnCheckpoint` reste exporté (compat) mais **n'est plus utilisé** par AiPanel ⇒ point d'attention : un futur nettoyage pourra le retirer si aucun autre appelant n'apparaît.
  - `checkpointBanner` ne stocke qu'un `turnId` : la bannière n'affiche que le résumé du **dernier** tour, mais son « Undo all » agit désormais sur **tout le run**. C'est volontaire (le run est l'unité de revert).

- **Prochaines étapes :**
  - Test manuel : run créant un dossier + plusieurs fichiers sur plusieurs envois → Revert depuis le message d'origine → vérifier que fichiers **et** dossiers créés disparaissent, que les fichiers modifiés reviennent à leur état initial, et que le dialogue liste bien les deux catégories avant action.

### [2026-10-15T22:40] | Orchestration intelligente — la délégation devient une évidence, pas une règle

- **Contexte :**
  Le câblage du suivi était correct et les tests verts, mais **rien ne se déclenchait en usage réel** : le root n'appelait presque jamais `spawn_agent`. Deux causes racines : (1) le prompt de délégation était timide (« never as a mandatory first step »), (2) le root **ignorait son propre budget de contexte**, donc ne ressentait aucune pression à déléguer. Le suivi « existait » mais restait invisible faute de déclenchement. Contrainte utilisateur : *« je veux un truc d'intelligent pas un truc codé à la main »* → interdiction de seuil hardcodé.

- **Modifications effectuées :**
  - **`src/lib/ai.ts`** : `DELEGATION_GUIDANCE` recadré en **principe d'économie de contexte** (asymétrie : le transcript d'un sous-agent n'entre jamais dans le contexte du root, seul le rapport borné). La décision devient un jugement de coût relatif, pas un compteur.
  - **`src/lib/agent/tokenBudget.ts`** : nouvelle fonction `contextStatusPrompt(messages, budget)` → produit un bloc « état du contexte réel » (budget, tokens consommés, %, niveau de pression : *comfortable / getting full / critically full*) avec pour chaque niveau un conseil orienté délégation.
  - **`src/components/ai/AiPanel.tsx`** : en branche mode IA, ce bloc est injecté dans le **prompt système du root** (`rootSystemPrompt`). Le modèle connaît sa contrainte et **en déduit** la délégation. Ajout d'une ref `spawnedThisTurnRef` : comptée au `subagent-start`, remise à zéro au début du tour.
  - **`src/lib/aiTypes.ts`** + **`src/components/ai/StatusNotice.tsx`** : `MessagePart["status"].kind` étendu à `"orchestration"` ; `StatusNotice` affiche une ligne repliable « Orchestration » (icône `Network`), libellés factorisés.
  - **`src/components/ai/AiPanel.tsx` (`case "finish"`)** : si `spawnedThisTurnRef.current > 0`, une part `status/orchestration` est **ajoutée au corps final** (donc persistée) : « N sous-agents ont travaillé pour ce tour. » Aucune ligne si le root a tout fait seul — journal, pas injonction.

- **Décisions Techniques :**
  - Traiter la cause **cognitive** (le modèle ne *savait pas* qu'il devait économiser) plutôt que d'imposer un seuil. Un seuil « > X fichiers → délègue » serait faux sur les petits comme sur les gros dépôts ; la conscience du budget se généralise.
  - Trace **conditionnelle** : on ne journalise que les tours **avec** délégation, pour rester discret et ne pas transformer un choix légitime (faire soi-même) en avertissement.

- **Impacts & Dépendances :**
  - `MessagePart` gagne une valeur de `kind` → tout consommateur de parts `status` doit tolérer `"orchestration"` (`StatusNotice` mis à jour ; `MessageBubble` passe simplement le `kind`).
  - Le bloc contexte est **borné** et n'est injecté **qu'avec** l'outil `spawn_agent` disponible → aucun surcoût en mode IDE mono-agent.

- **Prochaines étapes :**
  - Validation visuelle en mode IA (carte qui progresse, texte live, onglet Agents, ligne d'orchestration en fin de tour).
  - **Lot 2 = équipes d'agents** (non démarré).

### [2026-10-15T20:22] | Correctif — suivi des sous-agents cassé (spawnId, tokens fuyants)

- **Contexte :**
  En test réel, les sous-agents « ne se coordonnaient pas » et le **suivi était absents** : cartes bloquées, aucune progression, et le fil du root se faisait polluer. Quatre défauts distincts, tous sur le chemin du suivi.

- **Modifications effectuées :**
  - **`src/lib/agent/spawnRuntime.ts`** : le `spawnId` est désormais **généré par l'hôte** (une seule fois) et transmis à `runSubAgent`. Il était auparavant émis à `""` par l'hôte, tandis que `runSubAgent` en générait un second, distinct → **deux entrées** dans le store et une carte fantôme jamais clôturée.
  - **`src/lib/agent/subagent.ts`** : `spawnId` reçu en option (plus généré ici) ; **suppression** de l'émission `subagent-start` (réservée à l'hôte). Ajout d'un `subagent-step` routé à chaque tour (avec total **cumulé** via `baseIterations`) → progression visible. Les events enfants sont routés avec le `spawnId` fourni.
  - **`src/components/ai/AiPanel.tsx`** : les branches `token` et `reasoning` **routent** désormais par `event.spawnId` — sans ça, les tokens d'un sous-agent s'ajoutaient au message du **root**, cassant la garantie « le root ne reçoit que le rapport borné ». Ajout de `appendChildStream` (flux live borné à 8 000 chars, on garde la fin).
  - **`src/lib/aiTypes.ts`** : `SubAgentChild.stream?: string` (texte live du sous-agent).
  - **`src/components/ai/SubAgentCard.tsx`** : pendant le run, la carte affiche le `stream` live (encadré pointillé, 240 px) ; le rapport final le remplace. `streamTail()` borne l'affichage.
  - **`src/lib/agent/__tests__/subagentEvents.test.ts`** (nouveau) : 4 tests verrouillant le contrat (`runSubAgent` n'émet jamais `subagent-start`, route avec le spawnId fourni, émet `subagent-step`, clôt par `subagent-end`).

- **Décisions Techniques :**
  Le `spawnId` a **un seul propriétaire : l'hôte.** Le moteur du sous-agent ne fait que router avec l'id reçu. Cette séparation supprime toute possibilité de divergence d'identifiant entre la carte (UI) et le flux d'events. Les tokens du sous-agent ne sont **jamais** injectés dans le fil du root (conformité au design Cline : seul le rapport borné remonte).

- **Impacts & Dépendances :**
  `spawnRuntime.ts`, `subagent.ts`, `AiPanel.tsx`, `aiTypes.ts`, `SubAgentCard.tsx`. Le store (`swarmStore.ts`) reste inchangé. **Breaking interne** : `runSubAgent` exige désormais `spawnId` (seul appelant : `spawnRuntime.ts`).

- **Prochaines étapes :**
  Valider visuellement en mode IA : carte qui progresse (steps), texte live pendant le run, rapport à la fin, onglet Agents cohérent. Lot 2 (équipes) toujours non démarré.

---

### [2026-10-15T20:35] | Revue de fichiers type Trae (barre repliable + liste détaillée)

- **Contexte :**
  La `TurnCheckpointCard` affichait en permanence la liste complète des fichiers modifiés, ce qui alourdissait le fil. Trae/Cursor affichent un **bloc compact repliable** (« N files changed · +N -N ») qui déplie la liste, plus une occurrence **juste au-dessus de l'input**.

- **Modifications effectuées :**
  - **`src/components/ai/TurnReviewCard.tsx`** (nouveau, remplace `TurnCheckpointCard.tsx` supprimé) : barre de statut **repliable** (pastille icône + « N file(s) changed » + `chevrons-up-down` + delta cumulé `+N -N` + chevron rotatif). Repliée par défaut ; déplie la liste détaillée (une ligne par fichier : créer/modifier, nom, chemin, `+N -N`, chevron) et le pied « N files to review » + « Undo all » / « Keep all ». Prop `docked` (marges nulles, rendu au-dessus de l'input) et `defaultExpanded`.
  - **`sumDelta(files)`** exporté : delta cumulé, testable sans monter le composant.
  - **`src/components/ai/AiPanel.tsx`** : le bloc est rendu **aux deux endroits** (exigence utilisateur) — une fois dans le fil, une fois **juste au-dessus de l'input** (`docked`), placé après `PinnedTodoList`. Import mis à jour.
  - **`src/components/ai/__tests__/TurnReviewCard.test.ts`** (nouveau) : 3 tests de `sumDelta` (somme, liste vide, fichier créé).

- **Décisions Techniques :**
  Un **seul** composant paramétré par `docked`/`defaultExpanded` plutôt que deux blocs dupliqués : une seule source de vérité pour le rendu et les actions. Delta cumulé calculé côté front (`sumDelta`) à partir du résumé Rust déjà chargé, aucune lecture disque supplémentaire. La carte du fil démarre **repliée** pour ne pas noyer la conversation ; celle au-dessus de l'input reste repliée aussi et se déplie au clic.

- **Impacts & Dépendances :**
  `AiPanel.tsx` (import + emplacement), suppression de `TurnCheckpointCard.tsx`. Réutilise `TurnFileDelta` et les handlers `handleUndoAll`/`handleKeepAll`/`handleOpenCheckpointDiff` existants — aucun changement du protocole checkpoint Rust.

- **Prochaines étapes :**
  Vérifier visuellement le rendu replié/déplié dans les deux thèmes ; éventuellement mémoriser l'état déplié par tour (aujourd'hui réinitialisé à chaque tour).

---

### [2026-10-15T20:05] | File d'attente de messages (message queue) pendant un tour

- **Contexte :**
  Jusqu'ici, écrire pendant qu'un tour streamait **annulait** implicitement le comportement attendu : l'utilisateur ne pouvait pas préparer son message suivant. Trae/Cursor permettent de saisir un message pendant le run ; celui-ci est **mis en attente** et **envoyé automatiquement** dès la fin du tour, avec un bandeau visible et des actions éditer/retirer.

- **Modifications effectuées :**
  - **`src/lib/agent/messageQueue.ts`** (nouveau) : logique **pure** (sans React) `enqueueMessage` / `dequeueMessage` / `hasQueued`. Modèle de file = **un seul message en attente** (un nouvel envoi écrase le précédent), comme Trae.
  - **`src/lib/aiTypes.ts`** : ajout du type `QueuedMessage` (`text`, `modelId`, `providerId`, `fileMentions`, `editorContext`, `mode`).
  - **`src/components/ai/ChatBox.tsx`** : props `queued`, `onQueue`, `onRemoveQueued`, `onEditQueued`. Dans `handleSend`, si `isStreaming` et `onQueue` renvoie `true`, le message est **mis en file** au lieu d'être envoyé. Rendu d'un **bandeau « Waiting to send... »** au-dessus de l'input (ligne 1 = texte + `Pencil`/`Trash2`, ligne 2 = statut).
  - **`src/components/ai/AiPanel.tsx`** : état `queuedMessage` ; refs `handleSendRef`, `queuedMessageRef`, `dequeuingRef`, `flushQueueRef` (pattern « ref mirroring » pour éviter les closures obsolètes dans les handlers stables). `handleQueue` / `flushQueue` / `handleRemoveQueued` / `handleEditQueued`. Dépilage appelé dans `case "finish"`, `case "error"` et `handleStop`.
  - **`src/lib/agent/__tests__/messageQueue.test.ts`** (nouveau) : 5 tests (mise en file, écrasement, dépilage, file vide, `hasQueued`).

- **Décisions Techniques :**
  File **mono-message** : empiler plusieurs envois contradictoires pendant un run est source de confusion et de coût tokens inutile ; écraser le précédent est le comportement le plus prévisible. `flushQueue` est déclenché **après** la retombée de `streaming` (via `setTimeout(0)` + garde `dequeuingRef`) pour que `isStreaming` soit recalculé avant le nouvel envoi et éviter un **double envoi** quand plusieurs signaux de fin se chevauchent (`finish` + `flush` tardif, `stop` + `error`). `handleStop` enchaîne explicitement : l'utilisateur a saisi son message en connaissance de cause.

- **Impacts & Dépendances :**
  `ChatBox.tsx` (props + bandeau), `AiPanel.tsx` (état/refs/handlers + 2 rendus de `ChatBox`), `aiTypes.ts`, `messageQueue.ts`. Aucune modification du protocole de stream. Les deux rendus de `ChatBox` (IDE + plein écran) reçoivent les mêmes props de file.

- **Prochaines étapes :**
  Vérifier visuellement le rendu du bandeau dans les deux thèmes ; envisager (non demandé) une file **multi-messages** si le besoin remonte.

---

### [2026-10-15T19:05] | Orchestration Lot 1 — sous-agents spécialisés pilotés par les données

- **Contexte :**
  Les sous-agents livrés précédemment étaient **figés** : un seul rôle codé en dur (« Search Agent »), un schéma `{ systemPrompt, task }` qui permettait au modèle de **réécrire ses propres règles**, aucun contexte projet, et aucune consigne de délégation dans le prompt du root. Objectif validé : un système qui **s'orchestre proprement selon le projet et la tâche**, sans rien hardcoder. Découpage accepté : **Lot 1 = sous-agents spécialisés**, Lot 2 = équipes (reporté).

- **Modifications effectuées :**
  - **`src/lib/agent/subagentRoles.ts`** (nouveau) : **catalogue déclaratif** des rôles. `ROLES` = entrées `{ id, label, icon, description, systemPrompt, tools (allowlist), budget }` ; 5 rôles (`explore`, `analyze`, `review`, `test`, `docs`). Exports `listRoles()`, `roleIds()`, `resolveRole()`, `rolesCatalogPrompt()`. Ajouter un rôle = ajouter une entrée, **aucun autre fichier à toucher**.
  - **`src/lib/agent/projectContext.ts`** (nouveau) : contexte projet **dérivé** (stack + arbo profondeur 2 + fichiers clés), **strictement borné** à `MAX_CONTEXT_CHARS = 2_400`, mis en cache et invalidé par tour (`resetProjectContext`). Jamais bloquant.
  - **`src/lib/agent/tools.ts`** : `createReadOnlyToolset({ folderPath, allow })` — l'allowlist d'un rôle est **appliquée** (le rôle ne peut pas dépasser ses outils).
  - **`src/lib/agent/subagent.ts`** (réécrit) : `runSubAgent` **paramétré par rôle** ; budget lu dans le rôle ; **relance bornée** (`MAX_REPORT_ATTEMPTS = 2`) si le rapport est inexploitable ; tokens de retry non retransmis au fil.
  - **`src/lib/agent/spawnRuntime.ts`** (réécrit) : schéma **`{ role, task, context_notes }`**. Le modèle **ne fournit plus de `systemPrompt`** (anti-réécriture des règles). L'hôte résout le rôle, assemble le bloc de contexte et n'expose au root que le **rapport borné**.
  - **`src/lib/ai.ts`** : `DELEGATION_GUIDANCE` + catalogue de rôles injectés dans les prompts système du root (`DEFAULT_SYSTEM_PROMPT`, `_LITE`).
  - **`src/components/ai/roleIcon.tsx`** (nouveau) : `renderRoleIcon(label, props)` résout l'icône lucide du rôle (table locale, pas d'`import *`). Consommé par `SubAgentCard` et `AgentPanel` pour afficher le **rôle réel** (label + icône).
  - **`src/lib/agent/__tests__/subagentRoles.test.ts`** (nouveau) : 11 tests (forme du catalogue, allowlist read-only, résolution d'entrée hostile, borne de contexte).

- **Décisions Techniques :**
  Spécialisation portée par des **données** (catalogue) et non par le modèle : le root choisit un `role`, l'hôte décide prompt/outils/budget. Le contexte est injecté **côté hôte** (jamais fourni par le modèle) pour éviter l'injection de faux contexte. Les rôles restent **read-only** par construction (allowlist ⊂ outils read-only). UI en **rendu** (`renderRoleIcon`) et non en composant résolu pendant le render — sinon `react-hooks/static-components`.

- **Impacts & Dépendances :**
  `subagent.ts`, `spawnRuntime.ts`, `ai.ts`, `tools.ts`, `AiPanel.tsx`, `SubAgentCard.tsx`, `AgentPanel.tsx`. Suppression des constantes figées (`SUBAGENT_MAX_STEPS`, `DEFAULT_SUBAGENT_ROLE`, `SUBAGENT_SYSTEM_PROMPT`). Le mode IDE reste **inchangé** (aucun `spawn_agent` exposé).

- **Corrections trouvées par les tests (sécurité) :**
  - **Prototype pollution / contournement de rôle** : `resolveRole` utilisait `rawId in ROLES`, qui matche `"__proto__"` et `"constructor"` via la chaîne de prototypes → renvoyait un objet **non-rôle** (budget/outils/prompt absents). Corrigé avec `Object.hasOwn`. Un modèle hostile ne peut plus sortir du catalogue.
  - **Dépassement de borne** : `buildContextBlock` dépassait `MAX_CONTEXT_CHARS` de 1 caractère (ellipsis non compté). Corrigé pour une borne **dure**.

- **Prochaines étapes :**
  Lot 2 (équipes d'agents : liste de tâches partagée + messagerie inter-agents) — **à valider explicitement avant démarrage**, coût tokens supérieur. Vérifier visuellement le rendu des cartes par rôle dans les deux thèmes.

---

### [2026-10-15T19:35] | Style prose (tirets longs) + todo list obligatoire et coche automatique

- **Contexte :**
  Trois demandes : (1) l'agent produisait des tirets longs `—`/`–` dans ses réponses, jugés non désirés ; (2) l'agent ne créait pas systématiquement de todo list, contrairement à Trae ; (3) la checklist devait se cocher seule au fil du run, proprement.

- **Modifications effectuées :**
  - **`src/lib/ai.ts`** :
    - `STYLE_GUARDRAIL` interdit désormais explicitement les tirets em/en (`— –`) au même titre que les emojis (réponses, items de todo, commits, fichiers générés).
    - `DEFAULT_SYSTEM_PROMPT` : l'obligation devient « ALWAYS start any task that requires more than one tool call by calling todo_write FIRST », avec consigne de cocher **dans le tool call suivant** chaque étape terminée (jamais en lot).
    - `DEFAULT_SYSTEM_PROMPT_LITE` : durcissement symétrique.
  - **`src/lib/textStyle.ts`** : `stripDecorativeEmojis` renommé `sanitizeProse` ; normalise `— – ―` en `-` (avec gestion des espaces adjacents) et supprime les espaces de fin de ligne, le tout **hors** blocs de code et code inline. Filet de sécurité côté rendu.
  - **`src/components/ai/MarkdownMessage.tsx`** : appel `sanitizeProse`.
  - **`src/lib/agent/todoStore.ts`** : nouvelle fonction `finalizeTodos(sessionId)` — marque `done` les items restés `pending`/`in_progress`, sans jamais toucher aux `cancelled`.
  - **`src/components/ai/AiPanel.tsx`** : `finalizeTodos` appelé à la clôture du tour (event `finish`, après passage de `streaming` à `false`).
  - **Tests ajoutés** : `src/lib/__tests__/textStyle.test.ts` et `src/lib/agent/__tests__/todoStore.test.ts`.

- **Décisions Techniques :**
  Double barrière, comme pour les emojis : **prévention** (prompt durci) + **filet** (nettoyage au rendu), car un modèle peut toujours dériver. La coche automatique est un **filet déterministe**, pas un pilotage du modèle : elle s'exécute uniquement à la fin réelle du tour (`finish`), donc jamais pendant une attente d'approbation (tool bloquant → pas de `finish`). Ce choix évite d'afficher une checklist « terminée » alors que l'agent est suspendu. La fonction préserve les `cancelled` pour ne pas transformer un abandon volontaire en succès.

- **Impacts & Dépendances :**
  `ai.ts` (prompts), `textStyle.ts` + `MarkdownMessage.tsx` (rendu), `todoStore.ts` + `AiPanel.tsx` (cycle de vie des todos). Le renommage `sanitizeProse` est un breaking change interne, sans consommateur externe (2 sites mis à jour).

- **Prochaines étapes :**
  Surveiller la qualité des todo lists générées (items trop granulaires ou redondants) ; éventuellement fusionner les petites étapes pour éviter une liste à rallonge.

---

### [2026-10-15T19:20] | Chat agent — barre d'actions Agent permanente + fix chevauchement

- **Contexte :**
  Retour visuel : (1) la barre d'actions de l'Agent ne devait **pas** être conditionnée au survol — elle doit rester **visible en permanence** pour être découvrable ; (2) les actions du message utilisateur **chevauchaient le texte** de la bulle.

- **Modifications effectuées :**
  - **`src/components/ai/MessageBubble.tsx`** :
    - `showActions` passe de `hovered && !streaming && !isEmpty && !isUser` à `!streaming && !isEmpty && !isUser` : la barre Agent est affichée en permanence dès que le message est terminé, quel que soit le survol.
    - Les actions utilisateur sont repositionnées **au-dessus** de la bulle (`bottom: calc(100% + 4px)`) au lieu de `top: -8px` à l'intérieur — plus de recouvrement du texte.

- **Décisions Techniques :**
  Asymétrie assumée entre les deux rôles : les actions **Agent** (fond du message, riches : copier/insérer/régénérer/vote + anneau) sont permanentes pour rester découvrables, tandis que les actions **utilisateur** (destructives : éditer/supprimer/revert) restent **au survol** pour ne pas alourdir visuellement la colonne droite. Le `hovered` sur le message utilisateur est conservé, mais n'affecte plus l'Agent.

- **Impacts & Dépendances :**
  `MessageBubble.tsx` uniquement. Le `setHovered` reste utilisé par le bloc utilisateur.

- **Prochaines étapes :**
  Vérifier la densité visuelle lorsque beaucoup de messages Agent sont affichés (barres permanentes visibles simultanément) ; envisager un décalage de la barre dans le flux (reserve de hauteur) si l'espacement paraît irrégulier.

---

### [2026-10-15T19:05] | Chat agent — actions par message au survol (user vs assistant)

- **Contexte :**
  Les actions de message étaient **fixes** (toujours visibles) et identiques pour les deux rôles. Décision produit : les actions doivent apparaître **au survol** et **différer selon le rôle** — un message utilisateur n'a que **trois** actions (éditer, supprimer, revert), placées **en haut à droite, à côté du texte** ; un message assistant conserve la barre complète (copier, insérer, régénérer, 👍, 👎) et l'anneau de contexte, sous le message.

- **Modifications effectuées :**
  - **`src/components/ai/MessageActionsBar.tsx`** : nouvel export `UserMessageActions` (3 icônes : `Pencil`, `Trash2`, `Undo2`) réutilisant `actionBtnStyle`/`actionHover`/`ICON`. Séparation volontaire des deux jeux d'actions pour ne jamais mêler vote/anneau (assistant) aux actions utilisateur. Import lucide étendu (`Trash2`, `Undo2`).
  - **`src/components/ai/MessageBubble.tsx`** : `showActions` restreint à l'assistant (`&& !isUser`) ; la prop `onEdit` est retirée de la barre assistant. Le rendu utilisateur enveloppe la bulle dans un conteneur `position: relative` qui pilote son propre survol et affiche `UserMessageActions` **en haut à droite** (`position: absolute; top: -8px; right: 0`) uniquement quand `hovered && !streaming`. Nouvelles props `onDeleteUserMessage` / `onRevertUserMessage`.
  - **`src/components/ai/AiPanel.tsx`** : `handleDeleteUserMessage` (tronque l'historique depuis le message — `truncateFrom`) et `handleRevertUserMessage` (restaure d'abord les fichiers du checkpoint via `undoTurnCheckpoint`, puis tronque l'historique ; en cas d'échec de restauration on **ne tronque pas** et on remonte l'erreur). Câblage des deux props sur `MessageBubble`.

- **Décisions Techniques :**
  Le revert restaure les fichiers **avant** de tronquer l'historique : l'opération destructive (écriture disque) est faite en premier pour que, si elle échoue, l'utilisateur conserve le contexte visuel du checkpoint et peut réessayer — on évite un état où l'historique disparaît mais les fichiers restent modifiés. Le survol utilisateur est piloté par un conteneur dédié (et non par la racine du message) afin que l'action « au survol du texte » soit anatomiquement juste.

- **Impacts & Dépendances :**
  `MessageActionsBar.tsx`, `MessageBubble.tsx`, `AiPanel.tsx`. Aucun impact sur la persistance. `undoTurnCheckpoint`/`discardTurnCheckpoint` étaient déjà importés dans `AiPanel.tsx`.

- **Prochaines étapes :**
  Vérifier visuellement le placement des trois icônes sur les bulles courtes (risque de chevauchement du message précédent avec `top: -8px`) ; envisager une confirmation pour « supprimer ».

---

### [2026-10-15T18:55] | Chat agent — bulles alignées Trae + restoration du sous-agent

- **Contexte :**
  Aligner la zone de conversation sur le rendu Trae/Cursor : message **utilisateur en haut, aligné à droite, dans une bulle grise sans étiquette** ; réponse **Agent en bas, sans bulle**, introduite par un libellé « Agent » avec logo. Par ailleurs, `vite build` échouait (`DEFAULT_SUBAGENT_ROLE is not exported`) et `tsc` signalait `latestUserText` introuvable — deux artefacts d'un refactor précédent.

- **Modifications effectuées :**
  - **`src/components/ai/MessageBubble.tsx`** : l'étiquette `You/Assistant` est supprimée au profit de deux rendus distincts — (1) user = conteneur `justifyContent: flex-end` + bulle `maxWidth: 85%`, `borderRadius: 12px`, fond `--origin-bg-active`, sans étiquette ; (2) assistant = en-tête `logoCode` (14 px) + libellé `Agent` (12 px, 600), puis le contenu rendu **sans cadre**. Import `logoCode` ajouté.
  - **`src/components/ai/AiPanel.tsx`** : `latestUserText(messages)` (helper inexistant) remplacé par une dérivation locale du dernier message utilisateur, bornée à 1 500 caractères pour le résumé de fil transmis aux sous-agents.
  - **`src/lib/agent/spawnRuntime.ts`** : correction `no-useless-assignment` (`let contextBlock = ""` → `let contextBlock: string`) — l'initialisation était écrasée dans tous les chemins.

- **Décisions Techniques :**
  Le libellé d'agent est rendu **dans la bulle** (et non dans le conteneur de liste) afin qu'il suive le message dans le scroll et lors des citations — cohérent avec le reste des métadonnées de message. La bulle utilisateur est plafonnée à 85 % de largeur pour conserver une gouttière à gauche, comme Trae, sans jamais coller au bord du panneau.

- **Impacts & Dépendances :**
  `MessageBubble.tsx` (rendu) et `AiPanel.tsx` (résumé de fil). Aucun impact sur `toolGroups.ts` ni sur les cartes d'outils. Les messages persistés restent inchangés : seul le rendu évolue.

- **Prochaines étapes :**
  Vérifier visuellement le rendu des messages longs et des citations dans la bulle utilisateur ; surveiller l'alignement sur écrans étroits (< 360 px).

---

### [2026-10-15T18:40] | Orchestration — sous-agents read-only (mode IA uniquement)

- **Contexte :**
  Porter l'agent au niveau Cline/Trae en mode IA : le mode IA cible les projets >2M lignes où un agent seul « se perd » dans l'exploration. Décision validée : orchestration par **sous-agents seuls** (pas d'équipes pour l'instant), sous-agents en **lecture seule + budget dur**, UI **carte repliable style Trae** (ex. `Search Agent │ Étudier le code source Cline ›`) et un **onglet Agents** listant les sous-agents. Contrainte volontaire : en **mode IDE, aucun sous-agent ni équipe** (économie de tokens) — `spawn_agent` n'est **jamais** exposé au modèle en mode IDE.

- **Modifications effectuées :**
  - **`src/lib/agent/run.ts`** : `AgentEvent` étendu de `subagent-start` / `subagent-step` / `subagent-end` ; les 4 events de base (`token`, `reasoning`, `tool-call`, `tool-result`) portent un `spawnId?` optionnel pour **router** les events d'un sous-agent vers son nœud parent. `SubAgentStatus` exporté (`completed | max_iterations | max_tokens | timeout | error | cancelled`). `RunAgentOptions` étendu : `maxSteps?` (défaut 24), `toolTimeoutMs?` (0 = illimité, garde par `Promise.race` par outil), `abortSignal?`, `initialUsage?`, `onSettled?`. Propagation d'abort parent→enfant (`abortSignal.addEventListener("abort", () => controller.abort())`) ; `settle()` **idempotent** appelé à **tous** les points de sortie de la boucle de retry (succès, abort in/out du delay, épuisement des tentatives).
  - **`src/lib/agent/subagent.ts`** (nouveau) : `runSubAgent(opts)` — runner d'un sous-agent. Budgets durs : `SUBAGENT_MAX_STEPS = 12`, `SUBAGENT_MAX_INPUT_TOKENS = 120_000`, `SUBAGENT_TIMEOUT_MS = 180_000`, `SUBAGENT_TOOL_TIMEOUT_MS = 30_000`, `SUBAGENT_REPORT_MAX_CHARS = 4_000`. Tools = `createReadOnlyTools({ folderPath })` exclusivement. Priorité d'issue `timeout > max_tokens > settled`. Émet `subagent-end` via `finalizeReport(text, status)` (note `[sub-agent stopped early: <status>]` si non `completed`, troncature à 4 000 chars).
  - **`src/lib/agent/swarmStore.ts`** (nouveau) : registre observable des sous-agents du tour courant via `useSyncExternalStore` (avec `cachedList` pour la **stabilité de référence**) — `startSubAgent`, `stepSubAgent`, `endSubAgent`, `listSubAgents`, `listActiveSubAgents`, `clearSubAgents`, `useSubAgents`, `useActiveSubAgents`.
  - **`src/lib/agent/spawnRuntime.ts`** (nouveau) : **hôte** du tool `spawn_agent` (intercepté côté hôte, jamais exécuté par le modèle). `wrapSpawnAgent(tools, …)` remplace l'`execute` de `spawn_agent`, émet `subagent-start` (avec `toolCallId`), lance `runSubAgent`, et ne renvoie au root que le **rapport borné**. `spawnAgentTool` = schéma `{ systemPrompt, task }` (calqué Cline) ; **`systemPrompt` accepté mais ignoré** (anti-réécriture des règles par le modèle).
  - **`src/lib/aiTypes.ts`** : `ToolCallDisplay.children?: SubAgentChild[]` ; `SubAgentChild { spawnId, role, task, status?, iterations, inputTokens, outputTokens, report?, tools? }`.
  - **`src/components/ai/SubAgentCard.tsx`** (nouveau) : carte repliable style Trae (spinner / Check / AlertTriangle + `Bot` + `role │ task` + libellé d'issue + chevron) ; déplié = résumé outils + rapport + stats steps/tokens ; `statusLabel`/`isHardStop` distinguent `completed` des arrêts durs.
  - **`src/components/ai/AgentPanel.tsx`** (nouveau) : onglet « Agents » (état vide informatif, header `N sub-agents · X active`, liste des lignes, `VISIBLE_LIMIT = 20`).
  - **`src/components/ai/ToolCallCard.tsx`**, **`MessageBubble.tsx`** : empilent les `SubAgentCard` des `children` sous le tool-call parent (branches running/complete et branche `group`).
  - **`src/components/ai/AgentModeView.tsx`** : `activeToolTab === "agents"` rend `AgentPanel` (retiré de la branche « Coming soon »).
  - **`src/components/ai/AiPanel.tsx`** : `handleEvent` gère `subagent-start/step/end` (attach/maj d'un `SubAgentChild` sur le tool-call parent) ; `tool-call`/`tool-result` **routés par `spawnId`** vers `appendChildTool`/`updateChildTool` ; helpers `mutateChild` ; `clearSubAgents()` au début de tour ; `streamCleanupRef` annule aussi les sous-agents en vol ; `children` **persistés sans leurs `tools`** (allègement de `tool_calls_json`).

- **Décisions Techniques :**
  - **Modèle `spawn_agent` calqué Cline** : l'hôte décide des tools, ils ne sont **jamais** exposés au modèle. Le sous-agent ne peut donc pas escalader ses capacités ; il ne renvoie qu'un **rapport borné** alors que l'hôte conserve le transcript complet.
  - **Profondeur 1 imposée côté hôte** (`enableSpawnAgent: false` dans le toolset du sous-agent) → **anti-récursion par construction**, pas par consigne. C'est le « swarm light » de jcode (seul le root *fan-out*).
  - **Lecture seule + budget dur** : un sous-agent ne peut ni écrire ni exécuter ; les budgets (steps, tokens, timeout) sont **durs** (abort réel), pas incitatifs → maîtrise du coût en tokens sur de très gros dépôts.
  - **Mode IDE sans sous-agents (volontaire)** : `spawn_agent` n'est injecté que dans la branche agent/IA → l'IDE garde un agent unique, économique.
  - **Routage par `spawnId`** plutôt que par canal séparé : un seul flux d'events, le parent sait à quel tool-call rattacher chaque event → UI simple et déterministe.
  - **Persistance allégée** : sauver les `children` **sans** leurs `tools` évite de gonfler la base ; le détail outil reste consultable pendant le tour.

- **Impacts & Dépendances :**
  - Aucune nouvelle dépendance npm. Nouveaux fichiers : `subagent.ts`, `swarmStore.ts`, `spawnRuntime.ts`, `SubAgentCard.tsx`, `AgentPanel.tsx`.
  - Comportement : en mode IA, le root peut déléguer une exploration à un *Search Agent* read-only ; l'utilisateur voit la carte de sous-agent dans le fil et la liste dans l'onglet Agents. Le mode IDE est inchangé (1 agent, pas de sous-agents).
  - Sécurité/abuse : sous-agent sans écriture ni shell ni réseau (tools read-only), profondeur 1, budget en tokens et en temps dur, `systemPrompt` du modèle ignoré, abort parent→enfants.
  - Validation : `npx tsc --noEmit` **exit 0**, `npx eslint` sur les 11 fichiers touchés **exit 0**, `npx vitest run src/lib/agent/__tests__` → **4 fichiers / 54 tests passés**.

- **Prochaines étapes :**
  - Équipes d'agents orchestrées (rôles multiples coordonnés) — **non démarré**, à valider avant implémentation.
  - Éventuel index sémantique du dépôt pour l'exploration >2M lignes — hors périmètre de ce lot.

---

### [2026-10-15T17:35] | Tool calls — accordéon nu (style Trae) + chemins de fichiers cliquables

- **Contexte :**
  Les tool-calls étaient rendus dans des **encadrés** (bordure + fond) qui alourdissaient le fil, à l'inverse du rendu Trae/Cursor : une simple ligne de texte repliable. Demande explicite : accordéon léger `Read 2 files, Searched files 2 times ›`, **sans bordure**, et **le nom de fichier cliquable** ouvre le fichier dans l'éditeur.

- **Modifications effectuées :**
  - **`src/components/ai/ToolGroupCard.tsx`** (réécrit) : accordéon nu — plus de check/icône de statut ni de fond ; texte gris `12px` + chevron `12px`. Déplié, chaque cible est rendue en **police mono cliquable** qui appelle `onOpenFile(path)` (grep/glob restent non cliquables car sans chemin).
  - **`src/components/ai/ToolCallCard.tsx`** : les états `running` et `complete` perdent leur encadré (`baseStyle` → `boxedStyle`, réservé au seul état `approval-required`) ; `complete` affiche le **chemin cliquable** (`stopPropagation` pour ne pas déplier l'accordéon) ; l'état `running` se réduit à une ligne avec spinner. Import `toolIcon` supprimé (plus d'icônes décoratives).
  - **`src/lib/toolGroups.ts`** : nouvelle `combinedGroupLabel(tools)` (agrège les verbes d'un run hétérogène : « Read 2 files, Searched files 2 times ») ; nouvelle `toolTargetPath(tc)` (chemin workspace-relatif exploitable) ; `buildToolRenderers` regroupe désormais **tous** les outils de lecture consécutifs (plus de flush sur changement de verbe).
  - **`src/components/ai/MessageBubble.tsx`** : prop `onOpenFile` descendue vers `ToolCallCard` et `ToolGroupCard`.
  - **`src/components/ai/AiPanel.tsx`** : prop `onOpenFile` ; `handleOpenFile` **résout le chemin relatif en absolu** (les tools travaillent en relatif au workspace) avant d'ouvrir l'onglet.
  - **`src/App.tsx`** + **`src/components/ai/AgentModeView.tsx`** : câblage `onOpenFile → openTabAtLine`.

- **Décisions Techniques :**
  - **Résolution relatif → absolu côté AiPanel** (et non dans l'éditeur) : l'éditeur (`openTab`/`readFile`) consomme des chemins absolus ; les tools produisent du relatif au workspace. La frontière de conversion est donc le panneau, qui seul connaît `folderPath`.
  - **Groupement par run consécutif** (et non par verbe) : c'est ce qui produit l'étiquette combinée de la capture ; un run d'un seul élément retombe en carte individuelle (plus lisible).
  - **Encadré conservé pour `approval-required` uniquement** : cet état est une demande d'action sensible, il doit rester visuellement saillant.
  - **Chemin cliquable avec `stopPropagation`** : cliquer le nom n'ouvre pas l'accordéon ; cliquer ailleurs le déplie — deux intentions distinctes sur la même ligne.

- **Impacts & Dépendances :**
  - Aucune dépendance nouvelle. Harmonisation du chat agent avec le rendu Trae (accordéons nus, chemins actionnables).
  - Validation : `tsc` clean, `eslint src/` **0 erreur** (7 warnings préexistants), vitest **281/281**, `vite build` clean.

- **Prochaines étapes :**
  - Étendre le clic aux cibles `grep`/`glob` (ouvrir une recherche dans le panneau Search) si besoin.

---

- **Contexte :**
  Rappel des manques du chat agent face à Cline/Cursor/Trae, traités en une fois. Quatre constats : (1) le modèle générait des emojis décoratifs (📋 …) dans ses réponses — rien ne l'interdisait ; (2) les **étapes de raisonnement** n'étaient pas visibles ; (3) aucun **indicateur de contexte/tokens** ; (4) pas de **boutons d'action** sur les messages ni d'**auto-scroll intelligent** ; et besoin d'**éditer / renvoyer** un message.

- **Modifications effectuées :**
  - **`src/lib/ai.ts`** : nouvelle constante exportée `STYLE_GUARDRAIL` (interdiction explicite des emojis / symboles Unicode décoratifs dans les réponses, arguments de tools et fichiers générés).
  - **`src/lib/textStyle.ts`** (nouveau) : `stripDecorativeEmojis(text)` — filet défensif au rendu ; **préserve** les blocs ``` ``` et le code inline `` ` `` (ne casse jamais du code légitime).
  - **`src/components/ai/MarkdownMessage.tsx`** : le contenu passe par `stripDecorativeEmojis` avant rendu.
  - **`src/components/ai/AiPanel.tsx`** : `withOriginMd` injecte `STYLE_GUARDRAIL` pour **tous** les modes/prompts custom ; `handleEvent` gère la part `reasoning` ; `contextTokens` (`useMemo` sur `estimateTokensWithOverhead`) ; auto-scroll intelligent (`stickToBottomRef`, tolérance 80 px) + bouton « Descendre » flottant ; refs `chatBoxRef`, `dbIdsRef`, `activeModelIdRef`/`activeProviderIdRef` ; handlers `handleRegenerate`, `handleEditUserMessage`, `handleInsertMessage`, `handleVoteMessage`, `handleMessageAction`, `truncateFrom` ; état `feedbackByIndex`.
  - **`src/lib/agent/run.ts`** : `AgentEvent` étendu d'une variante `reasoning` ; `case "reasoning-delta"` dans la boucle `fullStream` (champ `.text`).
  - **`src/lib/aiTypes.ts`** : `MessagePart` étendu d'une variante `reasoning` ; helper `appendReasoning` (fusion avec la dernière part `reasoning`) ; `DisplayMessage.dbId` (id de la ligne `messages`, pour cibler édition/régénération).
  - **`src/lib/toolGroups.ts`** : `buildToolRenderers` expose les parts `reasoning` (`{ kind: "reasoning", content }`).
  - **`src/components/ai/ReasoningBlock.tsx`** (nouveau) : section repliable (« Raisonnement ») ouverte par défaut pendant le streaming.
  - **`src/components/ai/ContextUsageBar.tsx`** (nouveau) : **anneau circulaire** type Cursor (arc SVG en `strokeDasharray`, 15 px) + `{pct}%` ; couleur vert/orange (≥80 %)/rouge (≥seuil critique), mêmes seuils que la compaction.
  - **`src/components/ai/MessageActionsBar.tsx`** (nouveau) : barre d'actions reproduisant la photo de référence — icônes 15 px sur 26 px, alignées à gauche (**copier · insérer/citer · régénérer (assistant) / éditer (user) · pouce haut · pouce bas**), **anneau de contexte poussé à droite** (`marginLeft:auto`). Vote piloté par le parent.
  - **`src/components/ai/MessageBubble.tsx`** : rendu de la part `reasoning` (`ReasoningBlock`) ; `hasVisibleContent` en tient compte ; barre d'actions sous le contenu (au survol, hors streaming) ; prop `onInsert`.
  - **`src/lib/sessionStore.ts`** : restauration des parts `reasoning` + peuplement de `dbId` depuis la ligne DB.
  - **`src/lib/db.ts`** : `deleteMessagesByIds(sessionId, ids)` — suppression ciblée avec **garde d'appartenance** (`AND session_id = ?`), pour éditer/régénérer sans risque de suppression croisée entre sessions.
  - **`src/components/ai/ChatBox.tsx`** : API impérative `ChatBoxHandle.setText` (via `handleRef`) pour « éditer et renvoyer » / « citer ».
  - **Suppression** : `src/lib/agent/subagent.ts` (ébauche non câblée, cassait `tsc`).

- **Décisions Techniques :**
  - **Anti-emoji à deux niveaux** : *prévention* (consigne système) + *filet* au rendu. La consigne seule est peu fiable (le modèle peut désobéir) ; le filet seul salirait le code. Le filet **épargne le code** pour ne jamais altérer un contenu légitime.
  - **Jauge de contexte = anneau circulaire** (et non barre) pour coller à la référence visuelle demandée ; réutilise `estimateTokensWithOverhead` + les seuils de compaction → cohérence avec le comportement réel (l'utilisateur voit ce qui déclenchera la compaction).
  - **Anneau affiché uniquement sur le dernier message** : il reflète l'état courant, pas un historique par message (évite la redondance visuelle).
  - **« Insérer » = citer** : Cursor utilise cette icône pour « repartir de ce message ». Faute d'API d'insertion directe dans l'éditeur, la traduction la plus honnête et utile est **citer le message dans le ChatBox** (réponse contextuelle), pas un bouton mort.
  - **Vote éphémère en session** : aucun envoi télémétrique sortant (pas de nouvelle surface de fuite) ; l'état est purement visuel.
  - **Troncature par ids DB indexés** : édition/régénération suppriment proprement les messages postérieurs, avec garde d'appartenance à la session — pas de suppression croisée.

- **Impacts & Dépendances :**
  - Aucune nouvelle dépendance npm. Nouveaux composants : `textStyle.ts`, `MessageActionsBar.tsx`, `ContextUsageBar.tsx`, `ReasoningBlock.tsx`. `db.ts` expose `deleteMessagesByIds`.
  - Comportement : le raisonnement du modèle (si fourni par le provider Orvyx) est désormais visible et repliable ; les réponses ne contiennent plus d'emojis décoratifs ; chaque message propose ses actions au survol.
  - Validation : `tsc --noEmit --incremental false` clean, `eslint src/` **0 erreur** (7 warnings préexistants hors périmètre), vitest **281/281**, `vite build` clean.

- **Prochaines étapes :**
  - Persister un éventuel vote (feedback) si un canal de télémétrie produit est décidé — actuellement volontairement éphémère.

---

- **Contexte :**
  Dernier lot du rapprochement Cline/Cursor/Trae. Trois besoins : (1) un **système de permission** calqué sur Trae (`Manual`/`Auto`/`Full Access`) et Cline (permissions *tiered* + *conditionnelles*), sans introduire un second modèle « juge » ; (2) rendre la **compaction visible** dans le fil (comme Trae affiche « Compaction de l'historique… ») et la déclencher **réactivement en fin de tour** dès que l'usage projeté franchit 80 % ; (3) une **télémétrie discrète** du nombre de compactions / reprises.

- **Modifications effectuées :**
  - **`src/lib/agent/permissions.ts`** (nouveau) : `PermissionMode = "manual"|"auto"|"full"`, clé `origin-ai-permission-mode`, défaut `manual`. `decideApproval(action, ctx)` par **règles déterministes** : garde anti-catastrophe brut→`block` (fork bomb, `rm -rf /` et `/*`, `mkfs`, `dd of=/dev/…`, écriture disque brute, `shutdown/reboot`, `chmod 777 /`) **prioritaire sur tous les modes** ; `full`→`approve` ; `ask_user`→toujours `ask` ; `manual` : écriture/exec→`ask` sinon `approve` ; `auto` : écriture **dans le workspace**→`approve`, hors workspace/bash→`ask`. Helpers `isWriteAction`, `actionPath`, `normalizePath`, `isInsideWorkspace` (casse/séparateurs normalisés). `PERMISSION_MODE_INFO`, `loadPermissionMode`/`savePermissionMode`.
  - **`src/lib/agent/tokenBudget.ts`** : ajout `projectedUsage(messages, marginTokens, budget)` et `shouldPreCompact(...)` — pré-compaction **réactive** : l'usage projeté (historique + marge du tour suivant) ≥ seuil 80 %.
  - **`src/lib/agent/run.ts`** : `AgentEvent` étendu (`approval-resolved`, `notice{kind:"compaction"|"retry"}`). Bloc budget : émet un `notice` de compaction quand l'historique est réellement réduit (avec tokens économisés) ; boucle retry : émet un `notice` de reprise avant le keep-alive.
  - **`src/lib/aiTypes.ts`** : `MessagePart` étendu d'une variante `status` (`kind`, `detail`, `savedTokens?`).
  - **`src/components/ai/StatusNotice.tsx`** (nouveau) : bannière in-line repliable « Compaction de l'historique » / « Reprise automatique » (chevron, icône, tokens économisés).
  - **`src/components/ai/MessageBubble.tsx`** : rendu de la part `status` via `StatusNotice` ; `hasVisibleContent` tient compte des parts `status`.
  - **`src/lib/toolGroups.ts`** : `buildToolRenderers` expose les parts `status` (`{ kind: "status", part }`).
  - **`src/lib/sessionStore.ts`** : la restauration préserve désormais les parts `status` et `plan-card` (avant, tout non-`tool-call` était écrasé en `text`).
  - **`src/components/ai/AiPanel.tsx`** : `onApproval` décide via `decideApproval` (mode lu à l'instant T) — `block`→toast+reject, `approve`→exécution directe, `ask`→carte ; `handleEvent` gère `approval-resolved` (fige l'état) et `notice` (crée la part `status` + incrémente la télémétrie) ; **pré-compaction réactive en fin de tour** (usage projeté ≥80 % → `compactHistory` + `notice`, marge 16k) ; **indicateur de télémétrie** discret en pied de fil ; reset des compteurs par tour.
  - **`src/components/ai/ChatBox.tsx`** : `ApprovalMenu` câblé sur `loadPermissionMode`/`savePermissionMode` (le `selected` cosmétique est remplacé par un état persisté) ; option `custom` retirée (aucun fichier de config supporté → ne pas mentir à l'utilisateur).
  - **`src/components/settings/SettingsPanel.tsx`** : nouvelle `PermissionSection` câblée sur la section nav **« Permission Approval »** (préexistante mais en « Coming soon ») : sélecteur du mode + encart explicatif (avertissement orange en Full Access).
  - **Tests** : `__tests__/permissions.test.ts` (15) + `tokenBudget.test.ts` étendu (`shouldPreCompact`/`projectedUsage`, 4) → vitest **281/281**.

- **Décisions Techniques :**
  - **Pas de LLM Guardian** (contrairement à Trae Auto) : règles déterministes = zéro coût, zéro latence, zéro nouvelle surface d'injection de prompt. On reprend de Cline les permissions *tiered* (lecture sûre / écriture à confirmer) et *conditionnelles* (décider sur le **contenu** — chemin, commande — pas seulement le nom du tool).
  - **Garde anti-catastrophe non désactivable, y compris en Full Access** : l'utilisateur peut tout autoriser, mais jamais détruire irréversiblement la machine. La garde est **étroite** (destruction système/disque) pour ne pas devenir un filtre gênant.
  - **`ask_user` n'est jamais auto-approuvé** : l'approuver annulerait la question elle-même.
  - **Pré-compaction en fin de tour** : évite d'attendre l'entrée suivante (retour utilisateur plus rapide au tour suivant) ; la compaction effective reste faite par `runAgent` — une seule implémentation, pas de divergence.
  - **Restauration des parts non-textuelles** : sans le correctif `sessionStore`, rouvrir une session perdait les bannières de compaction et les cartes de plan.

- **Impacts & Dépendances :**
  - Aucune nouvelle dépendance. `permissions.ts` est consommé par `AiPanel` (décision runtime), `ChatBox` (sélecteur) et `SettingsPanel` (réglage). `tokenBudget.shouldPreCompact` est consommé par `AiPanel`.
  - Comportement par défaut inchangé pour l'utilisateur existant : mode `manual` (tout confirmer), comme avant.
  - Validation : `tsc --noEmit --incremental false` clean, `eslint src/` **0 erreur** (5 warnings préexistants hors périmètre), vitest **281/281**, cargo **90/90**, `vite build` clean, `cargo build --no-default-features` clean.

- **Prochaines étapes :**
  - Envisager un mode **Custom** reposant sur un vrai fichier de règles (profils type Trae `customProfiles`) si le besoin se confirme.
  - Étendre la télémétrie (latence, tokens consommés/tour) si utile au réglage fin.

---

### [2026-10-15T15:32] | LOT D — Réduction de contexte + vitesse (patterns jcode)

- **Contexte :**
  Suite du rapprochement avec Cline/Cursor/Trae. Deux forces de **jcode** (agent TUI Rust) à porter : (1) une **gestion de budget de contexte** qui compacte avant de dépasser la fenêtre du modèle et **tronque d'urgence** en dernier recours, (2) une **politique de retry** qui réessaie les erreurs réellement transitoires sans jamais rejouer un tour qui a déjà produit des éditions.

- **Modifications effectuées :**
  - **`src/lib/agent/tokenBudget.ts`** (nouveau) : constantes et helpers portés de `jcode-compaction-core` — `CHARS_PER_TOKEN=4`, `SYSTEM_OVERHEAD_TOKENS=18_000` (ajouté seulement si budget ≥ 100k), `IMAGE_TOKEN_COST=1_600` (coût forfaitaire image, évite la surestimation ×100 du base64), `COMPACTION_THRESHOLD=0.80`, `CRITICAL_THRESHOLD=0.95`, `EMERGENCY_TOOL_RESULT_MAX_CHARS=4_000`, `DEFAULT_TOKEN_BUDGET=200_000`. `estimateTokens` / `estimateTokensWithOverhead` / `budgetLevel` (`ok`|`compact`|`critical`) ; `emergencyTruncateText` (garde tête `max/2` + queue `max/4` + marqueur) et `emergencyTruncateToolResults` (ne touche jamais au dernier message = tour courant).
  - **`src/lib/agent/retry.ts`** (nouveau) : `FailureKind` (`permanent`|`rate-limited`|`transient`), `MAX_ATTEMPTS=3`, `BASE_DELAY_MS=3_000`, `MAX_DELAY_MS=30_000`, `MAX_RATE_LIMIT_WAIT_MS=5min`, `CONTINUATION_REMINDER`. Classification par précédence **Permanent > RateLimited > Transient > Permanent (défaut sûr)** ; codes HTTP reconnus comme **nombres isolés** (`containsCode` ignore `req_15030`) ; `parseRetryAfter` (ms/s/m/h) ; `retryDelayMs` = backoff exp `base·2^(attempt-1)` **+ jitter ±20 %**, plafonné, `Retry-After` serveur prioritaire sous le cap.
  - **`src/lib/agent/compactHistory.ts`** : supprime l'`estimateTokens` et le gate local `40_000` ; importe les constantes partagées, gate = `0.80 × 200_000 = 160_000`.
  - **`src/lib/agent/run.ts`** : `attemptRun()` factorisé. Avant l'appel, `budgetLevel()` décide : `critical` → `emergencyTruncateToolResults` puis `compactHistory` (re-troncature si encore ≥ 95 %) ; sinon `compactHistory`. Boucle de tour : `producedOutput` partagé, `canRetry = !producedOutput || attempt === 1`, backoff via `retryDelayMs`, `CONTINUATION_REMINDER` injecté en message user final pour les reprises, keep-alive `token` vide pour garder l'UI en streaming. Helpers `toError` / `sleep(ms, signal)` (annulable).
  - **Tests** : `src/lib/agent/__tests__/retry.test.ts` (12) + `tokenBudget.test.ts` (12) → vitest **262/262**.

- **Décisions Techniques :**
  - **Ne jamais rejouer un tour ayant produit du contenu** (`canRetry`) : une reprise aveugle dupliquerait des éditions déjà approuvées. Un tour « à vide » peut être rejoué à l'identique ; un tour « sale » reçoit un simple rappel de continuation.
  - **Défaut = permanent** dans la classification : en l'absence de marqueur connu on ne réessaie **pas** — un retry silencieux masquerait une erreur de config (clé invalide, modèle inconnu).
  - **Comptage heuristique chars/4** assumé (pas de tokenizer exact) : la décision porte uniquement sur « quand compacter », jamais sur une troncature silencieuse d'une réponse utilisateur en vol.
  - **Coût image forfaitaire** : le base64 d'une image fausse `chars/4` d'un facteur ~100 ; on compte un forfait par image.
  - **Troncature d'urgence = dernier rempart**, ne touche jamais le tour courant et préserve l'ordre/format des messages.

- **Impacts & Dépendances :**
  - Aucune nouvelle dépendance (ni front ni Rust). Le seuil de compaction passe effectivement de 40k à 160k tokens — les longues sessions seront compactées **beaucoup moins souvent**, ce qui préserve le contexte utile plus longtemps (aligné jcode).
  - `run.ts` est appelé par `AiPanel` via `runAgent` : signature **inchangée**, comportement interne enrichi (budget + retry). `containsCode` est désormais **exporté** (utilisé par les tests).
  - Validation : `tsc --noEmit --incremental false` clean, `eslint` clean, vitest **262/262**, cargo **90/90**, `cargo build --no-default-features` clean.

- **Prochaines étapes :**
  - Phase `validate-all` : revue finale transversale (LOT A→D), vérification de l'intégration bout-en-bout dans `AiPanel`.
  - Envisager : compaction **réactive en fin de tour** (déclencher dès que l'usage projeté franchit 80 % plutôt qu'à l'entrée suivante), et télémesure du nombre de compactions/retries pour le réglage fin.

---

### [2026-10-15T15:20] | LOT A — Undo all / Keep all : checkpoints par tour (snapshots par copie)

- **Contexte :**
  Objectif : atteindre le niveau Cline/Cursor/Trae côté agent. Trae (et Cursor) offrent un **rollback en un clic** de toutes les modifications d'un tour d'agent (« Undo all » / « Keep all »). Origin n'avait aucun filet de sécurité : si l'agent modifiait 12 fichiers, l'utilisateur devait revenir à la main (git, undo éditeur…). Ce lot porte ce pattern.

- **Modifications effectuées :**
  - **`src-tauri/src/checkpoint.rs`** (nouveau) : journal de checkpoint par `turn_id`. Commandes `checkpoint_begin`, `checkpoint_touch_file` (idempotent : le **premier** état gagne), `checkpoint_undo` (réécrit les fichiers existants, **supprime** ceux créés pendant le tour, puis purge), `checkpoint_discard`, `checkpoint_count`. Racine = `<app_data_dir>/checkpoints` (jamais dans le workspace). Écriture de manifeste **atomique** (tmp + rename).
  - **`src-tauri/src/fs.rs`** : ajout de **`assert_in_workspace_public`**, wrapper exposant la garde de confinement (canonicalisation + détection de symlinks) aux autres modules.
  - **`src-tauri/src/lib.rs`** : `mod checkpoint;` + enregistrement des 5 commandes dans l'`invoke_handler`.
  - **`src/lib/turnCheckpoint.ts`** (nouveau) : façade front (`beginTurnCheckpoint`, `touchTurnFile`, `undoTurnCheckpoint`, `discardTurnCheckpoint`, `countTurnCheckpoint`).
  - **`src/lib/agent/tools.ts`** : `createTools` accepte **`onBeforeWrite`**, appelé dans le `approve()` de `write_file`/`edit`/`multi_edit` — donc **juste avant l'écriture effective**, et **pas** quand l'utilisateur refuse le diff.
  - **`src/components/ai/AiPanel.tsx`** : état de tour (`activeTurnIdRef`, `turnTouchedRef`, `streamDirtyRef`, `checkpointBanner`). `beginTurn()` ouvre un checkpoint dès le début d'un tour non-`ask` et **purge l'ancien** (Keep all implicite). Le `tool-call` d'un outil d'écriture marque le tour « sale » ; le `finish` affiche la bannière si le tour a écrit. `handleUndoAll`/`handleKeepAll` exécutent les actions avec toasts.
  - **`src/components/ai/TurnCheckpointCard.tsx`** (nouveau) : bannière liste de fichiers modifiés + boutons **Undo all / Keep all**, repliable au-delà de 2 fichiers.

- **Décisions Techniques :**
  - **Copies ciblées plutôt que git** (choix utilisateur validé) : le workspace n'est pas forcément un dépôt git, et même s'il l'est, manipuler son index/HEAD risque de **perdre du travail non commité**. Une copie des seuls fichiers touchés est simple, prévisible, sans effet de bord sur l'état git.
  - **Snapshot dans le data dir applicatif, pas dans le workspace** : on ne pollue pas le projet de l'utilisateur et on évite qu'un snapshot apparaisse dans son diff/git.
  - **Nom de backup dérivé d'un hash FNV-1a** du chemin absolu → aucun `/` ni `..` injectable via un nom de fichier, même si un manifeste était forgé.
  - **Garde `assert_in_workspace` à la restauration** : un manifeste altéré **ne peut pas** écrire hors du workspace — la restauration est re-validée côté Rust, pas seulement à la capture.
  - **Idempotence au premier état** : si un fichier est édité 3 fois dans le même tour, on restaure l'état **d'avant le tour** ; capturer à chaque écriture produirait un rollback incohérent.
  - **Purge du checkpoint précédent à l'ouverture d'un nouveau tour** : évite la fuite disque de snapshots orphelins (l'utilisateur peut ignorer la bannière et continuer à travailler).

- **Impacts & Dépendances :**
  - Rust : nouveau module `checkpoint` (dépend de `tauri::Manager` pour `app_data_dir`), pas de nouvelle crate. `fs.rs` expose une fonction publique supplémentaire.
  - Front : `createTools` gagne un paramètre optionnel `onBeforeWrite` (rétrocompatible — les autres appelants `createReadOnlyTools`/`createAskTools` ne le passent pas).
  - **Tests** : vitest **237/237**, cargo **90/90** (dont 2 nouveaux sur `path_hash` et la validation de `turn_id`). `tsc --noEmit` clean, `eslint` sans erreur nouvelle, `cargo build --no-default-features` sans warning.
  - Limite connue : le checkpoint est **en mémoire côté front** (`activeTurnIdRef`) ; si l'app se ferme entre l'écriture et le clic Undo, la bannière disparaît (les snapshots restent sur disque jusqu'au prochain tour). Acceptable pour un rollback « de tour ».

- **Prochaines étapes :**
  - **LOT B** : tool `ask_user` interactif (question + 2-4 options cliquables, réponse renvoyée comme résultat de tool) — `AskUserCard`.
  - **LOT C** : TodoList épinglée au-dessus de l'input (lecture du `todoStore`).
  - **LOT D** : réduction de contexte + vitesse (patterns jcode : compaction 80 %/95 %, comptage heuristique chars/4, retry backoff exponentiel).

---

### [2026-10-15T15:18] | LOT C — TodoList épinglée au-dessus de l'input

- **Contexte :**
  Trae affiche la todo-list de l'agent **au-dessus de la zone d'input**, en résumé compact qui se déplie : l'utilisateur voit l'avancement sans ouvrir de panneau. Origin n'exposait les todos que comme carte de tool call, noyée dans le fil.

- **Modifications effectuées :**
  - **`src/lib/agent/todoStore.ts`** (nouveau) : store **réactif observable** par `sessionId` — `TodoItem { id, content, status: pending|in_progress|done|cancelled }`, `getTodos`/`setTodos`/`clearTodos`/`subscribe`, et hook **`useTodos(sessionId)`** via `useSyncExternalStore`.
  - **`src/lib/agent/tools.ts`** : supprime le `Map`/`TodoItem` local, importe le store partagé. `createTools` gagne **`sessionId?`** (injecté par l'appelant, **jamais** par le modèle). `todo_write` = `{ todos: [...] }` → `setTodos(sessionId, …)` ; `todo_read` = `{}` → `getTodos(sessionId)`.
  - **`src/components/ai/PinnedTodoList.tsx`** (nouveau) : ligne résumé (icône, compteur `fait/total`, tâche courante, barre de progression, chevron) ; se déplie en liste avec icônes/couleurs par statut ; renvoie `null` si vide ou tout terminé/annulé.
  - **`src/components/ai/AiPanel.tsx`** : `activeSessionId` promu en **state** (+ ref) pour re-render réactif ; les 6 sites d'assignation mis à jour ; `<PinnedTodoList>` juste au-dessus du `<ChatBox>`.
  - **`src/lib/ai.ts`** : consignes `todo_write` dans le prompt système (full + lite).

- **Décisions Techniques :**
  - **`sessionId` hors du contrat d'outil** : si le modèle pouvait le fournir, il pourrait lire/écrire les todos d'une **autre** session (contournement d'isolation). Il est injecté côté hôte uniquement.
  - **`useSyncExternalStore`** plutôt qu'un contexte React : lecture fine, pas de re-render du panneau entier, et le store reste utilisable hors composant (tests, tools).
  - **Auto-masquage quand tout est terminé** : sans ça, la liste resterait collée à l'écran après la fin d'une tâche, bruit visuel permanent.

- **Impacts & Dépendances :**
  - `todoStore` remplace l'ancien état local de `tools.ts` — l'état des todos devient **partagé** entre les tools et l'UI.
  - Validation : vitest **237/237** (à cette étape), `tsc`/`eslint` clean. Pas de changement Rust.

- **Prochaines étapes :**
  - **LOT D** : réduction de contexte + vitesse (jcode).

---

### [2026-10-15T15:12] | LOT B — Tool `ask_user` interactif (pattern Trae)

- **Contexte :**
  Trae (et Cline) permettent à l'agent de **poser une question structurée** à l'utilisateur en plein tour, avec des options cliquables, au lieu de deviner. Origin ne savait que s'arrêter ou demander en langage naturel dans le fil.

- **Modifications effectuées :**
  - **`src/lib/agent/tools.ts`** : `PendingAction` étendu avec `{ type: "ask_user"; question; options; allowFreeform }` ; `ApprovalEvent.reject` devient `(answer?: string) => void` ; nouvel outil `ask_user` (2–4 options, `allow_freeform` par défaut `true`), **bloque** via une Promise. `approve()` → `{ cancelled: true }` ; `reject(answer)` → `{ answer }`.
  - **`src/lib/aiTypes.ts`** : `ToolCallDisplay.reject` = `(answer?: string) => void`.
  - **`src/components/ai/AskUserCard.tsx`** (nouveau) : options cliquables + saisie libre (Entrée / bouton Send) ; état « Answered » figé après réponse.
  - **`src/components/ai/ToolCallCard.tsx`** : label `ask_user: "Question"`, routage vers `AskUserCard` (avec `tc.reject?.(answer)` ou état figé), résumé `Answer: …`.
  - **`src/lib/ai.ts`** : consignes `ask_user` dans le prompt système (full + lite).

- **Décisions Techniques :**
  - **La réponse passe par le canal `reject(answer)`** (extension du canal d'approbation existant) plutôt qu'un nouveau chemin : un seul mécanisme bloquant à maintenir, et l'outil renvoie la réponse **comme résultat de tool** (le modèle la voit dans son contexte, comme chez Trae/Cline).
  - **`approve()` = annulation** (l'utilisateur ferme/skip) : l'agent reçoit `{ cancelled: true }` et peut décider quoi faire, au lieu d'inventer une réponse.
  - **`allow_freeform` par défaut `true`** : sans saisie libre, on enfermerait l'utilisateur dans les options proposées par le modèle — risque de réponse forcée non voulue.

- **Impacts & Dépendances :**
  - Signature de `ApprovalEvent.reject` élargie (rétrocompatible : les outils qui ignorent l'argument continuent de fonctionner).
  - Validation : vitest **237/237** (à cette étape), `tsc`/`eslint` clean. Pas de changement Rust.

- **Prochaines étapes :**
  - **LOT C** : TodoList épinglée au-dessus de l'input.

---

### [2026-10-15T14:55] | Vague 1 — Fiabilité édition (moteur de matching Cline)

- **Contexte :**
  Objectif : rapprocher l'agent de l'IDE du niveau Cline/Cursor. Analyse comparative → priorisation en 3 vagues ; la **Vague 1** cible la fiabilité des éditions (le point qui casse le plus un agent : « old_string not found »), plus le bornage des I/O. Le code source réel de Cline SDK a été cloné en référence (`/Users/user/code/_reference/cline`) et ses patterns portés dans Origin.

- **Modifications effectuées :**
  - **`src/lib/editMatch.ts`** (nouveau, moteur pur) : `canonicalize()` (NFC + normalisation de la ponctuation typographique `—`/guillemets/apostrophes/espaces insécables + échappements), `levenshteinDistance` (mémoire linéaire) + `similarity`, `findTextMatch(haystack, needle)` à **4 niveaux** (exact → trimEnd par ligne → trim complet → similarité **≥ 0.66**), `replaceText`. **Refus explicite de l'ambiguïté** : 0 occurrence → `not_found` (+ `bestSimilarity`), >1 → `ambiguous` (+ compteur). 19 tests.
  - **`src/lib/applyEdit.ts`** (réécrit en façade) : `applyEdit` (compat, renvoie `string | null`), `applyEditDetailed` (renvoie `{ ok, content, fuzz, similarity }` | échec), type `EditFailure`, et **`describeEditFailure(path, outcome)`** — messages **actionnables** (« Do not re-send this call unchanged », « extend old_string… ») portés de `editor.ts` de Cline.
  - **`src/lib/agent/tools.ts`** : tool `edit` (mode agent) branché sur `applyEditDetailed` + `describeEditFailure`, entrées `z.coerce.string()`, note de fuzzy match renvoyée au modèle. **`multi_edit` ajouté au toolset agent** (atomique, all-or-nothing, un seul diff, nomme l'édition fautive) ; `edit`/`multi_edit` du mode **ask** alignés sur le même moteur. `read_file` branché sur la lecture bornée.
  - **`src/lib/ai.ts`** : prompts système enrichis (matching tolérant, **unicité obligatoire**, contexte 3–5 lignes, « ne jamais renvoyer un appel échoué à l'identique », `multi_edit` pour plusieurs changements dans un fichier).
  - **`src-tauri/src/fs.rs`** : nouvelle commande **`read_file_range`** (`FileSlice { content, start_line, end_line, total_lines, truncated }`), plafond **2000 lignes/appel**, bornes clampées, réutilise `assert_in_workspace`. 7 tests.
  - **`src-tauri/src/ai.rs`** : **`agent_bash_run`** réécrit — `tokio::process::Command` + **`kill_on_drop(true)`**, **timeout dur 120 s** (process réellement tué), `stdin` null, **troncature stdout/stderr à 64 Ko/flux**, champs `timed_out`/`truncated`.
  - **`src/components/ai/ToolCallCard.tsx`** : `multi_edit` (label/icône/aperçu), affichage de la **plage de lignes** et de la troncature pour `read_file`.
  - **`src-tauri/src/lib.rs`** : `fs::read_file_range` enregistrée dans l'`invoke_handler`.

- **Décisions Techniques :**
  - **Porter le moteur de Cline plutôt que l'inventer** : le fuzzy matching à seuil + canonicalisation Unicode + refus d'ambiguïté sont éprouvés à grande échelle ; les réimplémenter from scratch aurait réintroduit les mêmes bugs. Origin garde l'orchestration TS (Vercel AI SDK) côté renderer ; Rust ne durcit que les **bordures système** (FS/shell), conforme à la règle « TS pour l'orchestration, Rust pour le confinement ».
  - **Refus de l'ambiguïté = choix de sécurité** : éditer une occurrence arbitraire quand `old_string` apparaît plusieurs fois est un vecteur de **corruption silencieuse**. On préfère refuser et demander plus de contexte (test historique « multiple occurrences » réécrit de `"bar foo foo"` → `null`, changement volontaire).
  - **`kill_on_drop` obligatoire** : `std::process::Command::output()` ne peut pas être interrompu ; un `timeout` sans kill laisserait le process **fuir** et grossir indéfiniment. `tokio::process` + drop du `Child` garantit l'arrêt.
  - **Bornes = anti-DoS + économie de contexte** : `read_file` plafonné (2000 lignes) et `bash_run` plafonné (64 Ko) empêchent un fichier/sortie volumineux de saturer la mémoire de la webview ou la fenêtre de contexte du modèle.
  - **`z.coerce` sur les entrées d'édition/lecture** : les modèles renvoient parfois des nombres en string ; coercition = moins d'échecs de validation Zod sans relâcher le typage interne.

- **Impacts & Dépendances :**
  - Front : `applyEdit` reste exporté (compat) ; les 3 appels internes passent par `applyEditDetailed`. `read_file` renvoie désormais un **objet slice** et non `{ content }` brut — `ToolCallCard` gère les deux formes.
  - Rust : `BashResult` gagne 2 champs (`timed_out`, `truncated`) ; `ai.rs` dépend de `tokio` features `process`/`time`/`io-util` (déjà présentes).
  - **Tests** : vitest **237/237** (dont 19 sur le moteur d'édition), cargo **88/88** (dont 7 sur `read_file_range`). `tsc --noEmit` clean, `eslint src/` sans erreur nouvelle, `cargo build --no-default-features` sans warning.

- **Prochaines étapes :**
  - **Vague 2** : contexte projet (`AGENTS.md` / `.originrules`…), `@codebase` sémantique, diagnostics post-édition, queue de messages.
  - **Vague 3** : terminal persistant, checkpoints/rollback, MCP, sous-agents, permissions granulaires.
  - Surveiller en usage réel : taux de `not_found` vs `ambiguous` (télémétrie légère à prévoir) pour ajuster le seuil de similarité si besoin.

---

- **Contexte :**
  Décision produit : « supprimer le système d'extension façon VS Code et créer notre propre système comme Zed, pour rendre l'outil plus léger ». Approche retenue (validée) : **garder le sandbox QuickJS** mais remplacer le shim `vscode.*` par une **API `origin.*` maison** ; **retirer le marketplace Open VSX** ; **retirer l'icône/menu Extensions de l'activity bar** (UI masquée « pour le moment »).

- **Modifications effectuées :**
  - **`src-tauri/src/extensions_market.rs`** : **supprimé** (client Open VSX, structs `MarketExtension`/`MarketSearchResult`, `valid_segment` anti-SSRF, commandes `market_search`/`market_install`, 4 tests).
  - **`src-tauri/src/lib.rs`** : `mod extensions_market;` et les 2 commandes marketplace retirées de l'`invoke_handler` (seules les commandes d'install/inventaire locales subsistent).
  - **`src/lib/extensions.ts`** : bloc Open VSX retiré (`MarketExtension`, `MarketSearchResult`, `marketSearch`, `marketInstall`) ; `readExtensionManifest` conservé.
  - **`src/lib/extensions/runtime.ts`** : l'en-tête décrit désormais l'API `origin` ; `installVscodeShim` → **`installOriginApi`** (surface plate `origin.commands/workspace/editors/extensions/notify/log/version`), exposée via `globalThis.origin` et `globalThis.__originApi`. `require("origin")` résout l'API ; `require("vscode")` conservé comme **alias legacy** vers le même objet. Builders morts supprimés (`buildCommands`, `buildWindow`, `buildWorkspace`, `buildUri`, `buildExtensionMode`, `buildExtensions`, `buildEnv`, `buildEventEmitter`) ainsi que `uriToPath`/`encodeUtf8`/`decodeUtf8`, devenus inutiles. Helpers conservés : `buildDisposable`, `buildExtensionContext`, `buildMemento`, `installConsole`, `installWebGlobals`, `wrapCommonJs`, `settleCallResult`, etc.
  - **`src/components/ActivityBar.tsx`** : item `{ id: "extensions", icon: "lucide:puzzle" }` retiré.
  - **`src/components/Sidebar.tsx`** : import `ExtensionsPanel` et `case "extensions"` retirés.
  - **`src/components/ExtensionsPanel.tsx`** : **supprimé** (plus référencé).
  - **`src/components/settings/SettingsPanel.tsx`** : message de thème ne renvoie plus vers le « Extensions panel » supprimé.

- **Décisions Techniques :**
  - **API plate et opportuniste plutôt que clone de `vscode`** : une surface étroite (`commands`, `workspace`, `editors`, `extensions`, `notify`) mappée 1:1 sur le `HostBridge` (capability-gated) réduit la surface d'attaque et reste plus simple à raisonner. Le sandbox QuickJS est conservé : le code `main.js` reste **non fiable** (pas de DOM/réseau/FS/`invoke`).
  - **Alias `vscode` conservé volontairement** : les bundles webpack existants font `require("vscode")` au chargement ; couper net ferait planter toute extension déjà installée. L'alias renvoie le **même** objet `origin` — zéro duplication, dette nulle.
  - **Marketplace supprimé, pas désactivé** : le retrait est total (Rust + TS + UI) pour éviter du code mort et un vecteur réseau/SSRF. L'installation reste possible via fichier `.vsix` local (dialog natif, aucun fetch distant).
  - **UI retirée « pour le moment »** : l'infra d'extensions (host, grammaires, thèmes, i18n, registre de commandes) reste **active** — elle alimente l'éditeur (coloration, thèmes, commandes palette). Seul le point d'entrée visuel (activity bar + panneau) est masqué.

- **Impacts & Dépendances :**
  - **Rust** : `install_from_bytes` reste public et partagé ; plus aucun appelant marketplace. Tests lib : **74/74** (4 tests marketplace supprimés).
  - **Manifeste** : inchangé pour l'instant — `package.json` façon VS Code (`contributes.grammars/snippets/themes/iconThemes/commands`) + section non-standard `origin.binaries`. Décision : **garder la compat VSIX** et documenter une section `origin` native plus tard.
  - **Palette** : les commandes d'extension déclarées continuent d'apparaître (via `lib/extensions/registry`) ; l'i18n NLS reste.
  - **Settings / Thèmes / IconTheme** : lisent toujours `listExtensions()` — le masquage UI n'affecte pas la détection des thèmes/grammaires installés.

- **Prochaines étapes :**
  - Définir un **manifeste `origin` natif** (contributions + section `origin`) sans casser le parse VSIX.
  - **Nettoyage résiduel** : `lsp.rs` (`find_in_extensions` lisant `<app_data>/extensions`) si on veut découpler complètement.
  - Reprendre les lots IDE en attente : **navigation back/forward** puis **Snippets**.

---


- **Contexte :**
  Audit de parité VS Code (« il manque quoi pour avoir un IDE pro comme vscode »). Trois manques retenus par ordre d'importance : (1) le **surlignage du mot sous le curseur** avait un fond qui « fait mal aux yeux » ; (2) pas de **hover LSP** (signature/doc au survol) ; (3) pas de **Go to Symbol in Workspace** (Ctrl+T), le préfixe `#` ne couvrant que le fichier actif.

- **Modifications effectuées :**
  - **`src/index.css`** : `.cm-selectionMatch` / `.cm-selectionMatch-main` perdent leur **fond** au profit d'une simple **bordure** `color-mix` sur `accent-blue` (confort visuel) ; ajout du style `.cm-tooltip.cm-tooltip-hover` + `.origin-lsp-hover` (tooltip LSP : largeur max 560 px, mono, scroll vertical).
  - **`src/lib/lspCm6.ts`** : nouveau provider `createLspHoverExtension(serverId, filePath)` basé sur `hoverTooltip` natif de `@codemirror/view` — interroge `textDocument/hover` via `invoke('lsp_request')` et normalise `HoverContents` (string/MarkupContent/MarkedString[]…) en texte ; intégré dans `createLspExtension`. Ajout de `RawWorkspaceSymbol` + `lspWorkspaceSymbols(serverId, query)` (`workspace/symbol`).
  - **`src/lib/outline.ts`** : nouveau `WorkspaceSymbolHit` + `workspaceSymbolsFromLsp(rootPath, refPath, query)` — cible le serveur LSP du **fichier de référence** (`getLspServerId(refPath)`), convertit les URI `file://` en chemins et normalise `kind` via la table `SYMBOL_KIND` existante.
  - **`src/components/palette/CommandPalette.tsx`** : nouveau mode `workspace-symbol` (prop `onGoToWorkspaceSymbol`, query initiale `#`, `useEffect` async debounced 250 ms, memo `wsSymbolItems` avec `containerName · relPath`) ; le mode `#` fichier (`symbol`) est préservé via `isFileSymbolMode` / `isWsSymbolMode`.
  - **`src/App.tsx`** : `paletteMode` étendu à `'workspace-symbol'` ; commande `origin.gotoWorkspaceSymbol` ; prop `onGoToWorkspaceSymbol` câblée sur `openTabAtLine` (ouverture **cross-file** à la ligne/colonne).
  - **`src/lib/keybindings.ts`** : `origin.gotoWorkspaceSymbol` → **Ctrl+T**.

- **Décisions Techniques :**
  - **Hover natif plutôt que `codemirror-languageserver`** : le package impose sa propre extension `languageServerWithTransport` ; un provider `hoverTooltip` sur le transport JSON-RPC déjà en place (`lsp_request`) évite une dépendance supplémentaire et reste maître du rendu. `lsp_request` côté Rust ne filtre aucune méthode → `textDocument/hover` et `workspace/symbol` passent sans modification backend.
  - **Serveur résolu depuis le fichier actif, pas le dossier** : `getLspServerId` matche par extension de fichier ; un `rootPath` de dossier ne résout rien. `workspace/symbol` étant une requête projet, n'importe quel fichier ouvert du bon langage cible le serveur correct.
  - **Fond retiré, bordure conservée** : VS Code marque l'occurrence courante sans aplat criard ; on garde la lisibilité (bordure) sans l'agression visuelle du fond.

- **Impacts & Dépendances :**
  - `CommandPalette` : préfixe `#` désormais bimodal (`openMode` tranche) — tout futur appelant doit fournir le bon `openMode`.
  - Aucun impact backend. `Engine` LSP inchangé.

- **Prochaines étapes :**
  - Navigation **back/forward** (Ctrl+Alt+- / Ctrl+Shift+-) sur l'historique de positions, puis **Snippets** (moteur + définitions utilisateur).

---

### [2026-10-13T18:55] | Search : aperçu du remplacement (occurrence barrée + remplacement) façon VS Code

- **Contexte :**
  Signalement utilisateur : « le remplace ne fait pas comme sur vscode en barrant le ou les termes à remplacer ». En effet, le panneau n'affichait que l'occurrence trouvée surlignée en bleu, sans montrer le résultat du remplacement. VS Code, dès que la ligne Replace est dépliée et non vide, **barre l'occurrence d'origine** et affiche le **texte de remplacement** à sa suite, dans chaque ligne de résultat.

- **Modifications effectuées :**
  - **`src/components/SearchPanel.tsx`** : `MatchLine` reçoit trois props (`replacement`, `replaceOpen`, `preserveCase`) ; l'aperçu `showDiff` s'active dès que la ligne Replace est ouverte et le remplacement non vide : l'occurrence originale passe en **rouge barré** (`textDecoration: 'line-through'`) et le remplacement s'affiche en **vert** juste après. Nouveau helper front `applyPreserveCase` (miroir de la version Rust) pour que l'aperçu respecte la casse si le toggle *AB* est actif. Aucun changement si Replace est replié ou vide (comportement bleu inchangé).

- **Décisions Techniques :**
  - **Aperçu purement front** : pas d'aller-retour backend pour afficher ce que donnerait le remplacement — le calcul local (slice + `applyPreserveCase`) est trivial et instantané, cohérent avec le backend sans le solliciter.
  - **Couleurs du thème** : rouge `--origin-accent-red` / vert `--origin-accent-green` (avec fallback), pour rester aligné sur la palette git.added/rewritten déjà utilisée ailleurs.

- **Impacts & Dépendances :**
  - `MatchLine` a trois props obligatoires supplémentaires : tout nouvel appelant doit les fournir.
  - Aucun impact backend ni sur les tests (rendu d'affichage uniquement).

- **Prochaines étapes :**
  - Envisager l'aperçu du remplacement dans l'onglet éditeur lui-même (overlay CM6) — non demandé pour l'instant.

---

### [2026-10-13T18:35] | Search : parité VS Code complète (replace par occurrence, Preserve Case, include/exclude) + sélection éditeur bleue VS Code

- **Contexte :**
  Deux manques de parité VS Code signalés par l'utilisateur. (1) Le panneau **Search** n'avait qu'un remplacement global : le champ Replace était mal placé (pas sous le champ Search, chevron absent), il manquait le bouton *Replace All*, le remplacement d'**une seule occurrence**, les boutons *Replace*/*Dismiss* au survol d'un résultat, le toggle *Preserve Case* et le champ *files to include*. (2) Dans l'éditeur, la **sélection de texte** était un gris translucide (blanc en sombre, noir en clair) au lieu du bleu VS Code, et les occurrences du mot sélectionné n'avaient ni bordure ni seuil de surlignage.

- **Modifications effectuées :**
  - **`src-tauri/src/search.rs`** : `ReplaceRequest` étendu (`includes: Option<String>`, `preserve_case: bool`, tous deux `#[serde(default)]`) ; nouvelle requête `ReplaceOneRequest { path, query, replacement, options, line, col, preserve_case }` + commande **`replace_one`** (remplace une occurrence ciblée par ligne/col sans reparser tout le fichier) ; fonction `apply_preserve_case` (minuscule→minuscule, majuscule→majuscule, casse mixte→1ʳᵉ lettre majuscule) ; `expand_replacement` prend un 4ᵉ param `preserve_case` ; `walk_search` filtre désormais aussi par `includes` via le nouveau helper `is_included` ; la commande `search_in_files` accepte `includes`. Tests ajoutés (`preserve_case_all_lower/_all_upper/_title/_no_alpha_is_verbatim`).
  - **`src-tauri/src/lib.rs`** : enregistrement de la commande `search::replace_one`.
  - **`src/lib/search.ts`** : `searchInFiles` accepte `includes` (5ᵉ arg) ; `replaceInFiles` accepte `preserveCase` + `includes` ; nouvelle `replaceOne(path, query, replacement, line, col, options, preserveCase)`.
  - **`src/components/SearchPanel.tsx`** (réécrit) : chevron *Replace* à gauche du champ Search ; ligne Replace alignée sous le champ (espace de 20 px à gauche) avec toggle **AB** (*Preserve Case*) + bouton *Replace All* ; lignes *files to include* / *files to exclude* ; boutons **Replace** + **Dismiss (X)** au survol de chaque résultat ; bouton *Replace All* par fichier dans l'en-tête de groupe ; navigation clavier (`Ctrl+Alt+Enter` = Replace All, `Enter` = ouvrir le 1ᵉʳ résultat) ; filtre local `dismissed`.
  - **`src/components/editor/Editor.tsx`** : `highlightSelectionMatches({ highlightWordAroundCursor: true, minSelectionLength: 3, wholeWords: true })` — seuil à **3 caractères** comme VS Code.
  - **`src/index.css`** : `.cm-selectionBackground` / `.cm-editor.cm-focused .cm-selectionBackground` câblés sur `--origin-bg-selection` / `--origin-bg-selection-focused` (avec `!important`) ; `.cm-selectionMatch` / `.cm-selectionMatch-main` reçoivent un fond + une **bordure** bleue (`color-mix` sur `accent-blue`).
  - **`src/themes/origin-dark/theme.json`** : `bg.selection = #1d3e5e`, `bg.selection-focused = #264f78` (bleu VS Code) ; **`origin-light/theme.json`** : `#add6ff80` / `#add6ff`.

- **Décisions Techniques :**
  - **Remplacement d'une occurrence ciblé par (ligne, col)** plutôt qu'une ré-écriture complète : `replace_one` ne touche que la ligne visée (`split_inclusive('\n')` + `find_iter`), ce qui évite un reparse coûteux et réduit la fenêtre de corruption en cas de fichier modifié entre-temps ; un match introuvable renvoie `false` (le front affiche « Match no longer exists »).
  - **Preserve Case appliqué au littéral uniquement** : un remplacement regex porte déjà son intention (groupes/`$1`) ; y superposer un calque de casse serait ambigu. Le comportement littéral reprend celui de VS Code.
  - **`includes` réutilise `compile_excludes`** : la grammaire glob est identique ; `is_included` retourne `true` sur liste vide (pas de filtre), d'où l'absence de régression pour les appels existants (palette de commandes, etc.).
  - **Sélection bleue via variables de thème** (et non valeurs codées en dur) : la couleur suit le système de thème `--origin-*` et reste cohérente entre dark/light.

- **Impacts & Dépendances :**
  - `searchInFiles` a un 5ᵉ argument **optionnel** (`includes = ''`) : les appels existants ne changent pas.
  - Nouvelle commande backend `replace_one` : tout nouvel appelant front doit passer par `replaceOne()` de `src/lib/search.ts`.
  - Les clés de thème `bg.selection` / `bg.selection-focused` sont désormais réellement bleues — sans effet ailleurs (uniquement éditeur).

- **Prochaines étapes :**
  - Surveiller la sync éventuelle entre `dismissed` local et un rechargement de fichiers (le set est réinitialisé à chaque nouvelle recherche, comportement voulu).
  - Navigation F3 / Shift+F3 entre résultats (optionnel, non confirmé comme nécessaire).

---

### [2026-10-13T17:48] | Auto Save (façon VS Code) + prévisualisation Markdown enrichie (raccourci + sync scroll)

- **Contexte :**
  Deux manques de parité VS Code. (1) **Aucune sauvegarde automatique** n'existait : chaque édition restait « dirty » jusqu'à un Ctrl+S manuel. (2) La **prévisualisation Markdown** existait déjà à ~90 % (composant `MarkdownPreviewPane`, ouverture d'onglet `openMarkdownPreviewTab`, routage `EditorArea`, entrée menu contextuel explorateur + palette) mais il manquait le **raccourci clavier**, une **commande palette globale** (indépendante de l'onglet actif) et la **synchronisation du scroll** éditeur ↔ aperçu.

- **Modifications effectuées :**
  - **`src/lib/autoSavePrefs.ts` (nouveau)** : store localStorage des préférences — clés `origin-editor-autosave` (mode) et `origin-editor-autosave-delay` (ms). `AutoSaveMode = 'off' | 'afterDelay' | 'onFocusChange' | 'onWindowChange'` (les trois modes de VS Code), défaut `{ mode: 'off', delayMs: 1000 }`, plus `AUTO_SAVE_CHANGED_EVENT` + `notifyAutoSaveChanged()` pour propager un changement de préférence sans rechargement.
  - **`src/hooks/useAutoSave.ts` (nouveau)** : moteur de la sauvegarde automatique. Lit les refs `tabsRef`/`fileContentsRef`/`activeTabRef` de `useTabs` et appelle `handleSave`. Filtre les onglets `isDirty && !isUntitled && !path.startsWith('__')` (exclut les onglets virtuels md-preview/diff). `afterDelay` = debounce sur l'événement `origin:autosave-change` ; `onFocusChange` = sauvegarde sur `origin:editor-blur` ; `onWindowChange` = sauvegarde sur `window blur`.
  - **`src/components/editor/Editor.tsx`** : émet `origin:autosave-change` à chaque `docChanged` ; ajoute la prop `onScrollLine` + listener `scroll` sur `view.scrollDOM` (`view.lineBlockAtHeight(scrollTop)` → numéro de 1ʳᵉ ligne visible) ; émet `origin:editor-blur` sur `focusout`.
  - **`src/components/editor/MarkdownPreviewPane.tsx`** : props `syncLine`/`syncTotalLines` + `useEffect` de mapping **par ratio** `(syncLine-1)/(total-1)` → `scrollTop`, avec verrou `programmaticScroll` relâché via `requestAnimationFrame` (anti-boucle).
  - **`src/components/editor/EditorArea.tsx`** : props `topLines`/`onScrollLine`, passe `syncLine`/`syncTotalLines` au bloc `__mdpreview__` et relaie `onScrollLine` depuis `<Editor>`.
  - **`src/App.tsx`** : état `topLines` câblé sur les **deux** `EditorArea` (principal + split) ; appel `useAutoSave(...)` ; commande runtime `origin.openMarkdownPreview` (View, `enabled` seulement si l'onglet actif est `.md`/`.mdx`).
  - **`src/lib/keybindings.ts`** : entrée registry `origin.openMarkdownPreview` → `ctrl+shift+v` (⌘⇧V sur mac).
  - **`src/components/settings/SettingsPanel.tsx`** : section Editor → « Auto Save » (sélecteur Off / After Delay / On Focus Change / On Window Change) + « Auto Save Delay » (ms, affiché uniquement en mode After Delay).

- **Décisions Techniques :**
  - **Préférences en localStorage** (et non dans le store Tauri) : cohérent avec `format-on-save` déjà en place et lecture synchrone au démarrage.
  - **Déclencheurs émis par `Editor` via `window` events** (`origin:autosave-change`, `origin:editor-blur`) : découple le hook des callbacks React proprement sans faire remonter la logique de sauvegarde dans l'éditeur.
  - **Exclusion des onglets virtuels** (`isUntitled`, préfixe `__`) : un onglet untitled déclencherait une boîte de dialogue `save()` native (bloquant + surprenant lors d'une sauvegarde automatique en arrière-plan).
  - **Sync scroll par ratio** plutôt que mapping d'ancres : simple, robuste aux différences de rendu markdown, sans dépendance à un parseur d'AST. Le verrou `requestAnimationFrame` évite la boucle de rétroaction scroll → re-scroll.
  - **Raccourci `ctrl+shift+v`** : identique à VS Code « Open Preview », choisi libre côté keymap CodeMirror (aucun conflit). La commande runtime complète la commande palette existante qui, elle, n'apparaissait que si l'onglet actif était un `.md`.

- **Impacts & Dépendances :**
  - Nouvelles clés localStorage `origin-editor-autosave` / `origin-editor-autosave-delay` (isolées).
  - `useTabs` expose désormais `tabsRef` (en plus de `fileContentsRef`/`activeTabRef`) dans son objet retour.
  - `EditorArea` a deux props obligatoires supplémentaires (`topLines`, `onScrollLine`) : tout nouvel appelant doit les fournir.
  - `handleSave` écrit via la commande backend `write_file` — **point de vigilance sécurité** : la sauvegarde automatique multiplie les écritures disque, mais reste bornée aux chemins déjà ouverts dans des onglets (pas de chemin arbitraire introduit).

- **Prochaines étapes :**
  - Envisager la **sync inverse** (aperçu → éditeur) si le besoin se confirme.
  - Envisager une entrée palette dédiée pour la sauvegarde automatique (basculer le mode sans passer par Settings).

---

### [2026-10-13T17:35] | Find : persistance « Replace déplié » + surbrillance des occurrences

- **Contexte :**
  Suite de la barre Find/Replace custom : deux finitions de parité VS Code. (1) La ligne « Replace » repartait toujours repliée à chaque ouverture — VS Code mémorise cet état. (2) Les occurrences du mot sous le curseur / de la sélection n'étaient pas surlignées (`editor.occurrencesHighlight` dans VS Code).

- **Modifications effectuées :**
  - **`src/lib/findPrefs.ts` (nouveau)** : petit store localStorage (`origin-find-prefs`) pour la préférence `replaceOpen`. Lecture défensive (parse + repli sur défaut) et écriture silencieuse si le stockage est indisponible — même style que `devEnv.ts`.
  - **`src/components/editor/Editor.tsx`** :
    - `findReplaceOpen` initialisé depuis `loadFindPrefs().replaceOpen` ;
    - `onToggleReplace` persiste la nouvelle valeur via `saveFindPrefs` ;
    - ajout de l'extension `highlightSelectionMatches({ highlightWordAroundCursor: true, minSelectionLength: 1, wholeWords: true })` à côté de `search({ top: false })`.
  - **`src/index.css`** : règles `.cm-selectionMatch` (occurrences) et `.cm-selectionMatch-main` (mot sous le curseur) — teinte `color-mix` sur `--origin-accent-blue`, en cohérence avec l'override global de sélection déjà présent.

- **Décisions Techniques :**
  - **Ne persister QUE l'état déplié** (pas la requête de recherche) : VS Code re-préremplit le champ depuis la sélection à chaque Ctrl+F, donc mémoriser le texte serait un écart de comportement.
  - **`highlightSelectionMatches` plutôt qu'une extension maison** : c'est l'API officielle `@codemirror/search`, déjà cohérente avec `search()` en place. `wholeWords: true` évite de surligner des sous-chaînes (parité VS Code).
  - **Styles en CSS global** (`.cm-selectionMatch`) plutôt qu'un `EditorView.theme` : les classes sont fournies par l'extension ; une règle globale les couvre sans remonter l'extension dans la config thématique.

- **Impacts & Dépendances :**
  - Nouvelle clé localStorage `origin-find-prefs` (isolée, pas de migration nécessaire).
  - `index.css` référence `--origin-accent-blue` (déjà injectée par `applyTheme`) : pas de nouvelle variable requise.

- **Prochaines étapes :**
  - Option : nettoyer les styles `.cm-search*` morts dans `Editor.tsx` (devenus inutiles depuis la barre custom).

---

### [2026-10-13T17:30] | Find/Replace éditeur : barre custom façon VS Code (Ctrl+F / Ctrl+H)

- **Contexte :**
  Demande : « la commande Ctrl+F dans un fichier, fais ça comme sur VS Code ». Auparavant `Ctrl+F` ouvrait le panneau natif de `@codemirror/search` : rendu pleine largeur, libellés anglais « Find/Replace/next/previous », sans les toggles ni le compteur VS Code.

- **Modifications effectuées :**
  - **`src/components/editor/findController.ts` (nouveau)** : façade impérative isolant `@codemirror/search`. Construit une `SearchQuery` (search/replace/caseSensitive/regexp/wholeWord), applique via `setSearchQuery`, expose `next/previous/replaceNext/replaceAll`, et calcule le compteur « N of M » en parcourant `query.getCursor(state)` (best-effort : regex invalide → pas de compteur).
  - **`src/components/editor/FindWidget.tsx` (nouveau)** : overlay flottant ancré **en haut à droite** de la zone d'édition. Contient : champ Find, compteur, flèches ↑/↓, toggles `Aa` (casse) / `.*` (regex) / `ab` (mot entier), bouton ✕, et ligne Replace dépliable (chevron) avec « Replace » / « Replace All ». Entrée = suivant, Maj+Entrée = précédent, Échap = fermer.
  - **`src/components/editor/Editor.tsx`** :
    - import de `FindWidget` + `FindController` ; ajout des états `findOpen`/`findReplaceOpen`/`findOptions`/`findStatus` et du `findControllerRef` ;
    - `openFind`/`openReplace` (handle) rebranchés sur la barre custom ; `openReplace` n'utilise plus le clic DOM sur le bouton natif ;
    - keymap : `Mod-f`/`Mod-h` ouvrent la widget ; **retrait de `searchKeymap`** (plus de panneau natif). L'extension `search({top:false})` est conservée (elle fournit le `searchState` requis par `setSearchQuery`/`getSearchQuery`) ;
    - le compteur est recalculé dans le `EditorView.updateListener` quand la barre est ouverte (via `findOpenRef`).

- **Décisions Techniques :**
  - **Barre custom plutôt que restyle du DOM CodeMirror** : le rendu VS Code exige les toggles + le format « N of M » absents du panneau natif ; piloter l'API `@codemirror/search` directement est plus robuste qu'agir sur un DOM interne non contractuel.
  - **Logique CodeMirror hors du composant React** (`findController.ts`) : sépare l'impératif CM du présentationnel, testable et réutilisable.
  - **`seedFromSelection`** : la sélection courante préremplit le champ (comportement VS Code).
  - **`search({top:false})` conservé** : nécessaire pour le champ `searchState` ; seul `searchKeymap` (raccourcis + panneau natifs) est retiré.

- **Impacts & Dépendances :**
  - `EditorHandle.openFind`/`openReplace` : même signature, comportement différent (widget interne) — aucun changement d'appelant.
  - Le CSS `.cm-search*` devenu inutile peut être retiré plus tard (inoffensif).
  - Nouvelle dépendance d'affichage : `lucide-react` (déjà utilisé ailleurs).

- **Prochaines étapes :**
  - Option : mémoriser « Replace » déplié entre sessions ; `highlightSelectionMatches` (surbrillance des occurrences).
  - Nettoyer les styles `.cm-search` morts dans `Editor.tsx`.

---

### [2026-10-13T17:10] | Parité commandes VS Code : Reload Window, Developer, Window, Terminal, Help + toggles d'apparence

- **Contexte :**
  Retour utilisateur : « je ne vois pas de Reload Window et plein d'autres commandes VS Code ». La palette ne contenait que les commandes déjà câblées (File/Edit/View/Go/Run/Debug) ; les catégories standard VS Code (Developer, Window, Help, Terminal) et les bascules d'apparence manquaient.

- **Modifications effectuées :**
  - **`src/App.tsx`** — ajout des commandes runtime (toutes réellement câblées, aucune factice) :
    - *Developer* : `Reload Window` (`window.location.reload()`), `Restart Application` (`relaunch()` natif), `Reload Extensions` (`reload()` du contexte extensions).
    - *Window* : `Close Window`, `Minimize Window`, `Toggle Maximize Window` (API `getCurrentWindow()`).
    - *Terminal* : `Create New Terminal`, `Clear Terminal`, `Kill Terminal` (via `terminalRef`).
    - *Help* : `Welcome`, `Keyboard Shortcuts`, `Check for Updates…`.
    - *Appearance (View)* : `Toggle Minimap`, `Toggle Sticky Scroll`, `Toggle Bracket Pair Colorization`.
  - **Nouveaux états d'apparence** (`minimap`, `stickyScroll`, `bracketColorization`) dans `App.tsx`, propagés via `EditorArea` → `Editor` (les props existaient déjà côté `Editor`, elles étaient figées aux valeurs par défaut).
  - **`src/components/editor/EditorArea.tsx`** : 3 props optionnelles `minimap`/`stickyScroll`/`bracketColorization` transmises à `Editor`.
  - **`src/lib/keybindings.ts`** : raccourcis VS Code ajoutés — `Reload Window` = `ctrl+r`, `Create New Terminal` = `ctrl+shift+``, `Close Window` = `ctrl+shift+w` ; branchement dans le `VSCODE_CMD_MAP` pour l'import de keybindings (`workbench.action.reloadWindow`, `.terminal.new`, `.closeWindow`).

- **Décisions Techniques :**
  - **Uniquement des commandes fonctionnelles** : pas de commande « décorative » non câblée (ex. pas de « Toggle Word Wrap » tant que l'option n'existe pas dans l'éditeur) — cohérence entre ce que la palette affiche et ce qui s'exécute réellement.
  - **`Reload Window` = rechargement du webview** (`location.reload()`) et **`Restart Application` = `relaunch()` natif** : deux niveaux distincts, comme la distinction VS Code entre reload de fenêtre et redémarrage.
  - **États d'apparence dans App** (source de vérité unique) plutôt que locaux à l'éditeur : la palette peut basculer un toggle commandé ailleurs.
  - **Position de la palette** confirmée `top: 0` (collée en haut, parité VS Code) — déjà en place, aucune régression.

- **Impacts & Dépendances :**
  - `EditorArea` : nouvelle surface de props (optionnelles) — rétro-compatible.
  - `useEffect` des commandes runtime : dépendances élargies (`minimap`, `stickyScroll`, `bracketColorization`) pour des closures à jour.
  - `reloadExtensions` extrait de `useExtensions()`.

- **Prochaines étapes :**
  - Envisager `Toggle Word Wrap` et d'autres bascules une fois l'option câblée côté `Editor`.
  - Étendre `VSCODE_CMD_MAP` au fur et à mesure des commandes ajoutées.

---


- **Contexte :**
  Retour utilisateur : « l'UI n'est pas encore bon, les textes ne sont pas visibles ». La capture montre deux défauts : (1) les libellés sont sombres/peu contrastés ; (2) les commandes d'extension affichent le placeholder brut `%command.activateIcons%` au lieu du texte réel.

- **Modifications effectuées :**
  - **Cause racine du texte invisible :** la palette est montée via `createPortal` sur `document.body`, qui n'a **aucune couleur de texte** (défaut navigateur = noir). Les libellés héritaient donc du noir sur fond sombre. Correctif : `color: 'var(--origin-fg-default)'` explicite sur le panneau + sur le `<span>` du label.
  - **Ligne active adaptative :** sur fond accentué bleu, texte forcé `#ffffff`, sous-textes en `rgba(255,255,255,0.75)` ; le surlignage de recherche passe en gras sans couleur (invisible sinon).
  - **Nouveau `src/lib/extensions/i18n.ts` :** résolution des chaînes localisées `%key%` d'une extension via `package.nls.json` / `package.nls.en.json` ; store module-level + `subscribe`/`getRevision` pour `useSyncExternalStore`. Une clé inconnue est rendue **sans les `%`** (jamais de placeholder brut).
  - **`CommandPalette.tsx` :** `ensureExtensionI18n()` appelé pour chaque extension contributrice ; index `extTitles` (id → titre résolu) recalculé sur changement de la révision NLS ; le tri fuzzy et le label utilisent ce titre.

- **Décisions Techniques :**
  - **Portail + couleur explicite** plutôt que dépendre de l'héritage : un portail sort de l'arbre React et n'hérite d'aucune couleur d'app → toujours fixer `color` sur le conteneur racine d'un portail.
  - **Résolution NLS côté front, best-effort :** les fichiers `package.nls*.json` sont déjà lisibles via `read_extension_asset` (confiné) ; pas de nouvelle surface backend. Le repli « retirer les `%` » garantit qu'aucun placeholder n'est jamais montré.
  - **Révision + index dérivé** plutôt que `useMemo` dépendant d'une valeur non lue : supprime le warning `exhaustive-deps` tout en gardant le recalcul au bon moment.

- **Impacts & Dépendances :**
  - `i18n.ts` : nouvelle dépendance lecture FS extension ; idempotent, erreurs absorbées.
  - Toute future vue portail (menus, dropdowns) doit fixer `color` explicitement.

- **Prochaines étapes :**
  - Si d'autres contributions localisées apparaissent (menus, keybindings d'extension), réutiliser `resolveNlsText`.
  - Envisager la locale réellement active (aujourd'hui : `package.nls.json` puis `en`).

---


- **Contexte :**
  Deux demandes : (1) « les commandes doivent avoir la même interface que VS Code, par exemple Ctrl+Shift+P » ; (2) « toutes les commandes doivent être cross-platform mac/windows/linux proprement ». Objectif : palette collée en haut comme VS Code (plus de fenêtre flottante draggable), séparation Quick Open / Command Palette, et affichage natif des raccourcis selon l'OS.

- **Modifications effectuées :**
  - **`src/lib/platform.ts` (nouveau, module central) :** `getPlatform()` (détection via `navigator.platform`/`userAgent`), `isMac()`, `formatShortcut(key)` (gère les chords `ctrl+k ctrl+o`), `modLabel()`. Map `MAC_SYMBOLS` / `WIN_LABELS`. **Clé de voûte** : `ctrl` = modificateur principal (⌘ sur Mac, Ctrl ailleurs), car `matchesEvent` accepte `e.ctrlKey || e.metaKey` ; le vrai Control (`⌃`) est réservé à `control`.
  - **`src/lib/__tests__/platform.test.ts` (nouveau) :** 8 tests couvrant mac/win/null/chords.
  - **`src/components/palette/CommandPalette.tsx` (réécrit) :** panneau collé en haut (plus de drag ni de fenêtre flottante), fermeture externe via scrim transparent, liste plate, footer « X results », préfixe `>` = commandes (Command Palette), champ vide = Quick Open. Tous les raccourcis passés par `formatShortcut`.
  - **`src/lib/keybindings.ts` :** ajout `origin.showCommands` (ctrl+shift+p) et `origin.quickOpen` (ctrl+p) ; suppression du doublon sur `origin.togglePalette`.
  - **`src/App.tsx` :** état `paletteMode: 'quickopen' | 'command' | 'line' | 'symbol'` ; enregistrement des commandes runtime ; l'icône TitleBar ouvre toujours la Command Palette.
  - **Uniformisation cross-platform des composants restants :** `TitleBar.tsx` (menu/tooltips), `SourceTreePanel.tsx` (placeholder commit), `SettingsPanel.tsx` (placeholder recherche), `TerminalPanel.tsx` (tooltip fermeture), `ai/TaskRail.tsx` (« New Task »), `editor/EditorWelcome.tsx` (Kbd du welcome). **Plus aucun glyphe ⌘/Ctrl en dur affiché** ; les mentions restantes sont uniquement dans des commentaires.

- **Décisions Techniques :**
  - **Un unique module `platform.ts`** plutôt que des conditionnels OS dispersés : une seule source de vérité, cohérence garantie sur tous les composants, testable isolément.
  - **Format canonique `ctrl+...`** au lieu de stocker des variantes par OS : un seul binding en base, rendu natif à l'affichage. Survivre à un changement d'OS sans modifier les données.
  - **Panneau collé en haut + scrim** (plutôt que drag + listener document) : parité visuelle VS Code et suppression du double-appel d'événements.

- **Impacts & Dépendances :**
  - `platform.ts` est désormais la dépendance commune pour tout affichage de raccourci ; tout nouveau composant affichant un raccourci doit passer par `formatShortcut`/`modLabel`.
  - Aucun changement de comportement des raccourcis eux-mêmes (`Mod-` CodeMirror + `matchesEvent` déjà cross-platform) : seul **l'affichage** devient natif.

- **Prochaines étapes :**
  - Surveiller les nouveaux composants pour éviter toute réintroduction de glyphes en dur.
  - Étendre les tests `platform.test.ts` si de nouvelles touches/séquences sont ajoutées.

---


- **Contexte :**
  Demande : « rend possible toutes les commandes de VS Code dans l'éditeur proprement et avec la même performance » + « le remplace ne marche pas ». Périmètre validé avec l'utilisateur : **Palette de commandes + Éditeur (multi-curseurs/sélection) + Éditeur (édition avancée) + Navigation & fichiers**, architecture **registry de commandes central**. Objectif parité VS Code sans régression de perf (dispatch direct sur `EditorView`, pas de re-render React).

- **Modifications effectuées :**
  - **Lot A — Registry + palette :**
    - `src/lib/commands/registry.ts` (source de vérité runtime) : `RuntimeCommand { id; title; category; keywords?; run; enabled? }`, `registerCommand(s)`, `getCommands`, `getCommand`, `subscribe`, `runCommand`. `enabled` est un **booléen** d'état (pas un prédicat).
    - `src/components/palette/CommandPalette.tsx` : consommation du registry via `useSyncExternalStore` ; fusion texte/fichiers/lignes/symboles/workspace/commandes runtime dans un flux unique de scoring ; raccourci affiché via `getEffectiveKey(cmd.id)`.
    - `src/hooks/useGlobalKeybindings.ts` : garde `if (e.defaultPrevented) return;` en tête du listener — évite la double-exécution quand CodeMirror a déjà traité un raccourci. Ordre de résolution : registry runtime → extensions → legacy.
    - `src/lib/keybindings.ts` : ajout des commandes+raccourcis (Go, Selection, Lines) mappés sur les ids runtime.
  - **Lot B — Navigation :** modes préfixes de palette `:` (Go to Line, regex `/^(\d+)(?::(\d+))?$/`) et `#` (Go to Symbol, aplati depuis `outlineFromLsp`/`outlineFromText`) ; commandes `origin.goToLine` (Ctrl/Cmd+G) et `origin.gotoSymbol` (Ctrl/Cmd+Shift+O) ; `goToLineInEditor` → `editorOfSplit()?.goToLine(line, col)`.
  - **Lot C — Multi-curseurs / sélection :** `Editor.tsx` expose via `EditorHandle` : `selectNextOccurrence`, `selectAllOccurrences`, `addCursorBelow/Above`, `addCursorToLineEnd(s)`. Helpers module : `findOccurrences` (garde-fou 5000), `addNextOccurrence`, `addAllOccurrences`, `addCursorLine`. Raccourcis : Ctrl/Cmd+D, Ctrl/Cmd+Shift+L, Ctrl/Cmd+Alt+↑/↓, Ctrl/Cmd+Shift+Alt+↓.
  - **Lot D — Édition avancée :** `duplicateLineUp/Down`, `moveLineUp/Down`, `deleteLines`, `insertLineBelow/Above`, `toggleComment`, `indentMore/Less`, transformation de casse, tri de lignes — via `@codemirror/commands`. Raccourcis : Shift+Alt+↑/↓, Alt+↑/↓, Ctrl/Cmd+Shift+K, Ctrl/Cmd+Entrée, Ctrl/Cmd+Shift+Entrée, Ctrl/Cmd+/, Ctrl/Cmd+] / Ctrl/Cmd+[.
  - **Fix « replace » :** `Editor.openReplace()` appelle `openSearchPanel(view)` puis, dans un `requestAnimationFrame`, clique `.cm-search button[name="toggle-replace"]` si `aria-expanded !== 'true'` → panneau ouvert directement sur la ligne de remplacement (parité Ctrl/Cmd+H VS Code).

- **Décisions Techniques :**
  - **Registry central plutôt que keymap éparpillées** : une seule source pour palette/keybindings/menus ; `useSyncExternalStore` évite tout re-render inutile (abonnement minimal).
  - **Modes préfixes dans la palette** (`:`, `#`) plutôt que des composants séparés : UX cohérente, un seul composant à maintenir.
  - **Garde `defaultPrevented`** : CodeMirror consomme déjà certains raccourcis (`moveLineUp`…) ; sans la garde, la commande runtime rejouerait la même action = double exécution.
  - **Replace non dépliable par API** : vérifié — `@codemirror/search` n'expose aucune API publique pour ouvrir le panneau déjà déplié (état visuel dans le DOM, pas dans l'état CM). Solution pragmatique et idempotente : clic DOM du bouton `toggle-replace` sous garde `aria-expanded`. Isolation : code confiné à `openReplace()`, remplaçable si l'API évolue.
  - **Perf** : toutes les actions éditeur s'exécutent sur `EditorView.dispatch` sans passer par React → équivalent VS Code.

- **Impacts & Dépendances :**
  - `EditorHandle` s'étend (~30 méthodes) : tout appelant futur doit s'y référer.
  - Nouvelle dépendance de comportement sur le markup DOM du panneau search (`button[name="toggle-replace"]`) — à surveiller lors d'une mise à jour majeure de `@codemirror/search`.
  - `useGlobalKeybindings` : la garde `defaultPrevented` change l'ordre d'arbitrage des raccourcis (CM prioritaire).

- **Prochaines étapes :**
  - Historique de navigation (back/forward) et quick-open de symboles workspace-wide restent hors périmètre immédiat.
  - Surveiller le markup de `toggle-replace` à chaque bump de `@codemirror/search`.

- **Validation :** `npx tsc --noEmit` propre ; `npx eslint` 0 erreur (3 warnings pré-existants) ; `npx vitest run` 221/221 ; `cargo test --lib` 74/74.

---

### [2026-10-13T15:20] | Recherche — replace in files + exclusions glob + regex/case/whole-word

- **Contexte :**
  Le panneau de recherche se limitait à une recherche littérale insensible à la casse, sans option ni remplacement. Pour parité VS Code il manquait : **regex**, **casse**, **mot entier**, **exclusions glob**, et surtout **Replace / Replace All** (global et par fichier). La logique de scan vivait côté Rust (`search_in_files`) : c'est donc là que les options et le remplacement devaient être portés pour rester performant sur de gros workspaces.

- **Modifications effectuées :**
  - **`src-tauri/Cargo.toml`** : ajout de la dépendance `regex = "1"`.
  - **`src-tauri/src/search.rs`** (refonte de la section text search) :
    - `SearchOptions { is_regex, case_sensitive, whole_word }` (deserialize, `#[serde(default)]`).
    - `regex_escape` (littéral sûr), `build_regex` (compile + `case_insensitive` + ancrage `\b(?:…)\b` mot entier), `glob_to_regex` (globs `*`/`**`/`?`, `**/` initial optionnel façon gitignore), `compile_excludes` (dossier, extension, chemin), `is_excluded`.
    - `search_in_files(folder, query, options, excludes)` : signature étendue, paramètres optionnels pour ne rien casser.
    - **`replace_in_files(ReplaceRequest)`** (nouveau) : `ReplaceRequest { folder, query, replacement, options, excludes, files? }` ; `expand_replacement` (développe `$1..$9` en mode regex, littéral sinon), `replace_in_file`, `collect_files`. Limite `MAX_REPLACE_FILES = 5000`, écriture uniquement si le contenu change.
    - Tests Rust +14 : build_regex (6), glob/excludes (4), regex_escape (1), expand_replacement (2), + le test « dir name partout ».
  - **`src-tauri/src/lib.rs`** : enregistrement de `search::replace_in_files`.
  - **`src/lib/search.ts`** : types `SearchOptions`, `DEFAULT_SEARCH_OPTIONS`, `toWireOptions` (camelCase → snake_case), `searchInFiles` étendu, `replaceInFiles` + `ReplaceResult`.
  - **`src/components/SearchPanel.tsx`** : toggles `Aa` (casse), `W` (mot entier), `.*` (regex), champ **excludes**, zone **Replace** repliable (Replace All global + « All » par fichier), surlignage adapté aux options (`highlightRange`), gestion d'erreur (regex invalide / aucun remplacement), rafraîchissement des résultats après remplacement.
  - **`src/hooks/useTabs.ts`** : `reloadFilesFromDisk(paths)` — recharge le contenu des fichiers ouverts (et les démarque) après une modification externe.
  - **`src/components/Sidebar.tsx` / `src/App.tsx`** : prop `onFilesChanged` propagée jusqu'au panneau.

- **Décisions Techniques :**
  - **Scan/remplacement côté Rust** : parcourir un workspace en JS serait lent et bloquerait l'UI ; `spawn_blocking` + `regex` (compilé une fois) garde l'opération hors du thread principal. Les exclusions sont compilées en `Regex` une seule fois, pas par fichier.
  - **Rétrocompatibilité de `search_in_files`** : `options`/`excludes` en `Option<…>` → aucun autre appelant casse.
  - **`$` littéral protégé en mode non-regex** : `expand_replacement` renvoie le texte tel quel hors regex, sinon une regex `$` serait interprétée comme référence de groupe.
  - **Glob `**/` initial optionnel** : reproduit un piège gitignore classique (un motif simple doit matcher la racine *et* les sous-dossiers) — détecté par les tests avant merge.
  - **Écriture conditionnelle** (`new_text != text`) : évite de toucher les mtimes inutilement et de déclencher des watchers.
  - **`files` optionnel dans la requête de remplacement** : permet le « replace in file » sans re-scanner tout l'arbre.

- **Impacts & Dépendances :**
  - Nouveau paramètre `options`/`excludes` sur `search_in_files` : tout appelant direct doit les fournir (ici uniquement `SearchPanel`, mis à jour).
  - Nouvelle commande Tauri `replace_in_files` + dépendance `regex` (compilée dans le binaire).
  - `useTabs` expose `reloadFilesFromDisk` ; `Sidebar`/`SearchPanel` acceptent `onFilesChanged` (optionnel, rétrocompatible).

- **Prochaines étapes :**
  - Lot 8 — Finitions : breadcrumbs, brackets colorization, stash, blame.

- **Validation :** `cargo test --lib` ✅ 74/74 (dont 14 search) · `cargo build --lib` ✅ · `npx tsc --noEmit` ✅ · `npx eslint` ✅ (0 erreur) · `npx vitest run` ✅ 215/215 · `npx vite build` ✅.

---

### [2026-10-13T15:05] | Debug — breakpoints conditionnels/log points + Watch + Debug Console

- **Contexte :**
  Le débogueur DAP savait poser des breakpoints simples, afficher call stack, variables et output, mais il manquait trois capacités standard de VS Code : (1) **breakpoints conditionnels / hit count / log points**, (2) un panneau **Watch** (expressions suivies), (3) une **Debug Console** (REPL d'évaluation). Le call stack existait déjà — conservé tel quel.

- **Modifications effectuées :**
  - **`src/lib/dapWatch.ts`** (créé) : logique pure testable — `toSourceBreakpoints` (UI → payload DAP, ignore les champs vides), `isLogPoint`/`isConditional`, `fromEvaluate` (normalisation d'une réponse `evaluate`), `addWatch`/`removeWatch`.
  - **`src/context/DebugContext.tsx`** (modifié) :
    - `BreakpointEntry` enrichi (`condition`, `hitCondition`, `logMessage`).
    - État : `watchExpressions: string[]`, `evalEntries: DebugEvalEntry[]`.
    - Nouvelles actions : `setBreakpointCondition/HitCondition/LogMessage`, `addWatchExpression` (dédoublonnée + évaluation immédiate), `removeWatchExpression`, `evaluateExpression` (contexte `repl`), `clearConsole`.
    - Helper interne `mutateBreakpoints` : calcule la liste cible depuis la ref (pas d'écriture dans le setter React → pas de doublon en StrictMode) puis pousse `setBreakpoints` avec qualificatifs **uniquement si** une session est `running`/`paused`.
    - Handler `stopped` : réévalue **toutes** les expressions de watch dans la frame courante (`Promise.all`, contexte `watch`).
    - Carrying des breakpoints au lancement via `toSourceBreakpoints` (les qualificatifs survivent au démarrage de session).
  - **`src/components/debug/BreakpointRow.tsx`** (créé) : ligne de breakpoint avec éditeur inline (condition / hit count / log message), indicateurs visuels log point / conditionnel.
  - **`src/components/debug/WatchSection.tsx`** (créé) : liste d'expressions, ajout/suppression, valeur ou erreur par expression.
  - **`src/components/debug/DebugConsole.tsx`** (créé) : REPL avec historique (↑/↓), bouton Clear, colorisation expression/valeur/erreur.
  - **`src/components/DebugPanel.tsx`** (modifié) : sections **Watch** et **Debug Console** ajoutées ; la liste des breakpoints utilise `BreakpointRow`.
  - **Tests** : `src/lib/__tests__/dapWatch.test.ts` (14).

- **Décisions Techniques :**
  - **Aucun changement backend Rust** : `dap_request` est un passe-plat générique — `evaluate` et `setBreakpoints` avec `condition`/`hitCondition`/`logMessage` étaient déjà supportés par le protocole. Éviter d'ajouter des commandes Tauri inutiles réduit la surface d'attaque.
  - **`mutateBreakpoints` lit `sessionRef.current`** (pas le setter `prev`) : en React 18 StrictMode, un setter peut s'exécuter deux fois ; calculer la valeur cible hors du setter garantit une seule synchronisation adaptateur et évite les divergences.
  - **Envoi DAP conditionné à `running`/`paused`** : hors session, il n'y a pas d'adaptateur ; au lancement, c'est la config de launch qui porte les breakpoints.
  - **`fromEvaluate` tolère `success: false`** : une expression invalide au point d'arrêt courant doit s'afficher comme erreur, pas faire planter le panneau.
  - **Watch réévalué au `stopped`** (et non à chaque frappe) : cohérent avec VS Code, borné, sans martèlement de l'adaptateur.

- **Impacts & Dépendances :**
  - `DebugContextType` reçoit 7 nouvelles entrées (consommateurs existants inchangés — ajout rétrocompatible).
  - `DapSourceBreakpoint` n'était plus importé directement dans le contexte (délégué à `dapWatch.ts`).
  - Fichiers touchés : `dapWatch.ts`, `DebugContext.tsx`, `DebugPanel.tsx`, `debug/BreakpointRow.tsx`, `debug/WatchSection.tsx`, `debug/DebugConsole.tsx`.

- **Prochaines étapes :**
  - Lot 7 — Recherche : replace in files + exclusions glob + regex/case.
  - Lot 8 — Finitions : breadcrumbs, brackets colorization, stash, blame.

- **Validation :** `npx tsc --noEmit` ✅ · `npx eslint` ✅ (0 erreur) · `npx vitest run` ✅ 215/215 · `npx vite build` ✅.

---

### [2026-10-13T14:50] | Panels — Outline (symboles) + Output (console texte)

- **Contexte :**
  Deux panels attendus d'un IDE « pro » manquaient : (1) un **Outline** (arbre des symboles du fichier actif, comme VS Code), (2) un onglet **Output** découplé du terminal xterm pour lire la sortie brute des tâches (copiable/sélectionnable, sans le bruit de contrôle du terminal). Lot 5 du gap analysis IDE vs VS Code.

- **Modifications effectuées :**
  - **Output** — `src/lib/outputStore.ts` (créé) : buffer texte singleton en mémoire (Map ordonnée `canal → OutputLine[]`, `OutputLine { channel, text, kind: 'stdout'|'stderr'|'system' }`), bornes `MAX_LINES = 5000` / `MAX_CHANNELS = 20` (éviction du plus ancien canal), API `appendOutput`, `startOutputChannel`, `appendOutputSystem`, `clearOutput`, `listOutputChannels`, `getOutput`, `subscribeOutput` + `getOutputVersion` (compatibles `useSyncExternalStore`).
  - **Output** — `src/components/output/OutputPanel.tsx` (créé) : onglet console (sélecteur de canal, checkbox Auto-scroll, bouton Clear, coloration par `kind`, `whiteSpace: pre-wrap`, état vide explicite).
  - **Output** — `src/components/terminal/Terminal.tsx` + `TerminalPanel.tsx` (modifiés) : le mode tâche alimente le store (`appendOutput` en parallèle de `xterm.write`), `TerminalPanelHandle.showOutput()` + 3ᵉ onglet « Output ».
  - **Outline** — `src/lib/lspCm6.ts` (modifié) : `RawDocumentSymbol` + `lspDocumentSymbols(serverId, filePath)` (`textDocument/documentSymbol`).
  - **Outline** — `src/lib/outline.ts` (créé) : type unifié `OutlineSymbol`/`OutlineKind` (26 valeurs), mapping `SYMBOL_KIND` (numéro LSP → catégorie), `outlineFromLsp` (null si pas de serveur), `hasLspForFile`/`languageIdOf`, et **fallback regex** frontend (`TS_RULES`/`RUST_RULES`/`PY_RULES`) opérant sur le contenu déjà en mémoire (garde-fou 100k lignes).
  - **Outline** — `src/components/outline/OutlinePanel.tsx` (créé) : arbre récursif (icônes `lucide:*`, couleurs syntaxiques, repli, clic → `onFileOpenAtLine`), source **LSP prioritaire** (débounce 250 ms) avec fallback regex dérivé, spinner de chargement.
  - **Branchement** : `ActivityBar.tsx` (entrée `outline` / `lucide:list-tree`), `Sidebar.tsx` (props `activePath`/`activeContent`/`rootPath`, `case "outline"`), `App.tsx` (passe `activeTab`, `fileContents[activeTab]`, `folderPath`).

- **Décisions Techniques :**
  - **Output store en mémoire** plutôt que lecture du buffer xterm : xterm est un canvas/DOM à sémantique de terminal (ANSI, redraw) — inadapté au texte sélectionnable. Un buffer dédié est simple, testable, et évite un re-render global (abonnements via `useSyncExternalStore`).
  - **Outline LSP d'abord, regex en secours** : le LSP donne des symboles exacts et hiérarchisés ; le fallback garantit un affichage même sans serveur actif. Choix de **ne pas** utiliser la commande Rust `search_symbols` (elle parcourt tout le workspace, inadaptée à un fichier unique) → fallback purement frontend.
  - **Fallback en `useMemo` et non en `setState` d'effet** : éviter le warning `react-hooks/set-state-in-effect` et les rendus en cascade ; le contenu étant déjà en mémoire, la dérivation est synchrone et gratuite.
  - **Débounce 250 ms + garde `reqId`** : évite de marteler le serveur à chaque frappe et ignore les réponses obsolètes (course async).

- **Impacts & Dépendances :**
  - `Sidebar` reçoit 3 nouvelles props optionnelles (aucune régression pour les autres panels).
  - `Terminal.tsx` écrit désormais dans deux cibles (xterm **et** store) : coût négligeable, borné par `MAX_LINES`.
  - Fichiers touchés : `outputStore.ts`, `OutputPanel.tsx`, `outline.ts`, `OutlinePanel.tsx`, `lspCm6.ts`, `Terminal.tsx`, `TerminalPanel.tsx`, `ActivityBar.tsx`, `Sidebar.tsx`, `App.tsx`.

- **Prochaines étapes :**
  - Lot 6 — Debug : watch + breakpoints conditionnels + debug console + call stack.
  - Lot 7 — Recherche : replace in files + exclusions glob + regex/case.
  - Lot 8 — Finitions : breadcrumbs, brackets colorization, stash, blame.

- **Validation :** `npx tsc --noEmit` ✅ · `npx eslint` ✅ (0 erreur) · `npx vitest run` ✅ 201/201 · `npx vite build` ✅.

---

### [2026-10-13T13:30] | Git — inline diff gutter + resolveur de conflits de merge

- **Contexte :**
  L'IDE gérait commit/stage/branches mais l'éditeur n'affichait **aucun repère** des modifications par rapport à HEAD, et les fichiers en conflit de merge s'ouvraient comme du texte brut (marqueurs `<<<<<<<` non exploitables). Deux manques majeurs par rapport à VS Code.

- **Modifications effectuées :**
  - **`src-tauri/src/git.rs`** : nouvelle commande `git_file_head(path, file) → Result<Option<String>, String>` — `git rev-parse --is-inside-work-tree` d'abord (sinon `Err`), puis `git show HEAD:./<rel>`. `Ok(Some)` = suivi (tracked), `Ok(None)` = nouveau fichier (untracked), `Err` = hors dépôt. Chemin validé par `validate_rel_path` (confinement workspace).
  - **`src-tauri/src/lib.rs`** : `git::git_file_head` enregistrée dans `generate_handler!`.
  - **`src/lib/git.ts`** : `gitFileHead` + type `GitHeadResult` (`tracked`/`untracked`/`none`) ; bus d'événements `notifyGitChanged()` / `onGitChanged(cb)` (CustomEvent `origin:git-changed`).
  - **`src/lib/gitGutter.ts`** (créé) : `computeLineChanges(original, current)` (diff borné `timeout:60, scanLimit:8000`, normalisation CRLF, classification added/modified/deleted) ; `relativeToRoot` ; extension CM6 (`StateField` + `RangeSet` + `gutter()` + `EditorView.baseTheme`), triangle pour les suppressions, garde-fou `MAX_LINES = 50_000`.
  - **`src/lib/gitConflict.ts`** (créé) : `findConflictBlocks` (appariement par pile, gère l'imbrication et les marqueurs suffixés `<<<<<<< HEAD`/`>>>>>>> branche`), `currentSide`/`incomingSide`, `resolveConflict(text, block, 'current'|'incoming'|'both')` (fonction pure → testable), extension CM6 (surlignage des blocs + widget 3 boutons **Accept Current / Incoming / Both** ancré en fin de ligne `<<<<<<<`).
  - **`src/components/editor/Editor.tsx`** : `gitCompartment` + `conflictCompartment` ; `useEffect` (dépendant de `path`/`rootPath`) qui active les deux extensions, charge le baseline HEAD (`gitFileHead`), et le rafraîchit sur `onGitChanged`. Les compartiments sont capturés en variable locale (warnings `exhaustive-deps` évités).
  - **`src/components/SourceTreePanel.tsx`** : `load(notify = false)` → `notifyGitChanged()` ; **toutes** les opérations mutantes (commit, stage/unstage, stageAll/unstageAll, discard, pull/push/fetch, checkout, createBranch, refresh manuel) appellent `load(true)` pour rafraîchir les gutters.
  - **Tests** : `src/lib/__tests__/gitGutter.test.ts` (13) + `src/lib/__tests__/gitConflict.test.ts` (10).

- **Décisions Techniques :**
  - **Réutilisation de `diff()` de `@codemirror/merge`** (déjà en dépendance pour la revue de diff IA) plutôt que d'un merge view par éditeur : diff asynchrone borné, aucun état de merge dans le document, coût maîtrisé à la frappe.
  - **Ligne de frontière pour les suppressions** (triangle posé sur `lineAt(fromB)`), comme VS Code.
  - **Bug corrigé pendant les tests** : lors d'un ajout en fin de fichier, l'algorithme de diff inclut le `\n` final de la ligne précédente dans le bloc inséré → la ligne de frontière était marquée `added` à tort. Correctif : si le texte inséré commence par `\n` (et qu'il s'agit d'une insertion pure), on démarre après cette frontière.
  - **Résolution via `EditorView.findFromDOM`** : le widget retrouve sa vue à partir de son nœud DOM (pas de capture de closure fragile), puis raisonne en lignes pour retrouver le bloc et réécrit le document en une transaction (curseur remis au début, `scrollIntoView`).
  - **Détection courte-circuitée** (`text.includes('<<<<<<<')`) : coût nul sur les fichiers sans conflit, qui sont l'immense majorité.
  - **Confirmation/consentement** : aucune opération git destructive nouvelle introduite ; le resolver ne fait qu'éditer le buffer (l'utilisateur sauvegarde/stage ensuite), donc pas de garde-fou supplémentaire requis.

- **Impacts & Dépendances :**
  - Nouvelle commande Tauri → nécessite un rebuild du binaire Rust (fait : `cargo build --lib` OK).
  - Le gutter dépend de `localStorage`/dépôt git : hors dépôt, baseline = `null`, aucun marqueur (dégradation silencieuse).
  - `SourceTreePanel.load` : signature étendue avec paramètre optionnel `notify` (rétrocompatible).
  - Le resolver est activé pour les fichiers de travail uniquement (exclut les onglets virtuels `__*`).

- **Prochaines étapes :**
  - Lot 5 : Panels — Outline (symboles) + Output.
  - Lot 8 : ajouter blame par ligne au survol du gutter git.

---

### [2026-10-13T13:20] | LSP — rename symbol (F2) + code actions (lightbulb) + format on save

- **Contexte :**
  Les capacités LSP exposées se limitaient à diagnostics/completion/hover/définition. VS Code propose en plus le renommage de symbole, les quick fixes (ampoule) et le formatage. Le paquet `codemirror-languageserver` gère `rename`/`formatting` mais **pas** les code actions, et son API ne couvre pas le rename multi-fichiers piloté par l'app.

- **Modifications effectuées :**
  - **`src/lib/lspEdits.ts`** (créé) : types + helpers neutres pour appliquer les `TextEdit` LSP (`lspPosToOffset`, `offsetToLspPos`, `applyLspEdits` trié fin→début, `flattenWorkspaceEdit` qui aplatit `changes` + `documentChanges`). Base partagée formatage/rename/code actions.
  - **`src/lib/lspCm6.ts`** : `uriToPath` exporté ; ajout des requêtes ponctuelles via `lsp_request` (serveur CM6 déjà initialisé) : `lspFormatDocument`, `lspPrepareRename`, `lspRename`, `lspCodeActions`, `lspExecuteCommand`.
  - **`src/components/editor/Editor.tsx`** : `lspServerIdRef` (id serveur résolu pour le fichier) ; `applyWorkspaceEditLocally` (applique la part « fichier courant » dans la vue, remonte le reste via `onApplyWorkspaceEdits`) ; `runFormatDocument`, `triggerRename`/`confirmRename`, `fetchCodeActions` (alimentées par les diagnostics `forEachDiagnostic`)/`triggerCodeActions`/`applyCodeAction`. Keymap : `F2` → rename, `Mod-.` → code actions, `Shift-Alt-f` → format. `EditorHandle` enrichi (`formatDocument`, `getContent`, `renameSymbol`, `showCodeActions`). UI : invite de renommage flottante (Entrée/Échap/blur) + menu des code actions (portail, quick fixes `isPreferred` en tête) + bouton **ampoule** visible quand la ligne du curseur porte un diagnostic.
  - **`src/hooks/useTabs.ts`** : `handleSave(path, contentOverride?)` (le format-on-save relit le doc formaté depuis la vue) ; nouvelle `applyWorkspaceEdits` (fichiers ouverts → patch mémoire + `isDirty` ; fichiers fermés → lecture/patch/écriture disque, comme VS Code).
  - **`src/components/editor/EditorArea.tsx`** / **`src/App.tsx`** / **`src/components/ai/AgentModeView.tsx`** : prop `onApplyWorkspaceEdits` câblée jusqu'à `useTabs.applyWorkspaceEdits`.
  - **`src/App.tsx`** : `saveActiveFormatted` (formate via `editorRef.formatDocument()` puis sauvegarde le contenu relu depuis la vue) branché sur le raccourci de sauvegarde et la commande `onSave`.
  - **`src/components/settings/SettingsPanel.tsx`** : réglage « Format on save » (localStorage `origin-editor-format-on-save`, défaut activé).
  - **`src/lib/__tests__/lspEdits.test.ts`** (créé) : 19 tests sur les helpers (conversion positions, ordre d'application, aplatissement des WorkspaceEdits).

- **Décisions Techniques :**
  - **Requêtes ponctuelles via `lsp_request` plutôt que via le client CM6** : le serveur est déjà démarré/initialisé par `createLspExtension` ; éviter d'orchestrer le plugin du paquet tiers tout en récupérant les structures LSP brutes (dont le rename multi-fichiers).
  - **`applyWorkspaceEditLocally`** : éditer en place la vue pour le fichier courant (pas de rechargement d'onglet, préserve le focus) et remonter les autres fichiers à `useTabs`.
  - **Fichiers fermés patchés sur disque** (comportement VS Code) ; les fichiers ouverts sont modifiés en mémoire et marqués `isDirty`.
  - **Keymap au niveau éditeur** (pas dans le registre global) : F2/Ctrl+. n'agissent que sous focus éditeur et évitent un double déclenchement avec le listener `window`.
  - **Ampoule = heuristique diagnostic** (la ligne du curseur porte un diagnostic) plutôt qu'un round-trip LSP par mouvement de curseur : zéro requête supplémentaire, pas d'icône « morte ».

- **Impacts & Dépendances :**
  - Nouvelle prop `onApplyWorkspaceEdits` en cascade `App` → `EditorArea`/`AgentModeView` → `Editor`.
  - `handleSave` accepte désormais un override de contenu (signature étendue, rétrocompatible).
  - Le format-on-save lit la préférence `localStorage` (`origin-editor-format-on-save`) exposée dans Réglages > General.

- **Prochaines étapes :**
  - Lot 4 : Git (inline diff gutter + merge conflict resolver).
  - Réutiliser `EditorArea` dans `AgentModeView` pour finaliser la déduplication (dette notée au Lot 2).

---

### [2026-10-13T13:00] | Éditeur — split côte à côte + extraction `EditorArea`

- **Contexte :**
  L'éditeur ne gérait qu'un seul groupe d'onglets. Le routage de l'onglet actif (diff, preview, médias, texte) était **dupliqué** entre `App.tsx` et `AgentModeView.tsx`, ce qui rendait l'ajout d'un second panneau risqué et coûteux.

- **Modifications effectuées :**
  - **`src/components/editor/EditorArea.tsx`** (créé) : extraction de la cascade de rendu de l'onglet actif (`EditorEmptyState` → `EditorWelcome` → `__diff__` → `__preview__` → `__mdpreview__` → kind image/pdf/binary/video/audio → `Editor` → erreurs → `LoadingPane`). Props explicites, `Ref<EditorHandle>` injectable par l'appelant.
  - **`src/App.tsx`** : imports nettoyés (les panneaux ne sont plus importés en direct), `EditorArea` importé et rendu **deux fois** ; état de split `splitTab`/`splitEditorRef` ; second panneau (flex-1, bordure gauche) avec son propre `TabBar` + `EditorArea`.
  - **`src/hooks/useGlobalKeybindings.ts`** : ajout de `toggleSplit?` dans `GlobalHandlers` + entrée `origin.toggleSplit` dans la table `dispatch`.
  - **`src/lib/keybindings.ts`** : commande `origin.toggleSplit` (« Split Editor », catégorie View, défaut `Ctrl/Cmd+\`) + mapping d'import VS Code `workbench.action.splitEditor`.

- **Décisions Techniques :**
  - **Extraction `EditorArea` plutôt que duplication** : le split exige deux rendus de la même logique ; l'extraction supprime au passage la dette de duplication App/AgentModeView (routage par préfixe de path conservé à un seul endroit).
  - **Deux groupes partagent la même liste d'onglets** (comportement VS Code) : chaque panneau a son propre `activeTab` visuel, mais ouvre les fichiers du même pool.
  - **Non-objectif assumé** : l'éditeur d'une même ressource ouvert dans les deux panneaux garde deux états CodeMirror indépendants (pas de synchronisation live). Suffisant pour un premier lot ; à traiter si besoin (broadcast de `onChange`).

- **Impacts & Dépendances :**
  - `AgentModeView.tsx` peut désormais réutiliser `EditorArea` pour supprimer sa propre duplication (à faire dans un lot ultérieur).
  - `Cmd/Ctrl+\` bascule le split ; fermer l'onglet du panneau droit (`×`) referme le split s'il n'y a plus d'onglet actif.

- **Prochaines étapes :**
  - Lot 3 : rename symbol (F2) + code actions (lightbulb) + format on save.
  - Envisager la réutilisation d'`EditorArea` dans `AgentModeView` pour finaliser la déduplication.

---

### [2026-10-13T12:40] | Éditeur — minimap + folding + sticky scroll

- **Contexte :**
  Pour se rapprocher de l'ergonomie VS Code : navigation rapide (minimap), repli de code (folding) et contexte syntaxique persistant en haut du viewport (sticky scroll).

- **Modifications effectuées :**
  - **`src/components/editor/Editor.tsx`** : ajout de `codeFolding()`, `foldGutter()` et `...foldKeymap` (déjà fournis par `@codemirror/language`, aucune install). Compartiments `minimapCompartment` et `stickyCompartment` (reconfiguration à chaud) ; props `minimap` et `stickyScroll` (défaut `true`). `position: relative` ajouté au thème racine (requis pour le sticky absolu). Styles : gouttière de repli, placeholder, gouttière minimap, overlay `.cm-sticky-scroll`.
  - **`src/lib/stickyScroll.ts`** (créé) : plugin `ViewPlugin` maison. `enclosingHeaders()` remonte la chaîne d'ancêtres syntaxiques (`tree.resolveInner` + `node.parent`) et retient les en-têtes multi-lignes strictement au-dessus du viewport ; l'overlay `.cm-sticky-scroll` s'aligne sur la largeur de la gouttière et ses lignes sont cliquables (saut + défilement).
  - **`@replit/codemirror-minimap@0.5.2`** (MIT) installé via `bun add` ; intégré via `showMinimap.compute(['doc'], …)` avec `displayText: 'blocks'`.

- **Décisions Techniques :**
  - **Minimap via paquet tiers** (`@replit/codemirror-minimap`, licence MIT permissive) plutôt qu'une implémentation maison : coût/bénéfice défavorable pour un canvas de rendu.
  - **Sticky scroll maison** : aucun paquet open-source CM6 stable ne le fournit ; l'heuristique des ancêtres syntaxiques est générique (indépendante du langage) et réutilise l'arbre Lezer déjà présent.
  - **Compartiments** pour minimap/sticky/folding : permettent d'activer/désactiver sans recréer l'éditeur (perspective de réglages par onglet).

- **Impacts & Dépendances :**
  - Nouvelle dépendance front : `@replit/codemirror-minimap`.
  - Le thème de l'éditeur ajoute `position: relative` sur `&` — prérequis pour le positionnement absolu de l'overlay sticky.

- **Prochaines étapes :**
  - Exposer minimap/sticky/folding dans les réglages utilisateur (aujourd'hui : props avec défaut `true`).

---

### [2026-10-13T02:15] | LSP — ajout de 4 serveurs légers (Svelte, Vue, Astro, Prisma)

- **Contexte :**
  L'architecture LSP était complète (allowlist Rust + manifeste figé SHA-256 + pas de shell) mais ne couvrait que 14 serveurs. Les frameworks web modernes (Svelte, Vue/Volar, Astro) et Prisma manquaient, alors qu'ils sont légers et distribués via npm (Node déjà présent).

- **Modifications effectuées :**
  - **`src-tauri/src/lsp.rs`** : ajout de 4 entrées dans `lsp_exe_and_args` (`svelteserver --stdio`, `vue-language-server --stdio`, `astro-ls --stdio`, `prisma-language-server --stdio`) ; dans `npm_packages_for` (`svelte-language-server`, `@vue/language-server`, `@astrojs/language-server`, `@prisma/language-server`) et `npm_bin_names` ; ajout des 4 ids dans la liste `SERVER_IDS` de `lsp_catalog`.
  - **`src-tauri/src/lsp_index.rs`** : 4 nouveaux `Component` (npm, `artifacts: &[]`) avec `approx_mb` estimé.
  - **`src/lib/lspConfig.ts`** : 4 entrées dans `KNOWN_SERVERS` et `DEFAULT_LSP_CONFIG` (extensions `.svelte`, `.vue`, `.astro`, `.prisma`).
  - **`src/lib/languages.ts`** : 4 nouveaux `LanguageDef` (Svelte/Vue/Astro utilisent le parser `html()` ; Prisma sans parser dédié).
  - **`src/themes/materialIcons.ts`** : glyphes `svelte` (#FF3E00), `vue` (#42b883), `astro` (#BC52EE), `prisma` (#5A67D8) ; `FILE_EXTENSIONS` mis à jour (vue ne pointe plus vers `html`).

- **Décisions Techniques :**
  - **Priorité aux serveurs npm** : légers, pas de toolchain système requise, installables en un clic via `npm install --prefix` isolé dans `app_data`.
  - **Méthode d'installation homogène** : réutilisation du pipeline `install_via_npm` existant (pas de shell, validation des args).
  - **Prisma sans parser CodeMirror** : aucun parser open-source léger disponible ; la coloration viendra d'une extension TextMate future.

- **Impacts & Dépendances :**
  - Aucune nouvelle dépendance Cargo ou npm côté app (les serveurs sont installés à la demande par l'utilisateur).
  - Les 4 serveurs apparaissent dans le catalogue LSP avec bouton « Installer » actif.
  - `vue: 'html'` remplacé par `vue: 'vue'` dans `FILE_EXTENSIONS` — les fichiers `.vue` affichent désormais le logo Vue.

- **Prochaines étapes :**
  - Ajouter d'autres serveurs légers si demandé (ex: `tailwindcss-language-server`, `graphql-language-service`, `emmet-ls`).
  - Tester l'installation réelle d'un serveur (runtime Tauri) pour valider `npm install --prefix` + résolution du binaire.

---

### [2026-10-12T23:10] | Éditeur — preview vidéo/audio + icônes médias fixes

- **Contexte :**
  Après l'ajout des visionneuses image/PDF, deux manques : (1) les médias populaires (vidéo, audio) n'étaient pas prévisualisables ; (2) les icônes des médias devaient être **fixes et distinctes** par famille (image, PDF, vidéo, audio, archive, bureautique) — un `.svg` affichait à tort l'icône XML, car le registre de langages classe le SVG comme XML pour la coloration.

- **Modifications effectuées :**
  - **`src/lib/fileKind.ts`** : kinds ajoutés `video` / `audio` ; nouveaux sets `VIDEO_EXTENSIONS` (mp4, m4v, webm, ogv, mov, mkv) et `AUDIO_EXTENSIONS` (mp3, wav, ogg, oga, flac, aac, m4a, opus, weba) ; nouvelle fonction `mediaMimeOf` (MIME vidéo/audio) ; `isBinaryReadable` étendu à video/audio. Nettoyage : `avi/wmv/flv/mpg/mpeg/3gp` déplacés en binaire (non lus par la webview) ; `ts` retiré du binaire (collision avec TypeScript).
  - **`src/components/editor/VideoViewerPane.tsx`** / **`AudioViewerPane.tsx`** (CRÉÉS) : base64 → `Blob` → `URL.createObjectURL` → `<video controls>` / `<audio controls>` (seek natif, pas de limite de data URL) ; URL révoquée au démontage.
  - **`src/hooks/useTabs.ts`** : le MIME est choisi selon le kind (`imageMimeOf` pour image, `mediaMimeOf` pour vidéo/audio).
  - **`src/App.tsx`** / **`src/components/ai/AgentModeView.tsx`** : 2 branches de routage (`video`, `audio`) avec état Loading + fallback `UnsupportedFilePane`.
  - **`src/themes/materialIcons.ts`** : nouveaux glyphes `video`, `audio`, `archive`, `word`, `excel`, `powerpoint` ; `FILE_EXTENSIONS` étendu (vidéo, audio, bureautique, archives) ; table `MEDIA_EXTENSIONS` élargie — une extension média **prime sur l'icône de langage**, corrigeant le `.svg` → icône `image`.
  - **`src/lib/__tests__/fileKind.test.ts`** (CRÉÉ) : 12 tests figeant la classification (image/pdf/video/audio/binary/text), les MIME et `isBinaryReadable`.

- **Décisions techniques :**
  - **Blob URL pour vidéo/audio** (comme le PDF) : permet le seek et évite la limite de longueur des data URLs sur les gros médias ; toujours en base64 côté backend (garde workspace, aucun chemin exposé).
  - **Icônes par famille d'extension** : on connaît l'extension → icône fixe, sans dépendre du registre de langage (source de la confusion SVG/XML). Table `MEDIA_EXTENSIONS` évaluée **avant** `languageIcon` dans `pickKey`.
  - **Collision `ts`** : extension ambiguë (TypeScript vs MPEG-TS). Arbitrage : TypeScript l'emporte (usage écrasant) — le MPEG-TS retombe sur l'icône texte, acceptable.

- **Impacts & Dépendances :**
  - `useTabs` importe désormais `mediaMimeOf` ; vues `App.tsx`/`AgentModeView.tsx` étendues (duplication de routage maintenue — dette préexistante).
  - Validation : `tsc` 0 erreur, `eslint` 0 erreur (2 warnings préexistants `App.tsx`), `vitest` **159/159**, `cargo build --lib` OK.
  - Recompiler le binaire Tauri pour tester le rendu réel.

- **Prochaines étapes :**
  - Factoriser le routage d'onglets (supprimer la duplication App/AgentModeView).
  - Chantier D (non entamé) : `gopls` / `clangd`.

---

- **Contexte :**
  Ouvrir une image ou un PDF dans l'éditeur tentait de lire le fichier comme du texte UTF-8 → écran d'erreur « stream did not contain valid UTF-8 ». Besoin : afficher correctement les médias (images, PDF) et les autres fichiers binaires, et disposer d'icônes d'onglet distinctes.

- **Modifications effectuées :**
  - **`src-tauri/Cargo.toml`** : ajout `base64 = "0.22"`.
  - **`src-tauri/src/fs.rs`** : nouvelle commande `read_file_base64(path, workspace_root)` — passe par `assert_in_workspace`, refuse au-delà de `MAX_BINARY_BYTES = 50 Mo`, lit les bytes et renvoie du base64 (jamais de chemin exposé à la webview).
  - **`src-tauri/src/lib.rs`** : enregistrement `fs::read_file_base64` dans `generate_handler!`.
  - **`src/lib/fs.ts`** : wrapper `readFileBase64(path, scope?)`.
  - **`src/lib/fileKind.ts`** (CRÉÉ) : module pur `FileKind = 'text' | 'image' | 'pdf' | 'binary'`, `extensionOf`, `imageMimeOf` (svg→image/svg+xml), `fileKindOf` (sentinelles `__…` → `text`), `isBinaryReadable`.
  - **`src/hooks/useTabs.ts`** : nouvel état `binaryData: Record<string, { base64, mime }>` ; l'effet de chargement route selon `fileKindOf` (binaire lisible → `readFileBase64`, binaire pur → pas de lecture, sinon texte).
  - **`src/components/editor/ImageViewerPane.tsx`** (CRÉÉ) : data URL depuis base64, fond damier (transparence), zoom molette `Ctrl/Cmd` + boutons, « Ajuster » via `ResizeObserver`, état d'erreur.
  - **`src/components/editor/PdfViewerPane.tsx`** (CRÉÉ) : base64 → `Blob` → `URL.createObjectURL` → `<embed type="application/pdf">` (contourne la limite de longueur des data URLs) ; URL révoquée au démontage.
  - **`src/components/editor/UnsupportedFilePane.tsx`** (CRÉÉ) : message clair pour les binaires sans lecteur.
  - **`src/App.tsx`** / **`src/components/ai/AgentModeView.tsx`** : 3 nouvelles branches de routage (image / pdf / binaire) insérées avant la branche texte.
  - **Icônes** : aucune modification nécessaire — `materialIcons.ts` mappe déjà `pdf`→`pdf` et les extensions image→`image` ; `TabBar` passe déjà `tab.name` à `FileIcon`.

- **Décisions techniques :**
  - **Base64 via commande Rust plutôt que le protocole `asset:`** : `convertFileSrc`/`assetProtocol` exigerait un scope couvrant dynamiquement tout le workspace (accès fichier large accordé à la webview, surface d'attaque accrue). Le base64 garde `assert_in_workspace` (autorité backend) et n'expose aucun chemin exploitable dans la webview.
  - **Limite anti-DoS 50 Mo** : borne la taille du fichier lu, évite la saturation mémoire côté Rust et côté webview (une data URL géante figerait le rendu).
  - **Classification par extension (module pur)** : évite de tenter de décoder du binaire en texte et rend le routage testable sans DOM.
  - **Corrections eslint ciblées** : `set-state-in-effect` supprimé (PdfViewerPane), `refs` au rendu supprimé (ImageViewerPane) au profit d'un effet de « fit » déclenché par des primitives `naturalW/naturalH`.

- **Impacts & Dépendances :**
  - `src-tauri/Cargo.toml` + `lib.rs` : handlers ajoutés → **recompiler le binaire Tauri**.
  - `useTabs()` expose désormais `binaryData` ; les vues (`App.tsx`, `AgentModeView.tsx`) le reçoivent en prop.
  - Dette technique connue (préexistante) : le routage d'onglets est **dupliqué** entre `App.tsx` et `AgentModeView.tsx` — les 3 branches ont été répliquées dans les deux.
  - Validation : `tsc` 0 erreur, `eslint` 0 warning sur les fichiers médias (2 warnings préexistants subsistent dans `App.tsx`), `vitest` **147/147**, `cargo build --lib` OK.

- **Prochaines étapes :**
  - Test fonctionnel à l'exécution (binaire Tauri recompilé) : ouvrir une image, un PDF, un binaire.
  - Envisager de factoriser le routage d'onglets (supprimer la duplication App/AgentModeView).
  - Chantier D (non entamé) : `gopls` / `clangd`.

---

- **Contexte :**
  Deux bugs bloquants signalés : (1) impossible de créer un fichier/dossier **dans** un dossier (vide ou nouveau) depuis l'explorateur ; (2) le **drag & drop** pour déplacer un fichier/dossier vers un dossier ne fonctionnait pas. Objectif : refonte propre de l'explorateur pour une parité VS Code complète (création, DnD interne + import OS, presse-papier, renommage inline, menu contextuel, raccourcis, virtualisation grands projets).

- **Modifications effectuées :**
  - **`src-tauri/src/fs.rs`** : `assert_in_workspace` durci (garde lexicale + **canonicalisation** anti-symlink/anti-`..`, résolution du plus proche ancêtre existant + suffixe pour les créations). `read_dir` valide désormais le workspace. Nouvelles commandes `path_exists`, `copy_path` (+ `copy_recursive` gérant symlinks `cfg(unix/windows)`, refus de copie dans le sous-arbre) ; `rename_path`/`create_dir_cmd` étendus (validation `from`/`to`, refus si la cible existe).
  - **`src-tauri/src/lib.rs`** : enregistrement `copy_path`, `path_exists` dans `generate_handler!`.
  - **`src/lib/fs.ts`** : interface `FsScope` ; toutes les commandes acceptent un scope optionnel (`workspaceRoot`) ; ajout `copyPath`, `pathExists`.
  - **`src/lib/explorer/treeModel.ts`** (CRÉÉ, 17 tests) : helpers de chemins (`sepOf`, `parentOf`, `baseName`, `joinPath`, `normalize`, `isAncestorOrSelf`), `sortEntries` (**dossiers d'abord + A→Z**), `flattenTree` (arbre aplati → `FlatRow[]`), `nextSelection` (sélection avec ancre, Shift/Cmd).
  - **`src/lib/explorer/ops.ts`** (CRÉÉ) : opérations FS pures avec gardes (`uniquePath` anti-écrasement « name copy », `createFile`, `createFolder`, `renameEntry`, `moveInto`, `copyInto`, `deleteEntries`, `listDir`).
  - **`src/lib/explorer/useExplorer.ts`** (CRÉÉ) : état centralisé (cache par dossier, expansion persistée, sélection+ancre, presse-papier interne, drag, création/renommage inline, décoration git). Refs stables `opsCtxRef`/`refreshRef` câblées via `useEffect` (jamais mutées au rendu). `startCreate` déplie le dossier cible **avant** de poser `pendingCreate` → corrige le bug de création.
  - **`src/components/explorer/ExplorerTree.tsx`** (CRÉÉ) : arbre **virtualisé** (`ROW_HEIGHT=22`, `OVERSCAN=8`, `ResizeObserver`, fenêtrage `translateY`). **Import OS** via l'API native Tauri 2 `getCurrentWebview().onDragDropEvent()` (hit-test de la ligne sous le curseur, position physique → logique via `devicePixelRatio`, restreint à la zone de l'explorateur). **Drag interne réimplémenté en Pointer Events** (`pointerdown`/`pointermove`/`pointerup`, seuil 5 px, sélection au mousedown, suppression du clic post-drag) car l'API HTML5 DnD est **bloquée** par Tauri 2 quand `dragDropEnabled` est actif (défaut).
  - **`src/components/explorer/RenameInput.tsx`** / **`CreateInput.tsx`** (CRÉÉS) : saisie inline, sélection du nom sans l'extension (VS Code), `Enter`=valider, `Escape`=annuler, `blur`=valider.
  - **`src/components/FileTree.tsx`** (RÉÉCRIT en façade) : consomme `useExplorer`, menu contextuel complet, raccourcis (Del/F2/Cmd+N/Cmd+Shift+N/C/X/V/A, flèches, Enter, Espace), suppression avec **confirmation native** (`window.confirm`).

- **Décisions techniques :**
  - **Séparation pure/impure** : `treeModel.ts` et `ops.ts` sont des modules purs, testables sans DOM ; le hook ne fait qu'orchestrer l'état ; le composant ne fait que rendre. Cela rend les bugs de logique (tri, sélection, résolution de chemins) couvrables par des tests rapides.
  - **Défense en profondeur** : le confinement workspace est vérifié **côté frontend** (pré-filtrage, retour immédiat) **et** côté **backend Rust** (autorité finale, anti-symlink via canonicalisation). Le frontend n'est jamais digne de confiance seul.
  - **Virtualisation** : listes plates + fenêtrage pour tenir 10 k+ fichiers sans exploser le DOM.
  - **Anti-écrasement systématique** : `uniquePath` résout « name copy » ; le renommage refuse une cible existante. Jamais de perte silencieuse de données.
  - **Suppression** : confirmation native explicite plutôt que corbeille (choix utilisateur), pour rester portable et prévisible.
  - **Conflit DnD Tauri 2 (découverte majeure)** : avec `dragDropEnabled: true` (défaut, indispensable pour capter les chemins des fichiers venus de l'OS via `onDragDropEvent`), Tauri **intercepte et bloque l'API HTML5 Drag & Drop** dans la webview (surtout Windows/WebView2, cible de nos bundles `nsis`/`msi`). Le drag interne a donc été **réécrit en Pointer Events** — indépendant de l'API bloquée et multiplateforme — plutôt que de dépendre d'un plugin tiers non mature (`tauri-plugin-windows-file-drop`) ou de désactiver l'import OS. On garde ainsi **les deux** fonctionnalités sans dépendance externe.

- **Impacts & Dépendances :**
  - `src-tauri/src/lib.rs` : handlers ajoutés → recompiler le binaire Tauri.
  - `FileTree.tsx` garde la même API publique (`onFileOpen`, `onMarkdownPreview?`, `refreshKey?`) + nouvelle prop **optionnelle** `onFileOpenToSide?` (n'apparaît dans le menu que si branchée).
  - Validation : `tsc` 0 erreur, `eslint` 0 erreur (sur `FileTree.tsx`, `components/explorer`, `lib/explorer`), `vitest` **127/127**, `cargo test --lib` **61/61**.

- **Prochaines étapes :**
  - Brancher `onFileOpenToSide` quand l'éditeur supportera le split d'onglets (l'item de menu s'affichera automatiquement).
  - Chantier D (non entamé) : `gopls` / `clangd`.

---

### [2026-10-12T16:30] | Chantier C — Détection native des frameworks mobile + LSP Dart/Flutter

- **Contexte :**
  L'utilisateur veut que l'IDE **reconnaisse nativement les projets mobile** (React Native, Expo, Flutter, Android, iOS, Capacitor, Ionic) : signaler le type de projet et brancher les outils LSP adaptés (dart analysis server pour Flutter), sans qu'il ait à configurer quoi que ce soit.

- **Modifications effectuées :**
  - **`src/lib/mobileFrameworks.ts`** (CRÉÉ) : module pur + hook.
    - `MobileFramework { id, label, language, icon, markers }`.
    - `JS_STACK_RULES` (react-native, expo, @capacitor/core, @ionic/react, @ionic/angular) via `package.json` ; `FILE_RULES` (pubspec.yaml→flutter, AndroidManifest.xml/settings.gradle(.kts)→android, Podfile→ios).
    - `extractDependencies` : parsing JSON **borné** (2 Mo max), sections `dependencies`/`devDependencies` uniquement, échec silencieux (jamais de throw sur entrée hostile).
    - `detectMobileFrameworksFromNames` (pur, testable) + `detectMobileFrameworks(folderPath)` (lecture superficielle) + hook `useMobileProject`.
  - **`src/lib/__tests__/mobileFrameworks.test.ts`** (CRÉÉ) : 10 tests (Flutter, RN, Expo, Android, iOS, dédup, JSON invalide, non-mobile, casse, clés d'icônes).
  - **`src/themes/materialIcons.ts`** : bloc SVG « Mobile » (flutter, android, apple, capacitor, ionic) + mappings noms/extensions (pubspec.yaml, Podfile, Gradle, AndroidManifest.xml, Info.plist…). **API `materialIconByKey(key)`** exportée (résolution directe par clé).
  - **`src/lib/languages.ts`** : `kotlin` scindé (kt / kts), `gradle` et `plist` ajoutés, fichiers Ruby étendus (Podfile/Fastfile/Appfile) ; **`dart` câblé sur `dart-analysis-server`**.
  - **`src/components/StatusBar.tsx`** : badge(s) framework(s) mobile détecté(s) à droite.
  - **Câblage LSP Dart** : `src-tauri/src/lsp.rs` (`lsp_exe_and_args` → `("dart", &["language-server"])` + `SERVER_IDS`), `src/lib/lspConfig.ts` (`KNOWN_SERVERS` + `DEFAULT_LSP_CONFIG.servers`, `needs: 'NEEDS_DART_TOOLCHAIN'`), `src-tauri/src/lsp_index.rs` (raison `NEEDS_DART_TOOLCHAIN`).

- **Décisions techniques :**
  - **Détection non fiable à 100 % → bornée et défensive** : lecture superficielle (racine + `package.json`), parsing JSON en try/catch silencieux, taille plafonnée. Détection = indication UX, jamais autorité d'exécution.
  - **Dart jamais téléchargé par l'app** : le language server (`dart language-server`) est fourni par le SDK Dart/Flutter. On l'expose en LSP dédié mais **non auto-installable** (`NEEDS_DART_TOOLCHAIN`) : cohérent avec la règle « binaire tiers = confirmation / pas de téléchargement sauvage ».
  - **Langages mobile ajoutés au registre unique** `languages.ts` (source de vérité icône + parser + identité LSP) plutôt qu'un mapping ad hoc.

- **Impacts & Dépendances :**
  - `tsc` 0 erreur, `eslint` 0 erreur, `vitest` 110/110, `cargo test --lib` 61/61.
  - `App.tsx` : `useMobileProject(folderPath)` → `mobileFrameworks` → `StatusBar`. Aucun impact sur les serveurs existants (entrée purement additive dans l'allowlist).

- **Prochaines étapes :**
  - Chantier D : `gopls` / `clangd` (binaires tiers + confirmation au premier usage).
  - Envisager un LSP Kotlin/Swift (`kotlin-language-server`, `sourcekit-lsp`) si le besoin mobile natif Android/iOS se confirme.

---

### [2026-10-12T15:10] | Chantier B — Preview Markdown en onglet plein écran + action/icône

- **Contexte :**
  L'utilisateur veut **prévisualiser proprement les fichiers `.md`** depuis l'IDE (icône + action), au lieu de dépendre d'un rendu inline limité.

- **Modifications effectuées :**
  - **`src/components/editor/MarkdownPreviewPane.tsx`** (CRÉÉ) : onglet plein écran, modes **Preview / Source**, réutilise `MarkdownMessage`. Aucun `openUrl`/`ExternalLink` (pas de navigation externe depuis le rendu).
  - **`src/components/editor/TabBar.tsx`** : `kind` étendu à `'markdown-preview'` + icône `FileText`.
  - **`src/hooks/useTabs.ts`** : sentinelle `__mdpreview__`, `openMarkdownPreviewTab(filePath)`.
  - **`src/App.tsx`** : rendu conditionnel de l'onglet preview.
  - **`src/components/FileTree.tsx`** : item « Open Markdown Preview » (icône `Eye`) pour `.md`/`.mdx` ; prop `onMarkdownPreview?` **optionnelle** (défaut no-op).
  - **`src/components/Sidebar.tsx`** : prop `onMarkdownPreview?` optionnelle propagée.
  - **`src/components/palette/CommandPalette.tsx`** : commande **« Open Markdown Preview »** affichée uniquement si l'onglet actif est un `.md`/`.mdx` (+ `activeTab`/`onOpenMarkdownPreview` dans les deps).

- **Décisions techniques :**
  - **Onglet dédié** plutôt qu'aperçu inline : place au rendu complet, cohérent avec le modèle d'onglets existant.
  - **Prop optionnelle avec no-op par défaut** : évite de casser les autres points de montage (`AgentModeView`) → un seul point de câblage à maintenir.

- **Impacts & Dépendances :**
  - `tsc` 0 / `eslint` 0 / `vitest` 100/100 au moment de la livraison.
  - `Tab.kind` étendu : tout `switch` sur `kind` doit rester exhaustif (aucune régression constatée).

- **Prochaines étapes :**
  - ~~Chantier C mobile~~ (livré, voir entrée ci-dessus).

---

### [2026-10-12T14:20] | Chantier A — LSP Markdown (marksman, binaire natif)

- **Contexte :**
  Le Markdown était le seul langage « courant » sans serveur LSP. Objectif : complétion/diagnostic Markdown, sans dépendance à Node.

- **Modifications effectuées :**
  - **`src-tauri/src/lsp.rs`** : `lsp_exe_and_args` → `("marksman", &["server"])` ; ajout à `SERVER_IDS` du catalogue.
  - **`src-tauri/src/lsp_index.rs`** : entrée d'index figé (archive `"bin"`, binaire natif) pour `marksman`.
  - **`src-tauri/src/downloader.rs`** : `write_binary` branché pour l'installation du binaire.
  - **`src/lib/lspConfig.ts`** : `marksman` dans `KNOWN_SERVERS` + `DEFAULT_LSP_CONFIG.servers` (`extensions: ['md','mdx']`, `languageId: 'markdown'`, pas de `--stdio`).
  - **`src/lib/languages.ts`** : `markdown` câblé sur `marksman`.

- **Décisions techniques :**
  - **marksman (binaire natif)** retenu plutôt qu'un serveur npm : pas de toolchain Node requise, téléchargement d'une archive unique, invocation `marksman server`.
  - **Index figé = seule autorité de téléchargement** : le frontend ne peut demander que des composants présents dans `lsp_index::COMPONENTS` (surface d'attaque réduite).

- **Impacts & Dépendances :**
  - `cargo test --lib` 7/7 (marksman ajouté à l'allowlist + index).
  - Aucune régression des serveurs npm existants.

- **Prochaines étapes :**
  - Chaîner sur le chantier B (preview `.md`).

---

### [2026-10-12T23:55] | Toasts LSP clarifiés + icônes Material officielles dans l'explorateur

- **Contexte :**
  Deux irritants d'UX signalés par l'utilisateur : (1) les toasts LSP contenaient des **tirets cadratins** (`—`) et un message de succès peu explicite (« installé — complétion activée ») ; (2) dans l'éditeur/explorateur, **les icônes de langages ne correspondaient pas au langage réel** (glyphes monochromes génériques : Python = engrenage, Go = symbole de code…).

- **Modifications effectuées :**
  - **`src/App.tsx`** (`handleMissingServer`) : suppression de tous les tirets cadratins dans les toasts LSP ; message de succès remplacé par **« X installé avec succès »** ; messages d'erreur `NEEDS_PYTHON`/`NEEDS_NODE` reformulés en une phrase claire (action exécutable conservée).
  - **`src/themes/materialIcons.ts`** : réécriture complète sur la base des **SVG officiels du Material Icon Theme** (`github.com/PKief/vscode-material-icon-theme`), **couleur intégrée** (`fill`), au lieu des couples forme+couleur génériques.
    - `ICONS` : catalogue autonome de SVG complets (web, data, langages, shell/build/infra, `lock`, `pdf`, `zip`, `image`).
    - `FILE_NAMES` (nom exact) et `FILE_EXTENSIONS` (extension) : mappings déclaratifs exhaustifs (Dockerfile, Makefile, tsconfig, Cargo, go.mod, requirements.txt, Gemfile, LICENSE, README…).
    - `ICON_KEY_ALIASES` : pont explicite entre les clés d'icône du registre `lib/languages.ts` (`tsx`, `jsx`) et le catalogue (`react_ts`, `react`).
    - `pickKey` : priorité **langage → nom exact → extension → repli** (`file`/`folder`).
    - `iconDataUri` : encode un SVG complet en data-URI `image/svg+xml` (cache mémoire) ; **API publique `resolveMaterialIcon` conservée** (repli toujours non-null).

- **Décisions techniques :**
  - **Icônes Material officielles plutôt que glyphes maison** : fidélité au comportement VS Code (extension préinstallée), reconnaissance immédiate des langages, zéro dépendance réseau.
  - **Catalogue auto-contenu (SVG + couleur intégrée)** : élimine la paire forme/couleur qui rendait le mapping fragile ; chaque clé EST l'icône finale.
  - **SVG générés côté code** (jamais lus sur disque) → aucune source non fiable ; rendu via `<img src=…>` (média passif, pas de markup vivant).
  - **Alias explicites** (`ICON_KEY_ALIASES`) plutôt que renommage des clés du registre : évite de coupler le registre de langages au catalogue d'icônes.

- **Impacts & Dépendances :**
  - `src/themes/materialIcons.ts` (réécrit), `src/App.tsx` (toasts). Interface `resolveMaterialIcon(name, isDir, expanded, languageIcon)` **inchangée** → `FileIcon.tsx` non modifié.
  - Le thème d'icônes d'extension reste **prioritaire** (`FileIcon` : thème → bundle Material), conforme à VS Code.

- **Prochaines étapes :**
  - Poursuivre le câblage LSP (candidats à valider avec l'utilisateur : Markdown resté sans serveur, `gopls`/`clangd` grisés hors périmètre auto-installable…).
  - Envisager une distinction visuelle dossier ouvert/fermé si le thème courant le requiert.

---

### [2026-10-12T23:20] | Correctif « Node.js introuvable » (nvm/`n`, npm-cli.js) — débloque les serveurs LSP npm

- **Contexte :**
  Après le câblage des serveurs npm (JSON/CSS/HTML/YAML/Shell/Dockerfile), l'utilisateur obtenait « HTML (vscode-html-language-server) — Node.js introuvable » malgré un Node v24 installé. **Deux causes distinctes**, toutes deux dans la résolution d'environnement :
  1. **PATH enrichi (`env_path.rs`) ignorait les gestionnaires de version Node.** Le PATH couvrait Cargo/Homebrew/pipx mais **ni nvm** (`~/.nvm/versions/node/<v>/bin`), ni `n` (`~/n/bin`), ni fnm/volta/asdf. Ces outils patchent le PATH depuis les rc du shell ; un shell de login lancé avec `-c` peut ne pas les charger (early-return non-interactif). `find_node()` (via `find_in_path`) échouait donc → `NEEDS_NODE`.
  2. **`install_via_npm` cherchait `npm-cli.js` au mauvais endroit.** Le code visait `<node_bin>/node_modules/npm/bin/npm-cli.js`, alors que nvm/`n`/Homebrew placent npm dans le **`lib/` du préfixe** : `<node_bin>/../lib/node_modules/npm/bin/npm-cli.js`. Même avec Node trouvé, npm n'aurait pas été localisé → `NEEDS_NODE`.

- **Modifications effectuées :**
  - **`src-tauri/src/env_path.rs`** :
    - `well_known_dirs` étendu via `node_manager_dirs(home)` : `~/n/bin`, versions `n`/nvm (`<v>/bin`), `~/.fnm/aliases/default/bin`, `~/.volta/bin`, `~/.asdf/shims`.
    - `nvm_alias` lit `~/.nvm/alias/default` (alias souvent **partiel**, ex. `24`) ; `resolve_nvm_alias` le résout contre les versions installées (exact / préfixe `24` / symbolique `lts/*`, `node`) et retombe sur la plus récente.
    - `latest_version_bin` : tri **sémantique décroissant** des `vX.Y.Z` (indépendant de l'ordre du FS), `parse_semver` robuste.
    - 6 tests ajoutés (semver, tri, résolution d'alias, présence nvm/`n`, dont un test « machine réelle » conditionnel qui vérifie que le PATH enrichi expose bien `node`).
  - **`src-tauri/src/lsp.rs`** : `install_via_npm` teste désormais **deux** dispositions de `npm-cli.js` (`../lib/node_modules/npm/bin/…` puis `node_modules/npm/bin/…`). Fallback `npm` du PATH **volontairement exclu** : sous nvm/`n` c'est un script shell (shim) non passable comme script à `node`.

- **Décisions Techniques :**
  - **Détection explicite plutôt que pari sur le shell** : résoudre nvm/`n` directement est **déterministe** et couvre les configs où `zsh -lc` ne charge pas nvm. Le shell de login reste un canal *supplémentaire*, pas l'unique.
  - **Alias nvm partiel** : `~/.nvm/alias/default` contenant `24` (et non `v24.21.0`) est un cas réel constaté — la résolution par préfixe évite de viser un dossier inexistant.
  - **Pas de fallback npm shim** : passer le shim shell à `node` aurait produit un échec obscur ; mieux vaut échouer explicitement (`NEEDS_NODE`) que mal exécuter.

- **Impacts & Dépendances :**
  - Rust : `env_path.rs`, `lsp.rs`. Aucun changement front/API.
  - Effet de bord **bénéfique** : tout binaire Node/npm (et futurs serveurs npm) devient résolvable sans configuration utilisateur, quel que soit le gestionnaire de version.
  - Vérifié end-to-end : `node <npm-cli.js> install --prefix <dir>` a réellement installé `bash-language-server` et `vscode-langservers-extracted` (→ `.bin/vscode-css|html|json-language-server`).

- **Prochaines étapes :**
  - Confirmer dans l'app l'installation en un clic d'un serveur npm partagé (HTML/CSS) et son démarrage (stdio).
  - (Futur, non câblé v1) Node portable embarqué pour supprimer toute dépendance à un Node système.

---

### [2026-10-12T22:40] | LSP : câblage des serveurs « à moitié finis » + langages légers (JSON/CSS/HTML/YAML/Shell/Dockerfile)

- **Contexte :**
  Cinq serveurs LSP étaient **supportés par l'allowlist d'exécution** Rust (`lsp_exe_and_args`) et routés par `languages.ts`, mais **absents de l'autorité de téléchargement** (`lsp_index::COMPONENTS`) et du catalogue front (`KNOWN_SERVERS` / `DEFAULT_LSP_CONFIG`) : ils restaient donc invisibles/inertes. Parallèlement, Dockerfile (langage déjà déclaré) n'avait aucun serveur câblé alors que `dockerfile-language-server-nodejs` est léger (npm). Objectif : activer ces serveurs « déjà à moitié finis » et les langages absents légers, sans travail manuel utilisateur.

- **Modifications effectuées :**
  - **`src-tauri/src/lsp_index.rs`** : ajout à `COMPONENTS` (tous `artifacts: &[]`, install via npm) de `vscode-css/html/json-language-server` (paquet partagé `vscode-langservers-extracted`, ISC), `yaml-language-server` (MIT), `bash-language-server` (MIT), `dockerfile-language-server-nodejs` (MIT). Test `pip_and_npm_servers_are_registered_without_direct_artifacts` étendu à 9 ids ; gopls/clangd vérifiés hors COMPONENTS.
  - **`src-tauri/src/lsp.rs`** :
    - `lsp_exe_and_args` : ligne `dockerfile-language-server-nodejs` → `("dockerfile-language-server-nodejs", ["--stdio"])`.
    - `lsp_catalog` : `SERVER_IDS` complété ; condition `auto_installable` généralisée via `npm_packages_for(id).is_some() || id == "pylsp"` (plus de liste figée `basedpyright|typescript|pylsp`).
    - Nouvelles fonctions **source unique** `npm_packages_for` (paquets) et `npm_bin_names` (binaires dans `node_modules/.bin`), utilisées à la fois par le routage `lsp_install` et par `install_via_npm` (refactoré).
    - **`resolve_lsp_binary`** : le dossier app-data est désormais résolu via `component.install_dir` (et non `server_id`) — indispensable car css/html/json **partagent** le dossier `vscode-langservers-extracted`. Recherche étendue à `node_modules/.bin` (binaires produits par `npm install --prefix`), en plus de `bin`/`Scripts`/racine.
    - **`classify_source`** : même alignement `install_dir` pour étiqueter correctement la source « app » d'un binaire npm partagé.
  - **`src/lib/lspConfig.ts`** : ajout de `dockerfile-language-server-nodejs` à `KNOWN_SERVERS` ; `DEFAULT_LSP_CONFIG` étendu de 3 → 9 serveurs (ajout json/jsonc, css/scss/less, html/htm, yaml/yml, sh/bash/zsh, dockerfile) avec `languageId` et args corrects (`start` pour bash, `--stdio` ailleurs).
  - **`src/lib/languages.ts`** : `lsp:` + `languageId` ajoutés sur `dockerfile` → `dockerfile-language-server-nodejs` et `yaml` → `yaml-language-server`. Markdown **volontairement laissé sans LSP** (aucun serveur dans l'allowlist).

- **Décisions Techniques :**
  - **`install_dir` ≠ `server_id`** : pour ne pas télécharger trois fois le même paquet, css/html/json partagent un dossier physique ; la résolution et la classification devaient donc suivre `install_dir` **sinon** le binaire installé serait resté introuvable (régression silencieuse). C'est le point d'alignement clé corrigé ici.
  - **`npm_packages_for` comme source unique** : évite la divergence historique entre « ce qu'on décide d'installer » et « ce qu'on exécute », en centralisant paquets et noms de binaires par `serverId`.
  - **Zéro travail utilisateur** : tous ces serveurs sont npm → installables en un clic si Node est présent ; sinon le backend renvoie `NEEDS_NODE` (action exécutable), jamais un échec sec.
  - **Sécurité inchangée** : l'autorité reste l'allowlist `lsp_exe_and_args` (exécution) + `COMPONENTS` (téléchargement), tous deux figés à la compilation ; le front ne peut pas faire exécuter un binaire arbitraire.
  - **Markdown exclu** : décision de ne pas câbler `vscode-markdown-language-server` (non présent dans l'allowlist) — hors périmètre « léger sûr » de cette passe.

- **Impacts & Dépendances :**
  - Rust : `lsp.rs`, `lsp_index.rs`. Front : `lspConfig.ts`, `languages.ts`.
  - Nouveaux serveurs visibles dans Settings et le catalogue LSP ; un fichier `.yaml`/`.yml`/`Dockerfile` déclenche désormais un serveur (installation proposée au premier usage si absent).
  - Dépendance runtime : **Node** (déjà requise par basedpyright/typescript-language-server) pour ces six serveurs npm.

- **Prochaines étapes :**
  - Vérifier en exécution réelle l'installation + démarrage d'un serveur npm partagé (ex. CSS) pour confirmer la résolution `node_modules/.bin` sous `vscode-langservers-extracted`.
  - (Futur, non câblé v1) Node portable embarqué pour supprimer la dépendance à un Node système.

---

### [2026-10-12T22:10] | Runtime d'extensions : polyfill Node `process` (correctif `'process' is not defined`)

- **Contexte :**
  L'activation de l'extension `ms-python.python` échouait sur `extension failed to load: 'process' is not defined`. Cause racine : le sandbox QuickJS injecte les globals web (`structuredClone`, timers, `TextEncoder`…) et le shim `vscode`, mais **aucun global `process` / `global` / `setImmediate` / `Buffer`**. Le bundle `.vsix` de MS-Python est produit par webpack/esbuild pour Node.js et référence `process.platform` / `process.env` / `process.cwd()` **dès le chargement du module** → `ReferenceError` qui **avorte l'évaluation complète** (message générique levé par `evalModule`).

- **Modifications effectuées :**
  - `src/lib/extensions/runtime.ts` (`installWebGlobals`) : ajout d'un **polyfill Node inerte** fourni avant l'eval du bundle :
    - `process` : `platform`/`arch`/`type`/`version`/`versions`/`argv`/`execPath` figés, `env` = objet **vide**, `cwd()` = dossier d'extension, `nextTick`/`hrtime`/`memoryUsage`/`uptime` neutres, surface EventEmitter (`on`/`once`/`off`/`emit`…) en no-op, `stdin`/`stdout`/`stderr` non fonctionnels (jamais les handles hôte).
    - `global` = alias de `globalThis`.
    - `setImmediate` / `clearImmediate` (microtask).
    - `Buffer` : sous-ensemble pur JS (`from`/`alloc`/`concat`/`isBuffer`/`byteLength`) encodé via `TextEncoder`/`TextDecoder` — aucune mémoire hôte référencée.

- **Décisions Techniques :**
  - **Modèle VS Code confirmé par la doc officielle** : le *web extension host* (WebWorker) n'expose **pas** `process`/`os`/`setImmediate`/`path`/`util`/`url` — les web extensions doivent fournir elles-mêmes un polyfill (`process/browser` via webpack). Origin étant dans la même catégorie (sandbox sans accès Node), il doit **fournir le polyfill côté runtime** plutôt que d'exiger du packager. Zed, lui, n'exécute pas de JS `.vsix` (extensions Rust/WASM) — non applicable.
  - **Inerte par conception** : le polyfill ne donne **aucun accès hôte** (pas d'`env`/PATH réel, pas de FS, pas de `stdout` réel). Toute capacité host-bound reste **exclusivement** derrière le bridge `vscode.*` (déjà capability-gated + consentement). Le polyfill débloque le *chargement*, pas les *privilèges*.
  - **Placement dans `installWebGlobals`** : regroupe tous les globals « de chargement » au même endroit, cohérent avec l'existant, appliqué avant `installVscodeShim` et l'eval.

- **Impacts & Dépendances :**
  - Frontend uniquement : `src/lib/extensions/runtime.ts`. Aucun changement Rust/API.
  - Les extensions qui *utilisaient* `process` sans le référencer (cas de chargement) sont désormais débloquées. Une extension qui attendrait un `process` **fonctionnel** (spawn, I/O réel) restera bridée — ce qui est l'objectif de sécurité.

- **Prochaines étapes :**
  - Réactiver `ms-python.python` et confirmer visuellement le chargement (au-delà de l'erreur de référence).
  - Surveiller d'autres globals Node potentiellement référencés (ex. `require('child_process')`, `worker_threads`) s'ils apparaissent au chargement d'autres bundles.

---

### [2026-10-12T21:55] | LSP : rendre l'installation automatique de `pylsp` réelle (correctif `NO_AUTO_INSTALL`)

- **Contexte :**
  L'utilisateur a cliqué « Installer » sur le serveur **pylsp** et a reçu `{"code":"LSP_NOT_AUTO_INSTALLABLE","serverId":"pylsp","reason":"NO_AUTO_INSTALL"}`. Cause racine : `pylsp` est listé dans le catalogue front (`lspConfig.ts`) **et** dans l'allowlist d'exécution (`lsp_exe_and_args`), mais il était **absent** de `lsp_index::COMPONENTS` (autorité de téléchargement). Résultat : `component_for("pylsp")` → `None`, `auto_installable: false` côté catalogue, et `lsp_install` refusait avec la raison par défaut `NO_AUTO_INSTALL`. Incohérence front/back : l'UI proposait une action qui ne pouvait pas aboutir.

- **Modifications effectuées :**
  - `src-tauri/src/lsp_index.rs` : composant `pylsp` ajouté à `COMPONENTS` (`install_dir: "pylsp"`, `approx_mb: 20`, **artefacts vides** — installé via pip, comme basedpyright via npm). Nouveau test `pip_and_npm_servers_are_registered_without_direct_artifacts`.
  - `src-tauri/src/lsp.rs` :
    - `find_python()` : détecte `python3` puis `python` dans le PATH enrichi.
    - `install_via_pip(python, dest)` : crée un **venv isolé** dans app-data (`python -m venv`), puis `<venv>/bin/python -m pip install python-lsp-server` ; retourne l'exécutable `pylsp` (`bin/` Unix, `Scripts/` Windows). Aucun `pip install` global, aucun droit admin.
    - `lsp_install` : nouvelle branche `pylsp` dans le cas sans artefact (miroir de la branche npm), avec raison exécutable `NEEDS_PYTHON` si aucun Python n'est présent.
    - `resolve_lsp_binary` : la recherche app-data couvre désormais `bin` / `Scripts` (venv) **en plus** de la racine du dossier serveur.
    - `lsp_catalog` : `pylsp` ajouté au `matches!` des serveurs installés sans artefact direct → `auto_installable: true`.
  - `src/App.tsx` : le `.catch` de `lsp_install` **parse le JSON structuré** de Rust et affiche un message actionnable (`NEEDS_PYTHON` / `NEEDS_NODE` / `LSP_NOT_AUTO_INSTALLABLE`) au lieu du JSON brut.

- **Décisions Techniques :**
  - **Venv isolé plutôt que `pip install --user`** : un environnement autonome dans `<app_data>/lsp-servers/pylsp/` est supprimable d'un bloc (désinstallation propre), ne pollue jamais le Python système, et son script `pylsp` a un **shebang absolu** (vérifié : `#!/…/venv/bin/python`) — il reste correct même lancé par l'app GUI.
  - **Même schéma que npm** : `pylsp` suit exactement le modèle de `basedpyright` (composant sans artefact + orchestration d'un gestionnaire de paquets local). Cohérence architecturale, pas de chemin spécial.
  - **Résolution étendue à `bin`/`Scripts`** : nécessaire pour qu'un venv soit trouvé sans shim textuel fragile (descripteur non portable sous Windows).
  - **Erreurs actionnables** : `NEEDS_PYTHON` n'est pas un échec sec mais une instruction (« installe Python 3 puis réessaie »), conforme à la politique « zéro travail pour l'utilisateur ».

- **Impacts & Dépendances :**
  - Backend : `lsp_index.rs` (registre composants), `lsp.rs` (résolution + install + catalogue). Frontend : `App.tsx` (traduction des erreurs structurées).
  - `resolve_lsp_binary` gagne 2 sous-dossiers de recherche : purement additif, aucun risque de régression sur rust-analyzer (racine toujours consultée).
  - Validation : `cargo test --lib` **53 passed** (+1), `npm test` **100 passed**, `tsc --noEmit` **0 erreur**, `eslint` **0 erreur** (warnings préexistants inchangés). Flux pip validé manuellement (Python 3.14) : `pylsp v1.15.0` installé et résolu dans le venv ; ressources temporaires nettoyées.

- **Prochaines étapes :**
  - Envisager `pip install` incrémental (réutiliser un venv existant) pour accélérer les réinstallations — non nécessaire en v1 (le dossier est repart de zéro volontairement).
  - Téléchargement d'un Node portable embarqué (v1 non branché) — même logique pour pylsp si Python système absent.

---

### [2026-10-12T21:35] | Extensions : consentement des binaires tiers & garde de prérequis (ext-guard + ext-consent)

- **Contexte :**
  Deux garde-fous manquaient au tier « code » des extensions (Level 2, sandbox QuickJS). **(1) ext-guard** : une extension déclarant `extensionDependencies` pouvait être activée alors que ses dépendances n'étaient pas installées, provoquant des échecs opaques à l'exécution. **(2) ext-consent** : aucune extension ne peut embarquer/lancer un binaire tiers sans confirmation — règle produit « tout binaire tiers demande confirmation au premier usage ». Objectif : bloquer l'activation tant qu'un prérequis manque ou qu'un binaire tiers n'est pas approuvé, avec des états **explicables** (jamais un « error » nu) et une action exécutable côté UI.

- **Modifications effectuées :**
  - `src-tauri/src/extensions.rs` : `ExtensionInfo` expose désormais `extension_dependencies` / `extension_pack` (standard `extensionDependencies` / `extensionPack`) et `binaries` (section **non standard** `origin.binaries`, liste de chemins relatifs). Nouveau struct `OriginSection`. 3 tests Rust ajoutés (deps/pack parsés, défauts vides, binaires `origin`).
  - `src/lib/extensions.ts` : champs `extension_dependencies`, `extension_pack`, `binaries` ajoutés à `ExtensionInfo`.
  - `src/lib/extensions/guard.ts` (**nouveau**) : `checkPrerequisites` / `describeMissing` — résolution pure et testable des prérequis (comparaison d'ids insensible à la casse).
  - `src/lib/extensions/binaryConsent.ts` (**nouveau**) : modèle de consentement binaire — `normalizeBinaryPath` / `normalizeBinaryList` (clé stable), `missingBinaryConsent`, `grantedBinaries` / `setGrantedBinaries` / `addGrantedBinaries` / `clearBinaryConsent`, `binaryConsentStatus`. Persistance localStorage `origin-extension-binary-consents`.
  - `src/lib/extensions/host.ts` : états `prerequisites-missing` et `binary-consent-required` ajoutés à `ActivationState`. Dans `activate()` : garde `checkPrerequisites` **avant** les permissions, puis garde `binaryConsentStatus` — activation refusée (état explicable, pas « error ») tant que non satisfait.
  - `src/components/ExtensionsPanel.tsx` : badges neutres `PrereqBadge` / `BinaryBadge`, messages explicatifs + action ; bouton Activer grisé pour ces états ; nouvelle `BinaryConsentModal` (approbation binaire par binaire).
  - `src/context/ExtensionsContext.tsx` : `revokeConsent` purge aussi le consentement binaire à la désinstallation.

- **Décisions Techniques :**
  - **Binaires déclarés hors `contributes`** : champ non standard `origin.binaries` isolé dans son propre struct, pour qu'un champ Origin ne soit jamais confondu avec un champ VS Code standard.
  - **Consentement pur + persistance séparée** : `binaryConsent.ts` garde la logique de normalisation/calcul testable **sans** effet de bord ; le stockage est isolé en fin de module. Les chemins sont normalisés (`\` → `/`, `./` retiré) pour qu'une variante Windows/Unix désigne le même binaire.
  - **Défense en profondeur** : le consentement est vérifié à l'activation (host) **et** reste exigé pour toute capacité sensible (déjà en place via `assertCapability`). Aucun lancement silencieux possible.
  - **États non bloquants plutôt qu'« error »** : prérequis/binaire manquants laissent l'extension installée et **deviendront activables** dès satisfaction — cohérent avec la politique « jamais un error nu, toujours une action ».

- **Impacts & Dépendances :**
  - Backend : `extensions.rs` (manifest + `ExtensionInfo`). Frontend : `extensions.ts`, `guard.ts` (nouveau), `binaryConsent.ts` (nouveau), `host.ts`, `ExtensionsPanel.tsx`, `ExtensionsContext.tsx`.
  - `ExtensionInfo` gagne 3 champs optionnels : rétrocompatible (défauts vides côté Rust).
  - Validation : `cargo test --lib` **52 passed** (+3), `npm test` **100 passed** (+17 : guard + binaryConsent), `tsc --noEmit` **0 erreur**, `eslint` **0 erreur** (warnings préexistants inchangés).

- **Prochaines étapes :**
  - Câbler le lancement effectif d'un binaire d'extension (aujourd'hui : consentement + gating en place ; l'exécution réelle d'un `origin.binaries` via une commande Tauri dédiée reste à brancher).
  - Optionnel : téléchargement du Node portable non branché (v1).

---

### [2026-10-12T20:40] | LSP : résolution multi-source, erreur structurée & support des serveurs embarqués dans les extensions VS Code

- **Contexte :**
  Symptôme rapporté : « Python (pylsp) language server not found » — sans savoir si la cause était l'absence d'extension ou autre chose. Diagnostic : le binaire `pylsp` n'est **pas** sur la machine. Trois faiblesses réelles (au-delà du binaire manquant) : (1) la détection d'absence se faisait en **parsant le texte** du message d'erreur (`os error 2`, « not found »…) — fragile, localisé, dépendant de l'OS ; (2) **aucun diagnostic proactif** — on ne découvrait le manque qu'à l'ouverture d'un fichier ; (3) le lancement n'avait **qu'une seule source** (PATH), donc une extension VS Code embarquant son serveur n'avait aucun effet. Objectif : rendre le LSP fiable de bout en bout et tirer parti des extensions `.vsix` déjà installables (marketplace Open VSX + fichier).

- **Modifications effectuées :**
  - `src-tauri/src/lsp.rs` :
    - **Résolution multi-source** `resolve_lsp_binary(app, server_id, bare_name, serverPath)` par ordre de précédence : **(1)** `serverPath` explicite (config, chemin absolu délibéré) → **(2)** binaires embarqués dans l'app (`<app_data>/lsp-servers/<serverId>/`) → **(3)** **PATH** système → **(4)** **extensions installées** (`<app_data>/extensions/*/{node_modules/.bin,bin,server,out,dist,racine}`). Pure résolution de chemin, **aucun processus lancé**.
    - **Erreur structurée** `LspBinaryError { code: "LSP_BINARY_NOT_FOUND", serverId, binary, searched }` sérialisée en JSON — contrat **stable**, remplace l'heuristique sur le texte.
    - Nouvelle commande **`lsp_probe`** (`LspProbeResult` : `found`, `path`, `source`, `searched`) : interroge la disponibilité d'un serveur **sans le spawner** ; `classify_source` distingue `serverPath` / `app` / `extension` / `PATH`.
    - `lsp_start` accepte désormais `serverPath` et résout via l'allowlist (le binaire reste imposé par Rust, jamais par le frontend).
  - `src/lib/lspProbe.ts` (**nouveau**) : `parseLspBinaryError` (parse le JSON structuré) + `probeLspServer`.
  - `src/lib/lspConfig.ts` : `serverPath` ajouté au schéma `LspServerConfigSchema` ; constante `LSP_BINARY_NOT_FOUND`.
  - `src/lib/lspCm6.ts` : `isMissingBinaryError` ne parse **plus** de texte → compare le **code** via `parseLspBinaryError` ; `serverPath` propagé à `lsp_start`.
  - `src/components/editor/Editor.tsx` : passe `resolved.config.serverPath` à `createLspExtension`.
  - `src/components/settings/SettingsPanel.tsx` : **badge de statut par serveur** (found / not found / n-a, avec la source en tooltip), bouton **Rescan servers**, champ **Server path (optional — overrides PATH)**.
  - `src/App.tsx` : `handleMissingServer` n'ouvre le terminal d'installation que si la commande du catalogue est **réellement exécutable** (les entrées « See https://… » comme clangd/jdtls affichent l'info au lieu d'un bouton mort).

- **Décisions Techniques :**
  - **Code d'erreur stable plutôt que parsing de texte** : le seul contrat fiable entre Rust et le webview. Fin des faux négatifs selon la locale/OS.
  - **Probe séparé du spawn** : diagnostic collectif et sans effet de bord ; l'UI connaît l'état avant d'ouvrir un fichier.
  - **Extensions en dernier recours (après PATH)** : le comportement reste **prévisible** — si l'utilisateur a le binaire dans son PATH (pip/npm/rustup), il gagne ; les extensions ne servent que de repli. On évite qu'un serveur bundlé périmé masque une install volontaire.
  - **Périmètre « serveurs embarqués » assumé** : on ne scanne **que** des emplacements déterministes d'une extension, et on ne devine jamais un id de binaire (imposé par l'allowlist). Le **shim complet de `vscode-languageclient`** (exécution de `main.js` + transports IPC) a été écarté : coût démesuré pour un résultat fragile — reporté, non requis pour couvrir la majorité des serveurs packagés.
  - **Sécurité** : aucune extension n'est exécutée ni son code chargé lors de la résolution ; le nom de binaire vient de l'allowlist Rust ; `serverPath` est validé (absolu + existant) et ne peut jamais désigner un programme arbitraire hors allowlist.

- **Impacts & Dépendances :**
  - Backend : `lsp.rs` (résolution + `lsp_probe`), `lib.rs` (`generate_handler!`). Frontend : `lspProbe.ts` (nouveau), `lspConfig.ts`, `lspCm6.ts`, `Editor.tsx`, `SettingsPanel.tsx`, `App.tsx`.
  - `lsp_start` gagne un paramètre `serverPath` (optionnel) : rétrocompatible (les appels sans `serverPath` retombent sur PATH).
  - Validation : `cargo check` **OK**, `tsc --noEmit` **0 erreur**, `eslint` **0 erreur** (warning `set-state-in-effect` corrigé en retirant le reset synchrone du probe), `build:frontend` **OK**.

- **Prochaines étapes :**
  - Proposition **automatique** à l'installation d'une extension de type language-server (détection dans `contributes` / heuristique) pour préremplir la config LSP en un clic.
  - Éventuel : shim `vscode-languageclient` si un besoin réel d'extensions pilotées par `main.js` se confirme.
  - Étendre l'allowlist d'adapters/serveurs si de nouveaux cas remontent.

---

### [2026-10-12T18:15] | Icônes Material natives par défaut + détection de langage dans l'explorateur

- **Contexte :**
  L'explorateur n'avait **aucune icône par défaut** (aucun thème d'icônes installé) : il retombait sur un glyphe lucide générique teinté par extension via `fileColors.ts`, une table **parallèle** au registre de langages. Objectif : se sentir comme VS Code — **Material Icon Theme préinstallé d'origine**, icônes reconnaissables, disponibles **hors-ligne et sans extension**, et résolues depuis le **registre de langages unique** (`lib/languages.ts`) pour éviter toute divergence coloration / icône / LSP.

- **Modifications effectuées :**
  - `src/lib/languages.ts` : nouveau champ `icon` sur `LanguageDef` (clé Material par langage, ex. `typescript`, `react_ts`, `rust`…), renseigné pour **tous** les langages du registre ; nouveaux helpers `getLanguageIcon(path)` et `getLanguageLabel(path)`.
  - `src/themes/materialIcons.ts` (**nouveau**) : bundle natif — catalogue de **glyphes SVG 16×16** (monochromes, définis une fois), **palette de couleurs** Material (par clé), mapping **nom de fichier exact** → clé, **extension** → clé, **dossier** (replis), et `resolveMaterialIcon(name, isDir, expanded, languageIcon)` qui renvoie une **data-URI `image/svg+xml`** mémoïsée.
  - `src/components/FileIcon.tsx` : ordre de résolution — (1) thème d'icônes d'extension s'il est sélectionné (comportement VS Code), (2) **bundle Material natif** résolu via `getLanguageIcon` puis nom/extension. Suppression de la prop `color` (inutilisée) ; rendu toujours via `<img>` (média passif).
  - `src/themes/iconTheme.ts` : libellé du thème intégré `"Default (no icon theme)"` → `"Material Icons (built-in)"` (l'aperçu Settings reflète désormais le rendu réel).

- **Décisions Techniques :**
  - **Bundle natif** plutôt qu'une extension à installer : icônes disponibles *out-of-the-box*, hors-ligne, zéro dépendance, coût bundle ≈ **+5,5 kB** (glyphes partagés et data-URI mémoïsées).
  - **Résolution via le registre de langages** (et non une table d'icônes parallèle) : un seul point de vérité — ajouter un langage suffit à lui donner une icône cohérente avec sa coloration et son LSP.
  - **Priorité au thème d'extension** : si l'utilisateur installe/sélectionne un thème d'icônes (ex. material-icon-theme réel), il gagne — parité stricte avec VS Code.
  - **Sécurité inchangée** : les SVG Material sont **générés par le module** (jamais lus sur disque) et rendus en `<img>` data-URI → aucune exécution de script possible ; le chemin non fiable (extensions) reste confiné par `readExtensionAsset`.

- **Impacts & Dépendances :**
  - Fichiers touchés : `languages.ts`, `materialIcons.ts` (nouveau), `FileIcon.tsx`, `iconTheme.ts`.
  - Aucune modification backend. `fileColors.ts` conservé (encore utilisé par `CommandPalette`).
  - Validation : `eslint` **0 erreur**, `tsc --noEmit` **0 erreur**, `build:frontend` **OK**.

- **Prochaines étapes :**
  - Étendre le catalogue Material (fichiers de conf spécialisés : `.pyi`, lockfiles, frameworks) si besoin.
  - Éventuel : colorer aussi les onglets / la palette via le même resolver.

---

### [2026-10-12T17:30] | DAP extensible + Explorateur façon VS Code

- **Contexte :**
  Deux chantiers menés ensemble vers la parité VS Code. (1) **DAP** : le débogueur ne connaissait que 2 adapters codés en dur (`codelldb`, `debugpy`) ; impossible d'en ajouter ni de surcharger par projet. Objectif : rendre les adapters **déclaratifs et extensibles** (workspace `.origin/debug.json` + global), sur le même modèle que LSP/Run, sans jamais exposer un binaire arbitraire depuis le frontend. (2) **Exploreur** : l'arbre de fichiers était minimal (clic = ouvrir) — il manquait les comportements quotidiens de VS Code (multi-sélection, drag & drop, navigation clavier, persistance de l'expansion, décoration SCM).

- **Modifications effectuées :**
  - `src/lib/dapConfig.ts` (**nouveau**) : schéma **Zod strict** (`DapAdapterConfigSchema { adapterId, extensions[], label, adapterPath?, enabled? }`, `DapConfigSchema` v1, bornes : 64 adapters). `ADAPTER_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/`. Catalogue `KNOWN_ADAPTERS` (**7** : codelldb, debugpy, delve, netcoredbg, js-debug, php-debug, kotlin-debug-adapter) + `DEFAULT_DAP_CONFIG` (codelldb, debugpy, delve). `findAdapterForFile` (1ʳᵉ extension correspondante).
  - `src/lib/dapConfigStore.ts` (**nouveau**) : résolution **workspace > global > défaut**. Persistance globale (localStorage `origin-dap-config`), lecture `.origin/debug.json`, `mergeDapConfigs` (fusion par `adapterId`), `resolveDapConfig`.
  - `src-tauri/src/dap.rs` : allowlist `dap_exe_and_args` (**7** adapters → exe + args par défaut) ; `validate_dap_arg` / `validate_adapter_path` (refus vide / >4096 / NUL / `\n` / `\r`) ; `make_dap_process` (**argv direct, jamais de shell** ; `cmd /C` réservé aux shims npm `.cmd`/`.bat` sous Windows) ; `dap_start` ne fait **jamais** confiance aux args du frontend (seuls les args par défaut de l'allowlist sont utilisés ; `adapterPath` sert uniquement à localiser le binaire).
  - `src/lib/dap.ts` : `DapAdapterType = string` (au lieu de l'union figée).
  - `src/components/DebugLaunchForm.tsx` : liste d'adapters **dynamique** (résolue via `resolveDapConfig`), auto-détection par extension, `<select>` alimenté par les adapters activés.
  - `src/lib/explorerState.ts` (**nouveau**) : persistance de l'expansion **par workspace** (localStorage `origin-explorer-expanded:<root>`, plafond 2000 entrées, validation robuste à la lecture).
  - `src/components/FileTree.tsx` (**réécrit**) : **multi-sélection** (Cmd/Ctrl+clic) ; **drag & drop** multi-sources (déplacement via `renamePath`, garde-fous : pas dans soi-même/descendant, pas vers le parent courant) ; **Collapse All** + **navigation clavier** (↑/↓ focus, → ouvre sinon descend au 1ᵉʳ enfant, ← ferme sinon remonte au parent, Entrée ouvre) ; **persistance de l'expansion** ; **décoration SCM** (`buildGitDecoration` propage le « pire » statut git aux dossiers parents, refresh 5 s, couleur du nom + badge `M/A/D/R/U`) ; en-tête racine + compteur de sélection + boutons New File / New Folder / Collapse All.
  - Attributs `data-path` / `data-dir` / `data-open` exposés sur chaque ligne (`role="treeitem"`) — indispensables à la navigation clavier.

- **Décisions Techniques :**
  - **Le frontend ne référence jamais un binaire** : la config DAP ne contient qu'un `adapterId` qui **doit** appartenir à l'allowlist compilée Rust. Double validation (Zod frontend + Rust) — un `.origin/debug.json` malveillant ne peut ni exécuter de code ni injecter hors schéma.
  - **argv, jamais shell** (sauf shims npm sous Windows, strictement encadrés) : cohérent avec la brique Run ; les métacaractères restent littéraux.
  - Fusion par `adapterId` (pas remplacement) : cohérent avec LSP/Run.
  - Explorer : le reset d'état au changement de workspace se fait **hors effet** (comparaison de clé en rendu + `useEffect` pour la persistance), afin d'éviter les `setState` synchrones dans un effet (règle `react-hooks/set-state-in-effect`) et les renders en cascade.

- **Impacts & Dépendances :**
  - Fichiers touchés : `dapConfig.ts`, `dapConfigStore.ts`, `dap.rs`, `dap.ts`, `DebugLaunchForm.tsx`, `explorerState.ts`, `FileTree.tsx`.
  - Validation : `eslint` (fichiers DAP + Explorer) **0 erreur 0 warning**, `tsc --noEmit` **0 erreur**, `build:frontend` **OK**, `cargo check` **OK**.

- **Prochaines étapes :**
  - UI Settings pour éditer les adapters DAP (parité avec la section LSP) — non encore livrée.
  - CF `pathFormat` et events DAP étendus (évaluation de watch/expand) si besoin de parité de débogage avancée.

---

### [2026-10-12T16:40] | Bouton Run — tâches déclaratives + allowlist argv + Workspace Trust

- **Contexte :**
  L'ancien « Run » écrivait une **chaîne de commande dans le shell** (`runInNewTab(command: string)`) : vecteur d'injection/RCE dès qu'un fichier `.origin/run.json` ou une substitution de placeholder provient d'un dépôt tiers. Objectif : parité fonctionnelle avec VS Code (`tasks.json`) **sans** exposer la surface d'exécution — commande passée en **argv**, allowlist d'interpréteurs côté Rust, et confirmation explicite à la première exécution d'un workspace non fiable.

- **Modifications effectuées :**
  - `src/lib/runTasks.ts` (**nouveau**) : schéma **Zod strict** (`RunTaskSchema { id, label, program, args[], cwd?, extension? }`, `RunConfigSchema` v1, bornes : 64 tâches, 64 args, 1024 car.). `DEFAULT_RUN_CONFIG` (python/node/tsx/cargo/go). `substituteArgs` (`$file`, `${dir}`, `${workspaceFolder}`, `${fileBasenameNoExtension}`) — substitution **littérale**, jamais réinterprétée par un shell. `pickTaskForFile` (extension exacte sinon 1ʳᵉ tâche sans extension).
  - `src/lib/runConfigStore.ts` (**nouveau**) : résolution **workspace > global** par fusion d'`id`. Persistance globale (localStorage `origin-run-config`), lecture `.origin/run.json`. **Workspace Trust** : hash de contenu (djb2) + `isWorkspaceTrusted`/`trustWorkspace` (clé `origin-run-trust:<root>`) — modifier le fichier **invalide** la confiance. `resolveRunConfig` renvoie `{ config, needsTrust, workspaceRaw }`.
  - `src-tauri/src/terminal.rs` : allowlist `TASK_PROGRAM_ALLOWLIST` (~40 interpréteurs/compilateurs) ; `validate_argv_component` (refus vide / >4096 / NUL / `\n` / `\r`) ; `program_in_path` (résolution PATH + PATHEXT Windows) ; `enforce_program` (chemin absolu obligatoire si `/`, sinon nom nu ∈ allowlist + présent dans PATH) ; `terminal_create_task` → `CommandBuilder::new(program).arg(...)` (**aucun shell**), spawn PTY, events `terminal-output-{id}` / `terminal-exit-{id}`.
  - `src-tauri/src/lib.rs` : `terminal::terminal_create_task` enregistré dans `generate_handler!`.
  - `src/lib/terminal.ts` : `terminalCreateTask(cwd, program, args, cols, rows)`.
  - `src/components/terminal/Terminal.tsx` : prop `task?` — si présente, spawn argv direct (bannière `$ program args`) **sans** shell interactif ; sinon shell habituel. Correction : suppression d'un bloc `terminalCreate` **dupliqué** qui aurait créé deux PTY par onglet.
  - `src/components/terminal/TerminalPanel.tsx` : `runTaskInNewTab(name, program, args)` + state `taskSpawns` (map id d'onglet → tâche).
  - `src/App.tsx` : `handleRunActiveFile` (résolution config → `pickTaskForFile` → `substituteArgs` → si `needsTrust`, ouvre le dialogue) ; `startTask` (ouvre le panneau terminal puis lance) ; **dialogue de confiance** (Run once / Always trust this workspace / Cancel).
  - `CommandContext.tsx` / `useGlobalKeybindings.ts` / `keybindings.ts` : commande `origin.runFile` (défaut `Ctrl+F5`).

- **Décisions Techniques :**
  - **argv, jamais shell** : `CommandBuilder::new(program).arg(a)` construit un `argv` — `;`, `&&`, `$(...)`, backticks restent **littéraux**. Le shell n'est jamais invoqué pour une tâche.
  - **Double validation** (Zod frontend + allowlist Rust) : un `.origin/run.json` malveillant ne peut ni exécuter un binaire hors allowlist ni injecter hors schéma.
  - **Workspace Trust** (modèle VS Code) : la confiance porte sur le **contenu** ; toute modification l'invalide. Les tâches **globales** sont de confiance par construction.
  - Fusion par `id` (pas remplacement) : cohérent avec la brique LSP.

- **Impacts & Dépendances :**
  - Fichiers touchés : `runTasks.ts`, `runConfigStore.ts`, `terminal.rs`, `lib.rs`, `terminal.ts`, `Terminal.tsx`, `TerminalPanel.tsx`, `App.tsx`, `CommandContext.tsx`, `useGlobalKeybindings.ts`, `keybindings.ts`.
  - Validation : `tsc --noEmit` **0 erreur**, `eslint` (fichiers Run) **0 erreur**, `build:frontend` **OK**, `cargo check` **OK** (warning préexistant `dap.rs:75` uniquement).

- **Prochaines étapes :**
  - UI Settings pour éditer les tâches (analogue à la section « Languages & LSP ») — non encore livrée.
  - Étape suivante du plan de parité : **DAP extensible** (debug adapters).

---

### [2026-10-12T15:10] | LSP extensible par configuration (workspace + global) + UI Settings

- **Contexte :**
  Le registre de langages reconnaissait 11 identités LSP, mais le backend Rust restait figé sur une allowlist de 3 serveurs et il n'existait **aucun moyen** pour l'utilisateur de lier un serveur à des extensions, ni de surcharger par projet. L'objectif : rendre l'identité LSP **déclarative et extensible par configuration**, à deux niveaux (global utilisateur + workspace versionnable), sans jamais permettre l'exécution d'un binaire arbitraire depuis le frontend.

- **Modifications effectuées :**
  - `src/lib/lspConfig.ts` (**nouveau**) : schéma **Zod strict** (`LspServerConfigSchema`, `LspConfigSchema` version 1) + catalogue `KNOWN_SERVERS` (11 serveurs, miroir de l'allowlist Rust, avec `installCommand`) + `DEFAULT_LSP_CONFIG` (3 serveurs historiques). Garde-fou `isKnownServerId`.
  - `src/lib/lspConfigStore.ts` (**nouveau**) : résolution **workspace > global > défaut**. `loadGlobalLspConfig`/`saveGlobalLspConfig` (localStorage `origin-lsp-config`), `loadWorkspaceLspConfig` (lit `.origin/lsp.json` via `readFile`, `null` si absent/invalide), `mergeLspConfigs` (fusion par `serverId`, workspace gagne), `resolveLspConfig`, `findServerForFile`.
  - `src-tauri/src/lsp.rs` : allowlist `lsp_exe_and_args` étendue de 3 → **11 serveurs** ; nouveau `validate_lsp_arg` (refus vide / >512 / NUL / newline / CR) ; `lsp_start` accepte `args: Option<Vec<String>>` (validés, sinon args par défaut). Sesssion et suffixe d'événement keyés par **serverId**.
  - `src/lib/lsp.ts`, `src/lib/lspCm6.ts` : client/transport keyés par `serverId` (plus par union figée) ; `INSTALL_COMMANDS` dérivé de `KNOWN_SERVERS`.
  - `src/components/editor/Editor.tsx` : résolution **async** de la config (`resolveLspConfig` → `findServerForFile`) avant `createLspExtension`.
  - `src/context/DiagnosticsContext.tsx` : écoute les notifications pour tous les `getSupportedLspServerIds()`.
  - `src/App.tsx` : `handleMissingServer` résout le libellé via `KNOWN_SERVERS`.
  - `src/components/settings/SettingsPanel.tsx` : **nouvelle section « Languages & LSP »** (nav `languages`) — liste des serveurs, toggle activer/désactiver, édition extensions / languageId / arguments, ajout (id contraint au catalogue), suppression avec confirmation, persistance globale ; encart rappelant la surcharge workspace.

- **Décisions Techniques :**
  - **Le frontend ne référence jamais un binaire** : la config ne contient qu'un `serverId` qui **doit** appartenir à l'allowlist compilée Rust. Double validation (Zod frontend + Rust). Un `.origin/lsp.json` malveillant ne peut donc ni exécuter de code ni injecter de données hors schéma.
  - **Précédence workspace > global** plutôt qu'un remplacement complet : fusion par `serverId` — un projet peut surcharger un serveur sans perdre les autres préférences globales.
  - Serveurs inconnus tolérés à l'affichage (badge « unknown ») mais **rejetés** à l'ajout : cohérence stricte avec le catalogue.
  - Édition par `defaultValue` + commit `onBlur` (pas de state par champ) : évite les re-renders et les désynchros de curseur.

- **Impacts & Dépendances :**
  - Fichiers touchés : `lspConfig.ts`, `lspConfigStore.ts`, `lsp.rs`, `lsp.ts`, `lspCm6.ts`, `Editor.tsx`, `DiagnosticsContext.tsx`, `App.tsx`, `SettingsPanel.tsx`.
  - Ajouter un serveur = (1) entrée dans `lsp_exe_and_args` (Rust) + (2) entrée dans `KNOWN_SERVERS` (TS). Aucun autre code à toucher.
  - Le lint a révélé une affectation morte dans `Editor.tsx` (`serverId` initialisé à `null` puis écrasé) — corrigée (`let serverId: string;` + garde `cancelled`).
  - Validé : `tsc --noEmit` OK, `eslint` OK (0 erreur), `build:frontend` OK, `cargo check` OK (seul warning préexistant `dap.rs:75`).

- **Prochaines étapes :**
  - Bouton **Run** par langage (config workspace) — brique suivante actée.
  - Vue « langage détecté » (registre) dans Settings pour transparence.
  - Support des serveurs **complétés par extension** (au-delà du catalogue compilé).

---

### [2026-10-12T14:30] | Registre unique de langages (registre + alignement coloration/label/LSP)

- **Contexte :**
  Travailler « proprement avec tous les langages » était impossible : trois tables de langages **divergentes** coexistaient — `languageSupport.ts` (coloration + label), `lsp.ts` (identité LSP) et `ExtensionsContext.tsx` (`LANGUAGE_EXTENSIONS` pour les grammaires TextMate). Conséquences réelles : la StatusBar pouvait afficher « Shell Script » ou « TOML » alors qu'aucune coloration n'était appliquée (`default → []`), SCSS/Sass étaient routés vers du CSS pur, et seuls 3 langages (TS/JS, Rust, Python) avaient une identité LSP reconnue.

- **Modifications effectuées :**
  - `src/lib/languages.ts` (**nouveau**) : **source de vérité unique**. Chaque `LanguageDef` déclare `id`, `label`, `extensions[]`, `filenames[]` (ex. `Dockerfile`, `Makefile`), une **factory de parser** CodeMirror, et l'identité LSP optionnelle (`lsp` + `languageId`). Couverture des langages courants : TS/TSX/JS/JSX, CSS/SCSS/Sass, HTML, JSON, Markdown, XML/SVG, Rust, Python, Go, C, C++, Java, C#, Scala, Kotlin, Swift, Dart, Ruby, PHP, Lua, Perl, R, Erlang, Haskell, Clojure, Shell, Dockerfile, Makefile, SQL, YAML, TOML, INI, Protobuf. Index dérivés (`byId`/`byFilename`/`byExtension`) construits une fois ; résolution par **nom de fichier exact puis extension**. Garde-fou : id dupliqué → throw au chargement.
  - `src/components/editor/languageSupport.ts` : réduit à une **façade** ré-exportant `getLanguageExtension`/`languageLabel`/`resolveLanguage` depuis le registre (imports existants inchangés).
  - `src/lib/lsp.ts` : `getLspLanguage`/`getLspLanguageId` délèguent au registre ; `type LspLanguage` ré-exporté pour ne pas casser les consommateurs.
  - `src/context/DiagnosticsContext.tsx` : la liste figée `['typescript','rust','python']` est remplacée par `getSupportedLspLanguages()` dérivé du registre.
  - `package.json` : dépendance `@codemirror/legacy-modes@^6.5.5` (modes CM5 pour les langages sans parser moderne).

- **Décisions Techniques :**
  - **Un seul module déclaratif** plutôt que trois tables : élimine par construction les divergences label≠coloration≠LSP.
  - Parsers modernes (`@codemirror/lang-*`) quand ils existent (meilleure précision : Lezer), sinon `StreamLanguage.define` sur un mode `legacy-modes`. Un helper `legacy()` isole le **seul cast nécessaire** : `legacy-modes` type ses parsers via `@codemirror/streamparser` (paquet de compat CM5), nominalement distinct de `@codemirror/language` bien que structurellement identique. Le cast est sûr (même contrat runtime) et documenté.
  - PHP n'a **aucun** mode legacy-modes → déclaré avec `parser: () => []` : le label « PHP » est correct sans coloration, et une grammaire TextMate fournie par une extension peut le compléter (priorité `dynLangCompartment` ≥ coloration de base).
  - LSP **volontairement** non élargi ici : `lsp.rs` (côté Rust) reste sur une allowlist stricte (3 serveurs). Élargir l'identité LSP sans serveur côté backend créerait des tentatives de spawn vouées à l'échec. Étape suivante séparée.

- **Impacts & Dépendances :**
  - Fichiers : `languages.ts` (nouveau), `languageSupport.ts`, `lsp.ts`, `DiagnosticsContext.tsx`, `package.json`.
  - `Editor.tsx` : la coloration de base `getLanguageExtension(path)` est **surchargée** par `dynLangCompartment` si une extension fournit une grammaire — comportement voulu (VS Code-like).
  - Aucune rupture d'API : `languageLabel`/`getLanguageExtension`/`getLspLanguage` conservent leurs signatures.
  - Validé : `tsc --noEmit` OK, `eslint` OK (0 erreur), `build:frontend` OK.

- **Prochaines étapes :**
  - Élargir l'identité LSP par **config workspace** (gopls, clangd, jdtls, etc.) côté `lsp.rs` + préférences, avec commandes d'installation.
  - Vue « langage détecté » (registre) dans Settings pour transparence.
  - Ajouter bouton **Run** par langage (pilote via fichier de config workspace).

---

### [2026-10-12T13:15] | Problems panel LSP (diagnostics globaux + StatusBar)

- **Contexte :**
  Les diagnostics LSP (`publishDiagnostics`) arrivaient déjà du serveur et s'affichaient dans l'éditeur (squigly + gutter via `codemirror-languageserver`), mais aucun **état global** ne les agrégeait : la StatusBar affichait `errors`/`warnings` figés à 0 (props jamais alimentées depuis `App.tsx`) et il n'existait aucun panneau Problems.

- **Modifications effectuées :**
  - `src/context/DiagnosticsContext.tsx` (nouveau) : provider écoutant `lsp-notification-{typescript,rust,python}`, filtrant `textDocument/publishDiagnostics`, convertissant URI→chemin (`uriToPath`, gère `file:///c%3A/...`) et exposant `byFile: Map<path, DiagnosticEntry[]>`, `errors`, `warnings`, `total`. Sévérité LSP 1–4 normalisée en `error|warning|info|hint`, lignes/colonnes converties de 0-based à 1-based.
  - `src/main.tsx` : `DiagnosticsProvider` monté autour de `<App/>`.
  - `src/components/problems/ProblemsPanel.tsx` (nouveau) : liste groupée par fichier (accordéon), tri erreurs d'abord puis par ligne, filtre par sévérité (All/Errors/Warnings/Info), chemins relatifs au workspace, clic sur un diagnostic → ouverture du fichier à la ligne/colonne.
  - `src/components/terminal/TerminalPanel.tsx` : transformé en **panneau bas à onglets** (Terminal / Problems). Barre d'onglets en header, `activeView` interne, `showProblems()` ajouté au handle, `addTab`/`runInNewTab` rebasculent sur la vue Terminal. Nouvelles props `rootPath`, `onOpenFile`.
  - `src/components/StatusBar.tsx` : compteur Problems rendu cliquable (`onShowProblems`).
  - `src/App.tsx` : `useDiagnostics()` branché sur la StatusBar (`errors`/`warnings` réels), clic ouvre le panneau bas + bascule sur Problems (`showProblems` via `requestAnimationFrame`), props `rootPath`/`onOpenFile` passées au `TerminalPanel`.
  - `src/components/ai/AgentModeView.tsx` : mêmes props passées au `TerminalPanel` en mode AI.

- **Décisions Techniques :**
  - Écoute permanente des 3 langues (pas d'abonnement par fichier) : simple et robuste ; le serveur envoie des diagnostics vides à la fermeture (`didClose`), donc les fichiers disparaissent automatiquement sans logique de nettoyage côté client.
  - Le panneau Problems vit **dans** le panneau bas existant (onglet) plutôt qu'un nouveau système de panneaux : réutilise le montage/redimensionnement déjà en place, zéro duplication.
  - Pas de nouveaux canaux IPC : tout passe par les événements LSP déjà émis.
  - API volontairement minimale (pas de `clearFile`/`clearAll`) — non utilisés, retirés pour éviter la dette.

- **Impacts & Dépendances :**
  - Fichiers : `DiagnosticsContext.tsx` (nouveau), `ProblemsPanel.tsx` (nouveau), `main.tsx`, `TerminalPanel.tsx`, `StatusBar.tsx`, `App.tsx`, `AgentModeView.tsx`.
  - Le `TerminalPanel` reste rétro-compatible : `rootPath`/`onOpenFile` optionnels, les autres call sites (TitleBar, CommandPalette, keybindings) sont inchangés.
  - Validé : `typecheck` OK, `lint` 0 erreur (warnings préexistants), `build:frontend` OK.

- **Prochaines étapes :**
  - Persister l'onglet actif du panneau bas (Terminal/Problems) si souhaité.
  - Ajouter un onglet « Output » / « Debug Console » au même panneau bas.
  - Raccourcis clavier : Ctrl+Shift+M (focus Problems), F8/Shift+F8 (navigation entre diagnostics).

---

### [2026-10-12T12:30] | Settings réels — Development Environment

- **Contexte :**
  La section « Development Environment » de Settings affichait des valeurs **codées en dur** (`Python 3.13.15 ('venv': venv)`, `Node.js 24.21.0`) et des boutons inertes. Objectif : refléter la machine réelle et permettre de choisir un interpréteur. Périmètre validé avec l'utilisateur : **Dev Env uniquement**, persistance via **localStorage**, détection **automatique au chargement**.

- **Modifications effectuées :**
  - `src-tauri/src/env.rs` (nouveau) : commande `detect_dev_environment` qui détecte `python3`/`python`, `node`/`npm`, `git` via `Command::new(exe).arg("--version")` (jamais de shell), résout le PATH sans shell, parse la version. Renvoie un `ToolInfo { name, path, version }` par outil (avec `path/version = None` si introuvable).
  - `src-tauri/src/lib.rs` : `mod env;` + enregistrement de `env::detect_dev_environment` dans `generate_handler!`.
  - `src/lib/env.ts` (nouveau) : wrapper `detectDevEnvironment()` typé.
  - `src/lib/devEnv.ts` (nouveau) : `loadDevEnvPrefs` / `saveDevEnvPrefs` (clé `origin-devenv`) pour le choix manuel d'interpréteur.
  - `src/components/settings/SettingsPanel.tsx` : `DevEnvironmentSection` réécrite — détection réelle au montage (état `Detecting…` → version réelle ou `not found`), bouton **Rescan** fonctionnel, sélection d'interpréteur persistée, `RefreshCw` importé, `Plus` retiré (inutilisé).

- **Décisions Techniques :**
  - Détection côté Rust plutôt que Node : cohérent avec `git.rs`/`system.rs`, aucun accès shell, allowlist de binaires fixes.
  - `Command::new` + argument littéral `--version` : aucun input utilisateur concaténé ⇒ pas de surface d'injection.
  - Persistance localStorage (et non fichier par workspace) pour rester cohérent avec le reste de l'app (`origin-ai-provider`, thème) et éviter de nouvelles commandes IPC.
  - `chooseTool` via `window.prompt` : solution minimale acceptable ; la vraie sélection native (dialog) pourra être ajoutée plus tard si besoin.

- **Impacts & Dépendances :**
  - Fichiers touchés : `env.rs`, `lib.rs`, `env.ts`, `devEnv.ts`, `SettingsPanel.tsx`.
  - Aucun effet de bord sur les autres sections. Le résultat de détection n'est pas mis en cache (rescan léger).
  - Validé : `cargo check` OK (warning préexistant `dap.rs:75`), `npm run typecheck` OK, `npm run lint` 0 erreur, `npm run build:frontend` OK.

- **Prochaines étapes :**
  - Sélection native d'interpréteur via `tauri-plugin-dialog` (remplacer `window.prompt`).
  - Brancher le « Python Extension Configuration » / « Go to Settings » sur la vraie section concernée.
  - Sections restantes encore « Coming soon » (General, Appearance persistés, etc.).

---

### [2026-10-12T11:45] | Source Control — Git complet + AI Commit réel

- **Contexte :**
  Les boutons du panneau Source Control étaient majoritairement morts (stage/unstage/discard/pull/push/fetch/branches/amend/sync), et l'« AI commit » fabriquait un message en concaténant des noms de fichiers au lieu d'appeler le LLM.

- **Modifications effectuées :**
  - `src-tauri/src/git.rs` : ~11 nouvelles commandes — `git_stage`, `git_stage_all`, `git_unstage`, `git_discard`, `git_pull`, `git_push`, `git_fetch`, `git_list_branches`, `git_checkout`, `git_create_branch`, `git_commit_amend`, `git_commit_sync`, `git_diff`. Ajout des validateurs `reject_unsafe_arg`, `validate_branch_name` (`git check-ref-format --branch`), `validate_rel_path`.
  - `src-tauri/src/lib.rs` : enregistrement des commandes.
  - `src/lib/git.ts` : wrappers TS + interface `BranchEntry`.
  - `src/lib/gitCommitMessage.ts` (nouveau) : génération IA via `generateText` + `buildLanguageModel` sur le diff réel (`git_diff`).
  - `src/components/SourceTreePanel.tsx` : staging/discard par fichier (actions au survol), menu Branches, Pull/Push/Fetch, amend/sync réels, bouton **Auto** = auto-refresh 5 s, « Unstage All », suppression du « Discard All » trompeur.
  - `src/index.css` : hover reveal `.origin-scm-actions`.

- **Décisions Techniques :**
  - Sécurité : jamais de shell (`Command::args`), noms de branche validés par la référence officielle git, suppression de fichier untracked seulement si `canonicalize` confirme le confinement au repo.

- **Impacts & Dépendances :**
  - Validé : `cargo check`, `typecheck`, `lint`, `build:frontend` OK.

- **Prochaines étapes :**
  - Voir entrée Dev Env ci-dessus.

---

### [2026-10-11T21:50] | Panneau Agent (IDE) : ouvert par défaut

- **Contexte :**
  Le panneau Agent à droite fait partie de l'IDE (pas de l'AI MODE). Il doit être **ouvert par défaut**. La logique précédente utilisait un flag « réouverture forcée une seule fois » qui pouvait laisser le panneau fermé si l'utilisateur l'avait fermé auparavant.

- **Modifications effectuées :**
  - `src/hooks/useWorkspacePersistence.ts` : simplification de l'initialisation `aiPanelOpen` → `ls.get('origin-ai-panel-open') !== 'false'`. Le panneau est désormais ouvert par défaut sauf fermeture explicite de l'utilisateur. Suppression du flag `origin-ai-panel-open-forced`.

- **Décisions Techniques :**
  - La persistance repose uniquement sur localStorage pour `aiPanelOpen` (le Tauri store n'hydrate pas ce réglage), donc une valeur par défaut simple `!== 'false'` suffit et est prévisible.

- **Impacts & Dépendances :**
  - Aucun impact sur les autres états (sidebar, terminal). `aiPanelOpen` reste consommé par `App.tsx` (rendu conditionnel d'AiPanel) et `TitleBar.tsx` (switch IDE ↔ AI MODE).
  - Validé : `pnpm typecheck` OK, `pnpm lint` 0 erreur, diagnostics IDE vides.

- **Prochaines étapes :**
  - Statut par tâche dans `RecentSessions`.
  - Rendu du Product Icon Theme.

---

### [2026-10-11T21:15] | Revert AI MODE plein écran — panneau Agent (IDE) aligné sur les captures

- **Contexte :**
  Retour utilisateur : « fais juste l'UI dans la partie IDE, le panneau à droite, le panneau Agent doit être ouvert par défaut ». Le layout plein écran AI MODE (rail de tâches + AiPanel en `renderMode="full"`) implémenté juste avant ne correspondait pas à l'attendu : il fallait rester dans le **layout IDE standard** et simplement que le **panneau Agent de droite soit ouvert par défaut**, avec l'UI de l'écran de bienvenue alignée sur les captures Trae SOLO.

- **Modifications effectuées :**
  - **Revert complet** du mode plein écran : suppression de `src/components/ai/AiModeView.tsx` et `src/components/ai/TaskSidebar.tsx`.
  - `src/hooks/useWorkspacePersistence.ts` : retrait de l'état `appMode` (et de sa persistance).
  - `src/context/CommandContext.tsx` : retrait de `appMode` / `onSetAppMode`.
  - `src/App.tsx` : retrait de l'import `AiModeView`, du destructuring et de la branche de rendu conditionnelle — retour au layout IDE unique.
  - `src/components/ai/AiPanel.tsx` : retrait des props ajoutées (`renderMode`, `openSessionId`, `newChatNonce`, `onActiveSessionChange`) et de toute la logique associée (effets, refs, largeur fluide, masquage de la poignée de resize).
  - `src/components/TitleBar.tsx` : le switch `IDE | AI MODE` repilote `aiPanelOpen` / `onSetAiPanel` (ouverture/fermeture du panneau Agent de droite). Style et animation conservés.
  - `src/components/ai/AiPanel.tsx` (écran de bienvenue) : textes alignés sur les captures —
    - sous-titre : « Deep understanding of complex tasks » ;
    - capacités : « Handles iterations, bug fixes, and refactoring in large projects », « Plans tasks intelligently and drives execution with precision », « Orchestrates intelligent multi-agent collaboration ».
  - **Panneau Agent ouvert par défaut** : déjà garanti par `useWorkspacePersistence` (`origin-ai-panel-open` avec réouverture forcée unique), aucun changement nécessaire.

- **Décisions Techniques :**
  - Le panneau Agent docké existant (`AiPanel`) était déjà complet et conforme : plutôt que de dupliquer une vue plein écran, on **conserve l'unique source de vérité** et on se limite à l'ajustement d'UI demandé (“juste l'UI”).
  - Le switch de titlebar reste un simple contrôle d'affichage du panneau (`aiPanelOpen`), ce qui évite toute bifurcation de layout et tout état global supplémentaire.

- **Impacts & Dépendances :**
  - Aucun impact sur la logique de chat/agent/session : toutes les modifications sont des suppressions ou des ajustements d'affichage.
  - Validé : `pnpm typecheck` OK, `pnpm lint` **0 erreur** (6 warnings pré-existants dans `useGlobalKeybindings.ts`), `pnpm build:frontend` OK, diagnostics IDE vides.

- **Prochaines étapes :**
  - Statut par tâche (Running / Completed) dans `RecentSessions` (actuellement titre seul).
  - Rendu du Product Icon Theme (chrome UI en lucide-react).

---

### [2026-10-11T20:40] | AI MODE : vrai layout plein écran (rail de tâches + Agent) — depuis reverté

- **Contexte :**
  Le commutateur IDE ↔ AI MODE ne pilotait qu'un état `aiPanelOpen` (panneau latéral droit), ce qui ne correspondait pas aux interfaces de référence fournies : un **espace plein écran dédié** composé d'un rail de tâches à gauche (`+ New Task` + historique) et de la surface Agent au centre (écran de bienvenue + chat).

- **Modifications effectuées :**
  - `src/hooks/useWorkspacePersistence.ts` : nouvel état persistant `appMode: 'ide' | 'ai'` (clé `origin-app-mode`), exposé avec `setAppMode`.
  - `src/components/ai/TaskSidebar.tsx` (**créé**) : rail gauche — bouton `+ New Task`, liste des tâches lue via `lsForPath` (découplée de l'état interne d'AiPanel), surbrillance de la tâche active, horodatage, poignée de redimensionnement persistée.
  - `src/components/ai/AiModeView.tsx` (**créé**) : layout `[TaskSidebar | AiPanel(renderMode="full")]`. Détient `activeSessionId`, `openSessionId`, `newChatNonce` et les relaie à AiPanel.
  - `src/components/ai/AiPanel.tsx` : nouvelles props `renderMode` (`"panel"`/`"full"`), `openSessionId`, `newChatNonce`, `onActiveSessionChange`. En mode `full`, la largeur devient fluide (`flex:1`, `100%`) et la poignée de resize est masquée. Deux `useEffect` relient les props externes à `handleSessionSelect`/`handleNewChat` (idempotents via refs de garde). `onActiveSessionChange` est émis à chaque création/sélection/restauration/clear de session.
  - `src/context/CommandContext.tsx` : ajout de `appMode` + `onSetAppMode`.
  - `src/App.tsx` : lecture de `appMode` depuis la persistence, exposition dans `commands`, et branche de rendu `appMode === "ai" → <AiModeView …>` (le layout IDE — sidebar/tabbar/éditeur/terminal/statusbar — n'est plus monté en AI MODE).
  - `src/components/TitleBar.tsx` : `ModeSwitch` pilote désormais `appMode`/`onSetAppMode` (props renommées `aiMode`/`onSetMode`), tooltips « Switch to IDE/AI Mode ».

- **Décisions Techniques :**
  - **Zéro duplication** : AiPanel reste l'unique source de la logique (sessions, streaming, agent, DB, pinboard). L'AI MODE le **réutilise** via `renderMode="full"` au lieu de recréer une UI de chat — évite la divergence entre le panneau IDE et l'espace plein écran.
  - **Communication par props descendantes** (`openSessionId`/`newChatNonce`) + **remontée d'état** (`onActiveSessionChange`) plutôt que d'extraire 1300 lignes d'état dans un hook : refactor à faible risque de régression, API explicite et testable.
  - Le rail de tâches lit le store persisté directement (`lsForPath`) : aucune donnée dupliquée en mémoire, la liste reste fraîche au changement de workspace.
  - Garde `lastOpenSessionRef`/`lastNewChatNonceRef` pour rendre les effets idempotents (évite un rechargement en boucle lors des re-rendus).

- **Impacts & Dépendances :**
  - `AiPanel` gagne 4 props optionnelles — rétro-compatible (le panneau IDE ne change pas de comportement, `renderMode` par défaut `"panel"`).
  - `CommandContext` gagne 2 membres — les fournisseurs/consommateurs sont mis à jour (App fournit, TitleBar consomme).
  - En AI MODE, le terminal et la barre de statut ne sont pas montés (choix de design assumé, plein écran). Le `folderPath` reste partagé via `WorkspaceContext`.
  - Validé : `pnpm typecheck` OK, `pnpm lint` **0 erreur** (warnings pré-existants), `pnpm build:frontend` OK, diagnostics IDE vides.

- **Prochaines étapes :**
  - Rendu réel du Product Icon Theme (chrome UI en lucide-react).
  - Statut « Completed / Running » par tâche (actuellement dérivé du titre + horodatage).
  - Éventuel panneau droit (Browser/Preview/Explorer) dans l'AI MODE, comme sur les captures.

---

### [2026-10-11T19:05] | Commutateur IDE ↔ AI MODE : thumb glissant animé

- **Contexte :**
  Retour utilisateur : « il faut utiliser un switch propre adapté avec une petite animation pendant le switch ». La première version (deux boutons dont la couleur changeait instantanément) manquait de transition.

- **Modifications effectuées :**
  - `src/components/TitleBar.tsx` : extraction d'un composant dédié `ModeSwitch` (logo conservé à gauche).
    - Un **thumb unique** (`<span>` absolu) qui **glisse** entre les deux segments via `translateX` + `width`, animé par `transition: transform/width 220ms cubic-bezier(0.4, 0, 0.2, 1)`.
    - La géométrie cible est mesurée sur le segment actif (`offsetLeft`/`offsetWidth`) via `useEffect` déclenché par `aiPanelOpen`.
    - Couleur du libellé animée (`transition: color 220ms`), segments en `role="tab"`/`aria-selected`, conteneur `role="tablist"`.

- **Décisions Techniques :**
  - **Mesure dynamique** plutôt que largeurs fixes : « IDE » et « AI MODE » ont des largeurs intrinsèques différentes (icône incluse) ; mesurer les boîtes réelles garantit un alignement parfait du thumb quelle que soit la police/zoom.
  - Le thumb ne gère pas le resize de fenêtre (les libellés sont fixes) : recalcul uniquement sur changement de mode, d'où un `useEffect` minimal sans `ResizeObserver` (évite une complexité inutile).
  - `accent.blue` non utilisé : on reste sur les tokens de surface (`bg-base`/`bg-hover`) pour rester cohérent avec le reste de la barre de titre et compatible tous thèmes.

- **Impacts & Dépendances :**
  - `TitleBar.tsx` importe désormais `useEffect`. Aucun changement d'API (le composant `ModeSwitch` est local).
  - Validé : `pnpm typecheck` OK, `pnpm lint` 0 erreur (6 warnings pré-existants), `pnpm build:frontend` OK.

- **Prochaines étapes :**
  - Éventuel vrai mode plein écran « AI MODE » (masquer explorateur/éditeur) si demandé.

---

### [2026-10-11T18:40] | Barre de titre : commutateur segmenté IDE ↔ AI MODE

- **Contexte :**
  Demande utilisateur : remplacer le libellé statique « IDE » de la barre de titre par un **toggle segmenté** (style SOLO/capture fournie) permettant de basculer entre **IDE** et **AI MODE**.

- **Modifications effectuées :**
  - `src/context/CommandContext.tsx` : ajout de `onSetAiPanel: (open: boolean) => void` à `AppCommands` (+ noop par défaut).
  - `src/App.tsx` : implémentation `onSetAiPanel: (open) => setAiPanelOpen(open)`.
  - `src/components/TitleBar.tsx` : le logo est conservé ; le texte « IDE » est remplacé par un contrôle segmenté `[IDE | AI MODE]` (pill, état actif sur `--origin-bg-base`, icône `lucide:monitor-dot`). « IDE » ferme le panneau IA, « AI MODE » l'ouvre.

- **Décisions Techniques :**
  - Réutiliser l'état existant `aiPanelOpen` plutôt que d'introduire un nouveau mode global : « AI MODE » = panneau IA visible. Évite un état dupliqué (source de désynchronisation) et respecte l'architecture de panneaux actuelle.
  - Exposer `onSetAiPanel` via `CommandContext` (déjà consommé par la barre de titre) plutôt qu'un prop-drilling.

- **Impacts & Dépendances :**
  - `AppCommands` gagne une méthode ; les implémentations par défaut/tests utilisant `defaults` restent valides (noop fourni).
  - Validé : `pnpm typecheck` OK, `pnpm lint` 0 erreur (6 warnings pré-existants), `pnpm build:frontend` OK.

- **Prochaines étapes :**
  - Envisager un vrai mode « AI MODE » plein écran (masquage conditionnel de l'explorateur/éditeur) si l'utilisateur le souhaite ; en l'état, le toggle pilote la visibilité du panneau IA.

---

### [2026-10-11T18:05] | Apparence : aperçu d'icônes + état vide Color Theme

- **Contexte :**
  Retour utilisateur « jusqu'à présent ce n'est pas encore bon » sur la page Apparence. Diagnostic mené sur la machine réelle (dossier `~/Library/Application Support/com.originide.ide/extensions/`) : seule l'extension `PKief.material-icon-theme-5.39.0` est installée, et son manifest **ne déclare aucun `contributes.themes`** (`themes: undefined`) — c'est un thème d'**icônes** uniquement. La grille « Color Theme » ne pouvait donc montrer que les 2 thèmes natifs, et rien ne permettait de *voir* que le thème d'icônes s'appliquait.

- **Modifications effectuées :**
  - **Vérification bout-en-bout de la chaîne technique** : rejeu de la logique `joinPath`/`pickKey` contre le vrai `dist/material-icons.json` (1251 définitions) → `index.ts→icons/typescript.svg`, `App.tsx→icons/react_ts.svg`, `package.json→icons/nodejs.svg`, `Dockerfile→icons/docker.svg`, dossiers `src`→`folder-src`/`folder-src-open`. Toutes les SVG existent et sont UTF-8 valides. La chaîne est fonctionnelle.
  - **UI** (`src/components/settings/SettingsPanel.tsx`) :
    - Nouveau composant `IconThemePreview` : bandeau d'échantillons (`src/`, `index.ts`, `App.tsx`, `styles.css`, `package.json`, `README.md`, `Dockerfile`) rendus via le `FileIcon` réel — l'utilisateur **voit** immédiatement le thème d'icônes appliqué, comme dans VS Code.
    - **État vide** sous Color Theme : quand `themes.length === builtinThemes.length` (aucun thème de couleur d'extension), un encart explique qu'aucun thème de couleur n'est installé et cite un exemple (« One Dark Pro »).

- **Décisions Techniques :**
  - Ne pas fabriquer un thème de couleur de toutes pièces : le manque n'est pas un bug, c'est l'absence d'extension de thème de couleur. La page doit le rendre **explicite** plutôt que de laisser croire à une panne.
  - Réutiliser le composant `FileIcon` (donc le resolver réel et le même chemin de sécurité data-URI) pour l'aperçu, afin que l'aperçu ne puisse jamais diverger du rendu de l'Explorateur.

- **Impacts & Dépendances :**
  - `SettingsPanel.tsx` importe désormais `FileIcon` et `builtinThemes`. Aucun changement d'API ni de backend.
  - Validé : `pnpm typecheck` OK, `pnpm lint` 0 erreur (6 warnings pré-existants), `pnpm build:frontend` OK.

- **Prochaines étapes :**
  - Installer un **thème de couleur** VS Code (ex. One Dark Pro) via le panneau Extensions pour peupler la grille Color Theme et valider l'adaptateur couleur.
  - Rendu effectif des Product Icon Themes ; support `include`/`languageIds` du thème d'icônes.

---

### [2026-10-12T00:30] | Page Apparence complète (style VS Code) + thèmes d'icônes de fichiers

- **Contexte :**
  Retour utilisateur : « quand je vais dans Apparence je ne vois pas ça, implémente tout correctement ». La page Apparence ne contenait qu'un `<select>` de thème de couleur, et rien pour les thèmes d'icônes. VS Code regroupe pourtant dans « Appearance » : Color Theme (avec aperçu visuel), File Icon Theme, Product Icon Theme et quelques réglages d'interface.

- **Modifications effectuées :**
  - **Backend** (`src-tauri/src/extensions.rs`) : `Contributes` parse désormais `iconThemes` et `productIconThemes` (`IconThemeContribution { id, label, path }`) ; `collect_contributions` émet `kind: "icon-theme"` / `"product-icon-theme"`. Test `parses_manifest_and_contributions` étendu (5 contributions assertées).
  - **Frontend types** (`src/lib/extensions.ts`) : union `ExtensionContribution.kind` étendue à `'icon-theme' | 'product-icon-theme'`.
  - **Découverte + résolution** (`src/themes/iconTheme.ts`, nouveau) :
    - `loadFileIconThemes()` / `loadProductIconThemes()` scannent les contributions des extensions installées.
    - `createIconResolver(extId, relPath)` parse le JSON de thème (tables `fileNames`/`fileExtensions`/`folderNames`/`folderNamesExpanded`/`folderExpanded`/`file`), **résout le nom → clé d'icône de façon synchrone**, et charge les SVG **paresseusement** (cache par chemin) — un thème de 1250 icônes ne charge rien au démarrage. `subscribeIconUpdates()` notifie les consommateurs quand un SVG arrive.
  - **Contexte** (`src/themes/ThemeContext.tsx`) : ajout de `iconThemes`/`iconThemeId`/`setIconTheme`/`iconResolver` et `productIconThemes`/`productIconThemeId`/`setProductIconTheme`, persistés en `localStorage`. Le resolver effectif est **dérivé** (`loadedResolver.id === sélection`) pour éviter tout resolver obsolète et tout `setState` synchrone dans l'effet.
  - **Rendu** (`src/components/FileIcon.tsx`, nouveau) : composant unique rendant l'icône du thème actif (via `<img src="data:image/svg+xml,...">`) ou retombant sur le glyphe lucide + teinte par extension. Branché dans `FileTree`, `TabBar`, `SearchPanel`.
  - **UI Apparence** (`src/components/settings/SettingsPanel.tsx`) : Color Theme en **grille de vignettes avec aperçu** (mini-éditeur + sidebar échantillonnant `bg.editor`, `bg.sidebar`, `fg.default`, `accent.blue`, `syntax.*`), sélecteurs File Icon Theme et Product Icon Theme, réglages Densité + Barre de statut.
  - **Application des préférences** : `src/main.tsx` pose `data-density`/`data-status-bar` avant le premier rendu ; `src/index.css` masque `[data-origin-statusbar]` et compresse `[data-origin-tabbar]`/`[data-origin-tree-row]` en mode compact.

- **Décisions Techniques :**
  - **SVG en data-URI, jamais inliné** : les SVG proviennent d'extensions non fiables ; les insérer en markup vivant exposerait à du script/handler dans notre origine. Une balise `<img>` les traite comme image passive. Les chemins passent par `readExtensionAsset` (confiné, anti-traversal).
  - **Chargement paresseux des icônes** : ne pas précharger 5 Mo de SVG ; le JSON de mapping seul suffit pour résoudre, le SVG est lu à la première utilisation.
  - **Resolver dérivé plutôt qu'état dupliqué** : évite les resolvers obsolètes lors d'un changement rapide de sélection et supprime le warning `set-state-in-effect`.
  - **Densité/statut via attributs `data-*` + CSS** : source de vérité unique, pas de duplication d'état React entre Settings et le layout.

- **Impacts & Dépendances :**
  - Nouvelle surface : `iconTheme.ts`, `FileIcon.tsx`. Modifiés : `extensions.rs`, `extensions.ts`, `ThemeContext.tsx`, `SettingsPanel.tsx`, `FileTree.tsx`, `TabBar.tsx`, `SearchPanel.tsx`, `StatusBar.tsx`, `main.tsx`, `index.css`.
  - Le **Product Icon Theme** est sélectionnable et persisté mais **non rendu** : notre chrome UI utilise lucide-react, pas la police codicon des thèmes produit. À implémenter si un rendu réel est requis (ne pas présenter comme pleinement fonctionnel).

- **Prochaines étapes :**
  - Rendu effectif des Product Icon Themes (police d'icônes) si souhaité.
  - Support `include` (héritage `fileIconTheme`/`base`) et `languageIds` du thème d'icônes.
  - Vérifier le rendu dans l'IDE (l'utilisateur doit sélectionner « Material Icon Theme » dans Apparence → File Icon Theme).

---

- **Contexte :**
  Deux bugs signalés : (1) « `Activation failed: Error: extension failed to load: cannot convert to object` » sur Material Icon Theme v5.39.0 ; (2) « je ne vois que deux thèmes ». Le premier a été diagnostiqué par reproduction hors-IDE (harnais Node exécutant le bundle dans le même variant QuickJS) : le bundle appelle au chargement/à l'activation `require("fs").existsSync(...)` et `require("path").join(...)`. Notre `require` renvoyait `{}` pour tout built-in non listé → `(0,ts.existsSync)` = `undefined()` → l'activation rejetait la promesse avec `not a function`. Le second est **attendu** : l'utilisateur n'a installé QUE `PKief.material-icon-theme`, qui contribue `contributes.iconThemes` (icônes de fichiers), **pas** `contributes.themes` (thème de couleur) → rien à convertir pour le sélecteur.

- **Modifications effectuées :**
  - `src/lib/extensions/runtime.ts` (`wrapCommonJs`, prelude) : ajout de deux shims **inertes et virtualisés** dans `__originNodeShims` :
    - `fs` : `existsSync → true`, `readdirSync → []`, `readFileSync → ''`, `statSync` neutre, écritures (`writeFileSync`/`mkdirSync`/`rmSync`/`unlinkSync`) no-op.
    - `fs/promises` : `readFile/writeFile/mkdir/rm/readdir/stat/access/unlink` renvoyant des promesses résolues sur des valeurs neutres.
  - Aucun accès au FS hôte : `existsSync` renvoie `true` pour que les bundles empruntent la branche « déjà présent, pas de régénération » et n'écrivent jamais sur disque.
  - (Rappel des correctifs du même cycle, déjà en place) : `readModuleExport` suit désormais `module.exports` (helpers esbuild `__toCommonJS`/`$s`) ; ajout `workspace.getConfiguration`/`onDidChangeConfiguration` et `window.createOutputChannel` ; `setExtensionsSnapshot` (globals VM `__originExtensions`/`__originExtensionsOrder`) alimenté par le **vrai** `package.json` (via `readExtensionManifest`) avant `evalModule`.

- **Décisions Techniques :**
  - **Shim FS virtuel plutôt qu'accès réel** : un backend complet `fs` aurait offert à du code tiers non fiable un accès disque arbitraire (écriture d'icônes, lecture de secrets) — régression sécurité inacceptable. Le shim satisfait l'API attendue sans jamais toucher au disque (least privilege).
  - `existsSync → true` (et non `false`) pour éviter la branche de régénération qui déclenche `writeFile`/`readdirSync` : chemin le plus court, zéro effet de bord.
  - **Diagnostic hors-IDE** (harnais Node sur le même variant QuickJS) plutôt qu'itérations en aveugle dans l'IDE : a permis d'isoler la cause exacte et de la prouver (`activate promise: fulfilled`, logs « Translations initialized. » / « Extension activated! »).

- **Impacts & Dépendances :**
  - `runtime.ts` : seuls le prelude `require` et les shims changent ; aucune nouvelle API hôte exposée. Le modèle de capacités (`vscode` gated) reste la **seule** surface fonctionnelle.
  - Les extensions qui s'appuient réellement sur un FS persistant (cache disque, génération d'assets) fonctionneront en mode dégradé silencieux (lecture vide, écriture no-op) — acceptable pour des thèmes/icônes, à documenter pour des extensions « lourdes ».

- **Prochaines étapes :**
  - **Thèmes d'icônes** (`contributes.iconThemes`) : système distinct non implémenté (associations fichier → icône dans l'explorateur). À cadrer si requis.
  - Support `include` (héritage de thème VS Code).
  - Informer l'utilisateur : installer un **thème de couleur** (ex. One Dark Pro, Dracula) pour voir des thèmes VS Code — un thème d'icônes n'apparaît pas dans le sélecteur de thèmes.

---

### [2026-10-11T22:05] | Thèmes VS Code — adaptateur de tokens (thèmes des extensions)

- **Contexte :**
  Obligation produit : prendre en charge les thèmes de couleur VS Code fournis par les extensions installées. Format source totalement différent du modèle interne (`OriginTheme` : `colors` à clés `bg.editor`… vs VS Code : `colors` à clés `editor.background`… + `tokenColors` TextMate).

- **Modifications effectuées :**
  - **Nouveau** `src/themes/vscodeTheme.ts` : adaptateur pur VS Code JSON → `OriginTheme`.
    - `COLOR_MAP` : ~45 tokens Origin → liste ordonnée de clés VS Code (ex. `bg.editor` → `editor.background`, `bg.sidebar` → `sideBar.background`/`activityBar.background`, terminal ansi → `terminal.ansi*`, git → `gitDecoration.*`).
    - `SYNTAX_SCOPES` : 9 tokens `syntax.*` → scopes TextMate ordonnés (ex. `syntax.keyword` → `keyword`, `storage`, `keyword.control`).
    - `resolveSyntaxColor()` : résout la couleur d'un token en cherchant le scope le plus spécifique (match exact puis préfixe pointé).
    - `vscodeThemeToOrigin(raw, fallback, name)` : fusionne couleurs UI + syntaxe résolues, complète les tokens non mappés depuis un thème Origin intégré (dark/light selon `type`). Retourne `{ theme, matched }`.
    - `parseVscodeTheme()` : parse + valide.
  - `src/themes/ThemeContext.tsx` : découverte des thèmes d'extensions au montage (`loadExtensionThemes`) — filtre `contributions[kind === "theme"]`, lit l'asset via `readExtensionAsset` (aucun code exécuté), convertit, et ajoute à `themes`. Nom préfixé `"<label> (<ext.name>)"` pour éviter les collisions. Échec isolé par thème (try/catch + `console.warn`), jamais bloquant.

- **Décisions Techniques :**
  - **Adaptateur (mapping déclaratif)** retenu plutôt qu'une refonte du moteur ou une dépendance tierce : zéro dépendance ajoutée, surface testable, s'insère dans le modèle CSS-vars existant sans toucher les composants (`--origin-*`).
  - **Fallback vers un thème intégré** pour les tokens absents du thème VS Code : garantit une UI toujours complète (un thème VS Code ne couvre pas forcément tous nos tokens).
  - **Isolation par thème** : un `.json` invalide n'empêche pas les autres thèmes de charger.
  - `include` (héritage de thème VS Code) **non géré** — hors périmètre ; la majorité des thèmes sont autonomes.
  - Aucune exécution de code : seul `read_extension_asset` (lecture texte confinée) est utilisé — cohérent avec le modèle de sécurité Niveau 1/2.

- **Impacts & Dépendances :**
  - `ThemeContext` expose désormais `themes` (état, plus la constante statique `builtinThemes`) ; `builtinThemes` reste exporté.
  - Appel asynchrone `listExtensions()` au démarrage du theme provider (déjà chargé ailleurs, impact perf négligeable).
  - Sélection d'un thème d'extension persistée sous son nom préfixé dans `localStorage["origin-theme"]`.

- **Prochaines étapes :**
  - Support de `include` (héritage de thème).
  - Import manuel d'un `.json` de thème VS Code via Settings (`loadThemeFromJson` existe mais attend le format Origin).

---

### [2026-10-11T21:35] | Settings — refonte style VS Code + retrait des System Prompts

- **Contexte :**
  Demande : « faire setting comme sur VS Code proprement » et « on ne met pas le prompt sur l'UI ». Décisions utilisateur : **Layout VS Code + recherche**, **retirer la section System Prompts**.

- **Modifications effectuées :**
  - `src/components/settings/SettingsPanel.tsx` :
    - **Suppression complète de la section « System Prompts »** (type `PromptTab`, `PROMPT_CONFIGS`, `PromptEditor`, `PromptsSection`) et de la section du type `Section`. Les prompts par défaut restent dans `lib/ai` et ne sont plus exposés à l'utilisateur.
    - **Barre de recherche** ajoutée dans le header : filtre les entrées de navigation (label + mots-clés) via `useMemo`, sélection automatique de la première section correspondante, message « No matching settings » si vide.
    - **Nav pilotée par données** : tableau `SECTIONS` (`id`, `label`, `icon`, `keywords`) rendu dynamiquement ; largeur nav 172→196 px.
    - **Composants réutilisables VS Code** : `SettingRow` (label/description à gauche, contrôle à droite, séparateur bas), `SectionHeading`, `Toggle` (switch on/off), style `selectStyle`.
    - **Sections restylées en lignes** : *General* (Inline completions = switch, Ghost text delay = input + select ms/s), *Appearance* (thème = select au lieu de la liste de cartes), *AI Providers* (heading « API Keys » + intro), *Terminal* (heading « Shell Integration »).
    - Contenu contraint à `maxWidth: 760px` pour l'alignement type VS Code.

- **Décisions Techniques :**
  - **Recherche = filtre de navigation** (approche légère) plutôt qu'un index global de chaque réglage : suffisant pour 5 sections, coût d'implémentation et de maintenance minimal. Un futur moteur déclaratif de settings (registry) permettrait une recherche par réglage — hors périmètre.
  - **`Toggle` en switch** (style VS Code) au lieu des boutons On/Off texte : meilleure lisibilité et cohérence avec les IDE de référence.
  - Fonctions utilitaires `msToDisplay`/`displayToMs` et logiques localStorage des sections **inchangées** — seul le rendu a évolué.

- **Impacts & Dépendances :**
  - Retrait des imports `MessageSquareDot`, `DEFAULT_SYSTEM_PROMPT`/`DEFAULT_ASK_PROMPT`/`DEFAULT_PLAN_PROMPT`.
  - Ajout de l'import `Search` (lucide-react) et `useMemo`.
  - Les clés localStorage des prompts (`origin-ai-system-prompt`, etc.) ne sont plus écrites depuis l'UI ; elles restent lues par le moteur IA (rétrocompatibilité conservée).

- **Prochaines étapes :**
  - Optionnel : index de réglages déclaratif pour une recherche au niveau du réglage.

---

### [2026-10-11T21:10] | UI — Settings en page plein écran + bouton en barre de titre

- **Contexte :**
  Settings s'ouvrait dans une petite modale centrée (760×540, fond flouté). Demande produit : en faire une **page plein écran** (sidebar de navigation à gauche, comme la référence VS Code/Trae), **retirer l'icône Settings de la barre de statut** (en bas) et la placer **en haut à droite**, à côté du bouton menu.

- **Modifications effectuées :**
  - `src/components/settings/SettingsPanel.tsx` : suppression de l'overlay modale (fond `rgba(0,0,0,0.55)` + `backdropFilter`, boîte arrondie, fermeture au clic extérieur). Le panneau occupe désormais tout l'écran (`inset: 0`, fond `--origin-bg-sidebar`, flex column) avec header et corps en pleine hauteur. Fermeture toujours via `X` ou `Échap`.
  - `src/components/TitleBar.tsx` : ajout d'un `IconBtn` **Settings** (icône `lucide:settings`, tooltip « Settings (Ctrl+,) ») dans le groupe de droite, juste avant le bouton menu.
  - `src/components/StatusBar.tsx` : retrait du `StatusItem` Settings et de la prop `onOpenSettings`.
  - `src/context/CommandContext.tsx` : ajout de `onOpenSettings` au type `AppCommands` + valeur par défaut.
  - `src/App.tsx` : câblage `onOpenSettings: () => setSettingsOpen(true)` dans `commands` ; suppression de la prop `onOpenSettings` passée à `StatusBar`.

- **Décisions Techniques :**
  - **Plein écran plutôt que modale** : meilleure ergonomie pour une page de réglages riche (6 sections) ; aligne sur les IDE de référence. Le portail `createPortal(..., document.body)` reste utilisé pour sortir de la hiérarchie de layout (évite tout clipping/stacking context).
  - **`onOpenSettings` dans `CommandContext`** : TitleBar consomme déjà `useCommands()` ; ajouter la commande au contexte évite une nouvelle prop et unifie le point d'entrée (aussi utilisé par le keybinding `origin.toggleSettings`).
  - Retrait du `StatusItem` Settings : évite un doublon d'entrée, l'icône est désormais unique en haut à droite.

- **Impacts & Dépendances :**
  - `AppCommands` gagne un membre obligatoire → valeur par défaut `noop` fournie ; aucun autre consommateur impacté.
  - La palette de commandes (`CommandPalette`) garde sa prop `onOpenSettings` distincte (inchangée).
  - Le keybinding `Ctrl+,` (`origin.toggleSettings`) continue de fonctionner via `App.tsx`.

- **Prochaines étapes :**
  - Aucune.

---

### [2026-10-11T20:45] | UI — suppression complète de la modale « About Origin »

- **Contexte :**
  Suite au retrait des liens GitHub, l'entrée *About Origin* ouvrait une modale locale non fonctionnelle/peu visible et confondue avec la modale de consentement des extensions. Demande : la supprimer entièrement.

- **Modifications effectuées :**
  - `src/components/TitleBar.tsx` : suppression de l'entrée de menu `About Origin` et de la destructuration `onAbout` de `useCommands()`.
  - `src/App.tsx` : suppression de la modale About (bloc `aboutOpen && (...)`), du state `aboutOpen`/`setAboutOpen`, de `handleAbout()` et de la prop `onAbout` du tableau `commands`.
  - `src/context/CommandContext.tsx` : retrait de `onAbout` du type `Commands` et de la valeur par défaut (`noop`).

- **Décisions Techniques :**
  - Suppression complète (state + handler + type + valeur par défaut) plutôt que masquage : évite du code mort et une clé de contexte orpheline.
  - La **modale de consentement des extensions** (`ConsentModal` dans `ExtensionsPanel.tsx`) est **conservée** : elle est distincte, utilise `createPortal(..., document.body)` avec `zIndex: 10000` (vérifié identique au pattern de `SettingsPanel`, qui fonctionne) — aucune régression.

- **Impacts & Dépendances :**
  - `Commands` (CommandContext) perd un membre : aucun autre consommateur que `TitleBar` ne l'utilisait.
  - Le menu *Help* ne contient plus que `Keyboard Shortcuts`.

- **Prochaines étapes :**
  - Aucune.

---

### [2026-10-11T20:25] | UI — retrait des liens GitHub du menu Help

- **Contexte :**
  Demande produit : retirer de l'interface tout texte/bouton redirigeant vers GitHub depuis le menu d'aide d'Origin.

- **Modifications effectuées :**
  - `src/components/TitleBar.tsx` : suppression de la constante `repo` et des 5 entrées du menu *Help* ouvertes via `openUrl` (`Documentation` → `#readme`, `Report an Issue` → `/issues/new`, `View on GitHub`, `View License` → `blob/main/LICENSE`, `Release Notes` → `/releases`). Suppression de l'import désormais inutilisé `openUrl` de `@tauri-apps/plugin-opener`.
  - Entrées conservées dans *Help* : `Keyboard Shortcuts` et `About Origin` (modale locale, aucun lien GitHub).

- **Décisions Techniques :**
  - Retrait ciblé sur la **surface UI** uniquement. Non touchés : l'endpoint d'auto-update (`tauri.conf.json`), la CI (`.github/workflows/release.yml`) et le `README.md` — ils ne sont pas affichés à l'utilisateur dans l'app et sont nécessaires au build/release.
  - Vérification préalable (recherche exhaustive) : la modale `About` et la page `Welcome` ne contenaient déjà aucun lien GitHub ; `TitleBar.tsx` était le seul point d'affichage.

- **Impacts & Dépendances :**
  - `openUrl` n'était utilisé que pour ces liens dans `TitleBar.tsx` → import supprimé sans effet de bord.
  - Aucun autre fichier applicatif ne référence GitHub dans l'UI.

- **Prochaines étapes :**
  - Aucune.

---

### [2026-10-11T20:05] | Niveau 2 — correctif « Maximum update depth exceeded »

- **Contexte :**
  Après activation d'une extension, React levait `Maximum update depth exceeded` (boucle de re-render via `forceStoreRerender`/`updateStoreInstance`). Symptôme classique d'un `useSyncExternalStore` dont le snapshot change d'identité à chaque appel.

- **Modifications effectuées :**
  - `src/lib/extensions/registry.ts` : `getCommands()` renvoyait `Array.from(commands.values())` — un **nouveau tableau** à chaque appel. Désormais un snapshot mémoïsé (`let snapshot`) est reconstruit uniquement dans `emit()` (donc sur mutation réelle). `getCommands()` renvoie ce snapshot stable.

- **Décisions Techniques :**
  - **Snapshot mémoïsé obligatoire** : `useSyncExternalStore` compare le snapshot par identité à chaque rendu ; un tableau neuf → React conclut « store modifié » → re-render → nouveau tableau → boucle infinie (React coupe au bout de N itérations avec cette erreur).
  - L'invalidation se fait au seul point d'écriture (`emit()`, appelé par `registerCommand`/`unregisterCommand`/`unregisterAllForExtension`), garantissant qu'aucun `emit` superflue ne soit émis.
  - `getRecords()` du host n'est **pas** concerné : il est consommé via `setHostRecords(...)` dans un listener d'abonnement, pas directement en tant que snapshot `useSyncExternalStore`.

- **Impacts & Dépendances :**
  - `getCommands()` reste synchrone et de même signature ; aucun autre appelant impacté.
  - `getCommand(id)` (lookup unitaire) inchangé.

- **Prochaines étapes :**
  - Vérifier en runtime que la palette se met bien à jour après `registerCommand` d'une extension (l'`emit` doit bien produire un nouveau snapshot).

---

### [2026-10-11T19:45] | Niveau 2 — shim `vscode.extensions` / `env` / `EventEmitter`

- **Contexte :**
  Après le correctif `require`, l'activation échouait sur `cannot read property 'getExtension' of undefined` (ex. Material Icon Theme). Le shim `vscode` n'exposait que `commands`/`window`/`workspace`/`Uri`/`ExtensionMode`/`Disposable`/`version`. Or de nombreuses extensions appellent `vscode.extensions.getExtension(...)`, lisent `vscode.env.*`, ou instancient `new vscode.EventEmitter()` au chargement.

- **Modifications effectuées :**
  - `src/lib/extensions/runtime.ts` :
    - `buildExtensions(ctx, bridge)` : `getExtension(id)` (descripteur `{id, extensionPath, isActive, packageJSON, exports}` ou `undefined`) et `all()` (liste des extensions installées). **Métadonnées uniquement** — pas de proxy `exports` inter-extension.
    - `buildEnv(ctx)` : `appName`/`appHost`/`language`/`machineId`/`sessionId`/`uiKind` + `clipboard.readText/writeText` inertes.
    - `buildEventEmitter(ctx)` : `EventEmitter` fonctionnel **en isolate** (`event`/`fire`/`dispose`), sans accès hôte.
  - `src/lib/extensions/hostBridge.ts` : `HostBridge` + `getExtensionInfo`/`getInstalledExtensions` + type `ExtensionMetadata`.
  - `src/lib/extensions/host.ts` : `HostDelegate` étendu (`ExtensionDescriptor`), `makeBridge` délègue les deux nouvelles méthodes.
  - `src/context/ExtensionsContext.tsx` : stub + forwarding delegate initialisés avec les deux méthodes.
  - `src/App.tsx` : `getExtensionInfo`/`getInstalledExtensions` construits depuis la liste installée (`extensions`), `packageJSON` dérivé des champs parsés.

- **Décisions Techniques :**
  - **`exports` vide (pas de proxy inter-isolate)** : exposer l'`exports` réel d'une autre extension donnerait à un sandbox un chemin vers un autre — refusé par principe (isolation stricte).
  - **`EventEmitter` en isolate pur** : c'est une primitive de composition interne, aucun besoin d'accès hôte ; l'implémenter localement évite d'ouvrir une surface.
  - **`packageJSON` partiel** : suffisant pour les motifs de détection courants (name/publisher/version) sans exposer tout le manifeste.

- **Impacts & Dépendances :**
  - `HostDelegate` a 2 membres obligatoires de plus → tout fournisseur du delegate doit les implémenter (fait dans App.tsx + stubs).
  - Dépendance ajoutée : l'effet de publication du delegate dans App.tsx dépend maintenant aussi de `extensions` (re-publication quand la liste change).

- **Prochaines étapes :**
  - Tester d'autres extensions courantes avec `main` (thème d'icônes, snippets, statusbar) et couvrir les motifs `vscode.*` restants à la demande (ex. `languages`, `window.createStatusBarItem`, `workspace.getConfiguration`).

---

### [2026-10-11T19:15] | Niveau 2 — correctif « Cannot find module 'path' »

- **Contexte :**
  Après installation, aucune extension ne s'activait : `extension failed to load: Cannot find module 'path'`. Les `.vsix` réels embarquent un bundle webpack/esbuild **ciblant Node.js** dont le préambule appelle `require("path")`, `require("os")`, etc. Notre `require` shim ne résolvait que `vscode` et levait sur tout le reste → le module ne se chargeait jamais.

- **Modifications effectuées :**
  - `src/lib/extensions/runtime.ts` :
    - `createExtensionRuntime(bridge, extensionPath, onLog)` reçoit désormais `extensionPath`.
    - `wrapCommonJs(source, extensionPath)` émet un préambule avec : shim `path` (join/resolve/dirname/basename/extname/relative/normalize/isAbsolute), stubs inertes `os`/`util`/`url`/`assert`, résolution `node:`-prefix, **runtime webpack** (`__webpack_require__` + cache `__originModules` + `.d`/`.r`/`.n`/`.o`) branché sur `__originRequire`, et résolution par défaut vers `{}` (sémantique `ignore` webpack) au lieu de lever.
  - `src/lib/extensions/host.ts` : passage de `ext.path` à `createExtensionRuntime`.

- **Décisions Techniques :**
  - **`require` inconnu → `{}` plutôt que throw** : de nombreuses extensions `require` des built-ins Node inutiles à l'activation (ex. `fs` importé mais non utilisé). Un throw empêchait tout chargement. Renvoyer un objet inerte reproduit la sémantique webpack `ignore`.
  - **Aucun accès hôte ajouté** : les stubs ne touchent jamais au système ; la seule surface fonctionnelle reste l'API `vscode` médiée par `HostBridge` + permissions. Aucune régression de sécurité (pas de fs réel, pas de réseau).
  - **Pourquoi pas de vraie résolution Node** : impossible/pas souhaitable dans un isolate WASM — cela élargirait la surface d'attaque. Les stubs suffisent à laisser un bundle s'initialiser.

- **Impacts & Dépendances :**
  - Les extensions purement grammaticales/thématiques (sans `main`) ne sont pas concernées.
  - Les extensions dont la logique dépend réellement de `fs`/`child_process` ne fonctionneront que partiellement (par conception) : seul `vscode.*` est réel.

- **Prochaines étapes :**
  - Tester l'activation d'extensions courantes du marketplace (celles avec `main`) et vérifier le log par extension.
  - Étendre le shim si un motif de `require` légitime réapparaît (ex. `module.exports.default` interop).

---

### [2026-10-11T18:30] | Extensions VS Code — Niveau 2 (runtime sandboxé QuickJS + shim `vscode.*`)

- **Contexte :**
  Le Niveau 1 (assets passifs : grammaires/snippets/thèmes) affichait les extensions dotées d'un `main` comme « code (inactive) » puisque rien ne l'exécutait. L'utilisateur a validé le passage au **Niveau 2** : exécuter le code d'extension dans un sandbox WASM. Décisions via questions : **périmètre étendu** (`commands` + `window` + `workspace.fs` + `texteditor`), **moteur QuickJS WASM** (variant single-file browser), **consentement explicite** par capacité.

- **Modifications effectuées :**
  - `src/lib/extensions/permissions.ts` (nouveau) : modèle de capacités (`commands:register`, `window:message`, `workspace:read`, `workspace:write`, `editor:modify`), calcul des capacités requises depuis le manifeste, stockage localStorage des consentements (`origin-extension-consents`), gardes `assertCapability` / `assertSafePath`.
  - `src/lib/extensions/registry.ts` (nouveau) : registre de commandes module-level + `useSyncExternalStore`-compatible (`subscribe`/`getCommands`), `registerCommand`/`unregisterAllForExtension`, `executeCommand`.
  - `src/lib/extensions/hostBridge.ts` (nouveau) : contrat `HostBridge` (seule surface exposée à l'extension) + `HostTextDocument`.
  - `src/lib/extensions/runtime.ts` (nouveau) : runtime QuickJS sandboxé (`quickjs-emscripten-core` + variant `@jitl/quickjs-singlefile-browser-release-sync`). Shim `vscode` limité (`commands`, `window`, `workspace.fs`, `Uri`, `ExtensionMode`, `Disposable`), `console` redirigé vers le log d'extension, promesses via `pendingSettles` + `executePendingJobs`.
  - `src/lib/extensions/host.ts` (nouveau) : `ExtensionHost` — chargement du `main.js` via asset confiné, cycle de vie `activate`/`deactivate`, état (`inactive`/`active`/`error`) + log borné (200 lignes), vérification de consentement à chaque appel de bridge.
  - `src/context/ExtensionsContext.tsx` : host unique (délégué « forwarding » stable), `activate`/`deactivate`/`hostRecords`, désactivation au reload des extensions dont le code a disparu.
  - `src/components/ExtensionsPanel.tsx` : toggle Activer/Désactiver, badges actif/erreur, console de log dépliable, et `ConsentModal` listant les capacités à accorder avant activation.
  - `src/components/palette/CommandPalette.tsx` + `src/hooks/useGlobalKeybindings.ts` : les commandes d'extension sont proposées dans la palette et déclenchables via keybinding.
  - `src/App.tsx` : publication du `HostDelegate` réel (workspace, fs, éditeur actif, toast, exécution de commandes) + auto-activation des extensions déjà consenties.
  - `tsconfig.json` : `target`/`lib` ES2020 → **ES2022** (nécessaire pour `Error(..., { cause })`).

- **Décisions Techniques :**
  - **Sandbox QuickJS WASM single-file** : exécution hors du thread principal webview n'est pas nécessaire ; le variant single-file évite des fetchs d'assets et tient dans le bundle. Les globals hôte ne sont **pas** exposés — seule l'API `vscode` médiée par `HostBridge` est atteignable.
  - **Consentement explicite par capacité** : une extension ne reçoit une capacité que si l'utilisateur l'a cochée ; refus → `activate` lève, aucune commande enregistrée.
  - **Contrôle à chaque appel** (défense en profondeur) : `assertCapability`/`assertSafePath` sont revérifiés côté bridge, pas seulement à l'activation — une extension ne peut pas élargir ses droits en cours d'exécution.
  - **Réseau Rust uniquement** : aucune `fetch` réseau depuis le code d'extension ; `workspace.fs` passe par les commandes Tauri existantes (confinement `checkPath`).
  - **Délégué « forwarding »** : le host est créé une seule fois mais lit la ref courante, évitant de recréer le host (et donc de perdre les runtimes) à chaque changement de workspace.

- **Impacts & Dépendances :**
  - Nouvelles deps : `quickjs-emscripten-core`, `@jitl/quickjs-singlefile-browser-release-sync` (chunk WASM ~684 kB gzip ~262 kB).
  - Le shim reste volontairement incomplet : `onStartupFinished`, contributions UI dynamiques (panneaux/ActivityBar), écriture directe dans l'éditeur (`setDocumentText`) restent à faire.

- **Prochaines étapes :**
  - Support réel de `activationEvents: onStartupFinished`.
  - Contributions UI dynamiques par extension (panneaux sidebar, items ActivityBar).
  - Écriture dans l'éditeur via `WorkspaceEdit`/`setDocumentText`.
  - Vérifier en runtime (`pnpm dev`) l'activation d'une extension réelle et le refus de permissions.

---

### [2026-10-11T12:00] | Extensions VS Code — Niveau 1 étendu (marketplace Open VSX + grammaires)

- **Contexte :**
  Après l'implémentation du Niveau 1 (assets passifs : installation locale de `.vsix`, extraction sécurisée, grammaires TextMate→CodeMirror), l'utilisateur a demandé de « continuer proprement » et de pouvoir « voir les extensions disponibles ». Choix retenu par l'utilisateur : un **marketplace en ligne (Open VSX)**.

- **Modifications effectuées :**
  - `src-tauri/src/extensions.rs` :
    - `Contribution` expose désormais `file_extensions` / `file_names` ; `GrammarContribution` lit `extensions`/`filenames` du manifeste VSIX (fini la table d'extensions codée en dur côté front pour les langages courants).
    - Extraction factorisée dans `install_from_bytes(app, &[u8])`, réutilisée par l'installation locale et par le téléchargement marketplace.
  - `src-tauri/src/extensions_market.rs` (nouveau) :
    - Commandes `market_search(query,size,offset)` et `market_install(namespace,name,version)`.
    - **Sécurité** : hôte figé `https://open-vsx.org` (jamais fourni par le front → pas de SSRF) ; segments `namespace`/`name`/`version` validés par allowlist (`valid_segment`) ; query encodée par `reqwest::query` (pas d'injection) ; plafond de taille (64 Mo, anti-DoS) ; timeouts client ; le `.vsix` téléchargé passe par `install_from_bytes` (garde zip-slip + parse manifeste déjà en place).
  - `src-tauri/src/lib.rs` : `mod extensions_market` + enregistrement de `market_search` / `market_install`.
  - `src/lib/extensions.ts` : types `MarketExtension`/`MarketSearchResult` + wrappers `marketSearch`/`marketInstall`.
  - `src/context/ExtensionsContext.tsx` : les extensions de fichiers sont tirées du manifeste (repli sur la table connue) ; nouveau `grammarByName` → les grammaires ciblant des fichiers sans extension (ex. `Dockerfile`) sont résolues par nom de fichier.
  - `src/components/ExtensionsPanel.tsx` : refonte en 2 onglets **Installed** / **Marketplace**. Le marketplace fait une recherche débouncée (350 ms) avec garde de séquence (anti-race), affiche icône, namespace, téléchargements, note, badge « verified », et un bouton Install/Installed/loading. Les contributions et « code (inactive) » restent visibles côté installés.

- **Décisions Techniques :**
  - **Réseau côté Rust uniquement** : le webview n'envoie jamais d'URL ; il envoie des coordonnées validées. Cela élimine la surface SSRF/`fetch` arbitraire depuis le JS.
  - **Pas d'Oniguruma/WASM** : grammaires converties en `StreamLanguage` CM6 pour tenir la contrainte de poids.
  - **Débounce + garde de séquence** : évite les réponses obsolètes qui écraseraient une recherche plus récente, sans recourir à une lib externe.
  - **Factorisation `install_from_bytes`** : une seule voie d'extraction/validation (DRY), le marketplace ne duplique pas la logique zip-slip.

- **Impacts & Dépendances :**
  - `reqwest` (déjà présent, feature `json`) utilisé pour les appels HTTPS ; TLS natif par défaut.
  - `csp: null` dans `tauri.conf.json` → les icônes distantes Open VSX s'affichent (sinon il faudrait élargir `img-src`).
  - Toujours Niveau 1 : snippets/thèmes sont listés mais pas encore appliqués à l'éditeur ; aucun code d'extension exécuté.

- **Prochaines étapes :**
  - Niveau 2 (non commencé) : shim `vscode.*` sandboxé (QuickJS) — hors périmètre tant que non confirmé.
  - Appliquer réellement snippets (complétion) et thèmes (switching) issus des VSIX.
  - Vérifier visuellement dans l'app (`pnpm dev`) l'installation d'un VSIX réel depuis le marketplace.

- **Validation :**
  - `cargo test --lib` : 37 passés (dont 8 extensions, 4 nouveaux pour le marketplace).
  - `pnpm typecheck` : OK. `pnpm lint` : 0 erreur (4 warnings pré-existantes). `pnpm build:frontend` : OK. `cargo check --lib` : OK.

---

### [2026-10-11] | Refonte de l'UI de l'éditeur (alignement sur la référence Cursor/Trae)

- **Contexte :**
  L'utilisateur a demandé à aligner l'UI de la partie éditeur sur une capture de référence type Cursor/Trae : barre de titre avec logo + nom de projet, colonne d'activité verticale, panneau AI renommé « Agent » avec un état vide dédié, et barre de statut. Contrainte explicite : ne pas inventer de fonctionnalités absentes du code ; copie fidèle mais sans créer de features inexistantes (Outline / Timeline / Cue-Pro ne doivent pas être ajoutés).

- **Modifications effectuées :**
  - `src/components/TitleBar.tsx` : réécriture complète. Structure = bouton « IDE » (logo + label, ouvre le menu fusionné) | sélecteur de projet (nom du dossier ouvrable via la palette) | bouton Search centré (ouvre la palette) | à droite : bascules Sidebar / Panneau bas / Panneau AI + contrôles fenêtre (minimize / maximize / close). Le composant `MenuButton` mort et les imports inutilisés ont été supprimés.
  - `src/components/ActivityBar.tsx` : conversion horizontale → verticale (colonne d'icônes 44px, indicateur d'activation à gauche, tooltip latéral). Icônes migrées vers Iconify (`@iconify/react`, préfixe `lucide:`).
  - `src/components/Sidebar.tsx` : layout passé en `flex` horizontal ; l'ActivityBar forme une colonne à gauche, l'arbre/panneau à droite. Largeur totale = `width + 44`. Poignée de redimensionnement conservée.
  - `src/components/ai/AiPanel.tsx` : header renommé « AGENT » ; nouvel état vide « Agent » (pastille icône, titre, tagline « Deep understanding of complex tasks », 3 capacités statiques avec coches) ; ChatBox et sessions récentes conservés. Toutes les icônes migrées vers Iconify.
  - `src/components/editor/EditorEmptyState.tsx` : remplacé l'écran d'accueil (logo + Open Folder/File/New + récents) par la liste de raccourcis de la référence (« Chat With AI ⌘U », « Edit Code Inline With AI ⌘I »). Props retirées (plus utilisées) et call-site mis à jour dans `src/App.tsx`.
  - `src/components/StatusBar.tsx` : icônes migrées vers Iconify (fonctionnalités inchangées : branche git, langue, Ln/Col, UTF-8, réglages, toggle thème).
  - `src/App.tsx` : correction d'une erreur de type pré-existante (`App.tsx:226`) — `debugCtx.startSession?.()` était appelé sans `DapLaunchConfig`. La commande `startDebug` ouvre désormais simplement le panneau latéral ; le lancement réel d'une session passe exclusivement par `DebugLaunchForm` (qui fournit la config).

- **Décisions Techniques :**
  - **Iconify vs lucide-react** : migration vers `@iconify/react` (préfixe `lucide:`) conformément à la préférence utilisateur. `lucide-react` reste en dépendance (encore utilisé ailleurs) pour ne pas casser le reste de l'app ; migration progressive.
  - **Pas de fonctionnalités inventées** : conformément à la contrainte, Outline / Timeline / Cue-Pro (absents du code) n'ont pas été créés. L'état vide « Agent » est purement statique et n'ajoute aucune capacité inexistante.
  - **Sélecteur de projet** : pas de vrai multi-projet dans le code → réutilisation de la palette de commandes existante plutôt que d'inventer un gestionnaire de projets.
  - **Fix `App.tsx:226`** : correction minimale et sûre plutôt que d'inventer un lancement de debug sans config (ce qui aurait produit un crash runtime).

- **Impacts & Dépendances :**
  - `TitleBar`, `ActivityBar`, `Sidebar`, `AiPanel`, `EditorEmptyState`, `StatusBar`, `App.tsx` modifiés. `@iconify/react@^6.0.2` requis (ajouté au `package.json`).
  - La signature de `EditorEmptyState` est désormais sans props → tout autre call-site éventuel devrait être adapté (seul `App.tsx` l'utilise).
  - `StatusIsland` n'est plus monté dans la TitleBar suite à la refonte. **Feature orpheline** : à replacer (ex. barre de statut) ou à réintégrer lors d'une prochaine itération.

- **Prochaines étapes :**
  - Décider du sort de `StatusIsland` (relocation ou suppression documentée).
  - Poursuivre la migration `lucide-react` → `@iconify/react` sur les composants restants.
  - Restyler le `FileTree` (icônes de dossiers encore en dur, `#eab308`) sur les variables de thème pour cohérence clair/sombre.

- **Validation :**
  - `pnpm typecheck` : OK (0 erreur).
  - `pnpm lint` : 0 erreur (4 warnings pré-existants/déjà présents, dont accès ref dans `TitleBar`/`useGlobalKeybindings`).
  - `pnpm build:frontend` : OK (`✓ built in 3.44s`).
