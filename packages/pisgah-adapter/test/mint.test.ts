import { describe, expect, it } from "vitest";
import { bearerExpiry, doorMintFrom, mintAgentBearerFromDoor, renewBearers } from "../src/sandbox.js";

const OWNER = "44444444-5555-4666-8777-888888888888";
const OTHER = "55555555-6666-4777-8888-999999999999";
const DOOR = { url: "https://emr.example.test/agent-mint", key: "k".repeat(48) };
const json = (status: number, j: unknown) => new Response(JSON.stringify(j), { status, headers: { "content-type": "application/json" } });
// An unsigned token with only an exp claim, enough for the serve to read when it expires.
const jwt = (expMs: number) => `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000) })).toString("base64url")}.sig`;

function fakeMint(reply: (body: { owner: string }) => Response) {
  const calls: { url: string; auth: string; body: { owner: string } }[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { owner: string };
    calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") ?? "", body });
    return reply(body);
  }) as typeof fetch;
  return { f, calls };
}

describe("the hospital's agent mint", () => {
  it("is configured only with both the mint and the key, and never sends the key over plain http off loopback", () => {
    expect(doorMintFrom({})).toBeNull();
    expect(doorMintFrom({ HEY_PISGAH_MINT_URL: DOOR.url })).toBeNull();
    expect(doorMintFrom({ HEY_PISGAH_MINT_URL: DOOR.url, HEY_PISGAH_SERVE_KEY: DOOR.key })).toEqual(DOOR);
    expect(doorMintFrom({ HEY_PISGAH_MINT_URL: "http://127.0.0.1:3000/m", HEY_PISGAH_SERVE_KEY: DOOR.key })).not.toBeNull();
    expect(() => doorMintFrom({ HEY_PISGAH_MINT_URL: "http://emr.example.test/m", HEY_PISGAH_SERVE_KEY: DOOR.key })).toThrow(/https/);
  });

  it("asks for one owner with the hospital key and keeps the bearer only when it names that owner", async () => {
    const exp = Date.now() + 12 * 3600_000;
    const { f, calls } = fakeMint((b) => json(200, { bearer: jwt(exp), owner: b.owner, agent: OTHER, expires_at: new Date(exp).toISOString() }));
    const m = await mintAgentBearerFromDoor(DOOR, OWNER, f);
    expect(m).toMatchObject({ owner: OWNER, agent: OTHER });
    expect(calls).toEqual([{ url: DOOR.url, auth: `Bearer ${DOOR.key}`, body: { owner: OWNER } }]);
    const wrong = fakeMint(() => json(200, { bearer: jwt(exp), owner: OTHER, agent: null, expires_at: new Date(exp).toISOString() }));
    await expect(mintAgentBearerFromDoor(DOOR, OWNER, wrong.f)).rejects.toThrow(/another owner/);
  });

  it("gives no bearer for an owner with no live login or from another hospital, and throws on any other refusal", async () => {
    expect(await mintAgentBearerFromDoor(DOOR, OWNER, fakeMint(() => json(409, { error: "no_live_login" })).f)).toBeNull();
    expect(await mintAgentBearerFromDoor(DOOR, OWNER, fakeMint(() => json(404, { error: "not_found" })).f)).toBeNull();
    await expect(mintAgentBearerFromDoor(DOOR, OWNER, fakeMint(() => json(401, { error: "unauthorized" })).f)).rejects.toThrow(/401/);
  });
});

describe("renewal before expiry", () => {
  const now = Date.parse("2026-11-01T09:00:00.000Z");

  it("reads a bearer's exp, and none from an opaque bearer", () => {
    expect(bearerExpiry(jwt(now + 60_000))).toBe(now + 60_000);
    expect(bearerExpiry("opaque-bearer-without-claims")).toBeNull();
  });

  it("mints again a bearer near expiry and a missing one, and leaves a fresh one alone", async () => {
    const bearers: Record<string, string> = { [OWNER]: jwt(now + 10 * 60_000), [OTHER]: jwt(now + 6 * 3600_000) };
    const third = "66666666-7777-4888-8999-aaaaaaaaaaaa";
    const asked: string[] = [];
    const renewed = await renewBearers(bearers, [OWNER, OTHER, third], async (o) => { asked.push(o); return `fresh-${o}`; }, { now });
    expect(asked).toEqual([OWNER, third]);
    expect(renewed).toEqual([OWNER, third]);
    expect(bearers[OWNER]).toBe(`fresh-${OWNER}`);
    expect(bearers[OTHER]).toBe(jwt(now + 6 * 3600_000));
  });

  it("keeps the old bearer when the owner has logged out or the mint fails, so nothing is revived", async () => {
    const old = jwt(now + 60_000);
    const bearers: Record<string, string> = { [OWNER]: old };
    expect(await renewBearers(bearers, [OWNER], async () => null, { now })).toEqual([]);
    expect(await renewBearers(bearers, [OWNER], async () => { throw new Error("down"); }, { now })).toEqual([]);
    expect(bearers[OWNER]).toBe(old);
  });
});
