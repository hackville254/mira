#!/usr/bin/env python3
"""LiveCodeBench — extraction SÛRE des cas de test vers un JSON pur.

POURQUOI CE SCRIPT (et pas un décodage en Node)
----------------------------------------------
Dans le dataset officiel `livecodebench/code_generation_lite`, le champ
`private_test_cases` n'est PAS du JSON direct : il est encodé

    base64( zlib( pickle( <chaîne JSON> ) ) )

Décoder du `pickle` est DANGEREUX : un pickle non fiable peut exécuter du code
arbitraire à la désérialisation. On ne le fait donc JAMAIS dans le processus
Node/agent. Ce script le fait UNE SEULE FOIS, HORS LIGNE, dans un interpréteur
Python jetable, puis n'écrit que du JSON pur (aucun exécutable, aucune donnée
Python). Le harnais Node ne consomme ensuite que ce JSON.

SÉCURITÉ — DÉFENSE EN PROFONDÉE (même si la source est un dataset de confiance) :
  - le pickle est lu via `pickletools.genops` d'abord : on REFUSE tout opcode
    autre que PROTO/FRAME/MEMOIZE/BINUNICODE/SHORT_BINUNICODE/STOP. Un pickle qui
    contient un GLOBAL/REDUCE (donc potentiellement exécutable) est rejeté ;
  - en complément, le venv est isolé et le script ne tourne pas dans l'app.

USAGE
-----
    python3 extract_cases.py --input <test.jsonl> --out <lcb-dataset.json> \
        [--since ISO] [--until ISO] [--platforms LeetCode,AtCoder] [--limit N]

Sortie (payload injectable dans la webview) :
    { "generated_at": ISO,
      "source": "<chemin>",
      "filters": {...},
      "problems": [ { question_id, question_title, question_content, platform,
                      contest_date, difficulty, starter_code, caseCount } ],
      "cases":    { "<question_id>": [ { "input": "...", "output": "..." }, ... ] } }

Le champ `cases` agrège publics + privés (les privés marqués `"hidden": true`).
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import pickle
import pickletools
import zlib
from datetime import datetime, timezone

# Seuls ces opcodes sont acceptés dans le pickle : ils ne peuvent PAS exécuter
# de code (pas de GLOBAL / STACK_GLOBAL / REDUCE / INST / OBJ).
_SAFE_OPCODES = {
    "PROTO", "FRAME", "MEMOIZE", "STOP",
    "BINUNICODE", "SHORT_BINUNICODE", "UNICODE",
    "EMPTY_TUPLE", "MARK", "TUPLE", "TUPLE1", "TUPLE2", "TUPLE3",
    "BININT", "BININT1", "BININT2", "BINFLOAT", "NONE", "NEWTRUE", "NEWFALSE",
    "BINUNICODE8", "SHORT_BINSTRING", "BINSTRING",
}


def _decode_private(raw: str) -> list[dict]:
    """Décode `private_test_cases` : base64 → zlib → pickle(JSON str).

    Refuse tout pickle contenant un opcode non sûr (défense contre l'exécution de
    code au moment de la désérialisation). Retourne la liste des cas.
    """
    if not raw:
        return []
    blob = base64.b64decode(raw)
    decompressed = zlib.decompress(blob)  # en-tête zlib standard (0x789c)
    # 1) Audit des opcodes AVANT tout unpickle : on n'exécute rien.
    for op, _arg, _pos in pickletools.genops(decompressed):
        if op.name not in _SAFE_OPCODES:
            raise ValueError(f"pickle refusé : opcode non sûr {op.name!r}")
    # 2) Unpickle (sûr : uniquement des littéraux chaîne ci-dessus).
    payload = pickle.loads(decompressed)
    if isinstance(payload, str):
        payload = json.loads(payload)
    if not isinstance(payload, list):
        raise ValueError("cas privés : charge utile inattendue")
    return payload


def _decode_public(raw: str) -> list[dict]:
    """`public_test_cases` est du JSON direct dans le dataset actuel."""
    if not raw:
        return []
    try:
        out = json.loads(raw)
        return out if isinstance(out, list) else []
    except json.JSONDecodeError:
        # Tolérance : certaines versions pourraient aussi l'encoder.
        return _decode_private(raw)


def _norm_cases(cases: list[dict], hidden: bool) -> list[dict]:
    out = []
    for c in cases:
        if not isinstance(c, dict) or "input" not in c or "output" not in c:
            continue
        inp = c["input"] if isinstance(c["input"], str) else json.dumps(c["input"])
        outp = c["output"] if isinstance(c["output"], str) else json.dumps(c["output"])
        case = {"input": inp, "output": outp}
        if hidden:
            case["hidden"] = True
        out.append(case)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="Extraction sûre des cas LiveCodeBench")
    ap.add_argument("--input", required=True, help="chemin vers test.jsonl")
    ap.add_argument("--out", required=True, help="chemin du JSON de sortie")
    ap.add_argument("--since", default=None, help="borne basse contest_date (ISO)")
    ap.add_argument("--until", default=None, help="borne haute contest_date (ISO)")
    ap.add_argument("--platforms", default=None, help="liste séparée par virgules")
    ap.add_argument("--limit", type=int, default=None, help="nombre max de problèmes")
    args = ap.parse_args()

    platforms = [p.strip() for p in args.platforms.split(",")] if args.platforms else None

    problems: list[dict] = []
    cases_by_id: dict[str, list[dict]] = {}
    skipped_no_cases = 0
    skipped_date = 0
    skipped_platform = 0
    decode_errors = 0

    with open(args.input, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            qid = row.get("question_id")
            if not qid:
                continue
            date = row.get("contest_date") or ""
            if args.since and date and date < args.since:
                skipped_date += 1
                continue
            if args.until and date and date > args.until:
                skipped_date += 1
                continue
            platform = row.get("platform") or "unknown"
            if platforms and platform not in platforms:
                skipped_platform += 1
                continue
            try:
                pub = _norm_cases(_decode_public(row.get("public_test_cases", "")), False)
                priv = _norm_cases(_decode_private(row.get("private_test_cases", "")), True)
            except Exception as e:  # noqa: BLE001 — on exclut le problème, jamais de crash
                decode_errors += 1
                print(f"[warn] {qid} : décodage ignoré ({e})")
                continue
            cases = pub + priv
            if not cases:
                skipped_no_cases += 1
                continue
            problems.append({
                "question_id": qid,
                "question_title": row.get("question_title") or "",
                "question_content": row.get("question_content") or "",
                "platform": platform,
                "contest_id": row.get("contest_id") or "",
                "contest_date": date,
                "difficulty": row.get("difficulty") or "unknown",
                "starter_code": row.get("starter_code") or "",
                "caseCount": len(cases),
            })
            cases_by_id[qid] = cases
            if args.limit and len(problems) >= args.limit:
                break

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": args.input,
        "filters": {
            "since": args.since, "until": args.until,
            "platforms": platforms, "limit": args.limit,
        },
        "stats": {
            "kept": len(problems),
            "skipped_no_cases": skipped_no_cases,
            "skipped_date": skipped_date,
            "skipped_platform": skipped_platform,
            "decode_errors": decode_errors,
            "total_cases": sum(len(v) for v in cases_by_id.values()),
        },
        "problems": problems,
        "cases": cases_by_id,
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)

    s = payload["stats"]
    print(f"OK -> {args.out}")
    print(f"   problèmes={s['kept']} cas={s['total_cases']} "
          f"exclus(sans cas)={s['skipped_no_cases']} exclus(date)={s['skipped_date']} "
          f"exclus(platform)={s['skipped_platform']} erreurs={s['decode_errors']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
