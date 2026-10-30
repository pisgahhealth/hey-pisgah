import { describe, expect, it } from "vitest";
import { DoorPacer } from "../src/port.js";

// A clock the test moves by hand, and a sleep that moves it.
function clock() { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms; } }; }

describe("the door budget kept by the port", () => {
  it("lets every write go, keeps a reserve for writes that reads cannot take, and refills at the door's rate", async () => {
    const c = clock();
    const p = new DoorPacer({ capacity: 20, perSecond: 1, writeReserve: 5, readWaitMs: 3000 }, c.now);
    let reads = 0;
    for (let i = 0; i < 30; i++) if (await p.read(c.sleep)) reads += 1; else break;
    // 15 reads go at once, then each read waits a second for its token until the wait runs out.
    expect(reads).toBeGreaterThanOrEqual(15);
    for (let i = 0; i < 10; i++) p.write();
    // With the reserve spent by writes, a read waits its whole budget and gives up rather than taking a write's token.
    const t0 = c.now();
    expect(await p.read(c.sleep)).toBe(false);
    expect(c.now() - t0).toBeGreaterThanOrEqual(3000);
  });
  it("gives a read a token once the bucket refills above the reserve", async () => {
    const c = clock();
    const p = new DoorPacer({ capacity: 10, perSecond: 2, writeReserve: 5, readWaitMs: 10_000 }, c.now);
    for (let i = 0; i < 10; i++) p.write();
    expect(await p.read(c.sleep)).toBe(true);
    expect(c.now()).toBeGreaterThanOrEqual(3000);
  });
});
