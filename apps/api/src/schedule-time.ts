import type { ScheduleInput } from '../../../packages/contracts/src/index.js';

type Cadence = Pick<ScheduleInput, 'cadence' | 'weekday' | 'hour' | 'minute' | 'zone'>;
const formatters = new Map<string, Intl.DateTimeFormat>();
function parts(date: Date, zone: string) {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    formatters.set(zone, formatter);
  }
  const values = Object.fromEntries(formatter.formatToParts(date).map(p => [p.type, Number(p.value)]));
  return { year: values.year, month: values.month, day: values.day, hour: values.hour, minute: values.minute };
}

export function nextFire(spec: Cadence, after: Date): Date {
  if (!Number.isFinite(after.getTime())) throw new Error('Invalid schedule anchor');
  const local = parts(after, spec.zone);
  const start = Date.UTC(local.year, local.month - 1, local.day);
  for (let day = 0; day < 9; day++) {
    const calendar = new Date(start + day * 86400000);
    if (spec.cadence === 'weekly' && calendar.getUTCDay() !== spec.weekday) continue;
    const y = calendar.getUTCFullYear(), m = calendar.getUTCMonth() + 1, d = calendar.getUTCDate();
    const desired = spec.hour * 60 + spec.minute;
    const utcWall = Date.UTC(y, m - 1, d, spec.hour, spec.minute);
    const offsets = new Set<number>();
    for (const shift of [-86400000, -43200000, 0, 43200000, 86400000]) {
      const probe = utcWall + shift;
      const p = parts(new Date(probe), spec.zone);
      offsets.add(Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - probe) / 60000));
    }
    // Search forward in wall minutes: an absent DST time uses the first valid minute after the gap.
    for (let wallMinute = desired; wallMinute < 1440; wallMinute++) {
      const wall = Date.UTC(y, m - 1, d, 0, wallMinute);
      const matches = [...offsets].map(offset => new Date(wall - offset * 60000)).filter(candidate => {
        const p = parts(candidate, spec.zone);
        return p.year === y && p.month === m && p.day === d && p.hour * 60 + p.minute === wallMinute;
      }).sort((a, b) => a.getTime() - b.getTime());
      if (matches.length) {
        if (matches[0].getTime() > after.getTime()) return matches[0];
        break; // Repeated wall times run only at their first occurrence.
      }
    }
  }
  throw new Error('Cannot calculate next schedule occurrence');
}
