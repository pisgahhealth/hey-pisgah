import { sha256 } from "@hey-pisgah/contracts";

// A keyed draw: each value is sha256 over the seed and a key, so a draw never depends on how many came before.
export function unit(seed: string, key: string): number {
  return Number.parseInt(sha256(`${seed}|${key}`).slice(0, 13), 16) / 2 ** 52;
}

// A deterministic shuffle: items sorted by their keyed draw, ties broken by the item's own key.
export function keyedOrder<T>(seed: string, items: readonly T[], keyOf: (x: T) => string): T[] {
  return [...items].map((x) => ({ x, k: keyOf(x), u: unit(seed, keyOf(x)) })).sort((a, b) => a.u - b.u || (a.k < b.k ? -1 : 1)).map((y) => y.x);
}

// A seeded stream of draws for generators that need many values in sequence.
export function stream(seed: string): { next(): number; int(lo: number, hi: number): number; pick<T>(xs: readonly T[]): T } {
  let i = 0;
  const next = () => unit(seed, String(i++));
  return { next, int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)), pick: (xs) => xs[Math.floor(next() * xs.length)]! };
}
