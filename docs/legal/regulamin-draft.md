# Regulamin świadczenia usług Whisp - PROJEKT do weryfikacji prawnika

> Projekt z 2026-10-30, oparty na tym, jak system faktycznie działa. Miejsca oznaczone **[DO DECYZJI]**
> wymagają decyzji właściciela, **[PRAWNIK]** - oceny prawnika. Dane spółki są tymczasowe.

## § 1. Usługodawca

1. Usługi świadczy **Whisp sp. z o.o.**, ul. Polna 5, 00-625 Warszawa, NIP **[DO UZUPEŁNIENIA]**, KRS **[DO UZUPEŁNIENIA]**, kapitał zakładowy **[DO UZUPEŁNIENIA]** ("Usługodawca").
2. Kontakt: jakub@whisp.so.

## § 2. Definicje

1. **Klient** - przedsiębiorca (osoba fizyczna prowadząca działalność gospodarczą, osoba prawna lub jednostka organizacyjna), który zawiera umowę w związku ze swoją działalnością gospodarczą. Usługi nie są przeznaczone dla konsumentów.
2. **Asystent** - czat umieszczany na stronie internetowej Klienta, odpowiadający osobom odwiedzającym stronę na podstawie informacji o Kliencie.
3. **Panel** - konto Klienta w serwisie whisp.so, w którym Klient przegląda rozmowy, zarządza informacjami Asystenta i ustawieniami.
4. **Informacje Klienta** - treści, na podstawie których odpowiada Asystent: treści odczytane ze strony internetowej Klienta, pliki, cenniki i odpowiedzi dodane przez Klienta w Panelu.
5. **Użytkownik** - osoba pisząca z Asystentem na stronie Klienta.
6. **Sieć Whisp** - funkcja przekazywania zapytań Użytkowników do innych firm korzystających z Whisp, które mogą je zrealizować, oraz przyjmowania takich zapytań przez Klienta.
7. **Abonament** - odpłatny plan usług rozliczany miesięcznie.

## § 3. Zakres usług

1. Usługodawca udostępnia Klientowi:
   1. Asystenta, który odpowiada Użytkownikom na podstawie Informacji Klienta, przyjmuje zapytania i przekazuje je Klientowi;
   2. automatyczny odczyt publicznych treści ze strony internetowej Klienta w celu przygotowania Informacji Klienta;
   3. Panel z historią rozmów, zestawieniem najczęstszych pytań i powiadomieniami o pytaniach, na które Asystent nie znał odpowiedzi;
   4. powiadomienia e-mail i SMS dla Klienta oraz - za zgodą Użytkownika wyrażoną w czacie - dla Użytkownika;
   5. przygotowywanie przez Asystenta wycen i zestawień na podstawie cennika Klienta, w trybie wybranym przez Klienta (od razu do Użytkownika albo po zatwierdzeniu przez Klienta);
   6. Sieć Whisp - jeżeli Klient z niej korzysta. **[DO DECYZJI: Sieć jako pilotaż - opisać jako funkcję testową, bez gwarancji liczby zapytań.]**
2. Szczegółowy zakres planów i ceny określa cennik na stronie whisp.so. **[DO DECYZJI: cennik na stronie jest nieaktualny (plany Free / 149 / 299 zł, funkcje których nie ma, np. API, porównanie z konkurencją). Do ustalenia jedna oferta - obecnie w Stripe jest jeden plan 149 zł/mies.]**

## § 4. Wymagania techniczne

1. Do korzystania z Panelu potrzebne są: urządzenie z dostępem do internetu, aktualna przeglądarka z włączoną obsługą JavaScript oraz adres e-mail.
2. Do umieszczenia Asystenta na stronie Klient wkleja na swojej stronie dostarczony fragment kodu lub instaluje wtyczkę (np. WordPress).
3. Usługodawca informuje o zagrożeniach związanych z korzystaniem z usług świadczonych drogą elektroniczną (np. złośliwe oprogramowanie, przejęcie hasła). Klient chroni swoje dane logowania.

## § 5. Zawarcie umowy

1. Umowa zostaje zawarta z chwilą utworzenia konta Klienta i akceptacji Regulaminu. Klient oświadcza, że zawiera umowę jako przedsiębiorca w związku ze swoją działalnością.
2. Abonament zaczyna się z chwilą opłacenia pierwszego okresu w formularzu płatności.
3. Osoba zakładająca konto w imieniu Klienta oświadcza, że jest do tego umocowana.

## § 6. Płatności

1. Abonament jest płatny z góry za każdy miesiąc, kartą lub inną metodą udostępnioną przez operatora płatności Stripe. **[DO DECYZJI: cena netto czy brutto; VAT 23% - w Stripe nie jest ustawione.]**
2. Abonament odnawia się automatycznie co miesiąc, dopóki Klient go nie anuluje.
3. Klient może anulować Abonament w każdej chwili w Panelu (portal płatności Stripe). Anulowanie działa na koniec opłaconego okresu; za rozpoczęty okres opłata nie jest zwracana.
4. Usługodawca wystawia faktury elektroniczne, na co Klient wyraża zgodę.
5. O zmianie ceny Usługodawca informuje e-mailem co najmniej 30 dni wcześniej; Klient, który się nie zgadza, może anulować Abonament przed zmianą.
6. Jeżeli płatność się nie powiedzie, Usługodawca może ograniczyć funkcje płatne do czasu jej uregulowania.

## § 7. Obowiązki Klienta

1. Klient odpowiada za to, że Informacje Klienta są zgodne z prawem i prawdziwe oraz że ma prawo z nich korzystać, w tym zlecić ich odczyt ze swojej strony.
2. Klient aktualizuje Informacje Klienta (ceny, godziny, dostępność) - Asystent odpowiada na podstawie informacji, które ma.
3. Klient, jako administrator danych Użytkowników, informuje Użytkowników swojej strony o przetwarzaniu ich danych, w tym o korzystaniu z Asystenta (np. w polityce prywatności swojej strony).
4. Klient nie używa usług do wprowadzania w błąd, rozsyłania niezamówionych informacji handlowych ani w sposób naruszający prawo lub prawa osób trzecich.
5. Klient nie próbuje obejść zabezpieczeń ani limitów usług, nie obciąża ich w sposób zakłócający działanie i nie odsprzedaje ich bez zgody Usługodawcy.

## § 8. Odpowiedzi Asystenta

1. Odpowiedzi Asystenta tworzą automatycznie modele sztucznej inteligencji na podstawie Informacji Klienta. Usługodawca stosuje kontrole ograniczające błędy (m.in. sprawdzanie odpowiedzi z Informacjami Klienta, kwoty liczone przez system z cennika Klienta), ale odpowiedzi mogą zawierać błędy lub być niepełne.
2. Ceny, wyceny i terminy podane przez Asystenta są informacyjne; wiążące dla Klienta są dopiero po potwierdzeniu przez Klienta, chyba że Klient ustawi inaczej. **[PRAWNIK: czy wystarczy wobec Użytkownika (konsumenta) - może potrzebny komunikat w czacie.]**
3. Klient może w Panelu przeglądać rozmowy, poprawiać Informacje Klienta i dodawać odpowiedzi na pytania, na które Asystent nie znał odpowiedzi.

## § 9. Odpowiedzialność

1. Usługodawca dokłada starań, by usługi działały nieprzerwanie, ale nie gwarantuje stałej dostępności. Prace serwisowe mogą powodować krótkie przerwy.
2. Usługodawca nie odpowiada za: treść Informacji Klienta; decyzje podjęte na podstawie odpowiedzi Asystenta bez ich sprawdzenia; przerwy wynikłe z działania dostawców infrastruktury, sieci lub siły wyższej; treść ofert i działania innych firm z Sieci Whisp.
3. Odpowiedzialność Usługodawcy wobec Klienta jest ograniczona do szkody rzeczywistej i do kwoty opłat zapłaconych przez Klienta w ostatnich 3 miesiącach; nie obejmuje utraconych korzyści. Ograniczenie nie dotyczy szkody wyrządzonej umyślnie. **[PRAWNIK: wysokość limitu; art. 473 § 2 KC.]**

## § 10. Dane osobowe

1. Dane Klienta i osób działających w jego imieniu przetwarza Usługodawca jako administrator - zasady opisuje polityka prywatności: whisp.so/polityka-prywatnosci.
2. Dane Użytkowników Usługodawca przetwarza w imieniu Klienta jako podmiot przetwarzający, na zasadach umowy powierzenia przetwarzania danych osobowych stanowiącej Załącznik nr 1. Akceptując Regulamin, Klient zawiera tę umowę.

## § 11. Reklamacje

1. Reklamacje można składać na adres jakub@whisp.so, opisując problem i podając adres e-mail konta.
2. Usługodawca odpowiada na reklamację w ciągu 14 dni.

## § 12. Czas trwania i rozwiązanie umowy

1. Umowa jest zawarta na czas nieokreślony.
2. Klient może rozwiązać umowę w każdej chwili, usuwając konto lub pisząc na jakub@whisp.so; opłacony Abonament działa do końca okresu.
3. Usługodawca może rozwiązać umowę z 30-dniowym wypowiedzeniem, a ze skutkiem natychmiastowym - gdy Klient rażąco narusza Regulamin lub prawo.
4. Po rozwiązaniu umowy Asystent przestaje działać, a dane Klienta i Użytkowników są usuwane w terminach z Załącznika nr 1 i polityki prywatności, z wyjątkiem danych, które Usługodawca musi przechowywać na podstawie przepisów (np. faktury). **[DO DECYZJI: termin usunięcia po rozwiązaniu - proponuję 30 dni; dziś rozmowy usuwane są 12 miesięcy od ostatniej wiadomości, niezależnie od umowy.]**

## § 13. Zmiany Regulaminu

1. Usługodawca może zmienić Regulamin z ważnych przyczyn (zmiana przepisów, zakresu usług, cen, bezpieczeństwa), informując Klienta e-mailem co najmniej 14 dni przed zmianą.
2. Klient, który nie akceptuje zmian, może rozwiązać umowę przed ich wejściem w życie.

## § 14. Postanowienia końcowe

1. Do umowy stosuje się prawo polskie.
2. Spory rozstrzyga sąd właściwy dla siedziby Usługodawcy.
3. Regulamin obowiązuje od **[DATA]**.

Załącznik nr 1 - Umowa powierzenia przetwarzania danych osobowych (osobny dokument).
