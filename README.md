# Fala

Fala to aplikacja webowa (PWA) z dźwiękiem do skupienia, relaksu i snu. Działa offline, także na
iPhonie dodanym do ekranu początkowego. To wersja robocza do użytku osobistego.

**https://matthewjosh96.github.io/fala/** (po wdrożeniu, patrz `docs/DEPLOY.md`)

| Tryb | Co robi |
|---|---|
| Skupienie | Muzyka instrumentalna w pętli, wybór utworu, minutnik 25 / 50 / 90 min |
| Relaks | Koło prowadzi oddech: od Twojego tempa do 6 oddechów na minutę w ok. 3 min, wdech do wydechu 4:6; 5–30 min |
| Sen | Zegar, spokojna muzyka zatrzymująca się po 30 / 45 / 60 min, ciemna czerwona paleta |

Minutnik liczy tylko czas, gdy dźwięk gra. Utwory pobiera się jawnie („Pobierz offline”), a aplikacja
sprawdza je SHA-256. Fala nie obiecuje „fal mózgowych”, 432 Hz ani poprawy koncentracji u każdego.
Uzasadnienia są w ekranie „Informacje” i w `docs/DECISIONS.md`.

## Struktura

| Ścieżka | Zawartość |
|---|---|
| `apps/fala/` | PWA: React 19, TypeScript, Vite 8, Workbox (Service Worker z obsługą Range), Vitest, Playwright |
| `media/catalogue.json` | Katalog utworów: które rendery i pod jaką nazwą trafiają do wydania `media-vN` |
| `scripts/publish-media.sh` | Publikacja nagrań jako zasobów wydania GitHub |
| `.github/workflows/pages.yml` | Build, testy, dołączenie nagrań z wydania, wdrożenie na GitHub Pages |
| `audio/presets/` | Parametry trybów z researchu (`research-params.json`) |
| `analysis/`, `tools/audio/` | Pomiary dźwięku, generator pliku diagnostycznego, detektor przerw (Python) |
| `docs/` | `DECISIONS.md`, `DEPLOY.md`, `ACCEPTANCE.md` (test nocny na iPhonie), `design/` (makiety i zrzuty) |

Nagrania (`renders/`) nie są w Gicie.

## Uruchomienie

Wymagany Node ≥ 22.12 (CI: 24.21.0, `apps/fala/.node-version`) i `ffmpeg`/`ffprobe`.

```sh
cd apps/fala
npm ci
npm run media:stage                 # nagrania z renders/ + sidecary do apps/fala/.media
npm run build && npm run preview    # http://localhost:4317/fala/
npm test                            # Vitest
npm run test:e2e                    # Playwright na buildzie produkcyjnym pod /fala/
```

Zrzuty ekranów w rozmiarze iPhone'a: `FALA_SCREENS=1 npx playwright test e2e/screens.spec.ts`
(zapisuje do `docs/design/screens/`).

## Licencja

Kod: MIT (`LICENSE`). Nagrania w wydaniach `media-vN` nie są objęte tą licencją. Instrumenty pochodzą z
VSCO 2 Community Edition (CC0).
