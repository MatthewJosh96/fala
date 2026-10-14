# Akceptacja — bramka PWA (test nocny)

Cel: rozstrzygnąć decyzję z `DECISIONS.md` (2026-10-13, „Bramka PWA”): czy PWA na iPhonie odtwarza
pełny 8-godzinny plik **offline, przy zablokowanym ekranie**, bez przerw ≥10 ms. Powtarzalna awaria
systemowa → Capacitor z małym natywnym adapterem AVPlayer (UI zostaje, wymieniany jest tylko `Player`).

Stan (2026-10-14): aplikacja, pliki diagnostyczne (8 h, 30 min, 120 s), detektor i skrypt nagrywania
są gotowe i przetestowane lokalnie (Vitest 119, Playwright 22 + 2 opcjonalne: plik 8 h i zrzuty ekranów,
pytest 52). Aplikacja działa pod ścieżką `/fala/` (jak na GitHub Pages, `docs/DEPLOY.md`), także lokalnie.
Plik 8 h usunięto 2026-10-14 (brak miejsca na dysku) — przed testem wygeneruj go ponownie (§3).
**Nie wykonano**: udostępnienia telefonowi (wymaga zgody Maćka), próby generalnej z mikrofonem,
testu nocnego, testów przerwań.

## 1. Co jest w repo

| Element | Ścieżka | Uruchomienie |
|---|---|---|
| PWA (React + TS + Vite, Workbox) | `apps/fala/` | `npm ci && npm run build && npm run preview` |
| Testy jednostkowe (Vitest) | `apps/fala/src/**/*.test.ts`, `apps/fala/server/*.test.ts` | `npm test` |
| Testy e2e (Playwright, Chromium) | `apps/fala/e2e/` | `npm run test:e2e` (sam buduje i uruchamia serwer na :4317, aplikacja pod `/fala/`) |
| Generator pliku diagnostycznego | `tools/audio/diagnostic/` + `analysis/src/fala_audio_check/diagnostic.py` | patrz §3 |
| Detektor ciągłości | `analysis/src/fala_audio_check/continuity.py` | patrz §6 |
| Skrypt nagrywania (Mac) | `tools/audio/diagnostic/record_mac.sh` | patrz §5 |

Jak działa odtwarzanie offline (skrót): jedno `<audio>`, żadnego `AudioContext`, timerów ani handlera
`ended`. Plik jest jawnie pobierany do Cache Storage w porcjach po 2 MiB, z SHA-256 liczonym w locie i
odczytem kontrolnym z pamięci; wpis „meta” powstaje dopiero po pozytywnej weryfikacji. Service Worker
odpowiada na żądania Range (200/206/416) z tych porcji, czytając najwyżej jedną porcję na raz.
Ekran blokady: Media Session (tytuł, okładka, odtwórz/pauza, przewijanie). Dziennik odtwarzania
(pauzy, `waiting`, `stalled`, błędy, zmiany widoczności) jest w zakładce „Pobrane”.

## 2. Uruchomienie lokalne

```sh
cd apps/fala
npm ci                      # .npmrc ma legacy-peer-deps (błąd npm z opcjonalnymi peerami)
npm test                    # Vitest
npm run test:e2e            # Playwright: tryby, minutnik, oddech, pobranie → offline → odtworzenie, Pobrane → Odtwórz do końca
npm run build
FALA_MEDIA_DIR="$PWD/../../renders/diagnostic" npm run preview   # http://localhost:4317/fala/
```

`FALA_MEDIA_DIR` to katalog z plikami `.m4a` i ich sidecarami `.json` (generator tworzy oba); do testu
nocnego `renders/diagnostic/` (poza Gitem). Bez tej zmiennej serwer bierze `apps/fala/.media`, czyli
utwory trybów przygotowane przez `npm run media:stage`. Serwer mediów jest wpięty w `vite preview`
(`apps/fala/server/mediaPlugin.ts`): `/fala/media/index.json` to katalog ścieżek, `/fala/media/<plik>`
obsługuje Range. Plik nie trafia do `dist/` ani do precache Workboxa. Pliki diagnostyczne nie mają
trybów, więc w aplikacji są tylko w „Pobranych” (przycisk **Odtwórz** → ekran „Odtwarzacz testowy”:
bez pętli i minutnika, plik gra do końca).

## 3. Plik diagnostyczny

Protokół `fala-diag-v1` (szczegóły: `tools/audio/diagnostic/README.md`, docstring
`analysis/src/fala_audio_check/timecode.py`): ciągły, deterministyczny szum różowy −26 dBFS RMS
(100 Hz–12 kHz), a na początku każdej sekundy burst — chirp 40 ms 1000→4500 Hz (oś czasu), 10 ms
przerwy i 6 symboli MFSK-16 po 30 ms z numerem sekundy (16 bitów + CRC-8). Pasmo 5,5–11 kHz zawiera
wyłącznie tło — tam detektor szuka wyciszeń. Render blokami po 10 s strumieniowo do stdin ffmpeg
(bez pośredniego WAV), koder `aac_at` (Apple, CBR), AAC-LC 128 kb/s, 48 kHz, stereo, `+faststart`.

Wygenerowane pliki (poza Gitem, `renders/diagnostic/`, każdy z sidecarem `.json` z `size` i `sha256`):

| Plik | Rozmiar | SHA-256 | Weryfikacja po zdekodowaniu |
|---|---|---|---|
| `fala-diag-8h.m4a` (28 800 s; usunięty 2026-10-14, regeneruj poniżej) | 466 206 493 B | `c99e298f3dc2bd8cbcd08a1a13b9922747c65c756724ec3e51f687abfd84a8cd` | ffprobe: aac LC 48 kHz 2 ch 128 kb/s, 28 800,0 s; 7 okien (początek, 5 losowych, koniec) odczytane, ostatnia sekunda 28799 |
| `fala-diag-30min.m4a` (1 800 s, testy przerwań) | 29 139 608 B | w sidecarze | ostatnia sekunda 1799 |
| `fala-diag-120s.m4a` (próba generalna) | 1 944 357 B | w sidecarze | ostatnia sekunda 119 |

Generowanie 8 h: 155 s na Macu mini M4 Pro, stała pamięć (~220 MB RSS).

```sh
tools/audio/diagnostic/generate.sh --duration-s 28800 --out renders/diagnostic/fala-diag-8h.m4a \
  --title "Fala — diagnostyka 8 h" --id fala-diag-8h --verify
tools/audio/diagnostic/generate.sh verify renders/diagnostic/fala-diag-8h.m4a   # ponowna weryfikacja
```

Ten sam plik przeszedł w Chromium całą ścieżkę PWA (opcjonalny test
`apps/fala/e2e/large-file.spec.ts`): pobranie 466 MB z podwójnym SHA-256 w 13,6 s, przeładowanie
offline, odtwarzanie, przewinięcie do połowy i do 7:59:57, koniec pliku bez błędu.

```sh
cd apps/fala
FALA_E2E_MEDIA_DIR="$PWD/../../renders/diagnostic" FALA_E2E_LARGE_FILE=fala-diag-8h.m4a \
  npx playwright test e2e/large-file.spec.ts
```

## 4. Udostępnienie telefonowi (HTTPS) — wybór Maćka

Service Worker działa tylko w bezpiecznym kontekście (HTTPS lub `localhost`), więc iPhone potrzebuje
adresu HTTPS. Nic z poniższego nie zostało uruchomione. Serwer jest potrzebny **tylko** do instalacji
i pobrania pliku; w nocy telefon jest offline.

### Opcja A (rekomendowana): `tailscale serve` w tailnecie

Adres: `https://maciejs-mac-mini.tail0d9374.ts.net/fala/` — widoczny tylko dla urządzeń w Twoim tailnecie,
certyfikat Let's Encrypt wystawia Tailscale. Telefon i tak jest już w tailnecie (Termius/SSH).

1. Jednorazowo: w panelu Tailscale → DNS włącz **MagicDNS** i **HTTPS Certificates**
   (`tailscale status --json` pokazuje teraz `CertDomains: null`, czyli certyfikaty prawdopodobnie są
   wyłączone; `tailscale serve` przy pierwszym uruchomieniu poda link do włączenia).
2. Na Macu:
   ```sh
   cd apps/fala && npm run build
   FALA_MEDIA_DIR="$PWD/../../renders/diagnostic" npm run preview &   # :4317 tylko na localhost
   tailscale serve --bg 4317          # https://maciejs-mac-mini.tail0d9374.ts.net → localhost:4317 (aplikacja: /fala/)
   tailscale serve status
   ```
3. Po pobraniu pliku na telefon: `tailscale serve reset` (obecnie nie ma innej konfiguracji serve,
   więc reset niczego nie usuwa) i zatrzymaj `vite preview`.

Plusy: brak publicznego adresu, prawdziwy certyfikat, transfer 460 MB po sieci lokalnej (połączenie
bezpośrednie). Minus: zmiana konfiguracji Tailscale (serve) na czas instalacji. `vite.config.ts` ma
`preview.allowedHosts: ['.ts.net']`, inaczej Vite odrzuci żądania z nagłówkiem Host tailnetu.

### Opcja B: tymczasowy tunel HTTPS (Cloudflare Quick Tunnel)

```sh
brew install cloudflared            # nie jest zainstalowany
cd apps/fala && npm run build
FALA_MEDIA_DIR="$PWD/../../renders/diagnostic" npm run preview &
cloudflared tunnel --url http://localhost:4317   # wypisze https://<losowe>.trycloudflare.com (aplikacja: /fala/)
```

W `vite.config.ts` trzeba wtedy dopisać `'.trycloudflare.com'` do `preview.allowedHosts`.
Plusy: bez konta i bez zmian w Tailscale. Minusy: adres jest **publiczny** (nieodgadywalny, ale każdy
z linkiem ma dostęp, dopóki tunel działa), 460 MB idzie przez Cloudflare, a każdy nowy tunel to nowy
origin — zainstalowana PWA i jej pobrane dane są przypisane do originu, więc po zmianie adresu trzeba
instalować i pobierać od nowa.

Dlaczego nie wersja z GitHub Pages (`docs/DEPLOY.md`): publikowany jest tylko katalog utworów trybów,
plik diagnostyczny 8 h (466 MB) nie — nie mieści się w rozsądnym limicie strony (Pages: 1 GB na całą
stronę), a przeniesienie go do zewnętrznego magazynu (R2/S3) wymaga CORS i zmian w SW (origin mediów ≠
origin aplikacji). Do jednorazowego testu nie warto. Uwaga: aplikacja z Pages i z serwera lokalnego to
różne originy, czyli osobne instalacje na ekranie początkowym i osobne pobrane pliki.

## 5. Procedura testu nocnego

Przygotowanie (dzień wcześniej)
1. Wygeneruj i zweryfikuj plik 8 h (§3). Sprawdź `df -h ~` — nagranie nocne zajmie ok. 0,9–1,1 GB (FLAC 24 kHz mono); w chwili przygotowania wolne było ok. 7 GiB, zostaw ≥2 GB.
2. Zapisz wersję iOS i model iPhone'a. Tryb niskiego zużycia energii: wyłączony (zapisz stan).
   Telefon na ładowarce (jak przy zwykłym zasypianiu). Skupienie „Sen”/„Nie przeszkadzać” wolno włączyć,
   ale **bez budzików** w oknie testu (budzik to test przerwania, nie test nocny).

Instalacja i pobranie
3. Uruchom serwer i wybrany wariant HTTPS (§4).
4. Na iPhonie w Safari otwórz adres z §4 (z `/fala/` na końcu) → Udostępnij → **Dodaj do ekranu początkowego** (z włączonym
   „Otwórz jako aplikację internetową”).
5. Uruchom Falę **z ekranu początkowego**. Uwaga: Safari i aplikacja z ekranu początkowego mają osobne
   magazyny — plik pobrany w karcie Safari nie będzie widoczny w aplikacji. Aplikacja pokazuje
   ostrzeżenie, gdy działa w karcie przeglądarki.
6. „Pobrane” (link na dole ekranu głównego) → **Pobierz** przy „Fala — diagnostyka 8 h”. Nie blokuj ekranu do końca (pobieranie
   + weryfikacja SHA-256 ok. 466 MB; aplikacja prosi o Wake Lock, ale nie przełączaj się do innych
   aplikacji). Wynik: „Dostępne offline”. Opcjonalnie **Sprawdź plik**.
7. „Pamięć trwała”: jeśli nie „przyznana”, stuknij **Poproś o pamięć trwałą** i zapisz wynik
   (na iOS bywa „nieprzyznana” mimo poprawnej instalacji — wtedy odnotuj, test i tak ma sens).

Odcięcie od sieci
8. Zamknij aplikację w przełączniku aplikacji (przesunięcie w górę).
9. Na Macu zatrzymaj `vite preview` i `tailscale serve reset` / tunel — żeby nie było cichego powrotu
   do sieci.
10. Na iPhonie włącz **tryb samolotowy** i upewnij się, że Wi-Fi i Bluetooth są wyłączone
    (tryb samolotowy pamięta wcześniejsze włączenie Wi-Fi).
11. Uruchom Falę z ekranu początkowego → „Pobrane”: przy „Fala — diagnostyka 8 h” znaczek
    „Dostępne offline”. Tamże Dziennik → **Wyczyść dziennik**.

Nagranie i start
12. Mikrofon: **Mac mini nie ma wbudowanego mikrofonu** — domyślnym wejściem jest kamera MX Brio 705
    (albo inny mikrofon USB). Nie wybieraj „iPhone Microphone” (Continuity) — to testowany telefon.
    W Logi Tune wyłącz redukcję szumów, w Centrum sterowania tryb mikrofonu „Standard” (bez Voice
    Isolation): tłumik zjadłby tło, na którym opiera się wykrywanie wyciszeń.
    Postaw iPhone'a dolną krawędzią (głośnik) w stronę mikrofonu, **20–40 cm**, w cichym pokoju.
    Detektor ma deklarowaną rozdzielczość przy DRR ≥ +6 dB; dalej (DRR +3 dB) gubi 10-ms wyciszenia
    wewnątrz symboli. Plik jest słyszalny (szum + piknięcia co sekundę) — najlepiej pokój, w którym
    nikt nie śpi.
    Głośność umiarkowana (tło szumu ma być wyraźnie słyszalne).
13. Na Macu uruchom nagrywanie (§5a) **przed** startem odtwarzania; sprawdź poziom przez pierwsze 30 s.
14. W „Pobranych” stuknij **Odtwórz** przy „Fala — diagnostyka 8 h” — otworzy się „Odtwarzacz testowy”
    (adres `…/fala/#/odtwarzacz`). Stuknij przycisk odtwarzania. Sprawdź ekran blokady: tytuł, okładka, przycisk pauzy, pasek pozycji
    (Media Session). Zablokuj ekran przyciskiem bocznym. Zapisz godzinę startu.
15. Nie dotykaj telefonu przez co najmniej 8 h 10 min.

Rano
16. Zatrzymaj nagrywanie (Ctrl+C) dopiero po końcu pliku. Odblokuj telefon, zrób zrzuty „Odtwarzacz testowy”
    i „Pobrane → Dziennik odtwarzania”. Oczekiwane: status „Plik odtworzony do końca”, w dzienniku
    `play` na starcie i jedno `pause — koniec pliku`, bez `waiting`/`stalled`/`error`/`pause` w środku.
    Każda pauza zlecona przez aplikację ma tuż przed sobą wpis `pause-request` ze źródłem (przycisk,
    minutnik, system — ekran blokady, słuchawki, klawisze multimedialne); `pause` bez takiego wpisu to
    pauza z samej przeglądarki.
17. Sprawdź log ffmpeg z nagrywania (overruny/dropy po stronie Maca unieważniają nagranie — wtedy
    powtórz noc, to nie jest wynik PWA).
18. Analiza detektorem (§6).

### 5a. Nagrywanie mikrofonem Maca (nie uruchamiano)

Najpierw próba generalna (2 min) z plikiem `fala-diag-120s.m4a` pobranym w aplikacji:

```sh
tools/audio/diagnostic/record_mac.sh --list        # indeks wejścia audio, np. 0 (MX Brio)
tools/audio/diagnostic/record_mac.sh 0 150         # start nagrania, potem na telefonie Pobrane → Odtwórz → ▶
cd analysis && uv run python -m fala_audio_check.continuity \
  ../renders/recordings/<plik>.flac --expected-duration-s 120
```

Oczekiwane: `"pass": true`, `bursts_decoded` 120, jitter < 0,05 ms. Głośność telefonu dobierz tak,
żeby szczyty nagrania były między −20 a −6 dBFS, i nie zmieniaj jej w nocy.

Noc:

```sh
tools/audio/diagnostic/record_mac.sh 0             # domyślnie 29 400 s = 8 h 10 min
```

Skrypt: `caffeinate -ims` (Mac nie zaśnie), ffmpeg avfoundation z `-thread_queue_size 8192`,
mono FLAC 24 kHz 16 bit do `renders/recordings/fala-diag-YYYYmmdd-HHMM.flac` (24 kHz, bo detektor
używa pasma do 11 kHz). Obok: `….ffmpeg.log` (overrun/queue/drop = problem po stronie Maca) i
`….progress.txt` (`speed` co 30 s, ma być ~1,0x). Wcześniejsze zakończenie: `q` lub Ctrl+C.

## 6. Analiza i kryterium zaliczenia

```sh
cd analysis
uv run python -m fala_audio_check.continuity ../renders/recordings/<plik>.flac \
  --expected-duration-s 28800 --json ../renders/recordings/<plik>.report.json
```

Analiza 8 h: ok. 1 min, 1–2 GB RAM; kod wyjścia 0 = pass, 1 = fail. Jak działa detektor
(`analysis/src/fala_audio_check/continuity.py`): filtr dopasowany znajduje każdy chirp z precyzją
podpróbkową i dekoduje numer sekundy; kolejne bursty muszą być dokładnie (n₂ − n₁) s od siebie, z
poprawką na powoli zmienny stosunek zegarów telefonu i Maca (lokalna mediana). Odchyłka to `skip`
(treść utracona), `gap` (wstawiona cisza, z zapadem tła) albo `repeat` (treść zagrana drugi raz).
Niezależnie pasmo tła 5,5–11 kHz daje `dropout` (wyciszenie bez przesunięcia osi) i informacyjne
`level_change`. Ostatni odczytany numer < 28799 to `premature_end` (z podpowiedzią, czy przestał grać
telefon, czy skończyło się nagranie). `pass` = brak awarii i ≥90% odczytanych burstów; niższe
pokrycie daje `inconclusive` (powtórz noc z lepszym ustawieniem mikrofonu).

Rozdzielczość (kalibracja na symulowanym torze: głośnik 250 Hz–14 kHz, pogłos RT60 0,4 s przy DRR
+6 dB, szum pokoju, zegar nagrania ±100 ppm, opcjonalnie AAC 128k; testy
`analysis/tests/test_continuity.py`):

| Usterka wstrzyknięta w źródło | Wynik |
|---|---|
| wycięte 1, 2, 10, 50 ms, 1 s, 5 s (przeskok) | `skip`, wielkość z błędem ≤0,05 ms, miejsce ±1 s |
| wstawiona cisza / wstrzymanie 10, 50 ms, 1 s | `gap`, wielkość dokładna; 2 ms → `gap_or_repeat` (nadal awaria) |
| powtórzony fragment 10, 300, 1000 ms | `repeat`, wielkość dokładna |
| wyciszenie bez przesunięcia osi 8, 10, 50, 500, 3000 ms | `dropout`, długość ±2 ms; **5 ms niewykryte** |
| przedwczesny koniec | `premature_end` z numerem ostatniej sekundy |
| dryf ±100 ppm, szum pokoju, skok −6 dB, rampa −6 dB, AAC | zero fałszywych alarmów (3 × 30 min czystego sygnału); zmiany głośności tylko jako `level_change`; dryf mierzony ±2 ppm |
| mikrofon za daleko (DRR +3 dB) | 10-ms wyciszenie wewnątrz symboli niewykryte, 10-ms przerwa w chirpie typowana jako `repeat` (nadal awaria) |

Deklarowana rozdzielczość przy DRR ≥ +6 dB: skoki osi czasu od 1 ms (próg max(0,5 ms, 10σ), jitter
~0,005 ms), wyciszenia od 8 ms przy spadku tła ≥5 dB. Wymóg „przerwy ≥10 ms” jest pokryty z zapasem —
ale to symulacja; pasma głośnika iPhone'a i mikrofonu kamery nie zmierzono, sprawdzi je próba generalna.
Utrata buforów po stronie Maca wygląda jak `skip` — dlatego log ffmpeg (pkt 17).

**Zaliczenie bramki PWA** (wszystkie warunki):
- detektor: `pass = true` — zero zdarzeń `skip`, `gap`, `gap_or_repeat`, `repeat`, `dropout`,
  `no_signal`, brak `premature_end`, ≥90% odczytanych burstów, ostatnia sekunda = 28799;
- dziennik aplikacji bez przerw w środku (pkt 16), status „Plik odtworzony do końca”;
- nagranie po stronie Maca bez overrunów (pkt 17).

**Niezaliczenie**: dowolne zdarzenie awarii lub przedwczesny koniec. Jedną awarię powtarzamy kolejną
nocą w tych samych warunkach (odróżnia przypadek od zachowania systemu). Awaria powtarzalna (2 z 2 nocy,
albo ten sam typ w tym samym miejscu) = „powtarzalna awaria systemowa” → przejście na Capacitor
z natywnym adapterem AVPlayer. Wynik i raport JSON zapisz w `DECISIONS.md`.

## 7. Testy przerwań (osobno, w dzień)

Do każdego wystarczy gotowy plik 30-minutowy `fala-diag-30min.m4a` (29 MB) pobrany w aplikacji; tryb
samolotowy, gdy przerwanie go nie wymaga. Przy każdym zapisz: co zrobił system, czy da się wznowić z
ekranu blokady, co pokazuje dziennik, oraz (opcjonalnie) krótkie nagranie + detektor z
`--expected-duration-s` równym długości pliku.

| # | Przerwanie | Oczekiwane zachowanie |
|---|---|---|
| 1 | Budzik / minutnik z aplikacji Zegar w trakcie | iOS wycisza lub pauzuje; po wyłączeniu budzika wznowienie z ekranu blokady działa |
| 2 | Połączenie przychodzące (wymaga wyłączenia trybu samolotowego; plik nadal z pamięci) | pauza na czas rozmowy; wznowienie z ekranu blokady |
| 3 | Siri | krótka pauza/wyciszenie, potem wznowienie lub pauza do ręcznego wznowienia |
| 4 | Inna aplikacja zaczyna grać (Muzyka, YouTube) | Fala pauzuje; wznowienie z ekranu blokady przejmuje dźwięk z powrotem |
| 5 | Słuchawki Bluetooth: rozłączenie w trakcie | pauza (zachowanie systemowe), brak przełączenia na głośnik bez akcji |
| 6 | Powiadomienie z dźwiękiem (Wiadomości) | chwilowe przyciszenie, odtwarzanie trwa bez pauzy |
| 7 | Włączenie trybu niskiego zużycia energii w trakcie | odtwarzanie trwa |
| 8 | Przełączenie do innej aplikacji na 10 min i powrót | odtwarzanie trwa przez cały czas |
| 9 | Wielokrotna blokada/odblokowanie, pauza i wznowienie z Centrum sterowania, przewijanie paskiem na ekranie blokady | każda akcja działa, pozycja zgodna |
| 10 | Zamknięcie aplikacji w przełączniku i ponowne uruchomienie offline | plik nadal „Dostępne offline”, odtwarza od początku |
| 11 | Restart telefonu, potem uruchomienie offline | jw.; pobrany plik przetrwał restart |
| 12 | Po 2–3 dniach bez użycia | plik nadal pobrany (sprawdź „Sprawdź plik”) |

Przerwania nie są kryterium bramki (system ma prawo pauzować), ale wynik „nie da się wznowić z ekranu
blokady” albo „plik znika z pamięci” to argument za adapterem natywnym.

## 8. Ograniczenia i ryzyka znane przed testem

- Test e2e (Chromium) potwierdza logikę pobierania, weryfikacji, Range i odtwarzania offline, ale
  **nie** zachowania WebKit/iOS przy zablokowanym ekranie — dlatego jest test nocny.
- Kluczowe ryzyko iOS: przy zablokowanym ekranie element audio co kilka minut prosi Service Worker o
  kolejny zakres bajtów. Jeśli iOS wstrzyma SW lub proces strony, odtwarzanie stanie — detektor pokaże
  to jako `premature_end` albo przerwę.
- Gdyby to był powód awarii, przed Capacitorem można jeszcze sprawdzić wariant bez SW w ścieżce
  odtwarzania (źródło `blob:` złożone z porcji), ale na WebKit to może trzymać cały plik w pamięci.
  Nie zbudowano go — to decyzja po wyniku pierwszej nocy.
