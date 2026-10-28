import { sha256 } from "@hey-pisgah/contracts";

// Every draw is a pure function of the case seed and the draw's job key, so cases that share a seed share every draw they have in common.
export type Drawer = {
  seed: string;
  u(key: string): number;
  int(key: string, lo: number, hi: number): number;
  chance(key: string, p: number): boolean;
  pick<T>(key: string, items: readonly T[]): T;
  sample<T>(key: string, items: readonly T[], n: number): T[];
};

export function drawer(seed: string): Drawer {
  const u = (key: string): number => parseInt(sha256(`${seed}|${key}`).slice(0, 13), 16) / 2 ** 52;
  const int = (key: string, lo: number, hi: number): number => lo + Math.floor(u(key) * (hi - lo + 1));
  return {
    seed,
    u,
    int,
    chance: (key, p) => u(key) < p,
    pick: (key, items) => items[int(key, 0, items.length - 1)]!,
    sample: (key, items, n) => [...items].map((x, i) => ({ x, r: u(`${key}#${i}`) })).sort((a, b) => a.r - b.r).slice(0, n).map((e) => e.x)
  };
}
