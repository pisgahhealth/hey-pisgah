const VALUES: Record<string, number> = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90
};
const UNIT = "(?:one|two|three|four|five|six|seven|eight|nine)";
const TEEN = "(?:ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)";
const TENS = "(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)";
const S = "[\\s-]+";
const TWO = `(?:${TENS}(?:${S}${UNIT})?|${TEEN}|${UNIT}|zero)`;
const INT = `(?:${UNIT}${S}hundred(?:${S}(?:and${S})?${TWO})?|${TWO}|\\d+)`;
const DEC = `(?:${S}point(?:${S}(?:${UNIT}|zero|oh|\\d)(?![a-z]))+)`;
const PHRASE = new RegExp(`\\b${INT}${DEC}?(?![a-z\\d])`, "gi");

// Reads one matched spoken number into digits, or null when it holds no number word.
function digitsOf(phrase: string): string | null {
  const parts = phrase.toLowerCase().split(/[\s-]+/);
  let int = 0;
  let i = 0;
  let wordy = false;
  for (; i < parts.length && parts[i] !== "point"; i++) {
    const w = parts[i]!;
    if (/^\d+$/.test(w)) int = Number(w);
    else if (w === "hundred") { int *= 100; wordy = true; }
    else if (w !== "and") { int += VALUES[w] ?? 0; wordy = true; }
  }
  const dec = parts.slice(i + 1).map((w) => (/^\d$/.test(w) ? w : String(VALUES[w] ?? ""))).join("");
  if (dec) wordy = true;
  return wordy ? (dec ? `${int}.${dec}` : String(int)) : null;
}

// Rewrites spoken numbers of ten or more, and spoken decimals, as digits, so "thirty seven point nine" reads 37.9; single small words stay words.
export function spokenDigits(text: string): string {
  return text.replace(PHRASE, (m) => {
    const d = digitsOf(m);
    return d !== null && (Number(d) >= 10 || d.includes(".")) ? d : m;
  });
}

// Cleans one finished transcript: digits for spoken numbers, one copy of a word the recogniser repeated, and one closing full stop.
export function cleanTranscript(raw: string): string {
  const words = spokenDigits(raw.replace(/\s+/g, " ").trim()).split(" ");
  const kept: string[] = [];
  const bare = (w: string) => w.toLowerCase().replace(/[.,;:?!]+$/, "").replace(/[^a-z0-9.]/g, "");
  for (const w of words) {
    const prev = kept.at(-1);
    if (prev !== undefined && bare(w).length > 1 && bare(prev) === bare(w) && !/[.,;:?!]$/.test(prev)) { kept[kept.length - 1] = w; continue; }
    kept.push(w);
  }
  return kept.join(" ").replace(/\.{2,}$/, ".").trim();
}
