# Mini-set SWE-bench réel — données, protocole et honnêteté

> **But** : mesurer l'agent ORVYX sur de **vraies** instances SWE-bench
> (issues GitHub réelles, commits réels, tests réels), et pouvoir **publier**
> les résultats sous forme d'un `predictions.jsonl` compatible avec le harness
> officiel.

## 1. Source des données (jamais inventées)

- Dataset : **`princeton-nlp/SWE-bench_Lite`** (split `test`, 300 instances).
  - Page : https://huggingface.co/datasets/princeton-nlp/SWE-bench_Lite
  - Fichier brut versionné ici : `swe-bench-lite-test.parquet` (1,1 Mo).
- Champs utilisés (tels quels, sans réécriture) :
  `instance_id`, `repo`, `base_commit`, `patch` (oracle), `test_patch`,
  `problem_statement`, `FAIL_TO_PASS`, `PASS_TO_PASS`, `environment_setup_commit`.
- Le mini-set sélectionné est extrait dans `instances/*.json` (un fichier par
  instance) : **reproductible** et **versionnable**.

## 2. Ce qui est repris du protocole SWE-bench, et ce qui ne l'est pas

| Élément | Protocole officiel | Ici |
|---|---|---|
| Dépôt + commit réel | ✅ | ✅ (`base_commit`) |
| `test_patch` appliqué | ✅ | ✅ |
| FAIL_TO_PASS / PASS_TO_PASS | ✅ | ✅ (noms de tests réels) |
| Exécution des tests | image Docker **par instance** (`linux/amd64`) | ✅ **idem** |
| Notation | harness officiel | notre runner, mêmes critères |
| `predictions.jsonl` | ✅ | ✅ produit, **publiable** |

**Conséquence honnête** : un score produit ici n'est **pas** un score
« SWE-bench Verified officiel ». Il est comparable **entre modèles** sur le
**même** mini-set, au **même** commit, avec les **mêmes** tests. Toute
publication doit préciser la taille de l'échantillon et l'environnement.

## 3. Environnement : Docker par instance (comme l'officiel)

Chaque instance construit **sa propre image** `orvyx-swebench:<instance_id>`
(`linux/amd64`, `python:3.9-bullseye`), à l'image du harness officiel. Le
dépôt est monté sur `/testbed` et les tests tournent **dans le conteneur**.

Détails empiriques encodés dans `prepare.ts` (chacun adossé à une erreur réelle
rencontrée, jamais deviné) :

- **Debian 11 (bullseye) est EOL** → `sources.list` repointé vers
  `archive.debian.org` + `Acquire::Check-Valid-Until "false"` (sinon apt renvoie
  des 404 et le build échoue).
- **gcc 12 (bookworm) transforme `-Wincompatible-pointer-types` en erreur**, ce
  qui casse astropy 4.3 → on reste sur bullseye (gcc 10) et on ajoute
  `CFLAGS=-Wno-error -Wno-incompatible-pointer-types -Wno-implicit-function-declaration`.
- **Dépendances par repo** (`REPO_SPECS`) : versions de build officielles
  (ex. astropy : `cython==0.29.22`, `pyerfa`, `extension-helpers`,
  `hypothesis` ; sklearn : `pandas`, `cython` ; sympy : `mpmath`).
- **Version de pytest hétérogène** : sympy 1.5 ne fonctionne qu'avec
  `pytest==5.4.3` + `py==1.11.0` (→ pas de `--no-header`, apparu plus tard).
- **Installation du dépôt** : `pip install --no-build-isolation -e .` (éditable)
  pour que l'agent, qui écrit sur l'hôte, modifie bien le code exécuté.

## 4. Deux pièges d'analyse (corrigés, prouvés)

1. **Codes ANSI** : pytest colore son résumé (`\x1b[32mPASSED\x1b[0m`), ce qui
   casse toute regex ancrée `^PASSED`. Correctif : `--color=no` +
   `FORCE_COLOR=0`/`NO_COLOR=1` **et** nettoyage ANSI défensif dans
   `parsePytestOutcome`. Sans cela, deux instances étaient faussement déclarées
   « environnement suspect ».
2. **Noms de tests « nus »** : certaines instances (sympy 1.5) donnent
   `test_imageset` sans fichier. pytest ne peut pas les résoudre depuis la racine
   (« no tests ran »). Correctif : `pytestArgsFor` localise le fichier via
   `git grep -l -E '^def <nom>\('` puis qualifie `fichier::nom`.

## 5. Étapes

1. **Extraire** les instances choisies (depuis l'API datasets-server ou le Parquet)
   → `instances/<instance_id>.json`.
2. **Préparer** (`prepare.ts`, `--prepare-only`) : clone du dépôt au
   `base_commit`, build de l'image Docker, `test_patch`, installation éditable,
   puis **vérification** que FAIL_TO_PASS échoue bien **avant** l'agent.
3. **Vérifier l'oracle** (`--verify`) : appliquer le `patch` de référence et
   confirmer que les FAIL_TO_PASS **passent**. C'est le contrôle de validité du
   banc d'essai (si l'oracle échoue, l'env est en cause, jamais le modèle).
4. **Exécuter** l'agent dans le dépôt préparé (driver réel via la webview Tauri ;
   les outils de production passent par `invoke`).
5. **Évaluer** : relancer les tests **dans Docker**, appliquer FAIL_TO_PASS /
   PASS_TO_PASS.
6. **Publier** : écrire `predictions.jsonl` (`instance_id`, `model_patch`,
   `model_name_or_path`) — format accepté par le harness officiel.

## 6. Commandes

```bash
# Préparer + vérifier l'oracle du mini-set (aucun appel modèle)
npx tsx bench/coding/swebench/cli.ts --prepare-only
npx tsx bench/coding/swebench/cli.ts --verify \
  --instances=astropy__astropy-12907,sympy__sympy-16988,scikit-learn__scikit-learn-25570

# Matérialiser le squelette publiable
npx tsx bench/coding/swebench/cli.ts --predictions-only
```

## 7. Limites assumées

- **Émulation `linux/amd64`** sur Apple Silicon : les tests sont plus lents que
  sur un runner x86 natif. Aucun impact sur la validité, mais les durées ne
  doivent pas être comparées telles quelles à un run x86.
- Certaines instances échouent à s'installer (dépendances obsolètes) : elles sont
  **exclues explicitement**, jamais comptées comme « résolues ».
