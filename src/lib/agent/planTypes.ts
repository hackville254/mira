export interface PlanStep {
  file: string;
  action: "edit" | "create" | "delete";
  description: string;
}

export interface ParsedPlan {
  title: string;
  steps: PlanStep[];
  rawXml: string;
}

export function parsePlan(content: string): ParsedPlan | null {
  const match = content.match(/<origin-plan>([\s\S]*?)<\/origin-plan>/);
  if (!match) return null;
  const inner = match[1];
  const titleMatch = inner.match(/<title>([\s\S]*?)<\/title>/);
  // Les attributs `file` et `action` peuvent apparaître dans n'importe quel ordre
  // (le modèle ne garantit pas l'ordre). On les capture indépendamment puis on
  // exige leur présence. Deux points durs :
  //  1. `[^>]*` doit refuser un `/` final pour ne pas confondre `<step …/>`
  //     (self-closing) avec un `<step …>` ouvrant.
  //  2. le corps `[\s\S]*?` doit refuser un `<step` imbriqué, sinon un step
  //     non fermé « avale » le suivant et on perd ce dernier.
  const stepMatches = [...inner.matchAll(/<step\b((?:[^>/]|\/(?!>))*?)(?<!\/)\s*>((?:(?!<step\b)[\s\S])*?)<\/step>/g)];
  const steps = stepMatches
    .map(m => {
      const attrs = m[1];
      const file = attrs.match(/\bfile="([^"]+)"/)?.[1]?.trim();
      const action = attrs.match(/\baction="([^"]+)"/)?.[1]?.trim();
      if (!file || !action) return null;
      return {
        file,
        action: action as "edit" | "create" | "delete",
        description: m[2].trim(),
      };
    })
    .filter((s): s is PlanStep => s !== null);
  if (steps.length === 0) return null;
  return {
    title: titleMatch?.[1]?.trim() ?? "Proposed changes",
    steps,
    rawXml: match[0],
  };
}
