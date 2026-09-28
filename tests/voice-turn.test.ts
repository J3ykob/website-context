import { describe, it, expect } from "vitest";
import { stripLeadingAck, ttsClean, headSettled } from "../src/voice/tts-sanitize.js";
import { confirmAction, pickNeutralFiller, smsAcceptedWithoutTag, type TurnIntent } from "../src/voice/turn-classifier.js";

const intent = (over: Partial<TurnIntent>): TurnIntent => ({
  intent: "odmowa", intentConfidence: 1, wantsSms: 0, wantsHuman: 0, ms: 300, ...over,
});

describe("stripLeadingAck", () => {
  it("drops an acknowledgement that would duplicate the spoken filler", () => {
    expect(stripLeadingAck("Rozumiem, może innym razem porozmawiamy.")).toBe("Może innym razem porozmawiamy.");
    expect(stripLeadingAck("Mhm. Na start jest za darmo.")).toBe("Na start jest za darmo.");
    expect(stripLeadingAck("Oookej, wysyłam link.")).toBe("Wysyłam link.");
    expect(stripLeadingAck("Jasne! Okej. Już łączę.")).toBe("Już łączę.");
  });
  it("keeps sentences where the ack word carries meaning", () => {
    expect(stripLeadingAck("Jasne, że tak, działa po polsku.")).toBe("Jasne, że tak, działa po polsku.");
    expect(stripLeadingAck("Rozumiem, iż to ważne.")).toBe("Rozumiem, iż to ważne.");
    expect(stripLeadingAck("Dobrze, że pan pyta.")).toBe("Dobrze, że pan pyta.");
    expect(stripLeadingAck("Rozumiemy potrzeby firm.")).toBe("Rozumiemy potrzeby firm.");
    expect(stripLeadingAck("Okejka to nie słowo.")).toBe("Okejka to nie słowo.");
  });
  it("capitalises Polish diacritics after stripping", () => {
    expect(stripLeadingAck("Mhm, świetne pytanie.")).toBe("Świetne pytanie.");
  });
});

describe("ttsClean", () => {
  it("reads number ranges as 'do' and other dashes as a pause", () => {
    expect(ttsClean("Pracujemy 9–17 — od poniedziałku.")).toBe("Pracujemy 9 do 17, od poniedziałku.");
  });
  it("drops bracketed tags the model invents instead of reading them out", () => {
    expect(ttsClean("Dziękuję. [KONIEC]")).toBe("Dziękuję. ");
  });
  it("drops emoji but keeps Polish text and ordinary hyphens", () => {
    expect(ttsClean("Za darmo 🎉 i bez umowy ✅️, e-mail też.")).toBe("Za darmo  i bez umowy , e-mail też.");
  });
});

describe("headSettled", () => {
  it("waits for enough text to judge the opening", () => {
    expect(headSettled("Rozumiem")).toBe(false);
    expect(headSettled("Rozumiem, może innym razem")).toBe(true);
  });
});

describe("confirmAction", () => {
  it("blocks an LLM transfer tag on a refusal (live call: 'nie, nie... nie link')", () => {
    expect(confirmAction(intent({ wantsHuman: 0.04 }), "human")).toBe(false);
  });
  it("allows actions Jev agrees with", () => {
    expect(confirmAction(intent({ wantsSms: 0.93 }), "sms")).toBe(true);
    expect(confirmAction(intent({ wantsHuman: 0.88 }), "human")).toBe(true);
  });
  it("trusts the LLM tag when Jev is unavailable, so an outage never blocks a real request", () => {
    expect(confirmAction(null, "sms")).toBe(true);
    expect(confirmAction(null, "human")).toBe(true);
  });
});

describe("confirmAction: hanging up", () => {
  it("hangs up after a refusal or goodbye", () => {
    expect(confirmAction(intent({ intent: "odmowa" }), "end")).toBe(true);
    expect(confirmAction(intent({ intent: "pozegnanie" }), "end")).toBe(true);
    expect(confirmAction(intent({ intent: "zgoda" }), "end")).toBe(true); // "tak, wyślij" -> SMS, then goodbye
  });
  it("never hangs up on a caller who still wants to talk", () => {
    for (const i of ["pytanie", "obiekcja", "scenka", "czlowiek", "niejasne"] as const)
      expect(confirmAction(intent({ intent: i, intentConfidence: 0.9 }), "end")).toBe(false);
  });
  it("trusts the LLM goodbye when Jev is unsure or unavailable", () => {
    expect(confirmAction(intent({ intent: "pytanie", intentConfidence: 0.3 }), "end")).toBe(true);
    expect(confirmAction(null, "end")).toBe(true);
  });
});

describe("smsAcceptedWithoutTag", () => {
  const OFFER = "Tak może obsługiwać Twoich klientów Whisp. Wysłać Ci SMS-em link do darmowego dema?";
  it("sends when Jev is sure the caller accepted an SMS offer the bot just made", () => {
    expect(smsAcceptedWithoutTag(intent({ intent: "zgoda", wantsSms: 0.99 }), OFFER)).toBe(true);
  });
  it("does not send on a lukewarm Jev score, or when no SMS was offered", () => {
    expect(smsAcceptedWithoutTag(intent({ wantsSms: 0.7 }), OFFER)).toBe(false);
    expect(smsAcceptedWithoutTag(intent({ wantsSms: 0.99 }), "Czym zajmuje się Twoja firma?")).toBe(false);
    expect(smsAcceptedWithoutTag(null, OFFER)).toBe(false);
  });
});

describe("pickNeutralFiller", () => {
  it("never repeats the previous filler", () => {
    for (let i = 0; i < 30; i++) expect(pickNeutralFiller("Mhm.")).not.toBe("Mhm.");
  });
});
