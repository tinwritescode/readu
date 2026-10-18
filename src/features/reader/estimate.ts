/** About 150 words a minute at 1×, at roughly six UTF-16 units per word with its space. */
const CHARS_PER_MINUTE = 900;

export function minutesFor(chars: number, speed: number): number {
  return chars / (CHARS_PER_MINUTE * speed);
}

export function formatClock(minutes: number): string {
  const total = Math.max(0, Math.round(minutes * 60));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function formatMinutesLeft(minutes: number): string {
  if (minutes < 1) return 'under a minute left';
  if (minutes < 60) return `${Math.round(minutes)} min left`;
  const h = Math.floor(minutes / 60);
  return `${h} h ${Math.round(minutes % 60)} min left`;
}
