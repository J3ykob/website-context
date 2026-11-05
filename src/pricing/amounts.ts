/**
 * The amounts a chat reply states, bound to the amounts our code computed or our items list (iteration-5 judges, problem
 * 3; review 2026-11-05). By the owner's rule: an LLM reads each amount of the reply as what the reply gives it for - which
 * item (or the request's total), as computed for the customer's quantity, a part of such a price, or as the price list
 * lists it, under which reading (text -> structure); code compares the numbers (structure -> structure). The amounts are
 * not shown to the LLM: shown them, it paired by the number ("3 doby for 480 zł" with the 96 h reading's 480) and a
 * per-person rate with the request's total (offline probes 2026-11-05).
 */
import type { QuoteFact } from "./model.js";
import { sameAmount } from "./quantity.js";

type PriceFact = QuoteFact;

// The items a reply may give amounts for, each with the kinds of amount we have for it (computed for the customer's quantity,
// per reading; listed by the price list), never the amounts.
export const AMOUNTS_PROMPT = `You read a chat reply's statements next to a numbered list of the items it may give prices for (the amounts are not shown). For each numbered statement: "amounts" - every sum of money it states (not a quantity, a date or a time), each {"amount": <number, e.g. "1 704,87 zł" -> 1704.87>, "item": <the number of the item the statement gives this amount for, by what it says; null when it is none of them (a minimum, a threshold, a deposit, a thing not listed)>, "as": "computed" (given as the price of the customer's whole quantity of the item, or as the request's total), "part" (a part of such a price: a surcharge, extra hours, a subtotal) or "listed" (given as a price or rate the way a price list gives it: per unit, hour, day or person, or a package's base price), "reading": <the letter of the reading it is given for, by the duration or dates the statement gives; null when it gives none>}; "other": true when it also states a fact besides sums of money, quantities and what they are for (a term, a date, delivery, a discount, availability, a property of the product). JSON {"statements": [{"n": <the statement's number>, "amounts": [...], "other": false}, ...]}.`;
const READINGS = "ABCD";
/** The items of a turn's price facts, as the amounts call reads them (what we have for each, no amounts). */
export function amountsView(facts: PriceFact[]): string {
  const items = [...new Set(facts.map((f) => f.item))];
  return `Items:\n${items.map((it, k) => {
    const fs = facts.filter((f) => f.item === it);
    const computed = fs.filter((f) => f.kind === "computed"), readings = computed.filter((f) => f.reading);
    const kinds = [
      computed.length ? `computed for the customer's quantity${readings.length ? ` - readings ${readings.map((f) => `${f.reading}: ${f.readingText || ""}`).join(" / ")}` : ""}` : "",
      fs.some((f) => f.kind === "listed") ? "listed price or rate" : "",
    ].filter(Boolean);
    return `${k}: ${it} (${kinds.join("; ")})`;
  }).join("\n")}`;
}
export interface AmountsVerdict { supported: boolean[]; given: Set<number>; wrong: { amount: number; facts: number[]; statement: number; text: string }[]; read: string[] }
/**
 * The amounts call's answer compared by code: each amount with the facts of the item, kind and reading it was read as
 * given for - none such, or a part of a computed price: not judged (a per-person rate where we only computed the request's
 * total, an extra hours' subtotal). supported[i]: every amount of statement i matches, and it states nothing else; given:
 * the facts stated right; wrong: amounts that match none of their facts. null when the answer has no statements.
 */
export function judgeAmounts(statements: string[], facts: PriceFact[], j: any): AmountsVerdict | null {
  const list: any[] = Array.isArray(j?.statements) ? j.statements : [];
  if (!list.length) return null;
  const items = [...new Set(facts.map((f) => f.item))];
  const given = new Set<number>(), wrong: AmountsVerdict["wrong"] = [], read: string[] = [];
  // By the statement's number: the model may answer one statement in several entries (all of them count).
  const supported = statements.map((_, i) => {
    const entries = list.filter((e) => e?.n === i);
    const amounts: any[] = entries.flatMap((e) => (Array.isArray(e?.amounts) ? e.amounts : []));
    const right = amounts.map((a) => {
      const n = Number(a?.amount), it = Number.isInteger(a?.item) ? items[a.item as number] : undefined;
      if (a?.as === "part") { read.push(`${i}: ${a?.amount} -> part`); return false; } // a part of a computed price: not judged
      const kind = a?.as === "listed" ? "listed" : "computed";
      const reading = typeof a?.reading === "string" && READINGS.includes(a.reading.trim().toUpperCase()) ? a.reading.trim().toUpperCase() : undefined;
      const of = it === undefined ? [] : facts.map((f, k) => ({ f, k })).filter(({ f }) => f.item === it && f.kind === kind && (!reading || !f.reading || f.reading === reading)).map(({ k }) => k);
      read.push(`${i}: ${a?.amount} -> ${it ?? "-"}${it !== undefined ? ` ${kind}${reading ? ` ${reading}` : ""}` : ""}`);
      if (!Number.isFinite(n) || !of.length) return false;
      if (sameAmount(n, of.flatMap((k) => facts[k].amounts))) { of.forEach((k) => given.add(k)); return true; }
      // An item's listed prices are what its offer entry holds - its price list can have more (an extra hour's rate): a
      // listed amount we don't hold is wrong only when it is another item's (a mix-up: the 90 kg compactor's 110 zł for
      // the 100 kg one); a computed one always (code computed the whole of it).
      if (kind === "listed" && !sameAmount(n, facts.filter((f) => f.item !== it).flatMap((f) => f.amounts))) return false;
      if (!wrong.some((w) => w.amount === n && w.facts.join() === of.join())) {
        const f = facts[of[0]];
        wrong.push({ amount: n, facts: of, statement: i, text: `${n} for ${it}${reading ? ` (reading ${reading})` : ""}${kind === "listed" ? " as listed" : ""} - ${f.line ? `computed: ${f.line.replace(/^- /, "")}` : `listed: ${of.flatMap((k) => facts[k].amounts).join(" / ")}`}` });
      }
      return false;
    });
    return entries.length > 0 && entries.every((e) => e.other === false) && right.length > 0 && right.every(Boolean);
  });
  return { supported, given, wrong, read };
}
