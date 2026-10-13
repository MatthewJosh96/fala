# Test ciągłości odtwarzania (fala-diag-v1)

Rozstrzyga bramkę PWA: czy iPhone odtworzy 8-godzinny plik offline przy zablokowanym ekranie bez przerw ≥10 ms. Telefon gra plik diagnostyczny przez noc, Mac nagrywa go mikrofonem, detektor sprawdza nagranie.

| Plik | Co robi |
|---|---|
| `generate.sh` | generuje plik M4A (AAC-LC 128 kb/s, 48 kHz, stereo) + sidecar JSON, opcjonalnie weryfikuje |
| `record_mac.sh` | nagrywa wejście audio Maca do FLAC (mono, 24 kHz) z logiem ffmpeg |
| `analysis/src/fala_audio_check/continuity.py` | detektor ciągłości (`python -m fala_audio_check.continuity`) |

## Sygnał

Każda sekunda pliku zaczyna się burstem: chirp synchronizacyjny 40 ms (1000→4500 Hz), 10 ms przerwy i 6 symboli MFSK-16 po 30 ms z numerem sekundy (16 bitów + CRC-8). Pod spodem przez cały czas leci deterministyczny szum różowy (100 Hz–12 kHz, −26 dBFS RMS). Pasmo 5,5–11 kHz zawiera tylko szum; detektor szuka w nim zapadów (wyciszeń). Szczegóły protokołu: docstring `analysis/src/fala_audio_check/timecode.py`.

Plik jest słyszalny (szum + piknięcia co sekundę). Telefon i Mac najlepiej postawić w pokoju, w którym nikt nie śpi.

## 1. Generowanie (8 h)

```bash
tools/audio/diagnostic/generate.sh --duration-s 28800 --out renders/diagnostic/fala-diag-8h.m4a \
  --title "Fala — diagnostyka 8 h" --id fala-diag-8h --verify
```

- około 3 min na Macu mini M4 Pro (10 min pliku generuje się w ~3,3 s), stała pamięć, bez pośredniego WAV;
- plik około 466 MB, obok `fala-diag-8h.json` z `size` i `sha256` gotowego pliku (PWA sprawdza nimi pobranie);
- `--verify` dekoduje początek, 5 losowych okien po 30 s i ostatnie 30 s i sprawdza, czy numery sekund zgadzają się z pozycją, a ostatni to 28799. Ponowna weryfikacja istniejącego pliku: `generate.sh verify renders/diagnostic/fala-diag-8h.m4a`.

Katalog `renders/` jest w głównym `.gitignore`. `renders/diagnostic/` to domyślny katalog mediów PWA (`FALA_MEDIA_DIR`), więc wygenerowane tam pliki od razu pojawiają się w „Pobrane”.

## 2. Ustawienie nagrania

- **Mikrofon.** Mac mini nie ma wbudowanego mikrofonu. Użyj kamery MX Brio 705 (domyślne wejście) albo innego mikrofonu USB. Nie wybieraj „iPhone Microphone” (Continuity), bo to testowany telefon.
- **Bez redukcji szumów.** W Logi Tune wyłącz redukcję szumów lub „noise suppression”, jeśli kamera ją ma. W Centrum sterowania ustaw tryb mikrofonu „Standard”, bez Voice Isolation. Tłumik szumu stacjonarnego zje tło, na którym opiera się wykrywanie wyciszeń.
- **Odległość: 20–40 cm**, głośnik telefonu (dolna krawędź) skierowany na mikrofon. Detektor ma deklarowaną rozdzielczość przy stosunku dźwięku bezpośredniego do pogłosu (DRR) ≥ +6 dB. Przy +3 dB (mikrofon za daleko) 10-ms wyciszenie wewnątrz symboli przechodzi niezauważone.
- **Głośność telefonu** ustaw tak, żeby w próbie szczyty nagrania wynosiły od −20 do −6 dBFS. Nie zmieniaj jej w nocy. Gdyby się zmieniła, raport pokaże `level_change` jako informację, nie jako awarię.
- **Mac:** podłączony do zasilania. `caffeinate` w skrypcie blokuje uśpienie. Na dysku zostaw ≥2 GB wolnego miejsca.

## 3. Próba generalna (2 min)

```bash
tools/audio/diagnostic/generate.sh --duration-s 120 --out renders/diagnostic/fala-diag-120s.m4a \
  --title "Fala — próba 120 s" --id fala-diag-120s --verify
tools/audio/diagnostic/record_mac.sh --list            # indeks wejścia, np. 0
tools/audio/diagnostic/record_mac.sh 0 150             # start nagrania, potem play na telefonie
cd analysis && uv run python -m fala_audio_check.continuity ../renders/recordings/<plik>.flac --expected-duration-s 120
```

Oczekiwany wynik: `"pass": true`, `bursts_decoded` 120 i jitter poniżej 0,05 ms.

## 4. Nagrywanie nocy

```bash
tools/audio/diagnostic/record_mac.sh 0          # domyślnie 29400 s = 8 h 10 min
```

Najpierw uruchom nagrywanie, potem odtwarzanie na telefonie. Skrypt zapisuje do `renders/recordings/fala-diag-YYYYmmdd-HHMM.flac`, mono 24 kHz 16 bit. Rozmiar wynosi około 0,9–1,1 GB za 8 h, zależnie od poziomu nagrania. Częstotliwość 24 kHz, a nie 16 kHz, jest potrzebna, bo detektor zapadów korzysta z pasma do 11 kHz. Obok nagrania powstają:

- `….ffmpeg.log`: ostrzeżenia ffmpeg. Wpisy o overrun, queue, drop lub non-monotonic oznaczają problem po stronie Maca. Takie `skip` w raporcie nie obciążają telefonu.
- `….progress.txt`: co 30 s `out_time` i `speed`. Przez całą noc `speed` powinno wynosić około 1,0x.

Wcześniejsze zakończenie: `q` albo Ctrl+C. FLAC pozostaje poprawny.

## 5. Analiza

```bash
cd analysis
uv run python -m fala_audio_check.continuity ../renders/recordings/<plik>.flac --expected-duration-s 28800 --json ../renders/recordings/<plik>.report.json
```

Analiza zajmuje około 1 min na 8 h i 1–2 GB RAM. Kod wyjścia 0 oznacza pass, 1 oznacza fail. Detektor czyta każdy format obsługiwany przez ffmpeg.

| Zdarzenie | Znaczenie | Awaria? |
|---|---|---|
| `skip` | utracona treść, oś czasu skoczyła do przodu (`magnitude_ms`) | tak |
| `gap` | wstawiona cisza lub wstrzymanie, oś przesunięta do tyłu i zapad tła | tak |
| `repeat` | treść zagrana drugi raz, przesunięcie bez zapadu albo powtórzony numer | tak |
| `gap_or_repeat` | dodatni krok <5 ms bez rozpoznawalnego zapadu | tak |
| `dropout` | wyciszenie bez przesunięcia osi (≥8 ms, ≥5 dB) | tak |
| `premature_end` | plik skończył się przed sekundą D−1; `cause_hint` mówi, czy przestał grać telefon, czy skończyło się nagranie | tak |
| `no_signal` | brak odczytanych burstów | tak |
| `level_change` | trwała zmiana głośności ≥3 dB | nie |
| `late_start`, `timing_outlier` | pierwszy numer >0; pojedynczy burst źle zlokalizowany (suma kroków ≈0) | nie |

Pole `pass` jest prawdziwe, gdy nie ma żadnej awarii i odczytano ≥90% burstów. Przy niższym pokryciu raport ma pole `inconclusive`. Każde zdarzenie ma `t_recording_s` (czas w nagraniu) i `source_second` (pozycję w pliku).

## Rozdzielczość (kalibracja na symulowanym torze)

Symulacja: pasmo głośnika 250 Hz–14 kHz, pogłos RT60 0,4 s przy DRR +6 dB, szum pokoju, zegar nagrania ±100 ppm, opcjonalnie AAC 128k.

- skok osi czasu (skip, gap, repeat): od 1 ms, wielkość z dokładnością ±0,05 ms; jitter około 0,005 ms;
- gap odróżniany od repeat od około 5 ms;
- wyciszenie bez przesunięcia osi: od 8 ms (5 ms nie jest wykrywane), długość ±2 ms;
- fałszywe alarmy: zero w 1,5 h czystego sygnału przez symulowany pokój i AAC.
