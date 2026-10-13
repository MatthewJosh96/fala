# Decyzje — Fala

Format: data — decyzja — powód (jedno zdanie).

- 2026-10-13 — Nazwa robocza „Fala”, repo `~/Development/fala`, użytek osobisty najpierw (Mac + iPhone) — szybka iteracja bez kosztów publikacji; publiczne wydanie to osobna decyzja.
- 2026-10-13 — Parametry dźwięku (częstotliwości modulacji, szumy, tempo, głośność) wynikają z deep researchu w hubie (`data/audio-stimulation-focus-sleep/`), z oceną pewności H/M/L — żeby „działa na mózg” miało pokrycie w badaniach, a nie w marketingu.
- 2026-10-13 — Płatne API do generowania muzyki (Lyria, ElevenLabs, Suno) tylko za zgodą Maćka.
- 2026-10-13 — Dźwięk renderowany offline w Pythonie do gotowych plików z wpaloną stymulacją; aplikacja tylko odtwarza — rozdziela produkcję muzyki i mierzalne DSP od problemów cyklu życia odtwarzania (zgodne: Claude i Astra).
- 2026-10-13 — Platforma faza 1: PWA (React + TypeScript + Vite), jeden element <audio>, Media Session, jawne pobieranie offline przez Service Worker z obsługą Range; bez AudioContext w ścieżce odtwarzania — bez płatnego konta Apple natywna aplikacja wymaga ponownej instalacji co 7 dni (Astra najpierw zalecała Expo, w rundzie konfrontacji przyjęła PWA-first).
- 2026-10-13 — Bramka PWA: jedna noc z pełnym 8-godzinnym plikiem na zablokowanym iPhonie offline, z zewnętrznym nagraniem i detektorem przerw ≥10 ms; powtarzalna awaria systemowa → Capacitor z małym natywnym adapterem AVPlayer (UI zostaje) — rozstrzyga test, nie dokumentacja.
- 2026-10-13 — Sen jako jeden ciągły plik 8 h, AAC-LC 128 kb/s (~461 MB), przejścia składane w PCM przed jednym kodowaniem; bez crossfade'ów dwóch elementów <audio> — usuwa zależność od harmonogramów w tle (propozycja Astry; Claude proponował segmenty).
- 2026-10-13 — Start od jednej intensywności produkcyjnej + krótkich podglądów porównawczych (bez modulacji / niska / docelowa); kolejne warianty pełnej długości dopiero po testach odsłuchu — oszczędza miejsce i czas renderu.
- 2026-10-13 — Binaural i izochroniczne domyślnie wyłączone; wolniejsza modulacja dla Relaks/Sen nie jest założeniem — tylko to, co wspiera research; Sen zaczyna od opcji bez modulacji (maskowanie).
- 2026-10-13 — Głębokość AM weryfikowana regresją z referencją (niemodulowana szyna muzyki: y = a·x + b·x·cos + d·x·sin + Σq·z), m = √(b²+d²)/a; widmo obwiedni miksu raportowane osobno — sama obwiednia muzyki może dać fałszywy szczyt (estymator Astry).
- 2026-10-13 — −18 LUFS i −2 dBTP to inżynierskie cele dostawy, nie parametry naukowe; głośność dobierana per preset — LUFS nie określa poziomu ciśnienia akustycznego przy uchu.
- 2026-10-13 — Muzyka: oryginalne aranżacje na samplach CC0/CC-BY (VSCO 2 CE, opcjonalnie Salamander) + pady syntetyczne; bramka odsłuchu Maćka przed rozbudową katalogu; AI muzyczne poza rdzeniem (MusicGen CC-BY-NC wykluczony) — jakość zależy od aranżacji, nie od samych sampli.
