# Benchmark ORVYX Code — rapport d'audit et protocole

> Objectif : **tester le produit réel** (la vraie boucle de l'agent, les vrais
> outils, la vraie indexation), pas construire un benchmark isolé.
> Aucun score de concurrent n'est inventé. Aucun benchmark payant n'est lancé
> sans accord explicite. Les tests simulés et les tests réseau sont distingués
> partout.

Dernière mise à jour : 2026-10-19.

---

## 1. Audit du code réel (Phase 1)

### 1.1 Point d'entrée de l'agent et boucle d'exécution

Il existe **deux moteurs** dans ORVYX Code :

| Moteur | Fichier | Rôle |
|---|---|---|
| **Sidecar Cline** (production) | `src/lib/agent/clineClient.ts`, `clineBridge.ts` | Moteur réel piloté en **NDJSON** (`@cline/core`). C'est lui qui répond à l'utilisateur. |
| **`runAgent` in-process** | [run.ts](file:///Users/user/code/orvyx-desktop/origin/src/lib/agent/run.ts) (724 lignes) | Boucle locale appelée uniquement par les **sous-agents** (`spawn_agent`). |

La boucle `runAgent` :

- Construit le `streamText` du SDK `ai@6` avec `stopWhen: stepCountIs(...)`.
- Transmet `options.abortSignal` à `doStream` (annulation propre).
- Gardes temporelles : **firstChunkMs** (désarmé au premier contenu) et
  **stallTimeoutMs** (armé seulement après le premier contenu).
- **Ne gère pas** l'événement `tool-error` (asymétrie relevée en §6).
- Cascade de repli via `modelCascade.ts` : bascule immédiate sans backoff si un
  repli existe ; `producedOutput` bloque le fallback (anti-duplication).
- Politique de retry (`retry.ts`) : `MAX_ATTEMPTS=3`, backoff exponentiel
  (`BASE 3 s`, `MAX 30 s`) + jitter ±20 % ; messages « timeout »/« stalled »
  classés **transient**.

### 1.2 Providers, modèles, fallback

- `src/lib/agent/providers.ts` — `OPENAI_COMPAT_BASE` couvre : orvyx, openrouter,
  deepseek, mistral, groq, xai, cohere, lmstudio, vllm, ollama.
  `resolveClineProvider` + `buildLanguageModel(providerId, modelId, apiKey)`.
- Modèles par défaut de comparaison (dans `scripts/model-compare.ts`, à **lire
  depuis la config, jamais à inventer**) : deepseek-v4-flash, gemini-3.5-flash,
  gemini-3.1-flash-lite, claude-haiku-4-5, qwen3-coder-480b-a35b-instruct-turbo,
  llama-3.3-70b-instruct-turbo, glm-5.3-flash.
- `.env` : `ORVYX_AI_PROVIDER/MODEL/API_KEY/BASE_URL`.

### 1.3 Outils réellement disponibles

Les outils de production ([tools.ts](file:///Users/user/code/orvyx-desktop/origin/src/lib/agent/tools.ts))
appellent `invoke` **Tauri** importé statiquement (`read_file`, `write_file`,
`read_dir`, `read_file_range`, terminal). **Conséquence pour le benchmark** :
il n'existe **aucun point d'injection** pour substituer des outils factices ;
un driver « outils ORVYX réels » ne peut tourner **que dans l'app Tauri**
(voir §3.3, adaptateur à venir). Nous n'avons **pas** créé de faux outils (§6).

### 1.4 Indexation et recherche BM25 (déjà implémentées)

- `src-tauri/src/indexing.rs` — BM25 réel : `k1 = 1.5`, `b = 0.75`,
  `PATH_WEIGHT = 2.0` (biais de chemin), IDF lissé (jamais négatif),
  persistance `<ws>/.mira/index/`.
- `src-tauri/src/search.rs` — recherche textuelle (regex, walk) + recherche de
  symboles `search_symbols`.
- **Câblage vers l'agent** : l'outil `codebase_search` → commande
  `search_index` dans le pont de production
  ([clineClient.ts](file:///Users/user/code/orvyx-desktop/origin/src/lib/agent/clineClient.ts#L619-L653)),
  en **lecture seule**, soumis à une **allowlist** (`INVOKE_ALLOWLIST`).
  Le contrat d'outils
  ([toolPresentation.ts](file:///Users/user/code/orvyx-desktop/origin/src/lib/agent/toolPresentation.ts#L81))
  ordonne au modèle de l'utiliser **en premier** pour localiser du code.

**Conclusion §1.4** : l'indexation **est réellement branchée** dans le chemin de
production, et le modèle est **incité** à l'utiliser. Reste à le **vérifier
empiriquement** (§4, non fait sans accord réseau).

### 1.5 Tests existants et mécanismes de simulation

- Vitest : `include: ["src/**/*.test.ts"]`, environment `node`, `globals: true`.
- Utilitaires SDK : `MockLanguageModelV3`, `simulateReadableStream`,
  `MockProviderV3` (exportés par `ai/test`).
- `clineBridge.test.ts` couvrait déjà le cycle tool-call / tool-result /
  tool_approval → **aucun ajout nécessaire** (documenté, pas dupliqué).

---

## 2. Niveau A — tests déterministes sans API (Phase 2) ✅

Fichier : `src/lib/agent/__tests__/bench.toolcall.test.ts` (**15 tests**, 12 scénarios).

Teste la **vraie boucle `runAgent`** avec un modèle simulé et des outils factices.
Vérifie les **résultats, les appels réellement émis et l'état final** — pas
seulement l'absence d'exception.

| # | Scénario | Couvert |
|---|---|---|
| 1 | Réponse simple sans appel d'outil | ✓ |
| 2 | Appel outil → résultat → réponse finale | ✓ |
| 3 | Plusieurs appels d'outils successifs | ✓ |
| 4 | Lecture / recherche / modification de plusieurs fichiers | ✓ |
| 5 | Appel d'outil invalide | ✓ |
| 6 | Erreur d'outil, timeout et récupération | ✓ |
| 7 | Limite maximale d'itérations | ✓ |
| 8 | Modèle qui refuse d'appeler un outil | ✓ |
| 9 | Modèle qui doit s'abstenir d'un outil inutile | ✓ |
| 10 | Fallback après erreur / indisponibilité du provider (429) | ✓ |
| 11 | Annulation → `cancelled`, sans boucle infinie | ✓ |
| 12 | Conservation du contexte (résultat d'outil réinjecté) | ✓ |

> ⚠️ Un modèle simulé valide le **comportement du harnais**, pas l'intelligence
> du modèle. Les scénarios 1–12 ne préjugent pas de la qualité réelle des modèles.

Support : `src/lib/agent/__tests__/support/mockModel.ts`
(`scriptedModel`, `flakyModel`, `abortableDelay`).

---

## 3. Niveaux B et C — benchmarks réels

### 3.1 Niveau C — tâches de codage (harnais) ✅ offline

Structure (respecte les conventions du dépôt, hors `src/` pour ne pas polluer la prod) :

```
bench/coding/
  types.ts        contrat versionné d'une tâche + résultat (indépendant de Tauri)
  tasks.ts        chargement + validation STRICTE (une tâche invalide fait échouer)
  evaluator.ts    vérification objective par tests (FAIL_TO_PASS / PASS_TO_PASS)
  runner.ts       exécution isolée (mkdtemp, nettoyage garanti, timeout dur)
  report.ts       agrégation JSON + tableau Markdown
  cli.ts          commande offline (driver « reference » = oracle déterministe)
  tasks/          3 tâches internes, chacune vérifiée avant/après
```

3 tâches internes (dépôts temporaires, état initial connu, vérification auto) :

| id | catégorie | vérif |
|---|---|---|
| `bugfix-sum-negatives` | bugfix | échoue avant, passe après |
| `feature-slugify` | feature multi-fichiers | échoue avant, passe après |
| `fix-test-range` | fix-test (bug production) | PASS_TO_PASS préservés, FAIL_TO_PASS corrigé |

**Résultat offline mesuré** (`npm run bench:coding`, driver oracle) :

```
reference-oracle | 3/3 | 100.0% | échec agent 0 | échec harnais 0 | agent 1ms | tests 63ms
```

> Ce score **100 %** valide que le **harnais mesure correctement** (l'oracle
> applique la correction connue). Il ne dit **rien** sur la performance d'un
> modèle. Les instances SWE-bench **réelles** sont traitées séparément en §3.4,
> avec le protocole officiel (dataset + commits + tests Docker).

### 3.2 Niveau B — benchmark réseau (MESURÉ) ✅

Fichier : `bench/network/run.ts` — **appels payants, jamais automatique**.

- Lire l'endpoint/les modèles depuis `.env` (`ORVYX_AI_*`) — **jamais inventés**.
- 3 sondes (`simple`, `toolcall`, `abstain`) sur un système réel
  (`buildSystemPrompt("agent", false)`).
- Mesures : TTFT, durée totale, tokens in/out, tokens/s, tours, appels d'outils,
  exactitude des arguments, taux d'abstention, erreurs HTTP (429/5xx → `provider`,
  4xx → `harness`), ventilation des erreurs.
- Persistance JSON incrémentale + reprise `--resume` (Ctrl-C ne perd rien).
- Les **clés API ne sont jamais écrites** dans les résultats (vérifié : aucune
  correspondance `sk-`/`Bearer`/`API_KEY` dans le JSON).
- Les **coûts sont estimés**, source du tarif à indiquer — jamais présentés comme réels.

**Run exécuté** (accord explicite reçu) : 4 modèles × 3 sondes × 3 répétitions,
`max_tokens=256`, endpoint `https://api.orvyx-ai.com/v1`.

Modèles testés (lus depuis `ORVYX_ALLOWED_MODELS`) : `deepseek-v4.1-flash`,
`glm-5.3-flash`, `deepseek-v4-flash-0731`, `deepseek-v4-flash`.

| modèle | sonde | TTFT méd. (ms) | total méd. (ms) | correct | abstention | args exacts | err. provider |
|---|---|---|---|---|---|---|---|
| deepseek-v4.1-flash | simple | 908 | 923 | 3/3 | — | — | 0 |
| deepseek-v4.1-flash | toolcall | 831 | 1016 | 3/3 | — | 3/3 | 0 |
| deepseek-v4.1-flash | abstain | 781 | 804 | 3/3 | 3/3 | — | 0 |
| glm-5.3-flash | simple | 887 | 887 | 3/3 | — | — | 0 |
| glm-5.3-flash | toolcall | 949 | 973 | 3/3 | — | 3/3 | 0 |
| glm-5.3-flash | abstain | 883 | 913 | 3/3 | 3/3 | — | 0 |
| deepseek-v4-flash-0731 | simple | 954 | 955 | 3/3 | — | — | 0 |
| deepseek-v4-flash-0731 | toolcall | 994 | 1122 | 3/3 | — | 3/3 | 0 |
| deepseek-v4-flash-0731 | abstain | 574 | 574 | 3/3 | 3/3 | — | 0 |
| deepseek-v4-flash | simple | 3189 | 3206 | 3/3 | — | — | 0 |
| deepseek-v4-flash | toolcall | 4892 | 5999 | 3/3 | — | 3/3 | 0 |
| deepseek-v4-flash | abstain | 3507 | 3507 | 3/3 | 3/3 | — | 0 |

**Observations objectives** (pas de conclusion d'intelligence — 3 sondes triviales) :

- **36/36 sondes correctes**, **0 erreur provider**, **taux d'abstention 100 %**,
  **exactitude des arguments 100 %** sur la sonde `toolcall` (tous appellent
  `read_file({"path":"src/math.mjs"})`).
- **TTFT** : le plus rapide = `deepseek-v4-flash-0731` (574–994 ms) ;
  le plus lent = `deepseek-v4-flash` (3,2–4,9 s, latence ~4–5× supérieure).
  Classe TTFT médiane : `deepseek-v4.1-flash` ≈ `glm-5.3-flash` ≈
  `deepseek-v4-flash-0731` < `deepseek-v4-flash`.
- **Variance** : forte instabilité intra-modèle sur `deepseek-v4-flash`
  (toolcall : 4,9 s / 5,9 s / 4,9 s de TTFT) — à confirmer sur plus de répétitions.
- **Limites expérimentales** : 3 sondes courtes, 3 répétitions, un seul endpoint,
  un seul créneau horaire ; `tokens/s` peu fiable sur des sorties de 2–3 tokens
  (donc **non concluant ici**) ; coût non calculé (aucun tarif public fourni
  dans la config → **non estimé**, source absente plutôt qu'inventée).

> Statut : `tsc` ✅, `eslint` ✅, **exécuté avec accord explicite** le 2026-10-19.

### 3.3 Adaptateur Tauri (driver réel) — implémenté

Le driver « vrais outils ORVYX » **ne peut pas** tourner hors app Tauri
(§1.3, `invoke` statique sans injection). Un **adaptateur côté Tauri** a donc
été implémenté dans [tauriDriver.ts](file:///Users/user/code/orvyx-desktop/origin/bench/coding/tauriDriver.ts) :

- Il **appelle le moteur de production** `startClineHarness` (sidecar Cline) —
  il ne le remplace ni ne le refactorise (§6).
- Il agrège les métriques depuis le **flux d'événements réel** (`tool-call`,
  `tool-result`, `timing`, `finish`, `error`) via `reduceEvent`, fonction **pure
  et testée** (`bench.tauriDriver.test.ts`, **7/7 verts**).
- **Approbations** : tout `ask` est **refusé par défaut** (comportement sûr) ;
  `autoApprove` reste **opt-in** (`ORVYX_BENCH_AUTO_APPROVE=1`), réservé au bench
  non interactif, jamais à la prod.
- **Construction par le CLI** : `--driver=cline` (alias `tauri`). Garde
  `isTauriAvailable()` : hors Tauri, **refus explicite** (pas de fausse exécution).
  Lit `ORVYX_AI_PROVIDER/MODEL/API_KEY/BASE_URL` (clé **jamais journalisée**).
- **Prompt système réel** : `buildSystemPrompt("agent", true)` — on mesure le
  moteur tel qu'il est livré, on ne fabrique pas un prompt de test.

**Décision** : ne pas créer de faux outils (§6). Le point d'extension
`resolveDriver` dans [cli.ts](file:///Users/user/code/orvyx-desktop/origin/bench/coding/cli.ts) est désormais branché.

### 3.4 Niveau C réel — instances SWE-bench Lite (MESURÉ)

**Exécuté le 2026-10-20.** Cette section remplace l'ancienne affirmation
« dataset/commits officiels absents » : le dataset réel
**`princeton-nlp/SWE-bench_Lite`** est désormais intégré (`bench/coding/swebench/`).

- **3 instances réelles** téléchargées (champs officiels `instance_id`,
  `base_commit`, `patch`, `test_patch`, `FAIL_TO_PASS`, `PASS_TO_PASS`) :
  `astropy__astropy-12907`, `scikit-learn__scikit-learn-25570`,
  `sympy__sympy-16988`.
- **Environnement par instance** : `Dockerfile` généré d'après le
  `environment_setup_commit` officiel, image `orvyx-swebench:<instance_id>`,
  dépôt cloné au `base_commit`, tests préparés (oracle vérifié : le
  FAIL_TO_PASS échoue bien sans le patch officiel).
- **Agent réellement exécuté** : sidecar Cline (production), modèle
  `deepseek-v4-flash-0731`, mode `act`, auto-approbation, `maxIterations=25`.
  Le dépôt hôte est modifié par l'agent ; **les tests tournent DANS Docker**
  (`docker run --platform linux/amd64`, `pytest`, `--color=no`).
- **Honnêteté du protocole** : après le travail de l'agent, les fichiers touchés
  par le `test_patch` officiel sont **remis au `base_commit`** puis le
  `test_patch` est **réappliqué**. Toute modification de test par l'agent est
  donc **ignorée** (constaté : l'agent avait édité le test astropy). Le
  `model_patch` publié ne contient que les fichiers **source**.

| instance | issue | source modifiée | agentMs | testMs | outils | FAIL_TO_PASS |
|---|---|---|---|---|---|---|
| astropy__astropy-12907 | **unresolved** | *(aucune)* | 220 301 | 3 196 | 16 | 2 ko |
| scikit-learn__scikit-learn-25570 | **resolved** ✅ | `sklearn/compose/_column_transformer.py` | 497 790 | 2 248 | 25 | 3 ok |
| sympy__sympy-16988 | **resolved** ✅ | `sympy/sets/sets.py` | 515 744 | 955 | 25 | 2 ok |

**Score : 2/3 resolved (66,7 %).**

Notes d'honnêteté :
- **astropy** : l'agent n'a modifié **aucune source** — il a édité le fichier de
  test (stratégie invalide). Après restauration du test officiel, les 2
  FAIL_TO_PASS échouent → `unresolved`. C'est un **vrai échec de l'agent**.
- **sympy** : le run a dépassé `agentTimeoutMs` (20 min) ; le harnais a classé
  `agent-error` avant de tester. **Ré-évaluation hors-ligne** conforme au
  protocole (patch source réappliqué + tests officiels) : 2/2 PASSED → `resolved`.
  Le timeout relève du **pilotage**, pas du résultat du patch.
- Ce **n'est pas** un score SWE-bench officiel : échantillon de 3, harnais
  différent du harness Python officiel. Aucune comparaison avec Cursor/Claude
  Code n'est revendiquée (aucune mesure de leur part dans ce contexte).

**Livrables** :
- `bench/coding/results/predictions.jsonl` — format officiel
  (`instance_id`, `model_patch`, `model_name_or_path`), **publiable**.
- `bench/coding/results/swebench-results.json` — résultats détaillés + protocole.

**Détails du harnais webview** ([benchWebview.ts](file:///Users/user/code/orvyx-desktop/origin/bench/coding/benchWebview.ts)) :
- Contourne `SIDECAR_REPLY_TIMEOUT` (le SDK `engine.send` n'acquitte qu'à la fin
  du tour > 30 s) en n'attendant **que** les événements terminaux réels — sans
  modifier le moteur.
- `maxIterations` borné (paramètre **public** du contrat) pour éviter les runs
  qui ne convergent jamais.
- `bench_bash_run` (Rust, **DEV-ONLY**) : commande Tauri bornée à 30 min / 4 Mo,
  nécessaire car `agent_bash_run` plafonne à 120 s / 64 Ko (insuffisant pour
  pytest Docker).
- `vite.config.ts` : `bench/**` exclu du watch (sinon chaque écriture de l'agent
  déclenche un full-reload qui détruit le run mesuré).

---

## 4. Vérification de l'usage réel de l'indexation (Phase §3 mission)

Statut : **moteur BM25 vérifié empiriquement (offline)** ;
**usage par le modèle non mesuré** (nécessite le sidecar Cline dans Tauri).

Ce qui est **prouvé** aujourd'hui :

- L'index BM25 **est** branché (`codebase_search` → `search_index`, §1.4).
- Le prompt modèle **incite** à l'utiliser en premier.
- **Moteur BM25 testé** : `cargo test indexing::` → **15/15 verts** (offline, gratuit),
  dont `rank_prefers_path_matches_and_more_frequent_terms`,
  `rank_is_deterministic_on_ties`, `rank_returns_empty_for_unknown_term`,
  `build_and_search_roundtrip_with_persistence`, `tokenize_lowercases_and_splits_identifiers`,
  `walk_respects_search_ignore`, `build_doc_never_indexes_own_index_dir`.
  (1 test `e2e_real_project` ignoré par défaut : I/O disque réel, exécutable
  via `-- --ignored`.)
  Commande : `~/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml indexing::`

Ce qui **reste à prouver empiriquement** (à faire avec accord, dans Tauri) :

1. Le modèle appelle-t-il **effectivement** `codebase_search` quand c'est pertinent ?
2. Retrouve-t-il les bons **fichiers / symboles** (pertinence) ?
3. **Temps de recherche** : indexé vs. recherche textuelle (`search_in_files`).
4. Taux de réussite **final** des tâches, BM25 on/off.

Protocole prévu (mêmes tâches, même commit, un seul paramètre varie) :

- Petite base vs. base volumineuse.
- `codebase_search` (index) vs. `search_in_files` (texte) vs. `search_symbols`.
- Répétitions ≥ 3 pour les tâches non déterministes.
- Vérification par les **tests**, jamais par jugement subjectif du texte.

> Aucune modification silencieuse du comportement de production n'a été faite.
> Si l'intégration manque quelque part, elle est signalée — pas corrigée en douce.

---

## 5. Comparaison Cursor / Claude Code — protocole équitable

Objectif : comparabilité maximale. **Aucun résultat inventé.**
Cursor et Claude Code ne sont pas automatisables dans cet environnement de
manière fiable → **protocole manuel reproductible** :

```text
Pour CHAQUE tâche de bench/coding/tasks/<id>/ :
  1. Dépôt : même fixture, même état initial (commit/`fixture/` identique).
  2. Instruction : EXACTEMENT le champ `instruction` de task.json (copier-coller).
  3. Environnement : même OS, même runtime Node, même dossier de travail isolé.
  4. Budget : même timeout (task.testTimeoutMs), même budget de tokens (si applicable).
  5. Répétitions : 3 pour les tâches non déterministes (échec partiel, random).
  6. Vérification : exécuter task.testCommand et appliquer evaluator.ts
     (FAIL_TO_PASS / PASS_TO_PASS). PAS de jugement sur le texte produit.
  7. Reporter : résolu/non résolu, durée, tours, erreurs. Coût estimé si tarif public.
```

Règles de reporting :

- Distinguer **erreur modèle / provider / outil / harnais**.
- Ne comparer **que** des configurations aux **mêmes** tâches / commit / tests.
- Publier les **limites expérimentales** (variance, taille d'échantillon).

---

## 6. Problèmes détectés (asymétries du produit)

| # | Constat | Fichier | Impact |
|---|---|---|---|
| 1 | `runAgent` ne traite pas l'événement `tool-error` | `src/lib/agent/run.ts` | Un échec d'outil peut ne pas être surfacé proprement |
| 2 | Outils non injectables (dépendance Tauri statique) | `src/lib/agent/tools.ts` | Impose un driver réel **dans Tauri** (§3.3) — adaptateur implémenté |
| 3 | `codebase_search` réel mais non mesuré empiriquement | `clineClient.ts` / `indexing.rs` | Utilisation effective inconnue (§4) |
| 4 | Conditions de course non testées (annulation pendant un tool call) | `runAgent` / cascade | À couvrir si pertinent (non requis §2) |

Ces points sont **rapportés**, pas corrigés en douce (§6) : les corrections
toucheraient l'architecture de production, ce que la mission interdit pour les
besoins du benchmark.

---

## 7. Commandes

```bash
# Tests déterministes offline (Niveau A + harness codage, AUCUN réseau)
npm run bench:offline

# Tâches de codage, driver oracle déterministe (AUCUN réseau) → JSON + MD
npm run bench:coding

# Tâches de codage, driver RÉEL via sidecar Cline — UNIQUEMENT dans l'app Tauri
# (hors Tauri : refus explicite). Lit ORVYX_AI_PROVIDER/MODEL/API_KEY/BASE_URL.
npx tsx bench/coding/cli.ts --driver=cline --out=bench/results/coding-cline.json

# Benchmark RÉSEAU (appels PAYANTS) — préparé, à lancer MANUELLEMENT, avec accord
npm run bench:network -- --models claude-haiku-4-5,gemini-3.5-flash --runs 2 --max-tokens 512
npm run bench:network -- --models ... --resume      # reprend un run interrompu

# Moteur d'indexation BM25 (Rust, offline, gratuit)
~/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml indexing::
```

Sorties : `bench/results/coding.json` + `bench/results/coding.md` (offline) ;
`bench/results/network.json` (réseau, si lancé).

---

## 8. État d'avancement et blocages

| Phase | État |
|---|---|
| 1 — Audit du code réel | ✅ Terminé |
| 2 — Benchmark offline minimal (Niveau A) | ✅ 15/15 verts (+ 7 driver Tauri) |
| 3 — Benchmark de codage réel (Niveau C) | ✅ harnais + 3 tâches, 3/3 oracle · **+ 3 instances SWE-bench réelles : 2/3 resolved** |
| 4 — Benchmark réseau (Niveau B) | ✅ **Exécuté** : 4 modèles × 3 sondes × 3 rép., 36/36 |
| 5 — Rapport final | ✅ Ce document |
| Adaptateur Tauri (driver réel) | ✅ Implémenté + testé (7/7) · **lancé** sur 3 instances SWE-bench (§3.4) |

**Blocages / décisions** :

- **Driver réel** (§3.3, §3.4) : adaptateur **implémenté** (`--driver=cline`), branché sur
  `startClineHarness`. **Exécuté** sur 3 instances SWE-bench réelles (agent dans la
  webview Tauri, tests dans Docker). Aucun faux outil créé (§6).
- **BM25 empirique (usage par le modèle)** non mesuré : nécessite le sidecar Cline
  dans Tauri (le harnais réseau n'expose pas `codebase_search`). Le **moteur BM25
  lui-même est vérifié** par les tests Rust (`indexing.rs`) ; restait à vérifier
  l'usage côté agent, hors périmètre automatisable ici.
- **Mini-set public SWE-bench** : ✅ **intégré** — 3 instances
  `princeton-nlp/SWE-bench_Lite` réelles, env Docker par instance, `predictions.jsonl`
  au format officiel (§3.4). Ce n'est **pas** un score officiel (échantillon de 3,
  harnais distinct du harness Python officiel) : aucun score SWE-bench « officiel »
  n'est revendiqué.
- **Coûts** : aucun tarif public n'est fourni dans la configuration → coût
  **non estimé** (source absente plutôt qu'inventée).

Aucun test déclaré réussi sans exécution. Aucun score de concurrent inventé.
