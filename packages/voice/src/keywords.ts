export const MAX_KEYWORDS = 100;
// Both endpoints refuse a keyword over 30 characters; the 28 Oct seven-word 400 was this limit, since a 13-character seven-word keyword is accepted (measured 30 Oct 2026).
export const MAX_KEYWORD_LENGTH = 30;
export const MAX_KEYWORD_WORDS = 6;

export type Vocabulary = { wards: readonly string[]; documents: readonly string[]; staff: readonly string[]; beds: readonly string[]; vitals?: readonly string[] };

// Builds the recognition hints in a fixed order with vitals words first, trimmed, deduplicated without case and capped.
export function buildKeywords(v: Vocabulary, max: number = MAX_KEYWORDS): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...(v.vitals ?? []), ...v.wards, ...v.documents, ...v.staff, ...v.beds]) {
    const term = raw.replace(/\s+/g, " ").trim();
    if (!term || term.length > MAX_KEYWORD_LENGTH || term.split(" ").length > MAX_KEYWORD_WORDS || /[\u0000-\u001f\u007f]/.test(term)) continue;
    const k = term.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(term);
    if (out.length >= max) break;
  }
  return out;
}
