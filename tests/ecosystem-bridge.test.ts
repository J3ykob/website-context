import { describe, it, expect, vi, beforeEach } from "vitest";

const pick = vi.fn();
vi.mock("../src/llm/jev.js", () => ({ jevPickOption: (...a: unknown[]) => pick(...a) }));

const { EcosystemBridge } = await import("../src/ecosystem/bridge.js");

type Stage = "collecting" | "confirming" | "sent" | "cancelled" | "failed" | undefined;

function setup(stages: Stage[]) {
  const talks: { bizId: string; key: string; text: string; opts?: any }[] = [];
  const bridge = new EcosystemBridge({
    askerId: "marsan_pl",
    askerBrand: () => "MARSAN",
    ensureFlow: async () => "collect_default_x",
    talk: async (bizId, key, text, opts) => {
      talks.push({ bizId, key, text, opts });
      const stage = stages[talks.length - 1];
      return { message: `reply ${talks.length}`, sources: [], ...(stage ? { collect: { flowId: "collect_default_x", stage, missing: [] } } : {}) };
    },
  });
  return { bridge, talks };
}

const LAZY = { tenantId: "beton_lazy_pl", label: "BUDOMAT ŁAZY" };
const BOSTA = { tenantId: "bostabeton_pl", label: "Bosta Beton" };

describe("ecosystem bridge", () => {
  beforeEach(() => pick.mockReset());

  it("does nothing (and asks Jev nothing) without a recommendation in the session", async () => {
    const { bridge, talks } = setup([]);
    expect(await bridge.handle("s1", "chcę zamówić beton")).toBeNull();
    expect(pick).not.toHaveBeenCalled();
    expect(talks).toHaveLength(0);
  });

  it("opens a bridge to the chosen business with its form, the customer's own words and via", async () => {
    pick.mockResolvedValue({ index: 1, confidence: 0.9, ambiguous: [] });
    const { bridge, talks } = setup(["collecting"]);
    bridge.remember("s1", [LAZY, BOSTA], ["I'm looking for waterproof concrete"]);
    const r = await bridge.handle("s1", "I'd like to order from Bosta, 20 m3");
    expect(talks[0].bizId).toBe("bostabeton_pl");
    expect(talks[0].key).toBe("eco:marsan_pl:s1:bostabeton_pl");
    expect(talks[0].text).toBe("I'm looking for waterproof concrete\nI'd like to order from Bosta, 20 m3");
    expect(talks[0].opts).toEqual({ startFlowId: "collect_default_x", via: { tenantId: "marsan_pl", brand: "MARSAN", sessionKey: "s1" } });
    expect(r?.message).toBe("**Bosta Beton:** reply 1");
    expect(r?.bridge).toEqual({ tenantId: "bostabeton_pl", label: "Bosta Beton", stage: "collecting" });
    expect(bridge.isOpen("s1")).toBe(true);
  });

  it("routes every next message to the business until the inquiry is sent, then closes", async () => {
    pick.mockResolvedValue({ index: 0, confidence: 0.9, ambiguous: [] });
    const { bridge, talks } = setup(["collecting", "confirming", "sent"]);
    bridge.remember("s1", [LAZY], ["beton wodoszczelny?"]);
    await bridge.handle("s1", "tak, zamawiam u nich");
    await bridge.handle("s1", "20 m3, piątek, Marki, Jan 600100200");
    const r = await bridge.handle("s1", "tak, wysyłaj");
    expect(talks.map((t) => t.text)).toEqual(["beton wodoszczelny?\ntak, zamawiam u nich", "20 m3, piątek, Marki, Jan 600100200", "tak, wysyłaj"]);
    expect(talks[1].opts).toBeUndefined();
    expect(r?.bridge?.stage).toBe("sent");
    expect(bridge.isOpen("s1")).toBe(false);
    expect(pick).toHaveBeenCalledTimes(1);
  });

  it("closes when the customer cancels or the business's form session is gone", async () => {
    pick.mockResolvedValue({ index: 0, confidence: 0.9, ambiguous: [] });
    const a = setup(["collecting", "cancelled"]);
    a.bridge.remember("s1", [LAZY], ["q"]);
    await a.bridge.handle("s1", "zamawiam");
    await a.bridge.handle("s1", "jednak nie");
    expect(a.bridge.isOpen("s1")).toBe(false);

    const b = setup(["collecting", undefined]);
    b.bridge.remember("s2", [LAZY], ["q"]);
    await b.bridge.handle("s2", "zamawiam");
    const r = await b.bridge.handle("s2", "20 m3");
    expect(r?.bridge?.stage).toBe("closed");
    expect(b.bridge.isOpen("s2")).toBe(false);
  });

  it("stays out when Jev picks no business or several", async () => {
    const { bridge, talks } = setup([]);
    bridge.remember("s1", [LAZY, BOSTA], ["q"]);
    pick.mockResolvedValueOnce({ index: -1, confidence: 0.9, ambiguous: [] });
    expect(await bridge.handle("s1", "a jakie macie godziny?")).toBeNull();
    pick.mockResolvedValueOnce({ index: 0, confidence: 0.5, ambiguous: [0, 1] });
    expect(await bridge.handle("s1", "zamówię u którejś")).toBeNull();
    pick.mockResolvedValueOnce(null);
    expect(await bridge.handle("s1", "zamawiam")).toBeNull();
    expect(talks).toHaveLength(0);
  });
});
