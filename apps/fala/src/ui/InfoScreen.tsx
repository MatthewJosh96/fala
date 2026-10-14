import { TopBar } from './parts';

// Plain-language version of do_not_claim in audio/presets/research-params.json.
const NOT_CLAIMED = [
  ['Strojenie 432 Hz nie jest „zdrowsze” ani bardziej relaksujące.', 'Badania są małe, niespójne i często bez porównania z 440 Hz.'],
  ['Częstotliwości 528 Hz i „solfeżowe” nie leczą.', 'To głównie badania na zwierzętach; brak rzetelnych badań na ludziach.'],
  ['Dudnienia binauralne nie „synchronizują fal mózgowych”.', 'Wyniki pomiarów EEG są niespójne, część badań nie pokazuje żadnej zmiany.'],
  ['Dźwięk 40 Hz nie poprawia skupienia i nie chroni przed demencją.', 'Nie ma spójnych korzyści dla myślenia u zdrowych osób.'],
  ['Brązowy szum nie jest „najlepszy na ADHD”.', 'Nie ma badań nad brązowym szumem; jest trochę danych o szumie białym i różowym.'],
] as const;

export function InfoScreen() {
  return (
    <section className="info">
      <TopBar title="Informacje" />

      <div className="card prose">
        <h2>Co robi Fala</h2>
        <p>
          <strong>Skupienie</strong> — muzyka instrumentalna bez słów, z minutnikiem. Słowa w muzyce w badaniach utrudniały czytanie i
          zapamiętywanie.
        </p>
        <p>
          <strong>Relaks</strong> — koło prowadzi oddech: zaczyna od Twojego obecnego tempa i przez około 3 minuty zwalnia do 6 oddechów na
          minutę, z dłuższym wydechem. Wolny oddech podnosi zmienność rytmu serca.
        </p>
        <p>
          <strong>Sen</strong> — spokojna muzyka przed zaśnięciem, która zatrzymuje się po 30–60 minutach. Bez całonocnego szumu: w badaniu
          różowy szum puszczany przez całą noc skracał fazę REM.
        </p>
        <p>Po pobraniu utwór działa bez internetu. Odtwarzanie przy zablokowanym ekranie iPhone’a jest jeszcze w testach.</p>
      </div>

      <div className="card prose">
        <h2>Czego nie obiecujemy</h2>
        <p>Fala nie jest wyrobem medycznym. Muzyka może pomóc części osób, ale nie każdemu i nie zawsze. W szczególności:</p>
        <ul className="claims">
          {NOT_CLAIMED.map(([claim, why]) => (
            <li key={claim}>
              <strong>{claim}</strong> {why}
            </li>
          ))}
        </ul>
      </div>

      <div className="card prose">
        <h2>Ustaw cicho</h2>
        <p>
          Norma WHO–ITU H.870 dla bezpiecznego słuchania (słuchawki, telefony) dopuszcza tygodniowo dawkę dźwięku odpowiadającą 80 dBA przez 40 godzin.
          Każde +3 dB skraca ten czas o połowę.
        </p>
        <p>Fala ma grać w tle: wystarczy poziom, przy którym muzykę ledwie słychać. Do snu — jak najciszej.</p>
      </div>

      <div className="card prose">
        <h2>Podziękowania</h2>
        <p>
          Instrumenty z biblioteki sampli <strong>VSCO 2 Community Edition</strong> (Versilian Studios), udostępnionej na licencji CC0.
          Muzyka to oryginalne aranżacje przygotowane dla Fali.
        </p>
      </div>

      <div className="card prose">
        <h2>Wersja robocza</h2>
        <p>
          To wczesna wersja aplikacji. Utwory, wygląd i funkcje będą się zmieniać, a pobrane pliki mogą wymagać ponownego pobrania po
          aktualizacji. Aplikacja nie ma kont ani analityki — ustawienia i pobrane pliki zostają na Twoim urządzeniu.
        </p>
      </div>
    </section>
  );
}
