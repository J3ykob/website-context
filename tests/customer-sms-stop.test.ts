import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { __setQuery } from "../src/storage/conversation-store.js";
import { sendResultReady, sendNewOffer, setStoppedNumbers } from "../src/projects/notify-channels.js";

// A customer who replied STOP to our number gets no more SMS (notify-channels.ts saidStop). Nothing is sent
// from here: D1 is a stub and fetch is replaced, so a number that is not stopped reaches the fake Twilio.
const env: Record<string, string> = { CUSTOMER_UPDATES_APPROVED: "1", CUSTOMER_OFFER_UPDATES_APPROVED: "1", TWILIO_ACCOUNT_SID: "AC-test", TWILIO_AUTH_TOKEN: "test", TWILIO_FROM_NUMBER: "+48729086795" };
const saved: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;
let fetched = 0;
beforeAll(() => {
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  __setQuery(async () => []);
  globalThis.fetch = (async () => { fetched++; return new Response("{}", { status: 500 }); }) as typeof fetch;
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  __setQuery(null);
  setStoppedNumbers(() => []);
  globalThis.fetch = realFetch;
});

const at = "2026-11-04T10:00:00Z";
const link = "https://whisp.so/p/test";

describe("customer SMS after STOP", () => {
  it("skips a number on the do-not-call list, whatever format it was stored in", async () => {
    setStoppedNumbers(() => ["+48 600 100 200"]);
    const contact = { phone: "+48600100200", lang: "pl", at };
    expect(await sendResultReady(contact, { brand: "Firma", link })).toEqual({ sms: "not sent: the number asked us to stop" });
    expect(await sendNewOffer(contact, { brand: "Firma", business: "Inna firma", link })).toEqual({ sms: "not sent: the number asked us to stop" });
    expect(fetched).toBe(0);
  });

  it("still sends to other numbers", async () => {
    setStoppedNumbers(() => ["+48600100200"]);
    expect(await sendResultReady({ phone: "+48600100201", lang: "pl", at }, { brand: "Firma", link })).toEqual({ sms: "failed" });
    expect(fetched).toBe(1);
  });
});
