/**
 * The customer's quantities as a reader returns them (src/pricing/model.ts read, src/offer/search.ts matchItems), counted
 * here - the owner's rule: text -> structure by a model, structure -> structure by code. A value is one of:
 *
 *   - a number in the input's own unit;
 *   - a period {from, to}: each a calendar date and a clock time (null = not said), counted with calendar arithmetic in
 *     the price's own unit - hours; a day of 24 h from the start's time of day (a "doba"); a calendar day; a night; a
 *     week of 7 x 24 h. A missing time gives two readings: the end at the start's time of day, and the end as late as
 *     its day allows (both times missing: every calendar day counted in full). rentbud-1 (iteration-5 judges): the
 *     reader made "from Friday to Monday" 96 h = 480 zł; returned at the pickup time it is 3 doby = 360 zł;
 *   - an amount in another unit with the conversion the item itself states: {amount, equals: {input, given}} -
 *     `input` of the input's unit = `given` of the customer's; `whole` rounds up to whole pieces or packs.
 *     sosnowydwor-3: soup for 8 people at "1 l = 4 portions" stayed "needs: quantity" - 8 x 1 / 4 = 2 l.
 *
 * Clock arithmetic is wall-clock (a doba ends at the same time of day, also across a DST change).
 */

export interface TimePoint { date: string; time?: string | null }
export type TimeUnit = "hour" | "day" | "calendar_day" | "night" | "week";
// counts: the unit, when the period itself says it (otherwise the input's, countInputs unitOf).
export interface Period { from: TimePoint; to: TimePoint; counts?: TimeUnit }
export interface Conversion { amount: number; equals: { input: number; given: number }; whole?: boolean }
/** What a reading assumes: both times given; the end at the start's time of day; the end as late as its day allows; the
 * start at the beginning of its day; every calendar day in full; only the dates count (nights, calendar days); converted. */
export type Basis = "exact" | "same_time" | "to_day_end" | "from_day_start" | "whole_days" | "dates" | "converted";
export interface Reading { value: number; basis: Basis; hours?: number }

const UNITS = new Set<TimeUnit>(["hour", "day", "calendar_day", "night", "week"]);
const DAY_MS = 86_400_000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/** The day number of an ISO date (YYYY-MM-DD), or null when it is not a real date (2026-02-30). */
export function dayNumber(date: unknown): number | null {
  if (typeof date !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return Math.round(t / DAY_MS);
}

/** A clock time (HH:MM, 0:00-24:00) in hours; null when not given or not a time. */
export function clockHours(time: unknown): number | null {
  if (typeof time !== "string" || !time.trim()) return null;
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(time.trim());
  if (!m) return null;
  const h = Number(m[1]), min = m[2] ? Number(m[2]) : 0;
  if (h > 24 || min > 59 || (h === 24 && min > 0)) return null;
  return h + min / 60;
}

export const isPeriod = (v: unknown): v is Period =>
  !!v && typeof v === "object" && dayNumber((v as Period).from?.date) !== null && dayNumber((v as Period).to?.date) !== null;
export const isConversion = (v: unknown): v is Conversion =>
  !!v && typeof v === "object" && typeof (v as Conversion).amount === "number" && !!(v as Conversion).equals && typeof (v as Conversion).equals === "object";

/**
 * A period counted in `unit`: one reading, or two when a time is missing (shortest first). [] when it cannot be
 * counted (an end before the start, nothing left of it).
 */
export function periodReadings(p: Period, unit: TimeUnit = "hour"): Reading[] {
  const a = dayNumber(p?.from?.date), b = dayNumber(p?.to?.date);
  if (a === null || b === null || b < a) return [];
  const days = b - a;
  if (unit === "calendar_day") return [{ value: days + 1, basis: "dates" }];
  if (unit === "night") return days > 0 ? [{ value: days, basis: "dates" }] : [];
  const tf = clockHours(p.from.time), tt = clockHours(p.to.time);
  const spans: { hours: number; basis: Basis }[] =
    tf !== null && tt !== null ? [{ hours: days * 24 + tt - tf, basis: "exact" }]
    : tf !== null ? [{ hours: days * 24, basis: "same_time" }, { hours: days * 24 + 24 - tf, basis: "to_day_end" }]
    : tt !== null ? [{ hours: days * 24, basis: "same_time" }, { hours: days * 24 + tt, basis: "from_day_start" }]
    : [{ hours: days * 24, basis: "same_time" }, { hours: (days + 1) * 24, basis: "whole_days" }];
  const per = unit === "day" ? 24 : unit === "week" ? 168 : 1;
  const out: Reading[] = [];
  for (const s of spans) {
    if (!(s.hours > 0)) continue;
    const value = per === 1 ? round(s.hours) : Math.ceil(s.hours / per - 1e-9);
    if (!out.some((r) => r.value === value)) out.push({ value, basis: s.basis, hours: round(s.hours) });
  }
  return out;
}

/** An amount converted into the input's unit as the item states it; null when the conversion is not usable. */
export function convert(c: Conversion): number | null {
  const amount = Number(c?.amount), a = Number(c?.equals?.input), g = Number(c?.equals?.given);
  if (![amount, a, g].every((x) => Number.isFinite(x) && x > 0)) return null;
  const v = (amount * a) / g;
  return c.whole ? Math.ceil(v - 1e-9) : round(v, 4);
}

/** The readings of one value: null = not a period or a conversion (it stays as it is); [] = it cannot be counted. */
export function readingsOf(v: unknown, unit?: TimeUnit): Reading[] | null {
  if (isPeriod(v)) {
    const u = v.counts && UNITS.has(v.counts) ? v.counts : unit;
    return u ? periodReadings(v, u) : [];
  }
  if (isConversion(v)) {
    const x = convert(v);
    return x === null ? [] : [{ value: x, basis: "converted" }];
  }
  return null;
}

const point = (t: TimePoint, withTime = true) => {
  const n = dayNumber(t.date);
  return `${n === null ? "" : `${WEEKDAYS[new Date(n * DAY_MS).getUTCDay()]} `}${t.date}${withTime && clockHours(t.time) !== null ? ` ${String(t.time).trim()}` : ""}`;
};
const COUNT: Record<TimeUnit, (r: Reading) => string> = {
  hour: (r) => `${r.value} h${r.value >= 48 && r.value % 24 === 0 ? ` (${r.value / 24} x 24 h)` : ""}`,
  day: (r) => `${r.value} x 24 h`,
  calendar_day: (r) => `${r.value} calendar day${r.value === 1 ? "" : "s"}`,
  night: (r) => `${r.value} night${r.value === 1 ? "" : "s"}`,
  week: (r) => `${r.value} x 7 days`,
};

/** What a reading assumes, for the reply's facts (the model words it for the customer). */
export function describeReading(name: string, v: unknown, r: Reading, unit?: TimeUnit): string {
  if (isConversion(v)) return `${name} ${r.value} (${v.amount} as the customer gives it; ${v.equals.input} of ${name} = ${v.equals.given}, as the item states${v.whole ? ", rounded up to whole units" : ""})`;
  if (!isPeriod(v)) return `${name} ${r.value}`;
  const u = (v.counts && UNITS.has(v.counts) ? v.counts : unit) || "hour";
  const tf = clockHours(v.from.time) !== null, tt = clockHours(v.to.time) !== null;
  const span = r.basis === "exact" ? `from ${point(v.from)} to ${point(v.to)}`
    : r.basis === "same_time" ? (tf ? `from ${point(v.from)} to ${point(v.to, false)} at the same time of day`
      : tt ? `from ${point(v.from, false)} at the same time of day to ${point(v.to)}`
      : `from ${point(v.from, false)} to ${point(v.to, false)}, ending at the same time of day as it starts`)
    : r.basis === "to_day_end" ? `from ${point(v.from)} to later on ${point(v.to, false)} (at most until the end of that day)`
    : r.basis === "from_day_start" ? `from the start of ${point(v.from, false)} to ${point(v.to)}`
    : r.basis === "whole_days" ? `every calendar day from ${point(v.from, false)} to ${point(v.to, false)} counted in full`
    : `${point(v.from, false)} to ${point(v.to, false)}`;
  return `${name} ${span} = ${COUNT[u](r)}`;
}

/**
 * Input records (a request's shared inputs and each line's) with every period and conversion counted: `sets[k]` = the
 * records under reading k - one reading, or two when a period lacks a time (the k-th reading of every such period) -
 * and `assumed[k]` what reading k assumes. A value that cannot be counted is left out (the program then asks for it);
 * other values stay as they are. `unitOf`: how an input counts time when its period does not say (the item matcher's
 * "hours").
 */
export function countInputs(records: Record<string, unknown>[], unitOf?: (name: string) => TimeUnit | undefined): { sets: Record<string, unknown>[][]; assumed: string[][] } {
  const per = records.map((rec) => Object.entries(rec && typeof rec === "object" ? rec : {}).map(([name, v]) => ({ name, v, rs: readingsOf(v, unitOf?.(name)) })));
  const n = Math.max(1, ...per.flat().map((x) => (x.rs?.length ? x.rs.length : 1)));
  const sets: Record<string, unknown>[][] = [], assumed: string[][] = [];
  for (let k = 0; k < n; k++) {
    const notes: string[] = [];
    sets.push(per.map((list) => Object.fromEntries(list.flatMap(({ name, v, rs }): [string, unknown][] => {
      if (rs === null) return [[name, v]];
      if (!rs.length) return [];
      const r = rs[Math.min(k, rs.length - 1)];
      const note = describeReading(name, v, r, unitOf?.(name));
      if (!notes.includes(note)) notes.push(note);
      return [[name, r.value]];
    }))));
    assumed.push(notes);
  }
  return { sets, assumed };
}

/** Today as the readers get it (they write dates as YYYY-MM-DD): "Thursday 2026-11-05", Warsaw time. */
export function todayLine(now = new Date()): string {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const n = dayNumber(date);
  return n === null ? date : `${WEEKDAYS[new Date(n * DAY_MS).getUTCDay()]} ${date}`;
}

/** An amount equal to one of `known` (cents apart at most). */
export const sameAmount = (a: number, known: number[]): boolean => Number.isFinite(a) && known.some((k) => Number.isFinite(k) && Math.abs(k - a) <= 0.011);
