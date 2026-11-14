/**
 * One turn's state record and the table that decides the reply from it (owner 2026-11-15).
 *
 * Before, the same things were decided in several places of chat.ts, each with its own rule: whether a request is
 * ours (six ways), whether it is answered, whether a total is given, whether to offer the team or the network. Here
 * the models' answers are written once into a record (TurnState), and one table of ordered rows - first match wins,
 * per column - gives the decision (Decision). Code only: structure in, structure out; every word of the reply is
 * still the model's (chat.ts turns the decision into its instructions).
 *
 * The record and the decision of every turn are kept (the turn's trace, and the `decisions` table): a changed table
 * can be replayed on them without asking any model again, and they are the data a learned policy needs later.
 */

export type Ours = "yes" | "no" | "unclear";
/** One part of the customer's request (src/network/coverage.ts). */
export interface PartState {
  ours: Ours;       // we have it / we don't / could not be judged (counts as ours: fail closed)
  priced: boolean;  // a confirmed item of ours for it has a price
  denied: boolean;  // our own pages say we don't offer it (positive evidence, not "nothing found")
}
export interface TurnState {
  intent: "order" | "ask" | "calculate" | "elsewhere" | "chitchat" | null;
  asksPrice: boolean;                       // a price, a total or a calculation is asked
  parts: PartState[];                       // [] when the message names no specific product or service
  info: "full" | "partial" | "none";        // what our information gives for the message
  price: "computed" | "listed" | "none";    // computed by code for the customer's quantities / only listed / no price here
  missing: string[];                        // the quantities a listed price still needs from the customer (recipe inputs)
  askedLast: boolean;                       // our previous reply already asked for them
  formOpen: boolean;                        // an order or inquiry form is open in the chat (it asks its own questions)
  calc: "none" | "simple" | "team";         // a calculation: simple (answered here) or one our team prepares
  network: "off" | "unknown" | "searching" | "found" | "none"; // other businesses for the parts we don't have
  owner: boolean;                           // the business's owner is writing
  canOffer: boolean;                        // an offer to pass it on may be made now (not declined, not just made, no open form)
}
export interface Decision {
  body: "network" | "networkChecking" | "noInfo" | "answer";
  withOurs: boolean;                        // a network reply that also gives what our own information says
  notOffered: number[];                     // the parts (indexes) told "not in our offer"
  price: "plain" | "compute" | "askInputs" | "teamQuote";
  partial: boolean;                         // say which detail we don't give
  offer: null | "question" | "quote" | "network";
  /** The row needs the network search's result first: fill `network` (relay waits longer than an offer) and decide again. */
  needs?: "relay" | "offer";
  rows: string[];                           // the row that decided each column (trace, replay)
}

type Row<T> = [name: string, when: (s: TurnState) => boolean, then: T];
function pick<T>(rows: Row<T>[], s: TurnState): { name: string; then: T } {
  for (const [name, when, then] of rows) if (when(s)) return { name, then };
  throw new Error("turn table: no row matched"); // every column ends with a row that always matches
}

const foreign = (s: TurnState) => s.parts.filter((p) => p.ours === "no");
const allForeign = (s: TurnState) => s.parts.length > 0 && foreign(s).length === s.parts.length;
const denied = (s: TurnState) => s.parts.map((p, k) => (p.ours === "no" && p.denied ? k : -1)).filter((k) => k >= 0);
const networkOn = (s: TurnState) => s.network !== "off" && !s.owner;
// The network answers in place of us: asked for by the customer, nothing of ours answers, or none of the request is ours.
const relay = (s: TurnState) => networkOn(s) && (s.intent === "elsewhere" || s.info === "none" || allForeign(s));

type Body = Decision["body"] | "wait";
const BODY: Row<Body>[] = [
  ["network: wait for the search", (s) => relay(s) && s.network === "unknown", "wait"],
  ["network: businesses found", (s) => relay(s) && s.network === "found", "network"],
  ["network: still searching", (s) => relay(s) && s.network === "searching", "networkChecking"],
  ["not in our offer", (s) => denied(s).length > 0, "answer"],
  ["no information", (s) => s.info === "none", "noInfo"],
  ["answer", () => true, "answer"],
];

// Only for a reply of our own (body "answer").
const PRICE: Row<Decision["price"]>[] = [
  ["team prepares the quote", (s) => s.calc === "team", "teamQuote"],
  ["totals computed", (s) => s.calc === "simple" || s.price === "computed", "compute"],
  // A clarifying question: the price is listed, a total needs a quantity the customer has not given - asked once.
  ["ask for the quantities", (s) => s.asksPrice && s.price === "listed" && s.missing.length > 0 && !s.askedLast && !s.formOpen, "askInputs"],
  ["plain", () => true, "plain"],
];

type Offer = Decision["offer"] | "wait";
// The offer rows read the columns decided before them.
function offerOf(s: TurnState, d: Decision): { name: string; then: Offer } {
  const rows: Row<Offer>[] = [
    ["none: the network answers", () => d.body === "network" || d.body === "networkChecking", null],
    ["none: not now", () => !s.canOffer, null],
    ["quote request to the team", () => d.price === "teamQuote", "quote"],
    ["question to the team", () => d.body === "noInfo", "question"],
    ["network: wait for the search", () => networkOn(s) && foreign(s).length > 0 && s.network === "unknown", "wait"],
    ["network for the parts we don't have", () => networkOn(s) && foreign(s).length > 0 && s.network === "found", "network"],
    ["none: we ask for the quantities", () => d.price === "askInputs", null],
    ["quote request to the team (no price here)", () => d.partial && s.asksPrice && s.price === "none", "quote"],
    ["question to the team (a detail missing)", () => d.partial, "question"],
    ["none", () => true, null],
  ];
  return pick(rows, s);
}

/** The decision for a turn's state. With `needs` set, nothing else is final: fill `network` and call again. */
export function decide(s: TurnState): Decision {
  const d: Decision = { body: "answer", withOurs: false, notOffered: [], price: "plain", partial: false, offer: null, rows: [] };
  const body = pick(BODY, s);
  d.rows.push(body.name);
  if (body.then === "wait") return { ...d, needs: "relay" };
  d.body = body.then;
  if (d.body === "network" || d.body === "networkChecking") d.withOurs = s.intent === "elsewhere" && s.info !== "none";
  if (d.body === "answer") {
    d.notOffered = denied(s);
    const price = pick(PRICE, s);
    d.rows.push(price.name);
    d.price = price.then;
    // Which detail we don't give - unless everything asked is told "not in our offer".
    d.partial = s.info === "partial" && !(d.notOffered.length > 0 && d.notOffered.length === s.parts.length);
    if (d.partial) d.rows.push("a detail missing");
  }
  const offer = offerOf(s, d);
  d.rows.push(`offer - ${offer.name}`);
  if (offer.then === "wait") return { ...d, needs: "offer" };
  d.offer = offer.then;
  return d;
}
