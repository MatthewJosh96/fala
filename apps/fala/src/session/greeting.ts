export function greeting(hour: number): { title: string; subtitle: string } {
  if (hour >= 5 && hour < 12) return { title: 'Dzień dobry', subtitle: 'Dobry moment na skupienie' };
  if (hour >= 12 && hour < 18) return { title: 'Dzień dobry', subtitle: 'Znajdź swój rytm' };
  if (hour >= 18 && hour < 22) return { title: 'Dobry wieczór', subtitle: 'Czas zwolnić' };
  return { title: 'Dobrej nocy', subtitle: 'Pora wyciszyć dzień' };
}
