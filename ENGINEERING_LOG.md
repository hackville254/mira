# ENGINEERING LOG — Origin IDE

> Journal technique chronologique (la plus récente entrée en haut).
> Format : `[ISO-DATE-HEURE] | [Titre]` → Contexte / Modifications / Décisions / Impacts / Prochaines étapes.

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
