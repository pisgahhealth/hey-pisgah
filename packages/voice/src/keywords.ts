export const MAX_KEYWORDS = 100;
export const MAX_KEYWORD_LENGTH = 60;

export type Vocabulary = { wards: readonly string[]; documents: readonly string[]; staff: readonly string[]; beds: readonly string[] };

// Builds the recognition hints in a fixed order, trimmed, deduplicated without case and capped.
export function buildKeywords(v: Vocabulary, max: number = MAX_KEYWORDS): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...v.wards, ...v.documents, ...v.staff, ...v.beds]) {
    const term = raw.replace(/\s+/g, " ").trim();
    if (!term || term.length > MAX_KEYWORD_LENGTH || /[\u0000-\u001f\u007f]/.test(term)) continue;
    const k = term.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(term);
    if (out.length >= max) break;
  }
  return out;
}
