import { z } from "zod";
import { EmrId } from "./port.js";
import { DRUG_ROUTES, dosesIn, prescriptionSaid, wordSaid } from "./work.js";

// A receiver takes another clinician's spoken order and reads it back; the agent records it by rule, on the receiver's own matched voice, and the hospital's rules decide whether it may be taken at all.
export const VERBAL_ORDER_KIND = "take_verbal_order" as const;
export const VERBAL_LINE = /\b(?:verbal|telephone|phone)\s+order\b/i;
const READ_BACK = /\bread(?:ing)?\s+(?:it\s+|that\s+)?back\b/i;

const Key = z.string().regex(/^[a-z0-9_]{1,40}$/);
export const VERBAL_ORDER_ARGS = z.strictObject({
  visit_id: EmrId, patient_id: EmrId, issuer: Key, order_kind: z.enum(["lab", "prescription"]),
  test: Key.optional(), drug: Key.optional(), dose: z.string().min(1).max(40).optional(),
  frequency: z.number().int().min(1).max(24).optional(), duration_days: z.number().int().min(1).max(90).optional(),
  quantity: z.number().int().min(1).max(1000).optional(), route: z.enum(DRUG_ROUTES).optional()
});
export type VerbalOrderArgs = z.infer<typeof VERBAL_ORDER_ARGS>;

export type VerbalOrderables = {
  tests: Record<string, readonly string[]>;
  drugs: Record<string, { words: readonly string[]; controlled: boolean }>;
  issuers: Record<string, { words: readonly string[]; label: string }>;
};

export type VerbalMissing = "read_back" | "issuer" | "order" | "dose" | "frequency" | "duration" | "quantity";

// What a verbal order line names: exactly one prescriber, exactly one test or medicine, and for a medicine its dose, how often, for how long and how much; anything missing is listed, never guessed.
export function verbalOrderSaid(line: string, o: VerbalOrderables): { args: Omit<VerbalOrderArgs, "visit_id" | "patient_id">; issuer_label: string } | { missing: VerbalMissing[] } | null {
  if (!VERBAL_LINE.test(line)) return null;
  const missing: VerbalMissing[] = [];
  if (!READ_BACK.test(line)) missing.push("read_back");
  const issuers = Object.entries(o.issuers).filter(([, v]) => v.words.some((w) => wordSaid(w, line)));
  if (issuers.length !== 1) missing.push("issuer");
  const tests = Object.entries(o.tests).filter(([, ws]) => ws.some((w) => wordSaid(w, line))).map(([k]) => k);
  const drugs = Object.entries(o.drugs).filter(([, d]) => d.words.some((w) => wordSaid(w, line))).map(([k]) => k);
  if (tests.length + drugs.length !== 1) missing.push("order");
  let rx: Pick<VerbalOrderArgs, "dose" | "frequency" | "duration_days" | "quantity" | "route"> = {};
  if (drugs.length === 1 && !tests.length) {
    const d = dosesIn(line)[0];
    const dose = d ? `${d.n}${d.unit ? ` ${d.unit}` : ""}` : null;
    const said = prescriptionSaid(line, { dose });
    if (!said.dose) missing.push("dose");
    if (!said.frequency) missing.push("frequency");
    if (!said.duration_days) missing.push("duration");
    const quantity = said.quantity ?? (said.frequency && said.duration_days ? said.frequency * said.duration_days : null);
    if (!quantity) missing.push("quantity");
    rx = { ...(said.dose ? { dose: said.dose } : {}), ...(said.frequency ? { frequency: said.frequency } : {}), ...(said.duration_days ? { duration_days: said.duration_days } : {}), ...(quantity ? { quantity } : {}), ...(said.route ? { route: said.route } : {}) };
  }
  if (missing.length) return { missing };
  const [issuer, who] = issuers[0]!;
  return drugs.length
    ? { args: { issuer, order_kind: "prescription", drug: drugs[0]!, ...rx }, issuer_label: who.label }
    : { args: { issuer, order_kind: "lab", test: tests[0]! }, issuer_label: who.label };
}

const MISSING_WORDS: Record<VerbalMissing, string> = {
  read_back: "your read-back", issuer: "which doctor gave it", order: "one test or one medicine", dose: "the dose", frequency: "how often", duration: "for how many days", quantity: "how much",
};
export const verbalMissingNote = (m: readonly VerbalMissing[]) => `To take a verbal order I still need ${m.map((x) => MISSING_WORDS[x]).join(", ")}; nothing was recorded.`;

