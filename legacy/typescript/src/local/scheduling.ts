import { validateCron } from '../domain.ts';

export async function nextCronTime(cron: string, timezone: string, after = new Date()): Promise<number> {
  validateCron(cron);
  new Intl.DateTimeFormat('en', { timeZone: timezone }).format(after);
  const packageName = 'cron-parser';
  let parser;
  try { parser = (await import(packageName)).CronExpressionParser; }
  catch { throw new Error('Timezone cron requires cron-parser. Run npm install.'); }
  return parser.parse(cron, { tz: timezone, currentDate: after }).next().toDate().getTime();
}

export function nextIntervalTime(previous: number, seconds: number, now: number): number {
  const interval = seconds * 1000;
  if (!Number.isFinite(interval) || interval < 60000) throw new Error('Interval must be at least 60 seconds');
  return previous + (Math.floor(Math.max(0, now - previous) / interval) + 1) * interval;
}
