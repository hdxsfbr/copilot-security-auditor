// Every schedule instant is rendered in the schedule's own IANA zone with its abbreviation, never in an implicit browser zone.
// The browser-local equivalent is optional and always labeled as the browser's.
export const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

function parts(iso: string, zone: string) {
  const formatted = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }).formatToParts(new Date(iso));
  const value = Object.fromEntries(formatted.map(part => [part.type, part.value]));
  return { date: `${value.weekday}, ${value.month} ${value.day}, ${value.year}`, time: `${value.hour}:${value.minute}`, abbreviation: value.timeZoneName };
}

/** "Tue, Sep 29, 2026 09:00 America/Chicago (CDT)". Falls back to the raw instant when the value or zone cannot be formatted. */
export function inZone(iso: string, zone: string): string {
  try { const p = parts(iso, zone); return `${p.date} ${p.time} ${zone} (${p.abbreviation})`; }
  catch { return `${iso} (not formattable in ${zone})`; }
}

/** Recurring wall time, e.g. "09:00 America/Chicago (CDT)"; the abbreviation is the one in effect at `at` (DST changes it). */
export function wallTime(hour: number, minute: number, zone: string, at: string): string {
  const clock = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  try { return `${clock} ${zone} (${parts(at, zone).abbreviation})`; } catch { return `${clock} ${zone}`; }
}

/** The same instant in the viewer's browser zone, labeled as such; null when it is the schedule's own zone. */
export function browserEquivalent(iso: string, zone: string, local = browserZone()): string | null {
  if (local === zone) return null;
  try { const p = parts(iso, local); return `Your browser (${local}, ${p.abbreviation}): ${p.date} ${p.time}`; } catch { return null; }
}

export const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function validZone(zone: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return zone.length > 0; } catch { return false; }
}
export const zoneNames = (): string[] => (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
