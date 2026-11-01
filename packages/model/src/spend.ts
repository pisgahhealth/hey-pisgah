import { openStream, type Stream } from "@hey-pisgah/store";
import { ModelError } from "./errors.js";

// A hospital's caps for one day, from the serve's configuration; null fields are not capped.
// reserveUsd is the least a model call holds; maxOutputTokens bounds the output a call with no limit of its own is reserved for.
export type DayCaps = { hospital: string; usd: number | null; calls: number | null; alertFraction: number; tz: string; reserveUsd: number; maxOutputTokens?: number };
export type SpendKind = "model" | "speech" | "reading";
export type SpendScope = "day_usd" | "day_calls";
export type SpendStatus = { hospital: string; day: string; usd: number; calls: number; speech_ms: number; reserved_usd: number; reserved_calls: number; cap_usd: number | null; cap_calls: number | null; alerted: SpendScope[]; capped: SpendScope[] };
export type Reservation = { settle(actualUsd: number, extra?: { calls?: number; speech_ms?: number }): void; release(): void };

const num = (v: string | undefined): number | null => (v !== undefined && v !== "" && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);
const Z = { recorded_at: 0, occurred_at: 0 };

// Caps are on only when HEY_PISGAH_DAY_USD or HEY_PISGAH_DAY_CALLS is set for this hospital's serve.
export function dayCapsFromEnv(env: NodeJS.ProcessEnv = process.env): DayCaps | null {
  const usd = num(env["HEY_PISGAH_DAY_USD"]);
  const calls = num(env["HEY_PISGAH_DAY_CALLS"]);
  if (usd === null && calls === null) return null;
  return {
    hospital: (env["HEY_PISGAH_HOSPITAL"] ?? "hospital").toLowerCase().replace(/[^a-z0-9_-]+/g, "_").slice(0, 40) || "hospital",
    usd, calls,
    alertFraction: num(env["HEY_PISGAH_SPEND_ALERT"]) ?? 0.8,
    tz: env["HEY_PISGAH_TZ"] ?? "Africa/Lagos",
    reserveUsd: num(env["HEY_PISGAH_CALL_RESERVE_USD"]) ?? 0.001,
    maxOutputTokens: num(env["HEY_PISGAH_RESERVE_OUTPUT_TOKENS"]) ?? 4096
  };
}

// The hospital's calendar day for a moment, as yyyy-mm-dd in its own time zone.
export function spendDay(now: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

// One running total per hospital day on its own stream: reservations before each call so concurrent calls cannot overshoot, charges after, and a note at the alert and at the cap.
export class DaySpend {
  private day = "";
  private stream: Stream | null = null;
  private usd = 0;
  private calls = 0;
  private speechMs = 0;
  private reservedUsd = 0;
  private reservedCalls = 0;
  private readonly alerted = new Set<SpendScope>();
  private readonly capped = new Set<SpendScope>();

  constructor(
    private readonly storeRoot: string,
    readonly caps: DayCaps,
    private readonly now: () => Date = () => new Date(),
    private readonly log: (line: string) => void = (l) => process.stderr.write(`${l}\n`)
  ) {}

  // Opens today's stream and folds what it already holds, so a restart keeps the day's total.
  private roll(): Stream {
    const day = spendDay(this.now(), this.caps.tz);
    if (this.stream && day === this.day) return this.stream;
    this.stream?.close();
    this.day = day;
    this.usd = 0; this.calls = 0; this.speechMs = 0; this.reservedUsd = 0; this.reservedCalls = 0;
    this.alerted.clear(); this.capped.clear();
    this.stream = openStream(this.storeRoot, `spend/${this.caps.hospital}-${day}`, { writer: true });
    for (const e of this.stream.records()) {
      const x = e.payload as Record<string, unknown>;
      if (e.record_type === "spend.charged") { this.usd += Number(x["usd"]) || 0; this.calls += Number(x["calls"]) || 0; this.speechMs += Number(x["speech_ms"]) || 0; }
      if (e.record_type === "spend.alert") this.alerted.add(x["scope"] as SpendScope);
      if (e.record_type === "spend.capped") this.capped.add(x["scope"] as SpendScope);
    }
    return this.stream;
  }

  status(): SpendStatus {
    this.roll();
    return { hospital: this.caps.hospital, day: this.day, usd: this.usd, calls: this.calls, speech_ms: this.speechMs, reserved_usd: this.reservedUsd, reserved_calls: this.reservedCalls, cap_usd: this.caps.usd, cap_calls: this.caps.calls, alerted: [...this.alerted], capped: [...this.capped] };
  }

  private note(type: "spend.alert" | "spend.capped", scope: SpendScope, used: number, cap: number): void {
    const set = type === "spend.alert" ? this.alerted : this.capped;
    if (set.has(scope)) return;
    set.add(scope);
    this.roll().append(type, { scope, used, cap, fraction: type === "spend.alert" ? this.caps.alertFraction : 1, day: this.day, hospital: this.caps.hospital }, Z);
    const what = scope === "day_usd" ? `$${used.toFixed(4)} of $${cap}` : `${used} of ${cap} calls`;
    this.log(type === "spend.alert" ? `spend alert: ${this.caps.hospital} has used ${what} today` : `spend cap reached: ${this.caps.hospital} has used ${what} today; new model calls are refused until tomorrow`);
  }

  private check(): void {
    const { usd, calls, alertFraction } = this.caps;
    if (usd !== null && this.usd >= usd * alertFraction) this.note("spend.alert", "day_usd", this.usd, usd);
    if (calls !== null && this.calls >= calls * alertFraction) this.note("spend.alert", "day_calls", this.calls, calls);
    if (usd !== null && this.usd >= usd) this.note("spend.capped", "day_usd", this.usd, usd);
    if (calls !== null && this.calls >= calls) this.note("spend.capped", "day_calls", this.calls, calls);
  }

  // Holds the estimate against the cap before a call; refused when the day's total, what is in flight and this call would pass a cap.
  reserve(kind: SpendKind, estimateUsd: number, meta: { run_id?: string | null; purpose?: string } = {}): Reservation {
    this.roll();
    const est = Math.max(0, estimateUsd);
    const calls = kind === "model" ? 1 : 0;
    const { usd: capUsd, calls: capCalls } = this.caps;
    const scope: SpendScope | null =
      capUsd !== null && this.usd + this.reservedUsd + est > capUsd ? "day_usd" : capCalls !== null && calls > 0 && this.calls + this.reservedCalls + calls > capCalls ? "day_calls" : null;
    if (scope) {
      const used = scope === "day_usd" ? this.usd : this.calls;
      const cap = (scope === "day_usd" ? capUsd : capCalls)!;
      this.note("spend.capped", scope, used, cap);
      throw new ModelError("budget_exhausted", "the hospital's spending cap for today is reached", { scope, used, cap, in_flight_usd: this.reservedUsd, in_flight_calls: this.reservedCalls, kind });
    }
    this.reservedUsd += est;
    this.reservedCalls += calls;
    let open = true;
    const day = this.day;
    const free = () => { if (!open) return false; open = false; if (this.day === day) { this.reservedUsd = Math.max(0, this.reservedUsd - est); this.reservedCalls = Math.max(0, this.reservedCalls - calls); } return true; };
    return {
      settle: (actualUsd, extra = {}) => { if (free()) this.charge(kind, actualUsd, { calls: extra.calls ?? calls, ...(extra.speech_ms !== undefined ? { speech_ms: extra.speech_ms } : {}), ...meta }); },
      release: () => { free(); }
    };
  }

  // Counts a cost already spent, including ones no client could refuse, and writes the alert or cap note it crosses.
  charge(kind: SpendKind, usd: number, extra: { calls?: number; speech_ms?: number; run_id?: string | null; purpose?: string } = {}): void {
    const s = this.roll();
    const row = { kind, usd: Math.max(0, usd), calls: extra.calls ?? 0, speech_ms: extra.speech_ms ?? 0, run_id: extra.run_id ?? null, purpose: extra.purpose ?? null };
    s.append("spend.charged", row, Z);
    this.usd += row.usd;
    this.calls += row.calls;
    this.speechMs += row.speech_ms;
    this.check();
  }

  close(): void {
    this.stream?.close();
    this.stream = null;
  }
}
