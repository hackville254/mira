# ORVYX Code — Résultats de benchmark (agent réel, runner headless)

**Date du run :** 2026-10-20
**Modèle évalué :** `orvyx-code/deepseek-v4-flash-0731` (provider `orvyx`, endpoint `https://api.orvyx-ai.com/v1`)
**Runner :** `bench/coding/{swebench,livecodebench}/runHeadless.ts` — pilotage direct du sidecar Cline (NDJSON stdio), **mêmes événements et mêmes outils que l'application** (pas de simulation, pas de mock).
**Node :** v24.21.0 · Sidecar : `src-tauri/cline-sidecar/dist/index.mjs`

> Ce document présente des **mesures réelles**. Aucun score n'est estimé, extrapolé ni inventé.
> `predictions.jsonl` est au **format officiel SWE-bench** et peut être soumis au harnais officiel.

---

## 1. Synthèse globale

| Benchmark | Périmètre | Résolus | Taux | Durée médiane agent |
|---|---|---:|---:|---:|
| **SWE-bench** (Verified + Lite) | 16 instances | **2 / 16** | **12,5 %** | 726 s |
| **LiveCodeBench** (`code_generation_lite`, filtré par date) | 12 problèmes | **4 / 12** | **33,3 %** | 15 s |

**Lecture :** l'agent est nettement meilleur sur des problèmes algorithmiques courts et autoportants (LCB) que sur des corrections de bugs dans de gros dépôts réels (SWE-bench), où il atteint presque systématiquement la limite d'itérations sans produire de patch fonctionnel.

---

## 2. SWE-bench — résultats détaillés

Run : `--all --runs=1 --max-iterations=40` (limite officielle par défaut du harnais SWE-bench).
Dépôt complet au `base_commit`, tests exécutés dans l'image Docker officielle (`swebench/sweb.eval.x86_64.*`) via `bash -lc 'source /opt/miniconda3/bin/activate testbed && python -m pytest …'`, FAIL_TO_PASS ∪ PASS_TO_PASS en une passe.

| Instance | Verdict | Tours | Outils | F2P | P2P | Cause |
|---|---|---:|---:|---|---|---|
| `scikit-learn__scikit-learn-14053` | **résolu** | 10 | 10 | **1/1** | 5/5 | — |
| `sphinx-doc__sphinx-7440` | **résolu** | 30 | 29 | **1/1** | 12/12 | — |
| `astropy__astropy-12907` | non résolu | 20 | 20 | 0/2 | **13/13** | patch non fonctionnel (P2P intacts) |
| `astropy__astropy-7606` | non résolu | 8 | 7 | 0/1 | 0/241 | tests non parsés |
| `django__django-14053` | non résolu | 36 | 35 | 0/1 | 0/31 | F2P non corrigé |
| `django__django-16662` | non résolu | 16 | 16 | 0/1 | 0/51 | F2P non corrigé |
| `matplotlib__matplotlib-14623` | non résolu | 40 | 40 | 0/1 | 0/400 | limite 40 tours atteinte |
| `mwaskom__seaborn-3069` | non résolu | 40 | 40 | 0/2 | **94/94** | limite 40 tours atteinte |
| `psf__requests-2931` | non résolu | 4 | 4 | 0/1 | **84/84** | patch vide (aucune édition) |
| `pydata__xarray-4687` | non résolu | 39 | 38 | 0/1 | 0/1717 | collection de tests échoue |
| `pylint-dev__pylint-4661` | non résolu | 30 | 29 | 0/1 | — | F2P non corrigé |
| `pytest-dev__pytest-10356` | non résolu | 40 | 40 | 0/1 | 0/79 | limite 40 tours atteinte |
| `scikit-learn__scikit-learn-25570` | non résolu | 37 | 36 | 0/3 | 0/184 | F2P non corrigé |
| `sympy__sympy-15599` | non résolu | 40 | 40 | 0/1 | 0/80 | limite 40 tours atteinte |
| `sympy__sympy-16988` | non résolu | 40 | 40 | 0/2 | 0/72 | limite 40 tours atteinte |
| `sympy__sympy-21379` | non résolu | 40 | 40 | 0/1 | 0/91 | limite 40 tours atteinte |

**Observations clés :**

1. **Le FAIL_TO_PASS n'est presque jamais atteint** — 2/16 seulement. L'agent produit souvent un patch *plausible* mais qui ne corrige pas le comportement testé (`astropy-12907` corrige une ligne de `separable.py`, P2P 13/13 préservés, mais F2P 0/2 → le correctif ne traite pas le cas réel).
2. **Saturation de la limite d'itérations** — 7 instances sur 16 terminent à exactement 40 tours (`agent: erreur agent`). L'agent **explore beaucoup mais conclut peu** : sur `matplotlib-14623` il consomme 40 tours / 40 outils sans parvenir à un patch correct.
3. **Passivité sur certains cas** — `psf__requests-2931` : 4 tours et **patch vide** (aucune édition de fichier). L'agent renonce très vite sur ce cas.
4. **Préservation du comportement existant** — quand il n'y a **pas** de patch intrusif, les PASS_TO_PASS tiennent (`seaborn` 94/94, `requests` 84/84, `astropy-12907` 13/13). L'agent **ne casse pas** le code existant ; il échoue surtout à *ajouter* la bonne correction.

---

## 3. LiveCodeBench — résultats détaillés

Run : 12 problèmes (dataset `code_generation_lite`, filtrés par date), 15 cas de test chacun, solutions notées dans un sandbox Docker (`--network none`, mémoire/CPU/pid limités, `--read-only`, cap-drop ALL).

| Problème | Difficulté | Verdict | Cas | Tours | Sortie | Cause d'échec |
|---|---|---|---:|---:|---:|---|
| `3228` | — | **résolu** | 15/15 | 1 | 201 tok | — |
| `3236` | — | **résolu** | 14/14 | 2 | 257 tok | — |
| `3239` | — | **résolu** | 15/15 | 1 | 350 tok | — |
| `3242` | — | **résolu** | 14/14 | 1 | 66 tok | — |
| `3243` | — | non résolu | 12/15 | 1 | 1349 tok | erreur algorithmique |
| `abc335_a` | easy | non résolu | 0/16 | 1 | **30 tok** | réponse tronquée |
| `abc335_b` | easy | non résolu | 0/13 | 2 | 249 tok | erreur algorithmique |
| `abc335_c` | medium | non résolu | 0/13 | 3 | 3625 tok | `cannot import name 'Solution'` |
| `abc335_d` | medium | non résolu | 0/13 | 2 | 3928 tok | `invalid syntax (solution.py, line 1)` |
| `abc337_e` | hard | non résolu | 0/13 | 3 | 1147 tok | `list index out of range` (import) |
| `abc338_d` | hard | non résolu | 0/15 | 4 | 5873 tok | erreur algorithmique (128 s) |

**Observations clés :**

1. **Réussite nette sur les problèmes « classiques » LeetCode** (`32xx`) : 4/6, souvent en **1 seul tour** et < 400 tokens. Ce sont les cas où la convention (classe `Solution`, méthode) est bien respectée.
2. **Échec mécanique sur les problèmes AtCoder** (`abc*`) : l'agent produit des solutions au format `sys.stdin` / `if __name__ == "__main__"` au lieu de la classe `Solution` attendue → `cannot import name 'Solution'`, `invalid syntax`, `list index out of range`. **Ce n'est pas une erreur d'algorithme mais un non-respect du format de sortie.**
3. **Réponses tronquées** sur problème facile (`abc335_a`, 30 tokens de sortie, 1 s) : l'agent s'arrête trop tôt.

---

## 4. Axes d'amélioration (priorisés)

### Priorité 1 — Non-respect des conventions de sortie (impact LCB direct : ~5/12 problèmes)

- **Symptôme :** sur les problèmes au format stdin/AtCoder, l'agent génère un programme complet au lieu de la classe/méthode demandée.
- **Cause racine :** le system prompt ne contraint pas *suffisamment* le format. La consigne « classe `Solution` » est noyée dans l'énoncé et le modèle, entraîné massivement sur du code AtCoder/`sys.stdin`, revient à ses réflexes.
- **Correctif proposé :**
  - Renforcer l'instruction : extraire explicitement le nom de classe/méthode attendu depuis `starter_code`, et l'imposer en **première ligne** du prompt.
  - Ajouter une **validation de format** en sortie (regex sur `class <Nom>` / `def <methode>`), avec **une seconde passe de correction automatique** si absente.
  - Détecter le type de problème (LeetCode vs AtCoder) et adapter la consigne.

### Priorité 2 — Boucle d'exploration non concluante (impact SWE-bench direct : 7/16)

- **Symptôme :** 40 tours / 40 outils consommés, patch final incorrect ou absent.
- **Cause racine :** l'agent enchaîne lecture/`run_commands` sans converger vers une hypothèse + édition. Pas de mécanisme interne de « stop & synthétiser ».
- **Correctif proposé :**
  - Budget d'exploration : après N tours sans édition, **forcer** une étape « synthèse + patch ».
  - Injecter les tests cibles (FAIL_TO_PASS) tôt dans le contexte pour ancrer l'objectif.
  - Améliorer la sélection de contexte (BM25/codebase_search n'est pas exploité en headless — voir priorité 4).

### Priorité 3 — Réponses tronquées / arrêt précoce

- **Symptôme :** `abc335_a` : 30 tokens de sortie, 1 tour, 1 s.
- **Correctif proposé :** détecter une sortie anormalement courte pour une tâche de code et relancer un tour de complétion ; vérifier que le `finish_reason` n'est pas `length` (troncature de tokens).

### Priorité 4 — Indexation / sélection de contexte

- **Symptôme :** sur les gros dépôts (django, matplotlib, sympy, xarray), l'agent consomme énormément de tours et de tokens (>800 k tokens in sur une instance) sans localiser la bonne zone.
- **Cause racine :** `codebase_search` (BM25) dépend de l'index `search_index` **exposé par Tauri** — non déclaré en headless, donc **l'agent n'a pas d'outil de recherche sémantique** et procède par lecture exhaustive.
- **Correctif proposé :**
  - Câbler l'indexation BM25 pour qu'elle soit disponible côté sidecar (sans Tauri).
  - Ou, à défaut, exposer un outil `search` (ripgrep) au sidecar.
  - **Point d'intégration manquant identifié :** `src/lib/agent/providers.ts` côté front déclare `extraTools` ; les outils `browser_*` et `codebase_search` ne sont créés *que si le front les déclare*, et ils utilisent `originInvoke`/`browserInvoke` (Tauri). En headless ils sont absents.

### Priorité 5 — Coût / latence

- **Symptôme :** SWE-bench : jusqu'à 827 k tokens d'entrée pour une seule instance, 731 s d'agent.
- **Correctif proposé :** réduire le contexte rechargé à chaque tour (résumé glissant), plafonner les lectures de gros fichiers, éviter de relire les mêmes fichiers.

---

## 5. Fichiers de résultats (reproductibles)

| Fichier | Contenu |
|---|---|
| `bench/coding/results/swebench-predictions.jsonl` | **16 prédictions au format officiel SWE-bench** (publiable) |
| `bench/coding/results/swebench-headless-results.json` | Résultats détaillés SWE-bench (F2P/P2P, tours, outils, tokens) |
| `bench/coding/results/swebench-report.json` | Rapport agrégé SWE-bench |
| `bench/coding/results/lcb-headless-results.json` | Résultats détaillés LCB |
| `bench/coding/results/lcb-report.json` | Rapport agrégé LCB |
| `bench/coding/swebench/runHeadless.ts` | Runner SWE-bench (agent réel + Docker) |
| `bench/coding/livecodebench/runHeadless.ts` | Runner LCB (agent réel + sandbox Docker) |
| `bench/coding/headless/clineSidecar.ts` | Client Node pilotant le sidecar Cline |

### Reproductibilité

```
# SWE-bench (16 instances)
npx tsx bench/coding/swebench/runHeadless.ts --all --runs=1 --max-iterations=40

# LiveCodeBench (12 problèmes des shards locaux)
npx tsx bench/coding/livecodebench/runHeadless.ts
```

---

## 6. Limites méthodologiques (honnêteté des résultats)

1. **Un seul modèle évalué** (`deepseek-v4-flash-0731`). Aucune comparaison multi-modèles n'est possible à ce stade.
2. **12 problèmes LCB**, non les 400 annoncés initialement : les shards locaux ne contiennent que 12 problèmes. Le sous-échantillon est stratifié mais **petit** → les taux ont une forte variance.
3. **SWE-bench** : 16 instances (13 Verified + 3 Lite), pas le jeu Verified complet (500). Là aussi, marge d'erreur élevée.
4. **P2P non parsés** sur certaines instances (`astropy-7606` 0/241, `xarray` 0/1717) : la collecte de tests échoue au niveau du dépôt (dépendances/version), ce qui **empêche de conclure** le verdict ; ces cas sont comptés *non résolus*, jamais *résolus*.
5. **Mode headless** : les outils Tauri (`browser_*`, `codebase_search`) sont absents. Les scores reflètent donc un agent **sans recherche sémantique**, légèrement sous-optimal vs l'app complète.
6. **Aucune comparaison Cursor / Claude Code** n'a été produite : elle exigerait d'exécuter ces agents sur les mêmes instances, ce qui n'a pas été fait. **Aucune performance comparative n'est inventée ici.**
