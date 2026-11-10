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
 *     sosnowydwor-3: soup for 8 people at "1 l = 4 portions" stayed "needs: quantity" - 8 x 1 / 4 = 2 l;
 *   - a length in a calendar unit without dates {count, unit}: "a year", "3 months", "6 weeks", "2 doby".
 *
 * A length counted in hours also keeps its calendar months (a Span): an item's monthly rate is priced per calendar month,
 * not per 720 h - whisp_so (2026-11-07): "na cały rok" read as 8760 h came to 13 x 149 zł, and the check rejected the
 * reply's right 12 x 149 = 1788 zł.
 *
 * Clock arithmetic is wall-clock (a doba ends at the same time of day, also across a DST change).
 */

export interface TimePoint { date: string; time?: string | null }
export type TimeUnit = "hour" | "day" | "calendar_day" | "night" | "week";
// counts: the unit, when the period itself says it (otherwise the input's, countInputs unitOf).
export interface Period { from: TimePoint; to: TimePoint; counts?: TimeUnit }
export interface Conversion { amount: number; equals: { input: number; given: number }; whole?: boolean }
/** A length of time in the customer's own calendar unit, without dates ("a year", "3 months", "6 weeks", "2 doby"). */
export type DurationUnit = "hour" | "day" | "week" | "month" | "year";
export interface Duration { count: number; unit: DurationUnit }
/**
 * A length of time as the calendar counts it (whisp_so 2026-11-07: a year as 8760 h was 13 monthly rates, not 12):
 * `months` whole calendar months (a year = 12), `rest` the hours beyond them, `hours` the whole length in hours - for
 * rates that are not monthly. A month without dates is 30 x 24 h (the monthly rate's convention), a year 365 x 24 h.
 */
export interface Span { months: number; rest: number; hours: number }
/** What a reading assumes: both times given; the end at the start's time of day; the end as late as its day allows; the
 * start at the beginning of its day; every calendar day in full; only the dates count (nights, calendar days); converted;
 * a length the customer gave in a calendar unit, without dates. */
export type Basis = "exact" | "same_time" | "to_day_end" | "from_day_start" | "whole_days" | "dates" | "converted" | "duration";
// span: the reading in calendar months, when it holds at least one (only for the hour unit, which the item recipes price).
export interface Reading { value: number; basis: Basis; hours?: number; span?: Span }

export const MONTH_HOURS = 720;
export const YEAR_HOURS = 8760;
const DURATION_UNITS: Record<DurationUnit, number> = { hour: 1, day: 24, week: 168, month: MONTH_HOURS, year: YEAR_HOURS };

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
export const isDuration = (v: unknown): v is Duration =>
  !!v && typeof v === "object" && typeof (v as Duration).count === "number" && Number.isFinite((v as Duration).count) && (v as Duration).count > 0
  && Object.prototype.hasOwnProperty.call(DURATION_UNITS, (v as Duration).unit);
export const isSpan = (v: unknown): v is Span =>
  !!v && typeof v === "object" && [(v as Span).months, (v as Span).rest, (v as Span).hours].every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0);

/** A length given in a calendar unit, as the calendar counts it: months and years in whole months, the rest in hours. */
export function durationSpan(d: Duration): Span {
  const months = d.unit === "year" ? d.count * 12 : d.unit === "month" ? d.count : 0;
  const whole = Math.floor(months + 1e-9);
  return { months: whole, rest: round((months - whole) * MONTH_HOURS), hours: round(d.count * DURATION_UNITS[d.unit]) };
}

/** The whole calendar months from day `a` at `startHour` within `hours` (Jan 31 + 1 month = Feb 28), and the hours beyond. */
function monthsIn(a: number, startHour: number, hours: number): Span {
  const start = new Date(a * DAY_MS), y = start.getUTCFullYear(), mo = start.getUTCMonth(), d = start.getUTCDate();
  const end = a * 24 + startHour + hours;
  const at = (m: number) => {
    const last = new Date(Date.UTC(y, mo + m + 1, 0)).getUTCDate();
    return Math.round(Date.UTC(y, mo + m, Math.min(d, last)) / DAY_MS) * 24 + startHour;
  };
  let m = 0;
  while (at(m + 1) <= end + 1e-9) m++;
  return { months: m, rest: round(end - at(m)), hours: round(hours) };
}
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
  // start: the hour of the start's day each reading counts from (for its calendar months).
  const spans: { hours: number; basis: Basis; start: number }[] =
    tf !== null && tt !== null ? [{ hours: days * 24 + tt - tf, basis: "exact", start: tf }]
    : tf !== null ? [{ hours: days * 24, basis: "same_time", start: tf }, { hours: days * 24 + 24 - tf, basis: "to_day_end", start: tf }]
    : tt !== null ? [{ hours: days * 24, basis: "same_time", start: tt }, { hours: days * 24 + tt, basis: "from_day_start", start: 0 }]
    : [{ hours: days * 24, basis: "same_time", start: 0 }, { hours: (days + 1) * 24, basis: "whole_days", start: 0 }];
  const per = unit === "day" ? 24 : unit === "week" ? 168 : 1;
  const out: Reading[] = [];
  for (const s of spans) {
    if (!(s.hours > 0)) continue;
    const value = per === 1 ? round(s.hours) : Math.ceil(s.hours / per - 1e-9);
    if (out.some((r) => r.value === value)) continue;
    const span = per === 1 ? monthsIn(a, s.start, s.hours) : null;
    out.push({ value, basis: s.basis, hours: round(s.hours), ...(span?.months ? { span } : {}) });
  }
  return out;
}

/** A length given in a calendar unit counted in `unit` (rounded up to whole units); one reading. */
export function durationReadings(d: Duration, unit: TimeUnit = "hour"): Reading[] {
  const span = durationSpan(d);
  if (!(span.hours > 0)) return [];
  const per = unit === "week" ? 168 : unit === "hour" ? 1 : 24;
  const value = per === 1 ? span.hours : Math.ceil(span.hours / per - 1e-9);
  return [{ value, basis: "duration", hours: span.hours, ...(unit === "hour" && span.months ? { span } : {}) }];
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
  if (isDuration(v)) return unit ? durationReadings(v, unit) : [];
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

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
// The calendar months of a span and what is beyond them ("12 calendar months", "1 calendar month + 3 h").
const monthsText = (s: Span) => `${plural(s.months, "calendar month")}${s.rest > 0 ? ` + ${s.rest} h` : ""}`;

/** What a reading assumes, for the reply's facts (the model words it for the customer). */
export function describeReading(name: string, v: unknown, r: Reading, unit?: TimeUnit): string {
  if (isConversion(v)) return `${name} ${r.value} (${v.amount} as the customer gives it; ${v.equals.input} of ${name} = ${v.equals.given}, as the item states${v.whole ? ", rounded up to whole units" : ""})`;
  if (isDuration(v)) {
    const u = unit || "hour", days = round((r.hours ?? 0) / 24);
    const counted = u !== "hour" ? COUNT[u](r) : r.span ? `${monthsText(r.span)}; ${days} x 24 h for rates that are not monthly` : COUNT.hour(r);
    return `${name} ${plural(v.count, v.unit)} = ${counted}`;
  }
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
  return `${name} ${span} = ${COUNT[u](r)}${r.span ? ` = ${monthsText(r.span)}` : ""}`;
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
