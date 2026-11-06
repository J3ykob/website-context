/**
 * The customer's quantities read for every matched item, whatever the pick answers (src/offer/search.ts matchItems).
 * empro-1 (2026-11-05/06): "ile za 3 aku 18V 5,5Ah do milwaukee? i wysylka gratis?" at a shop - the matcher, asked for the
 * items and the quantities in one call over the shop's 46 nearest catalogue items, answered {"ids": [8]} (5 of 5 offline
 * runs with the real offer), so the 3 batteries were never priced and the reply said it would not total them. The model
 * is played by a stub giving the answers it gave: the pick names the item and nothing more. A reading that gets no answer
 * is not "no quantity given" (the reply would again refuse to total), and the pick does not wait for the reading.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { matchItems } from "./search.js";
import { priceGiven, customerPriceLine } from "./quantities.js";
import type { OfferItem } from "./store.js";

const item = (name: string, over: Partial<OfferItem> = {}): OfferItem => ({
  id: name, name, category: "Akumulatory", description: "", fields: { kind: "product", price_type: "fixed", availability: "in_stock" }, price_value: 699, price_max: null,
  currency: "PLN", components: [], source: "shop", owner_set: [], url: "", updatedAt: "", ...over,
});
// The shop's list as its matcher saw it (shopProducts: word matches first, then the nearest by meaning).
const battery = item("M18™ HIGH OUTPUT™ akumulator 5.5 Ah", { description: "SKU: 350578. Model: 4932464712, nd" });
const shopPool = [
  item("Skrzynia Walizka Transportowa Milwaukee", { category: "Walizki transportowe", price_value: 289 }),
  item("Obuwie ochronne VM FOOTWEAR MILWAUKEE", { category: "VM FOOTWEAR", price_value: 359 }),
  item("M18™ akumulator 5.0 Ah", { price_value: null, fields: { kind: "product" } }), // no price: no inputs
  item("M18™ HIGH OUTPUT akumulator 3.0 Ah", { price_value: 449 }),
  battery,
  item("M18™ akumulator 4.0 Ah", { price_value: 529 }),
];

type Call = { system: string; user: string };
const calls: Call[] = [];
// The listed items of a prompt: "<id>: <name> (...)".
const listed = (user: string) => [...user.matchAll(/^(\d+): (.+?)(?: \(| \[| - |$)/gm)].map((m) => ({ id: Number(m[1]), name: m[2] }));
const answer = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
const isPick = (c: Call) => c.system.includes('{"ids"');
const reads = () => calls.filter((c) => !isPick(c));
// What a reading of the quantities answers for the battery's id (a test sets its own): by default 3 pieces for "3 aku".
const threePieces = (id: number, user: string): unknown => ({ quantities: user.includes("3 aku") ? [{ id, input: "pieces", value: 3 }] : [] });
let reading: (id: number, user: string) => unknown | Promise<unknown> = threePieces;

beforeAll(() => {
  process.env.OPENROUTER_API_KEY = "test-key";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("fetch", async (url: unknown, init?: { body?: string }) => {
    if (!String(url).startsWith("https://openrouter.ai/")) throw new Error(`network blocked: ${url}`);
    const body = JSON.parse(init?.body || "{}");
    const call = { system: String(body.messages?.[0]?.content || ""), user: String(body.messages?.[1]?.content || "") };
    calls.push(call);
    const wanted = listed(call.user).filter((x) => x.name === battery.name).map((x) => x.id);
    // The pick: the items asked for, by id - the answer deepseek gave for the shop's list, quantities asked or not.
    if (isPick(call)) return answer({ ids: wanted });
    const a = await reading(wanted[0], call.user);
    return a instanceof Response ? a : answer(a);
  });
});
afterEach(() => { reading = threePieces; });
afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.OPENROUTER_API_KEY;
});

describe("the customer's quantities for every matched item (matchItems)", () => {
  it("empro-1: the pick names the battery only - its 3 pieces are still read and priced, 3 x 699 = 2097 zł", async () => {
    calls.length = 0;
    const message = "ile za 3 aku 18V 5,5Ah do milwaukee? i wysylka gratis?";
    const m = await matchItems(message, shopPool, { limit: 6, quantities: true });
    expect(m?.items).toEqual([battery]);
    const given = await m!.given;
    expect(given?.get(battery)).toEqual({ pieces: 3 });
    const [p] = priceGiven(given!);
    expect(customerPriceLine(p)).toBe("M18™ HIGH OUTPUT™ akumulator 5.5 Ah, for the customer's pieces 3: 2097 zł (computed from our price list)");
    // The reading sees the matched items with a price input - not the pick's 6 items.
    expect(reads()).toHaveLength(1);
    expect(listed(reads()[0].user).map((x) => x.name)).toEqual([battery.name]);
    expect(reads()[0].user).toContain("[inputs: pieces = number of pieces]");
    // The same message again: answered from memory, the same quantities.
    calls.length = 0;
    expect((await (await matchItems(message, shopPool, { limit: 6, quantities: true }))!.given)?.get(battery)).toEqual({ pieces: 3 });
    expect(calls).toHaveLength(0);
  });

  it("no quantity given: the battery is matched and nothing is priced", async () => {
    const m = await matchItems("ile kosztuje akumulator M18 HIGH OUTPUT 5,5Ah?", shopPool, { limit: 6, quantities: true });
    expect(m?.items).toEqual([battery]);
    const given = await m!.given;
    expect(given?.size).toBe(0);
    expect(priceGiven(given!)).toEqual([]);
  });

  it("a reading's quantity for an input the item does not have, or for an item not listed, is left out", async () => {
    reading = (id) => ({ quantities: [{ id, input: "m2", value: 20 }, { id: id + 7, input: "pieces", value: 3 }, { id, input: "pieces", value: "3" }] });
    const m = await matchItems("3 aku M18 5,5Ah i coś na 20 m2", shopPool, { limit: 6, quantities: true });
    expect(m?.items).toEqual([battery]);
    expect((await m!.given)?.size).toBe(0);
  });

  it("no reading without quantities asked (the network's matches), or when no matched item has a price input", async () => {
    calls.length = 0;
    const m = await matchItems("3 aku M18 HIGH OUTPUT 5,5Ah", shopPool, { limit: 15, onePart: true });
    expect(m?.items).toEqual([battery]);
    expect((await m!.given)?.size).toBe(0);
    expect(calls).toHaveLength(1);
    calls.length = 0;
    const unpriced = { ...battery, id: "unpriced", price_value: null, fields: { kind: "product" } } as OfferItem;
    const n = await matchItems("ile za 3 aku 18V 5,5Ah do milwaukee? i wysylka gratis?", [shopPool[0], unpriced], { limit: 6, quantities: true });
    expect(n?.items).toEqual([unpriced]);
    expect((await n!.given)?.size).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("a reading with no answer (an error, twice): null, not kept - the next turn reads again", async () => {
    calls.length = 0;
    reading = () => new Response("upstream error", { status: 502 });
    const message = "ile za 3 aku 5,5Ah? (awaria)";
    const m = await matchItems(message, shopPool, { limit: 6, quantities: true });
    expect(m?.items).toEqual([battery]);
    expect(await m!.given).toBeNull();
    expect(reads()).toHaveLength(2); // asked again once
    calls.length = 0;
    reading = threePieces;
    const again = await matchItems(message, shopPool, { limit: 6, quantities: true });
    expect((await again!.given)?.get(battery)).toEqual({ pieces: 3 });
    expect(calls.filter(isPick)).toHaveLength(0); // the pick from memory
    expect(reads()).toHaveLength(1);
  });

  it("an answer without the quantities is no answer: asked again, then null and not kept", async () => {
    calls.length = 0;
    let n = 0;
    // Once without "quantities" ({"ids": [...]} - the pick's own shape), then right.
    reading = (id, user) => (n++ === 0 ? { ids: [id] } : threePieces(id, user));
    const m = await matchItems("ile za 3 aku M18 HIGH OUTPUT?", shopPool, { limit: 6, quantities: true });
    expect((await m!.given)?.get(battery)).toEqual({ pieces: 3 });
    expect(reads()).toHaveLength(2);
    calls.length = 0;
    reading = () => ({});
    const message = "ile za 3 aku M18 HO 5,5?";
    expect(await (await matchItems(message, shopPool, { limit: 6, quantities: true }))!.given).toBeNull();
    expect(reads()).toHaveLength(2);
    calls.length = 0;
    reading = threePieces;
    expect((await (await matchItems(message, shopPool, { limit: 6, quantities: true }))!.given)?.get(battery)).toEqual({ pieces: 3 });
    expect(reads()).toHaveLength(1);
  });

  it("the pick does not wait for the reading: the items first, the quantities when read", async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    reading = async (id, user) => { await gate; return threePieces(id, user); };
    const m = await matchItems("ile za 3 aku 18V M18 5.5?", shopPool, { limit: 6, quantities: true });
    expect(m?.items).toEqual([battery]); // the reading is still waiting
    let read = false;
    const given = m!.given.then((g) => { read = true; return g; });
    await new Promise((r) => setTimeout(r, 20));
    expect(read).toBe(false);
    open();
    expect((await given)?.get(battery)).toEqual({ pieces: 3 });
  });
});
