# Projekt UI — Fala

Makiety: `gen/a-mobile.png`, `gen/a-desktop.png` (kierunek A), `gen/b-mobile.png` (kierunek B).
Wygenerowane 2026-10-13 modelem obrazów ChatGPT przez Codex CLI (`image_generation`);
prompty obok (`gen/*.txt`). Computer use w aplikacji ChatGPT nie działał (zrzuty ekranu blokowane).

## Wybór: kierunek A „Night ink”, z dwoma elementami z B

Powód: aplikacja działa głównie wieczorem, przy pracy i w nocy; ciemny motyw z jednym ciepłym
akcentem nie razi i daje czytelną hierarchię. Z B bierzemy chip „Wznów” u góry ekranu głównego
i pasek postępu wyciszenia w trybie Sen. Jasny motyw (paleta B) jako opcja później.

Poprawki względem makiet:
- jeden przełącznik Odtwórz/Pauza (makieta desktop ma oba przyciski naraz);
- polskie znaki wszędzie („Intensywność”);
- karty trybów otwierają sesję od razu (bez osobnego „Start” jak w B);
- tryb Sen: tylko zegar, fala w czerwonawych odcieniach, wyciszenie i Pauza; jasność minimalna.

## Tokeny (A)

| Token | Wartość |
|---|---|
| tło | `#0B0E14` |
| powierzchnia (karta) | `#141925` |
| linia / obrys | `#232A38` |
| tekst główny | `#F1EEE8` |
| tekst drugorzędny | `#9AA3B2` |
| akcent (stan aktywny, CTA) | `#F2B56B` |
| akcent Sen (czerwony, przyciemniony) | `#C98A6B` na tle `#0D0A09` |
| zaokrąglenia | 24 px karty, 999 px przyciski |
| siatka | 8 pt |
| typografia | Inter / SF Pro; zegar sesji 64–72 pt light, tytuły 28–34 pt, opisy 15 pt |

## Ekrany (MVP)

1. Główny: powitanie wg pory dnia, fala, 3 karty trybów (Skupienie / Relaks / Sen), chip „Wznów”.
2. Sesja: pierścień czasu, nazwa utworu, fala reagująca na dźwięk, Intensywność (3 poziomy), Odtwórz/Pauza, Minutnik.
3. Sen: zegar, wyciszenie z paskiem postępu, Pauza; minimalna jasność.
4. Mac: okno ~900×600 z przełącznikiem trybów i popover w pasku menu (tryb, czas, Odtwórz/Pauza, przełącznik trybów).
