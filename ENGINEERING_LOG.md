# ENGINEERING LOG — Origin IDE

> Journal technique chronologique (la plus récente entrée en haut).
> Format : `[ISO-DATE-HEURE] | [Titre]` → Contexte / Modifications / Décisions / Impacts / Prochaines étapes.

---

### [2026-10-12T17:00] | Explorateur — réécriture complète « parité VS Code »

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
