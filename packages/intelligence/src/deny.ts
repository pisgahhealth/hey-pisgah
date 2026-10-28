// The leakage deny list from DESIGN.md; every prompt, tool description and app-written message is scanned with it.
export const DENY_LIST: readonly RegExp[] = [
  /before[\s_-]*sign[\s_-]*off/i, /\bearlier\b/i, /\bin[\s_-]+advance\b/i, /\bparallel\b/i, /\bdraft[\s_-]+first\b/i, /early[\s_-]*summary/i,
  /pre[\s_-]*signoff/i, /prep[\s_-]*in[\s_-]*advance/i, /reasoning[\s_-]+strength/i, /\bbottleneck/i, /\bdelay[\s_-]+cause/i, /\broot[\s_-]+cause/i,
  /\bfix(es|ed|ing)?\b/i, /\bimprovement/i, /\bF(?:[1-9]|1[0-2]|V)\b/
];

export type DenyHit = { label: string; pattern: string; excerpt: string };

// Returns one hit per denied pattern found in each labelled text.
export function denyScan(texts: readonly { label: string; text: string }[]): DenyHit[] {
  const hits: DenyHit[] = [];
  for (const t of texts) {
    for (const re of DENY_LIST) {
      const m = re.exec(t.text);
      if (m) hits.push({ label: t.label, pattern: re.source, excerpt: t.text.slice(Math.max(0, m.index - 30), m.index + 30) });
    }
  }
  return hits;
}
