# Plan — Fala (aplikacja typu Brain.fm)

| Faza | Co | Kto | Wynik |
|---|---|---|---|
| 0 | Repo, plan, decyzje | Claude | ten plik, DECISIONS.md |
| 1a | Deep research: bodźce słuchowe a skupienie/relaks/sen | autor + krytyk (Opus), świeży weryfikator | `data/audio-stimulation-focus-sleep/result.md` + notatka w vaulcie |
| 1b | Architektura: platforma, silnik audio, źródło muzyki, weryfikacja | propozycja Claude → Astra (high) → runda konfrontacji | wpis w DECISIONS.md |
| 1c | Projekt UI/UX | ChatGPT (obrazy) przez computer use, wybór Claude + Maciek | `docs/design/` |
| 2 | Specyfikacja dźwięku per tryb (z researchu) + harness pomiarowy (widmo obwiedni, LUFS, true peak, szwy pętli) | Claude | `docs/AUDIO-SPEC.md`, testy |
| 3 | Implementacja: silnik audio / render utworów / aplikacja UI | subagenci Opus (osobne zakresy) | kod + testy |
| 4 | QA: testy, pomiary, ślepy tester w przeglądarce, odsłuch Maćka | Sonnet (ślepy tester), Maciek | raport gotowe/niegotowe |
