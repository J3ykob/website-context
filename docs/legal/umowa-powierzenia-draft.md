# Załącznik nr 1 do Regulaminu - Umowa powierzenia przetwarzania danych osobowych - PROJEKT do weryfikacji prawnika

> Projekt z 2026-10-30 (art. 28 RODO), oparty na tym, jak system faktycznie działa. **[DO DECYZJI]** -
> decyzja właściciela, **[PRAWNIK]** - ocena prawnika.

## § 1. Strony i przedmiot

1. Umowę zawierają Klient (**Administrator**) i Whisp sp. z o.o., ul. Polna 5, 00-625 Warszawa (**Przetwarzający**), z chwilą akceptacji Regulaminu.
2. Administrator powierza Przetwarzającemu przetwarzanie danych osobowych Użytkowników w zakresie i celu potrzebnym do świadczenia usług z Regulaminu.

## § 2. Zakres powierzenia

1. **Kategorie osób:** osoby piszące z Asystentem na stronie Administratora (klienci i potencjalni klienci Administratora).
2. **Rodzaje danych:** treść rozmów i przesłanych zapytań; identyfikator sesji; adres IP; dane, które Użytkownik sam poda - zwykle imię, adres e-mail, numer telefonu, miejscowość lub adres realizacji, opis potrzeby. Usługa nie jest przeznaczona do szczególnych kategorii danych (art. 9 RODO); Administrator nie kieruje Asystenta do ich zbierania.
3. **Charakter i cel:** przechowywanie rozmów; tworzenie odpowiedzi przez modele sztucznej inteligencji; przyjmowanie zapytań i przekazywanie ich Administratorowi; powiadomienia e-mail i SMS do Użytkownika, gdy wyrazi na to zgodę w czacie; przygotowywanie wycen i zestawień; zabezpieczenie usługi przed nadużyciami.
4. **Sieć Whisp:** jeżeli Administrator z niej korzysta, zapytanie Użytkownika, którego Administrator nie realizuje, może zostać przekazane innym firmom z Sieci - bez danych kontaktowych Użytkownika; firma widzi opis zapytania (pełną treść, gdy ma Abonament), a jej odpowiedź trafia do Użytkownika przez stronę statusu zapytania. Treść zapytania może zawierać dane, które Użytkownik sam w nim napisał. **[DO DECYZJI / PRAWNIK: dziś Sieć działa dla firm z sieci, bez osobnego przełącznika w Panelu - potrzebny wyraźny przełącznik lub zgoda Użytkownika w czacie; sprawdzić, czy przekazanie do innej firmy to jeszcze polecenie Administratora.]**
5. **Czas:** przez czas trwania umowy oraz do usunięcia danych zgodnie z § 8.

## § 3. Obowiązki Przetwarzającego

1. Przetwarza dane wyłącznie na udokumentowane polecenie Administratora - poleceniem jest Regulamin, ta umowa i ustawienia wybrane w Panelu - także w zakresie przekazywania danych do państwa trzeciego, chyba że obowiązek wynika z prawa; wtedy informuje o nim Administratora, o ile prawo tego nie zabrania.
2. Zapewnia, że osoby upoważnione do przetwarzania danych zobowiązały się do zachowania poufności.
3. Stosuje środki bezpieczeństwa z § 4.
4. Korzysta z dalszych podmiotów przetwarzających na zasadach § 5.
5. Pomaga Administratorowi wykonywać obowiązki wobec osób, których dane dotyczą (dostęp, sprostowanie, usunięcie, ograniczenie, przeniesienie, sprzeciw) - m.in. przez wgląd w rozmowy w Panelu i usunięcie rozmowy na żądanie Administratora.
6. Pomaga Administratorowi w obowiązkach z art. 32-36 RODO, uwzględniając charakter przetwarzania i dostępne informacje.
7. Udostępnia informacje potrzebne do wykazania spełnienia obowiązków i umożliwia audyt (§ 7).
8. Niezwłocznie informuje Administratora, jeśli jego polecenie narusza w ocenie Przetwarzającego przepisy o ochronie danych.
9. Nie wykorzystuje danych Użytkowników do własnych celów. **[PRAWNIK - WAŻNE: dziś decyzje modeli (np. dopasowanie zapytania do pozycji cennika, podział zapytania na części) są zapisywane razem z treścią zapytania przez 365 dni, aby ulepszać dopasowanie - polityka prywatności to opisuje. Jako podmiot przetwarzający nie możemy tego robić na własne potrzeby bez podstawy. Opcje: (a) zapisywać bez danych osobowych (zanonimizowane), (b) polecenie Administratora w umowie (ulepszanie usługi dla niego), (c) osobna podstawa jako administrator. Rekomendacja techniczna: (a).]**

## § 4. Środki bezpieczeństwa (art. 32 RODO)

Przetwarzający stosuje co najmniej:
1. szyfrowanie połączeń (HTTPS/TLS) między przeglądarką, serwerami i dostawcami; szyfrowanie danych w spoczynku po stronie dostawców infrastruktury (Cloudflare);
2. kontrolę dostępu: konta Klientów z hasłem przechowywanym wyłącznie jako skrót kryptograficzny; dostęp administracyjny tylko z tajnym kluczem; Panel pokazuje Klientowi wyłącznie jego dane;
3. rozdzielenie danych Klientów w bazie i magazynie plików;
4. maskowanie danych osobowych przed przekazaniem zapytania do modelu, który przygotowuje wyceny i zestawienia;
5. limity zapytań, limity kosztów i rejestr nadużyć chroniące przed atakami i nadmiernym obciążeniem;
6. usuwanie danych po upływie okresów z § 8 (automatycznie, codziennie);
7. ograniczenie dostępu personelu Przetwarzającego do danych do przypadków potrzebnych do obsługi usługi, zgłoszeń i bezpieczeństwa.

**[PRAWNIK / DO DECYZJI: kopie zapasowe - opisać, czy i jak długo (dziś: mechanizmy dostawców, brak własnej polityki).]**

## § 5. Dalsze podmioty przetwarzające

1. Administrator wyraża ogólną zgodę na korzystanie z dalszych podmiotów przetwarzających. Aktualna lista:

| Podmiot | Zakres | Lokalizacja |
|---|---|---|
| Render Services, Inc. | serwery aplikacji | USA |
| Cloudflare, Inc. | baza danych, pliki, wyszukiwanie, modele do wyszukiwania | UE / globalnie |
| OpenRouter, Inc. i dostawcy modeli AI, przez których OpenRouter kieruje zapytania (m.in. Anthropic, DeepInfra, Novita, Nebius) | tworzenie odpowiedzi, dopasowanie zapytań do oferty | USA / UE |
| TypeSafe | model sprawdzający odpowiedzi i kierujący rozmową | **[DO UZUPEŁNIENIA]** |
| Resend, Inc. | wysyłka e-maili | USA |
| Twilio Inc. | SMS | USA |
| Stripe | płatności (dane Klienta, nie Użytkowników) | USA / UE |
| Browserless | odczyt stron internetowych | USA |

   **[PRAWNIK: czy dostawców modeli wymieniać z nazwy - OpenRouter wybiera ich spośród ustalonej przez nas listy.]**
2. O zamiarze dodania lub zmiany dalszego podmiotu Przetwarzający informuje Administratora e-mailem co najmniej 14 dni wcześniej; Administrator może zgłosić sprzeciw, a gdy sprzeciw uniemożliwia świadczenie usługi - rozwiązać umowę.
3. Przetwarzający nakłada na dalsze podmioty obowiązki ochrony danych nie mniejsze niż w tej umowie i odpowiada za ich wykonanie.

## § 6. Przekazywanie danych poza EOG

Przekazanie danych poza Europejski Obszar Gospodarczy odbywa się na podstawie decyzji stwierdzającej odpowiedni stopień ochrony (Ramy ochrony danych UE-USA) albo standardowych klauzul umownych przyjętych przez Komisję Europejską.

## § 7. Kontrola

1. Administrator może sprawdzać, jak Przetwarzający wykonuje umowę - w pierwszej kolejności przez pytania na piśmie, na które Przetwarzający odpowiada w ciągu 14 dni.
2. Audyt na miejscu jest możliwy po uprzedzeniu co najmniej 14 dni wcześniej, w godzinach pracy, nie częściej niż raz w roku (chyba że doszło do naruszenia), na koszt Administratora, przez audytora zobowiązanego do poufności.

## § 8. Naruszenia, usuwanie danych

1. O naruszeniu ochrony danych Przetwarzający informuje Administratora bez zbędnej zwłoki, nie później niż w ciągu 48 godzin od jego stwierdzenia, podając znane informacje z art. 33 ust. 3 RODO.
2. Okresy przechowywania: rozmowy z czatu i zapisane decyzje modeli - 365 dni od wiadomości; zapytania i ich pliki - 30 dni od utworzenia i od ostatniej aktywności; zdarzenia bezpieczeństwa - do 90 dni.
3. Po zakończeniu umowy Przetwarzający usuwa dane Użytkowników w ciągu **[DO DECYZJI: 30]** dni, chyba że prawo wymaga ich przechowywania; na żądanie Administratora zgłoszone przed końcem umowy przekazuje mu wcześniej rozmowy w formacie elektronicznym.

## § 9. Postanowienia końcowe

1. Odpowiedzialność stron określa RODO i Regulamin.
2. W sprawach nieuregulowanych stosuje się Regulamin, RODO i prawo polskie.
3. W razie sprzeczności z Regulaminem w sprawach ochrony danych pierwszeństwo ma ta umowa.
