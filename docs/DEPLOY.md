# Wdrożenie — GitHub Pages

Adres: **https://matthewjosh96.github.io/fala/**. Ścieżka `/fala/` jest wpisana w
`apps/fala/vite.config.ts` (`base`) i w `apps/fala/public/404.html`; inna nazwa repo = zmiana obu.

Jak to działa:

- Kod jest w Git, dźwięk nie. Pliki z `media/catalogue.json` są zasobami wydania GitHub o tagu z pola
  `release` (teraz `media-v1`). Publikuje je `scripts/publish-media.sh`.
- `.github/workflows/pages.yml` (push do `main` albo ręcznie): `npm ci` → `npm test` → `npm run build`
  → pobranie wszystkich zasobów wydania do `dist/media/` → kontrola inwentarza (dokładnie pliki z
  katalogu, po jednym sidecarze, nic więcej) → `index.json` w trybie ścisłym (rozmiar i SHA-256) →
  publikacja `dist/` na Pages. Każda niezgodność zatrzymuje wdrożenie, zanim cokolwiek zostanie wgrane.
- Node w CI: 24.21.0 (`apps/fala/.node-version`). Skrypty mediów to TypeScript uruchamiany przez
  Node (`--experimental-strip-types`). Lokalnie działają na Node 22.17 z tą flagą i na prywatnym Node
  24.21 (`~/.local/share/rea/node/bin`), obie wersje sprawdzone.
- Pliku diagnostycznego 8 h nie ma w katalogu i nie jest publikowany. Test nocny idzie z lokalnego
  serwera (`docs/ACCEPTANCE.md` §4).

Nic z poniższego nie zostało uruchomione: repo, wydanie i Pages nie istnieją.

## 0. Decyzje przed pierwszym wdrożeniem (Maciek)

- **Repo publiczne.** Pages w planie Free działa tylko z repo publicznego, a wtedy publiczna jest cała
  historia: kod, `docs/` (decyzje, plan, akceptacja), `analysis/`, `tools/`, presety. W śledzonych
  plikach nie ma sekretów ani danych osobowych (sprawdzone 2026-10-14); historia commitów ujawnia
  e-mail autora commitów. Alternatywy: GitHub Pro (Pages z prywatnego repo) albo osobne repo tylko z
  aplikacją.
- **Licencja nagrań.** `LICENSE` (MIT) obejmuje kod. Pliki audio w wydaniu nie mają licencji, więc
  obowiązują domyślnie wszystkie prawa zastrzeżone. Sample VSCO 2 CE są na CC0, więc nie wymuszają
  żadnej licencji.

## 1. Repo i Pages (jednorazowo)

```sh
gh auth status                                    # konto MatthewJosh96, zakres repo + workflow
cd ~/Development/fala
gh repo create MatthewJosh96/fala --public --source . --remote origin \
  --description "Fala — dźwięk do skupienia, relaksu i snu (PWA)"
gh api -X POST repos/MatthewJosh96/fala/pages -f build_type=workflow    # źródło Pages: GitHub Actions
```

## 2. Kod na `main`

Gałąź `website` (worktree `~/Development/fala-wt-pwa`) zawiera `main`, więc scalenie to przewinięcie.
`git fetch . website:main` przesuwa `main` bez przełączania gałęzi w głównym checkoucie (tam jest
`music-gate`) i odmówi, jeśli to nie jest fast-forward.

```sh
cd ~/Development/fala
git fetch . website:main
git push -u origin main
```

Push uruchamia workflow. **Pierwszy przebieg zatrzyma się na kroku „Add media from the release”**
(wydanie jeszcze nie istnieje) i nic nie opublikuje. To oczekiwane: wydania nie da się utworzyć w
pustym repo, więc kolejność jest wymuszona.

## 3. Dźwięk: wydanie `media-v1`

Potrzebne rendery w `renders/` (poza Gitem): `focus-a-strings-piano-v2.m4a` i `focus-b-soft-pulse.m4a`.
Skrypt sam wykrywa repo; `FALA_REPO=MatthewJosh96/fala` je wymusza.

```sh
cd ~/Development/fala
scripts/publish-media.sh --dry-run    # sidecary + ścisła kontrola; nic nie wysyła
scripts/publish-media.sh              # tworzy wydanie media-v1 z 2 × .m4a i 2 × .json (~28 MB)
gh workflow run pages.yml --ref main --repo MatthewJosh96/fala
gh run watch --repo MatthewJosh96/fala "$(gh run list --workflow pages.yml --repo MatthewJosh96/fala --limit 1 --json databaseId -q '.[0].databaseId')"
```

Istniejącego wydania skrypt nie zmieni: przerwie się z komunikatem.

## 4. Sprawdzenie po wdrożeniu

```sh
U=https://matthewjosh96.github.io/fala
curl -sI "$U/" | head -1                                              # HTTP/2 200
curl -s "$U/manifest.webmanifest" | grep -o '"start_url":"[^"]*"'      # "start_url":"/fala/"
curl -s "$U/media/index.json" | grep -o '"file": *"[^"]*"'             # poranne-swiatlo.m4a, miekki-puls.m4a
curl -sI -H 'Range: bytes=0-1' "$U/media/poranne-swiatlo.m4a" | grep -iE '^HTTP|^content-range'
#   oczekiwane: HTTP/2 206 i content-range: bytes 0-1/14680509 (Range na Pages nie był jeszcze sprawdzony)
curl -sI "$U/nie-ma/" | head -1                                        # 404, strona 404.html wraca do /fala/
```

Na iPhonie:

1. W Safari otwórz `https://matthewjosh96.github.io/fala/`.
2. Udostępnij → Dodaj do ekranu początkowego, a potem uruchom Falę z ikony.
3. Skupienie → **Pobierz offline** → poczekaj na „Dostępne offline”.
4. Włącz tryb samolotowy, zamknij i ponownie otwórz aplikację, stuknij odtwarzanie.

Odtwarzanie przy zablokowanym ekranie to osobny test (`docs/ACCEPTANCE.md`).

## 5. Kolejne wdrożenia

- **Kod:** push do `main` publikuje automatycznie (ten sam `media-vN` z katalogu).
- **Nowe lub zmienione nagranie:**
  1. Nadaj plikowi nową nazwę, np. `poranne-swiatlo-v2.m4a`.
  2. Podnieś `release` w `media/catalogue.json` (`media-v2`).
  3. `scripts/publish-media.sh`, potem commit katalogu i push.

  Nowa nazwa jest konieczna. Service Worker serwuje pobraną kopię po ścieżce URL, więc pod starą nazwą
  telefon odtwarzałby offline poprzednią wersję. Stara kopia zostaje w „Pobranych” do usunięcia.
- **Przed pushem lokalnie:** `cd apps/fala && npm test && npm run test:e2e` (e2e nie biegnie w CI: wymaga
  renderów i przeglądarki).

### Jak telefon przyjmuje nową wersję

Aplikacja sama decyduje, kiedy przejść na nową wersję (`registerType: 'prompt'`, w `sw.ts` nie ma
`skipWaiting`). Nowy Service Worker instaluje się w tle i czeka.

- Gdy nic nie gra, nic się nie pobiera ani nie sprawdza i nie ma rozpoczętej sesji, aplikacja przełącza się
  sama i przeładowuje stronę (zwykle w kilka sekund po uruchomieniu).
- Gdy sesja jest wstrzymana w połowie, na ekranie głównym pojawia się „Dostępna aktualizacja ·
  Zaktualizuj”. Stuknięcie przeładowuje aplikację, a wstrzymana sesja przepada.
- W trakcie odtwarzania albo pobierania aktualizacja czeka do końca, a zamiast przycisku jest dopisek
  „po zatrzymaniu dźwięku”.
- Gdy przejęcie nie nastąpi w 10 s (np. inne okno aplikacji wciąż gra ze starej wersji), strona przeładuje
  się dopiero wtedy, gdy nic w niej nie gra i nic się nie pobiera.
- Zamknięcie wszystkich okien aplikacji też kończy czekanie: przy następnym uruchomieniu działa już nowa
  wersja.

## 6. Lokalnie, bez wdrożenia

```sh
cd apps/fala
npm ci
npm run media:stage                  # symlinki renderów + sidecary w apps/fala/.media
npm run build && npm run preview     # http://localhost:4317/fala/
```

## 7. Wycofanie

- Poprzednia wersja: `gh run rerun <id-udanego-przebiegu> --repo MatthewJosh96/fala` (przebieg buduje
  swój commit) albo `git revert` + push.
- Zdjęcie strony: `gh api -X DELETE repos/MatthewJosh96/fala/pages`.
- Wycofana wersja dociera do zainstalowanych PWA tak samo jak każda aktualizacja (punkt „Jak telefon
  przyjmuje nową wersję”). Pobrane nagrania zostają na telefonach.
