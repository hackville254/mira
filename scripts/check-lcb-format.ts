// Vérification manuelle de la correction du format LiveCodeBench.
import { loadPayload, payloadToInstance } from "../bench/coding/livecodebench/instance";
import { runSolution, isResolved } from "../bench/coding/livecodebench/evaluator";
import { detectContract } from "../bench/coding/livecodebench/contract";

async function main(): Promise<void> {
  const payload = await loadPayload("bench/coding/results/lcb-shards/lcb-payload-001.json");
  const p = payload.problems.find(x => x.question_id === "abc335_a")!;
  const inst = payloadToInstance(p, payload.cases["abc335_a"]);
  console.log("contrat:", detectContract(inst), "| cas:", inst.cases.length);

  const good = `import sys\ns = sys.stdin.readline().strip()\nprint(s[:-1] + "4")\n`;
  const r1 = await runSolution(inst, good);
  console.log("BON programme stdin          ->", `${r1.passed}/${r1.total}`, "résolu:", isResolved(r1));

  const bad = `print("hello2024")\n`;
  const r2 = await runSolution(inst, bad);
  console.log("MAUVAIS programme            ->", `${r2.passed}/${r2.total}`, "résolu:", isResolved(r2));

  const wrong = `class Solution:\n    def f(self, s):\n        return s[:-1] + "4"\n`;
  const r3 = await runSolution(inst, wrong);
  console.log("class Solution (faux contrat)->", `${r3.passed}/${r3.total}`, "résolu:", isResolved(r3));

  // Problème interactif réel : doit être EXCLU, pas « échoué ».
  const payload2 = await loadPayload("bench/coding/results/lcb-shards/lcb-payload-002.json");
  const pi = payload2.problems.find(x => x.question_id === "abc337_e");
  if (pi) {
    const ei = payloadToInstance(pi, payload2.cases["abc337_e"]);
    const r4 = await runSolution(ei, "print(1)");
    console.log("abc337_e (interactif)        ->", `exclu=${r4.skipped === true}`, "contrat:", r4.contract);
  }
}

void main().catch(e => {
  console.error("ERREUR:", e);
  process.exit(1);
});
