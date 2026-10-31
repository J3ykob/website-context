/**
 * The products & services schema: a fixed matrix of fields and the values each
 * may take, and which fields apply to which business type. It is defined up
 * front so that every field can be filled by a choice (Jev during scraping, a
 * dropdown in the onboarding spreadsheet, a select in the dashboard) - never by
 * free text an LLM writes. Every field has "unknown": an empty answer is better
 * than a wrong one.
 *
 * Numbers (price, component amounts) are the only non-enum values; they are
 * picked from numbers that appear in the source (or typed by the owner).
 */

export type FieldId =
  | "kind" | "price_type" | "unit" | "availability" | "lead_time" | "fulfilment"
  | "delivery_cost" | "min_order" | "booking" | "payment";

export interface FieldDef {
  id: FieldId;
  label: string;          // Polish label (dashboard / spreadsheet column)
  question: string;       // what Jev is asked about an item (English, any-language content)
  values: Record<string, { label: string; meaning: string }>;
}

const v = (label: string, meaning: string) => ({ label, meaning });

export const FIELDS: Record<FieldId, FieldDef> = {
  kind: {
    id: "kind", label: "Rodzaj", question: "What kind of offer is this item?",
    values: {
      product: v("Produkt", "A physical product sold to the customer."),
      service: v("Usługa", "Work or a service performed for the customer."),
      rental: v("Wynajem", "Equipment or a space rented for a period."),
      package: v("Pakiet", "A bundle of several products and/or services sold together."),
      subscription: v("Abonament", "A recurring paid plan."),
      unknown: v("Nie wiadomo", "Cannot be told from the information."),
    },
  },
  price_type: {
    id: "price_type", label: "Typ ceny", question: "How is the price of this item stated?",
    values: {
      fixed: v("Stała", "One exact price is given."),
      from: v("Od", "A starting price is given ('from X')."),
      range: v("Zakres", "A price range is given ('X-Y')."),
      per_unit: v("Za jednostkę", "A price per unit of measure is given (per m², per hour, per day...)."),
      on_request: v("Na zapytanie", "The price is given only on request / individually."),
      free: v("Bezpłatnie", "It is free of charge."),
      included: v("W cenie", "It is included in another price."),
      not_listed: v("Brak ceny", "No price information at all."),
      unknown: v("Nie wiadomo", "Cannot be told from the information."),
    },
  },
  unit: {
    id: "unit", label: "Jednostka", question: "Per which unit is this item priced or sold?",
    values: {
      szt: v("szt.", "Per piece."), kg: v("kg", "Per kilogram."), t: v("t", "Per tonne."),
      m2: v("m²", "Per square metre."), m3: v("m³", "Per cubic metre."), mb: v("mb", "Per running metre."),
      worek: v("worek", "Per bag / sack."), paleta: v("paleta", "Per pallet."), litr: v("litr", "Per litre."),
      godzina: v("godzina", "Per hour."), doba: v("doba", "Per day."), tydzien: v("tydzień", "Per week."), miesiac: v("miesiąc", "Per month."),
      usluga: v("usługa", "Per service, once."), wizyta: v("wizyta", "Per visit / appointment."), osoba: v("osoba", "Per person."),
      projekt: v("projekt", "Per whole job / project."), komplet: v("komplet", "Per set."),
      unknown: v("Nie wiadomo", "Cannot be told from the information."),
    },
  },
  availability: {
    id: "availability", label: "Dostępność", question: "Is this item available?",
    values: {
      in_stock: v("Dostępny", "Available now / in stock."),
      to_order: v("Na zamówienie", "Made or brought in to order."),
      seasonal: v("Sezonowy", "Available only in some seasons."),
      limited: v("Ograniczona", "Limited quantity or limited availability."),
      unavailable: v("Niedostępny", "Currently not available."),
      unknown: v("Nie wiadomo", "Cannot be told from the information."),
    },
  },
  lead_time: {
    id: "lead_time", label: "Czas realizacji", question: "How soon can the customer get this item or have this done?",
    values: {
      immediate: v("Od ręki", "Immediately."),
      same_day: v("Tego samego dnia", "The same day."),
      d1_2: v("1-2 dni", "Within 1-2 days."),
      d3_7: v("3-7 dni", "Within 3-7 days."),
      w1_2: v("1-2 tygodnie", "Within 1-2 weeks."),
      over_2w: v("Ponad 2 tygodnie", "More than 2 weeks."),
      on_request: v("Do ustalenia", "Agreed individually."),
      unknown: v("Nie wiadomo", "Cannot be told from the information."),
    },
  },
  fulfilment: {
    id: "fulfilment", label: "Realizacja", question: "How does the customer receive this item or service?",
    values: {
      delivery: v("Dostawa", "Delivered to the customer."),
      pickup: v("Odbiór osobisty", "Picked up by the customer."),
      delivery_or_pickup: v("Dostawa lub odbiór", "Either delivery or pickup."),
      on_site: v("U klienta", "Done at the customer's place."),
      at_business: v("Na miejscu u nas", "At the business's premises."),
      remote: v("Zdalnie", "Online / remotely."),
      unknown: v("Nie wiadomo", "Cannot be told from the information."),
    },
  },
  delivery_cost: {
    id: "delivery_cost", label: "Koszt dostawy", question: "What does delivery of this item cost?",
    values: {
      free: v("Bezpłatna", "Free delivery."),
      fixed: v("Stała opłata", "A fixed delivery fee."),
      by_distance: v("Zależna od odległości", "Depends on distance."),
      from_threshold: v("Bezpłatna od kwoty", "Free above an order value."),
      on_request: v("Do ustalenia", "Agreed individually."),
      not_applicable: v("Nie dotyczy", "There is no delivery for this item."),
      unknown: v("Nie wiadomo", "Cannot be told from the information."),
    },
  },
  min_order: {
    id: "min_order", label: "Minimalne zamówienie", question: "Is there a minimum order for this item?",
    values: {
      none: v("Brak", "No minimum."),
      quantity: v("Ilościowe", "A minimum quantity (or minimum rental period)."),
      value: v("Kwotowe", "A minimum order value."),
      on_request: v("Do ustalenia", "Agreed individually."),
      unknown: v("Nie wiadomo", "Cannot be told from the information."),
    },
  },
  booking: {
    id: "booking", label: "Jak zamówić", question: "How does the customer order or book this?",
    values: {
      walk_in: v("Bez rezerwacji", "Just come in, no booking."),
      appointment: v("Umówienie terminu", "An appointment has to be arranged."),
      online_booking: v("Rezerwacja online", "Booked online on the website."),
      order_form: v("Formularz / zamówienie online", "Ordered online or via a form."),
      call: v("Telefonicznie", "By phone."),
      unknown: v("Nie wiadomo", "Cannot be told from the information."),
    },
  },
  payment: {
    id: "payment", label: "Płatność", question: "How is this paid for?",
    values: {
      on_site: v("Na miejscu", "Paid on site / on delivery."),
      transfer: v("Przelew", "Bank transfer."),
      card: v("Karta / online", "Card or online payment."),
      invoice: v("Faktura z terminem", "Invoice with payment terms."),
      deposit: v("Zaliczka", "A deposit / advance payment is required."),
      unknown: v("Nie wiadomo", "Cannot be told from the information."),
    },
  },
};

export type BusinessType = "shop" | "rental" | "contractor" | "appointment" | "food" | "other";

export const BUSINESS_TYPES: Record<BusinessType, { label: string; meaning: string }> = {
  shop: { label: "Sklep / hurtownia", meaning: "Sells products (retail, wholesale, building materials)." },
  rental: { label: "Wypożyczalnia", meaning: "Rents out equipment, machines, vehicles or spaces." },
  contractor: { label: "Wykonawca / usługi", meaning: "Performs jobs: construction, renovation, installation, repairs, design." },
  appointment: { label: "Wizyty", meaning: "Serves customers at appointments: clinic, salon, studio, office." },
  food: { label: "Gastronomia", meaning: "Restaurant, café, catering." },
  other: { label: "Inne", meaning: "Any other kind of business." },
};

/** Which fields apply to which business type (beyond kind / price, which always apply). */
export const APPLIES: Record<BusinessType, FieldId[]> = {
  shop:        ["kind", "price_type", "unit", "availability", "lead_time", "fulfilment", "delivery_cost", "min_order", "booking", "payment"],
  rental:      ["kind", "price_type", "unit", "availability", "lead_time", "fulfilment", "delivery_cost", "min_order", "booking", "payment"],
  contractor:  ["kind", "price_type", "unit", "lead_time", "fulfilment", "booking", "payment"],
  appointment: ["kind", "price_type", "unit", "lead_time", "fulfilment", "booking", "payment"],
  food:        ["kind", "price_type", "unit", "availability", "fulfilment", "delivery_cost", "min_order", "booking", "payment"],
  other:       ["kind", "price_type", "unit", "availability", "lead_time", "fulfilment", "booking", "payment"],
};

/** Fields for a business with one or more types (union, in schema order). */
export function fieldsFor(types: BusinessType[]): FieldId[] {
  const set = new Set<FieldId>();
  for (const t of types.length ? types : ["other" as BusinessType]) for (const f of APPLIES[t]) set.add(f);
  return (Object.keys(FIELDS) as FieldId[]).filter((f) => set.has(f));
}

/** A value is valid for a field only if it is one of the defined ones. */
export function validValue(field: FieldId, value: unknown): string {
  return typeof value === "string" && value in FIELDS[field].values ? value : "unknown";
}

/**
 * One part of a price that is made of several (a bathroom: design + labour per
 * m² + materials on request). quantityFrom says where the quantity comes from:
 * "fixed" (1), or a quantity the customer gives (e.g. "metraż").
 */
export interface PriceComponent {
  label: string;
  price_type: string;     // a FIELDS.price_type value
  price_value: number | null;
  price_max: number | null;  // for "range"
  unit: string;           // a FIELDS.unit value
  quantity_from: "fixed" | "customer";
  quantity_label: string; // what to ask the customer for, e.g. "metraż łazienki"
  // "sum": the parts add up (design + labour + materials); "alternative": the
  // customer picks one (rental per hour OR per day); "tier": the price depends on
  // the customer's quantity - the one whose range [applies_from, applies_to]
  // contains it applies (per guest by guest count, a lower price per m² above
  // 100 m², a weekly rate from 7 days).
  combine: "sum" | "alternative" | "tier";
  applies_from?: number | null; // "tier": the quantity range this price applies to
  applies_to?: number | null;
}
