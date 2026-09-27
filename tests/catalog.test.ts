import { describe, it, expect } from "vitest";
import { buildCatalog, retrieveFromCatalog, parseNamerReply, type CatalogInputChunk } from "../src/knowledge/catalog.js";

// Live TypeSafe API on real www.amygdala.pl passages. Skipped without JEV_API_KEY.
const live = process.env.JEV_API_KEY ? describe : describe.skip;

const c = (id: string, content: string): CatalogInputChunk => ({ id, content, metadata: { url: "https://www.amygdala.pl/", title: "Amygdala" } });
const CHUNKS = [
  c("ursynow", "Warszawa Ursynów. ul. Indiry Gandhi 27A, 02-776 Warszawa. +48 535 021 194. pon.-pt. 8:00-17:00, sobota nieczynne."),
  c("targowek", "Warszawa Targówek. ul. Barkocińska 6 lok. 10. +48 739 942 023. pon.-pt. 8:00-17:00, sobota nieczynne."),
  c("gdansk", "Gdańsk Wrzeszcz. ul. Leona Miszewskiego 16 lok. 14. +48 739 942 027. pon.-pt. 8:00-16:00."),
  c("cennik", "Cennik. Badanie psychotechniczne 150 zł. Lekarz medycyny pracy 150 zł. Badanie lekarskie kierowców kat. C, D 280 zł."),
  c("zespol", "Nasz zespół. Dr Marian Karwowski - lekarz medycyny pracy. Jerzy Zaleski - psycholog transportu."),
  c("opinia", "Opinie pacjentów. Szybko i profesjonalnie, badanie online trwało 20 minut. Polecam! - Anna"),
  c("przebieg", "Jak przebiega badanie. 1. Rejestracja online lub telefoniczna. 2. Badanie w placówce lub przez system telemedyczny. 3. Orzeczenie w 24 h."),
  c("bron", "Pozwolenie na broń: badania lekarskie i psychologiczne dla osób ubiegających się o pozwolenie na broń, kolekcjonerów i myśliwych."),
];

live("knowledge catalog", () => {
  it("sorts chunks into seed catalogs and grows a new one from 'other'", async () => {
    const namer = async () => [{ id: "", name: "Pozwolenie na broń", description: "Medical and psychological exams for gun permits." }];
    const cat = (await buildCatalog(CHUNKS, namer))!;
    const of = (id: string) => cat.chunks.find((x) => x.id === id)!.catalogId;
    expect(of("ursynow")).toBe("locations");
    expect(of("gdansk")).toBe("locations");
    expect(of("cennik")).toBe("pricing");
    expect(of("zespol")).toBe("people");
    expect(of("opinia")).toBe("reviews");
    expect(cat.catalogs.every((k) => cat.chunks.some((x) => x.catalogId === k.id))).toBe(true);
  }, 60000);

  it("answers an all-branches question with every branch and refuses off-site ones", async () => {
    const cat = (await buildCatalog(CHUNKS, null))!;
    const all = await retrieveFromCatalog("Gdzie jesteście i w jakich godzinach pracujecie?", cat);
    const ids = all!.hits.map((h) => h.chunk.id);
    expect(ids).toEqual(expect.arrayContaining(["ursynow", "targowek", "gdansk"]));
    const off = await retrieveFromCatalog("Czy robicie rezonans magnetyczny głowy?", cat);
    expect(off!.hits.length).toBe(0);
  }, 60000);
});

describe("parseNamerReply", () => {
  it("reads JSON wrapped in prose or code fences", () => {
    expect(parseNamerReply('Sure:\n```json\n{"catalogs":[{"name":"Broń","description":"Gun permits."}]}\n```')).toEqual([{ id: "", name: "Broń", description: "Gun permits." }]);
    expect(parseNamerReply("no json here")).toEqual([]);
  });
});

describe("lexicalCandidates (BM25 over the catalog)", () => {
  it("finds the chunk holding a rare query word even when its catalog is not about the question", async () => {
    const { lexicalCandidates } = await import("../src/knowledge/catalog.js");
    const mk = (id: string, catalogId: string, content: string) => ({ id, catalogId, content, url: "https://x.pl/" + id, title: id, type: "" });
    const cat = { version: 1 as const, builtAt: "", catalogs: [], chunks: [
      mk("uslugi", "services", "Badania medycyny pracy: badania wstępne, okresowe i kontrolne dla pracowników."),
      mk("kierowcy", "services", "Badania lekarskie kierowców, badania psychotechniczne, orzeczenie."),
      mk("synevo", "pricing", "Badania dodatkowe. Badania laboratoryjne zapewnia partner Synevo. Pobranie krwi 10 zł. ALT 46 zł."),
      mk("godziny", "locations", "Ursynów pon.-pt. 8:00-17:00."),
    ] };
    expect(lexicalCandidates("Czy robicie badania krwi na miejscu?", cat, 2)[0].id).toBe("synevo");
    expect(lexicalCandidates("Czy robicie?", cat)).toEqual([]);
  });
});
