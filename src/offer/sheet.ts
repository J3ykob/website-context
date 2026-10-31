/**
 * The onboarding spreadsheet: the business's offer as we found it, one row per
 * item, with a column per schema field that applies to the business and a
 * dropdown of the allowed values in each. Cells we could not fill are yellow.
 * A second sheet holds price components (a price made of several parts).
 * Read back column by column - no model: a value either is one of the
 * dropdown's values or it is reported back to the owner.
 */
import ExcelJS from "exceljs";
import { FIELDS, fieldsFor, type BusinessType, type FieldId } from "./schema.js";
import { clean, type Offer, type OfferItem } from "./store.js";

const MARK = "whisp-offer-template-v1";
const ITEM_SHEET = "Oferta";
const COMP_SHEET = "Składniki ceny";
const LISTS = "Listy";
const EMPTY_ROWS = 60;
const YELLOW = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF3B0" } } as ExcelJS.Fill;
const HEAD = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2A44" } } as ExcelJS.Fill;

const BASE_COLS = [
  { key: "id", header: "ID (nie zmieniaj)", width: 12 },
  { key: "name", header: "Nazwa *", width: 42 },
  { key: "category", header: "Kategoria", width: 22 },
  { key: "description", header: "Opis", width: 36 },
  { key: "price_value", header: "Cena (liczba)", width: 14 },
  { key: "price_max", header: "Cena do (dla zakresu)", width: 16 },
  { key: "currency", header: "Waluta", width: 9 },
];

const label = (f: FieldId, v?: string) => (v && FIELDS[f].values[v] ? FIELDS[f].values[v].label : "");

/** The spreadsheet for this business, pre-filled with its current offer. */
export async function buildTemplate(offer: Offer, businessName: string): Promise<Buffer> {
  const types: BusinessType[] = offer.businessTypes.length ? offer.businessTypes : ["other"];
  const fields = fieldsFor(types);
  const wb = new ExcelJS.Workbook();
  wb.creator = "Whisp";
  wb.subject = MARK;
  wb.title = `Oferta - ${businessName}`;

  // Hidden sheet with the allowed values (dropdown sources).
  const lists = wb.addWorksheet(LISTS, { state: "veryHidden" });
  const listRef: Partial<Record<FieldId, string>> = {};
  (Object.keys(FIELDS) as FieldId[]).forEach((f, c) => {
    const labels = Object.values(FIELDS[f].values).map((d) => d.label);
    labels.forEach((l, r) => { lists.getCell(r + 1, c + 1).value = l; });
    const col = lists.getColumn(c + 1).letter;
    listRef[f] = `${LISTS}!$${col}$1:$${col}$${labels.length}`;
  });
  lists.getCell(1, 30).value = MARK;

  const help = wb.addWorksheet("Instrukcja");
  help.getColumn(1).width = 110;
  [
    `Oferta firmy ${businessName} - uzupełnij, a asystent będzie odpowiadał klientom o dostępności, cenach i terminach.`,
    "",
    "1. Arkusz „Oferta”: jeden wiersz = jeden produkt lub usługa. Wypełniliśmy, co znaleźliśmy na stronie - sprawdź i popraw.",
    "2. Żółte komórki to informacje, których nie udało się ustalić. Wybierz wartość z listy (strzałka w komórce).",
    "3. Cena: sama liczba (np. 28,90). Typ ceny mówi, jak ją czytać (stała, od, za jednostkę, na zapytanie...).",
    "4. Nowe pozycje dopisz w pustych wierszach na dole. Nie zmieniaj kolumny ID.",
    "5. Arkusz „Składniki ceny”: gdy cena składa się z kilku części (np. łazienka = projekt + robocizna za m² + materiały),",
    "   wpisz każdą część w osobnym wierszu z nazwą pozycji z arkusza „Oferta”.",
    "6. Zapisz plik i wgraj go w panelu: Products & services → Import price list. Wartości, które wpiszesz, mają pierwszeństwo przed stroną.",
  ].forEach((t, r) => { help.getCell(r + 1, 1).value = t; });

  const ws = wb.addWorksheet(ITEM_SHEET, { views: [{ state: "frozen", ySplit: 1, xSplit: 2 }] });
  ws.columns = [
    ...BASE_COLS,
    ...fields.map((f) => ({ key: f, header: FIELDS[f].label, width: 20 })),
  ];
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.eachCell((c) => { c.fill = HEAD; });
  ws.getColumn("id").hidden = false;

  const rows = [...offer.items, ...Array.from({ length: EMPTY_ROWS }, () => null)];
  rows.forEach((it, k) => {
    const r = ws.getRow(k + 2);
    if (it) {
      r.getCell("id").value = it.id;
      r.getCell("name").value = it.name;
      r.getCell("category").value = it.category;
      r.getCell("description").value = it.description;
      if (it.price_value !== null) r.getCell("price_value").value = it.price_value;
      if (it.price_max !== null) r.getCell("price_max").value = it.price_max;
      r.getCell("currency").value = it.currency || "PLN";
    }
    for (const f of fields) {
      const cell = r.getCell(f);
      cell.dataValidation = { type: "list", allowBlank: true, formulae: [listRef[f]!], showErrorMessage: true, errorTitle: "Wybierz z listy", error: "Wybierz wartość z listy rozwijanej." };
      if (it) {
        const v = it.fields[f];
        if (v && v !== "unknown") cell.value = label(f, v);
        else cell.fill = YELLOW;
      }
    }
    if (it && it.price_value === null && !["on_request", "free", "included", "not_listed"].includes(it.fields.price_type || "")) r.getCell("price_value").fill = YELLOW;
    r.getCell("price_value").dataValidation = { type: "decimal", operator: "greaterThanOrEqual", formulae: [0], allowBlank: true, showErrorMessage: true, error: "Wpisz samą liczbę, np. 28,90" };
  });

  const cs = wb.addWorksheet(COMP_SHEET, { views: [{ state: "frozen", ySplit: 1 }] });
  cs.columns = [
    { key: "item", header: "Nazwa pozycji (z arkusza Oferta) *", width: 40 },
    { key: "label", header: "Składnik *", width: 30 },
    { key: "price_type", header: "Typ ceny", width: 16 },
    { key: "price_value", header: "Cena (liczba)", width: 14 },
    { key: "price_max", header: "Cena do", width: 12 },
    { key: "unit", header: "Jednostka", width: 12 },
    { key: "quantity_from", header: "Ilość", width: 16 },
    { key: "quantity_label", header: "O co zapytać klienta (np. metraż)", width: 30 },
    { key: "combine", header: "Sumuje się / do wyboru", width: 24 },
  ];
  cs.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  cs.getRow(1).eachCell((c) => { c.fill = HEAD; });
  const compRows: [OfferItem, OfferItem["components"][number]][] = offer.items.flatMap((i) => i.components.map((c) => [i, c] as [OfferItem, typeof c]));
  for (let k = 0; k < compRows.length + EMPTY_ROWS; k++) {
    const r = cs.getRow(k + 2);
    const pair = compRows[k];
    if (pair) {
      const [i, c] = pair;
      r.getCell("item").value = i.name; r.getCell("label").value = c.label;
      r.getCell("price_type").value = label("price_type", c.price_type);
      if (c.price_value !== null) r.getCell("price_value").value = c.price_value;
      if (c.price_max !== null) r.getCell("price_max").value = c.price_max;
      r.getCell("unit").value = label("unit", c.unit);
      r.getCell("quantity_from").value = c.quantity_from === "customer" ? "Podaje klient" : "Stała (1)";
      r.getCell("quantity_label").value = c.quantity_label;
      r.getCell("combine").value = c.combine === "alternative" ? "Do wyboru (alternatywa)" : c.combine === "tier" ? `Według ilości ${c.applies_from ?? ""}-${c.applies_to ?? ""}` : "Sumuje się";
    }
    r.getCell("combine").dataValidation = { type: "list", allowBlank: true, formulae: ['"Sumuje się,Do wyboru (alternatywa),Według ilości 0-"'] };
    r.getCell("price_type").dataValidation = { type: "list", allowBlank: true, formulae: [listRef.price_type!] };
    r.getCell("unit").dataValidation = { type: "list", allowBlank: true, formulae: [listRef.unit!] };
    r.getCell("quantity_from").dataValidation = { type: "list", allowBlank: true, formulae: ['"Stała (1),Podaje klient"'] };
  }

  wb.views = [{ x: 0, y: 0, width: 20000, height: 12000, firstSheet: 0, activeTab: 1, visibility: "visible" }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Is this our template? (checked before reading it without a model) */
export async function isTemplate(buffer: Buffer): Promise<boolean> {
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    return wb.subject === MARK || wb.getWorksheet(LISTS)?.getCell(1, 30).value === MARK;
  } catch { return false; }
}

function text(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if ("richText" in (v as any)) return (v as any).richText.map((t: any) => t.text).join("").trim();
    if ("result" in (v as any)) return String((v as any).result ?? "").trim();
    if ("text" in (v as any)) return String((v as any).text).trim();
  }
  return String(v).trim();
}
function number(v: ExcelJS.CellValue): number | null {
  const t = text(v);
  if (!t) return null;
  let s = "";
  for (const ch of t) if ((ch >= "0" && ch <= "9") || ch === "," || ch === ".") s += ch === "," ? "." : ch;
  const n = Number(s);
  return s && Number.isFinite(n) ? n : null;
}
/** A field cell back to its schema value: the dropdown label (or the value key itself).
 *  null = empty cell; undefined = not one of the allowed values (reported). */
function valueOf(f: FieldId, t: string): string | null | undefined {
  if (!t) return null;
  const low = t.toLowerCase();
  for (const [k, d] of Object.entries(FIELDS[f].values)) if (d.label.toLowerCase() === low || k === low) return k;
  return undefined;
}

/** Items from our template, exactly as the owner filled it. Problems are listed per cell. */
export async function readTemplate(buffer: Buffer): Promise<{ items: OfferItem[]; problems: string[] }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  const ws = wb.getWorksheet(ITEM_SHEET);
  if (!ws) throw new Error(`Brak arkusza „${ITEM_SHEET}”.`);
  const problems: string[] = [];
  const col: Record<string, number> = {};
  ws.getRow(1).eachCell((c, n) => {
    const h = text(c.value);
    const base = BASE_COLS.find((b) => b.header === h);
    if (base) col[base.key] = n;
    for (const f of Object.keys(FIELDS) as FieldId[]) if (FIELDS[f].label === h) col[f] = n;
  });
  if (!col.name) throw new Error("Brak kolumny „Nazwa”.");
  const items: OfferItem[] = [];
  const byName = new Map<string, OfferItem>();
  ws.eachRow((row, r) => {
    if (r === 1) return;
    const name = text(row.getCell(col.name).value);
    if (!name) return;
    const fields: Record<string, string> = {};
    const ownerSet: FieldId[] = [];
    for (const f of Object.keys(FIELDS) as FieldId[]) {
      if (!col[f]) continue;
      const t = text(row.getCell(col[f]).value);
      if (!t) continue;
      const v = valueOf(f, t);
      if (v === undefined) { problems.push(`Wiersz ${r}, „${FIELDS[f].label}”: „${t}” nie jest wartością z listy.`); continue; }
      if (v) { fields[f] = v; ownerSet.push(f); }
    }
    const price = col.price_value ? number(row.getCell(col.price_value).value) : null;
    if (col.price_value && text(row.getCell(col.price_value).value) && price === null) problems.push(`Wiersz ${r}, „Cena”: wpisz samą liczbę.`);
    if (price !== null && !ownerSet.includes("price_type")) ownerSet.push("price_type");
    const it = clean({
      id: col.id ? text(row.getCell(col.id).value) : "",
      name,
      category: col.category ? text(row.getCell(col.category).value) : "",
      description: col.description ? text(row.getCell(col.description).value) : "",
      price_value: price,
      price_max: col.price_max ? number(row.getCell(col.price_max).value) : null,
      currency: col.currency ? text(row.getCell(col.currency).value) || "PLN" : "PLN",
      fields: { ...(price !== null && !fields.price_type ? { price_type: "fixed" } : {}), ...fields },
      owner_set: ownerSet,
    }, "sheet");
    if (it) { items.push(it); byName.set(it.name.toLowerCase(), it); }
  });

  const cs = wb.getWorksheet(COMP_SHEET);
  if (cs) {
    cs.eachRow((row, r) => {
      if (r === 1) return;
      const itemName = text(row.getCell(1).value), lbl = text(row.getCell(2).value);
      if (!itemName && !lbl) return;
      const it = byName.get(itemName.toLowerCase());
      if (!it) { problems.push(`Składniki, wiersz ${r}: brak pozycji „${itemName}” w arkuszu Oferta.`); return; }
      if (!lbl) { problems.push(`Składniki, wiersz ${r}: brak nazwy składnika.`); return; }
      const pt = valueOf("price_type", text(row.getCell(3).value));
      const unit = valueOf("unit", text(row.getCell(6).value));
      if (pt === undefined || unit === undefined) problems.push(`Składniki, wiersz ${r}: typ ceny lub jednostka spoza listy.`);
      it.components.push({
        label: lbl,
        price_type: pt || (number(row.getCell(4).value) !== null ? "fixed" : "unknown"),
        price_value: number(row.getCell(4).value),
        price_max: number(row.getCell(5).value),
        unit: unit || "unknown",
        quantity_from: text(row.getCell(7).value) === "Podaje klient" ? "customer" : "fixed",
        quantity_label: text(row.getCell(8).value).slice(0, 80),
        // "Według ilości 80-99": our own cell format (written above), read back as a tier and its range.
        ...tierCell(text(row.getCell(9).value)),
      });
    });
  }
  return { items, problems: problems.slice(0, 50) };
}

/** The "combine" cell of our spreadsheet back into structure ("Według ilości 80-99" = a tier 80..99). */
function tierCell(v: string): { combine: "sum" | "alternative" | "tier"; applies_from?: number | null; applies_to?: number | null } {
  if (v === "Do wyboru (alternatywa)") return { combine: "alternative" };
  const tag = "Według ilości";
  if (!v.startsWith(tag)) return { combine: "sum" };
  const [from, to] = v.slice(tag.length).trim().split("-");
  const n = (x?: string) => (x && x.trim() !== "" && Number.isFinite(Number(x)) ? Number(x) : null);
  return { combine: "tier", applies_from: n(from), applies_to: n(to) };
}

