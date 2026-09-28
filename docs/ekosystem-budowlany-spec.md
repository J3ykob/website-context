# Ekosystem budowlany Warszawa - specyfikacja systemu komunikacji

Status: projekt (2026-09-28). Kod po pilocie, gdy będą pierwsze firmy zapisane do ekosystemu.
Baza podmiotów: `leads/warszawa-budowlanka/` (112 wykonawców, 30 hurtowni, 26 wynajem/narzędzia).

## Cel

Połączyć trzy typy firm, które i tak ze sobą pracują, przez boty Whisp, które już stoją na ich stronach:

- **Wykonawca** (W) - remonty, wykończenia, instalacje, dachy, elewacje.
- **Hurtownia** (H) - materiały, instalacje, elektryka, ceramika, chemia, drewno, beton.
- **Wypożyczalnia / narzędzia** (S) - sprzęt, rusztowania, zwyżki, kontenery, elektronarzędzia, BHP.
- **Klient końcowy** (K) - osoba lub firma, która pisze do bota którejkolwiek z nich.

Każdy podmiot to zwykły tenant Whisp (bot + opcjonalnie mikrostrona `/site/:id`). Ekosystem to warstwa nad tenantami, a nie osobny produkt.

## Przepływy (kolejność wdrażania)

### 1. Polecenia (K -> W przez bota H/S lub innego W)

- K pyta bota hurtowni: "polecicie ekipę do łazienki na Woli?". Bot odpowiada 2-3 wykonawcami z ekosystemu dopasowanymi po zakresie + dzielnicy (linki do ich stron/botów).
- Wykonawca bez terminów / spoza zakresu: jego bot, zamiast "nie robimy tego", proponuje firmę z ekosystemu.
- Przekazanie danych K do W (imię, telefon, opis) **tylko po wyraźnej zgodzie K w rozmowie**. Bez zgody - tylko podajemy kontakt do W.
- Każde polecenie = rekord w `eco_requests` (type=`referral`), żeby było wiadomo, kto komu ile przyniósł (podstawa pod rozliczenia / wzajemność).

### 2. Zapytania materiałowe (W -> H)

- W pisze zwykłym tekstem (panel, SMS, e-mail na adres ekosystemu, docelowo WhatsApp): "40 worków Geoflex, 20 płyt GK 12,5, dostawa Wola czwartek rano".
- LLM (Jev) **tylko** zamienia tekst na strukturę: pozycje (nazwa, ilość, jednostka), adres/dzielnica dostawy, termin, uwagi. Nic nie rozstrzyga.
- Dopasowanie hurtowni to reguły w kodzie: kategoria pozycji ∩ kategorie H, strefa dostaw H obejmuje dzielnicę, H aktywna i zapisana. Max 3-5 H na zapytanie.
- H dostaje e-mail/SMS z linkiem (magic link, bez logowania) do formularza odpowiedzi: cena per pozycja lub całość, dostępność, termin i koszt dostawy, ważność oferty.
- W dostaje zestawienie ofert (link), wybiera jedną -> H dostaje "zamówienie potwierdzone" + kontakt do W. Płatność i faktura poza systemem (na start).
- Opcja później: bot W po wycenie remontu z klientem generuje szkic listy materiałów -> gotowe zapytanie do H.

### 3. Rezerwacja sprzętu (W -> S)

- Ten sam mechanizm co 2, pozycje to sprzęt + **zakres dat** (od-do) + dowóz/odbiór.
- S odpowiada: dostępne / niedostępne / alternatywa, cena za dobę, kaucja, dowóz.

### 4. Komunikaty (H/S -> W)

- Promocje, wyprzedaże końcówek, nowy sprzęt. Tylko do W, którzy zaznaczyli zgodę na komunikaty od danej kategorii.
- Limit częstotliwości per nadawca (np. 1 / tydzień), link do wypisu w każdej wiadomości.

## Model danych (D1, obok `tenants`)

```sql
-- kto jest w ekosystemie i czego szuka / co oferuje
CREATE TABLE eco_members (
  tenant_id TEXT PRIMARY KEY,            -- FK tenants.id
  role TEXT NOT NULL,                    -- 'wykonawca' | 'hurtownia' | 'sprzet'
  categories TEXT NOT NULL,              -- JSON: ["ceramika","chemia_sucha_zabudowa"] / ["remonty","lazienki"]
  districts TEXT NOT NULL,               -- JSON: dzielnice obsługi / strefa dostaw (["Wola","Ochota"] lub ["*"])
  contact_email TEXT, contact_phone TEXT,
  channels TEXT NOT NULL,                -- JSON: ["email","sms"] - gdzie wysyłać zapytania
  accepts_requests INTEGER DEFAULT 1,    -- H/S: czy przyjmuje zapytania
  accepts_broadcasts INTEGER DEFAULT 0,  -- W: zgoda na komunikaty
  joined_at TEXT NOT NULL, consent_text TEXT NOT NULL  -- treść zgody, którą zaakceptował
);

CREATE TABLE eco_requests (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,                    -- 'referral' | 'materials' | 'rental'
  from_tenant TEXT,                      -- W (materials/rental) lub tenant, którego bot polecił (referral)
  customer_consent INTEGER DEFAULT 0,    -- referral: czy K zgodził się na przekazanie danych
  raw_text TEXT,                         -- oryginalna treść
  payload TEXT NOT NULL,                 -- JSON: pozycje / daty / dzielnica / termin
  status TEXT NOT NULL,                  -- 'open' | 'offered' | 'accepted' | 'closed' | 'expired'
  created_at TEXT NOT NULL, expires_at TEXT
);

CREATE TABLE eco_request_targets (       -- do kogo poszło i czy odpowiedział
  request_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,              -- magic link (hash, jednorazowy per target)
  notified_at TEXT, opened_at TEXT, responded_at TEXT,
  PRIMARY KEY (request_id, tenant_id)
);

CREATE TABLE eco_offers (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
  payload TEXT NOT NULL,                 -- JSON: ceny, dostępność, dostawa, ważność
  status TEXT NOT NULL,                  -- 'sent' | 'accepted' | 'rejected'
  created_at TEXT NOT NULL
);

CREATE TABLE eco_messages (              -- log każdej wysłanej wiadomości (audyt + limity)
  id TEXT PRIMARY KEY, request_id TEXT, to_tenant TEXT, channel TEXT,
  kind TEXT,                             -- 'request' | 'offer' | 'accepted' | 'broadcast' | 'reminder'
  sent_at TEXT NOT NULL, provider_id TEXT, error TEXT
);
```

## Kanały

- **E-mail (Resend)** - domyślny. Każda wiadomość = krótki tekst + jeden przycisk z magic linkiem.
- **SMS (Twilio, już podpięte pod voice)** - dla H/S, które wolą SMS; treść <= 160 znaków + krótki link.
- **Strona odpowiedzi** `/eco/r/:token` - formularz oferty, działa na telefonie, bez konta. Token jednorazowy per (zapytanie, odbiorca), ważny do `expires_at`.
- **Panel** - zakładka "Ekosystem" w istniejącym dashboardzie: moje zapytania, oferty, polecenia.
- Później: WhatsApp Business (fachowcy realnie tam siedzą), Messenger przez istniejący `src/channels/meta.ts`.

## Integracja z botem

- Nowe narzędzie w czacie (obok flows/agent): `eco_refer(zakres, dzielnica)` -> lista W z `eco_members`, a nie z pamięci LLM. Bot może polecić tylko firmy, które się zapisały.
- Zgoda K na przekazanie danych: jawne pytanie + potwierdzenie w rozmowie, zapisane w `eco_requests.customer_consent` (bramka w kodzie, jak consent w agent flows).
- Bot H/S nie wycenia za W i nie obiecuje terminów W.

## Zasady / RODO

- Dane z bazy researchu (publiczne dane firm) służą wyłącznie do pierwszego kontaktu. Do `eco_members` trafia firma dopiero po samodzielnym zapisie z zaakceptowaną zgodą (zapisujemy jej treść).
- Zapytania i komunikaty wysyłamy wyłącznie do członków. Nikt spoza ekosystemu nie dostaje automatycznych wiadomości.
- Dane klienta końcowego - tylko za zgodą, tylko do wybranego W, z informacją, komu je przekazano.
- Szablony wiadomości do akceptacji przed pierwszą wysyłką (jak wszystkie szablony e-mail).

## Kolejność wdrożenia

1. **Pilot (teraz):** 15 tenantów w klastrze Białołęka / Targówek / Praga / Wawer (3 H, 2 S, 10 W) - demo botów + mikrostrony dla słabych stron. Bez wysyłek.
2. **Kotwica:** 2-3 hurtownie zapisane jako pierwsze - każda ma dziesiątki stałych klientów-wykonawców, więc to one ściągają W ("Wasi klienci zamawiają przez czat").
3. **MVP ekosystemu:** `eco_members` + polecenia (przepływ 1) - widać efekt od razu w demo bota hurtowni.
4. **Zapytania materiałowe + wynajem** (2, 3) z magic linkami.
5. **Komunikaty** (4), WhatsApp, rozliczenia poleceń.

## Otwarte decyzje

- Model przychodu: abonament za bota/stronę vs prowizja od zaakceptowanych ofert vs płatne polecenia.
- Czy ekosystem jest jeden (Warszawa) czy per hurtownia (white-label: "sieć wykonawców Marsan").
- Kto moderuje członków (weryfikacja NIP w białej liście VAT przy zapisie - automatycznie).
