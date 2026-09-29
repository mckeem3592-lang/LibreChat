/** Calendar reporting only. Admission continues to use the existing monthly ledger. */
export function spendingWindows(now: Date, timeZone: string) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('invalid_report_time');
  const parts = (date: Date) => {
    const fields: Record<string, number> = {};
    for (const p of new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric',
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      second: '2-digit', hourCycle: 'h23' }).formatToParts(date)) {
      if (p.type !== 'literal') fields[p.type] = Number(p.value);
    }
    return fields;
  };
  const midnight = (date: Date) => {
    const desired = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    let guess = desired;
    for (let i = 0; i < 4; i++) {
      const p = parts(new Date(guess));
      const delta = desired - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
      guess += delta;
      if (delta === 0) return new Date(guess);
    }
    throw new Error('invalid_report_calendar');
  };
  const p = parts(now);
  const day = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const week = new Date(day);
  week.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return { asOf: now.toISOString(), timeZone, weekStartsOn: 'Monday' as const,
    dayStart: midnight(day).toISOString(), weekStart: midnight(week).toISOString(),
    monthStart: midnight(new Date(Date.UTC(p.year, p.month - 1, 1))).toISOString() };
}

interface SpendEvent {
  status: string;
  source?: string;
  createdAt: Date | string;
  monthStart: string;
  actualUsd?: number;
  usage?: { estimated?: boolean };
}

export function summarizeSpendingPeriods(rows: SpendEvent[], now: Date, timeZone: string) {
  const windows = spendingWindows(now, timeZone);
  const totals = { todayUsd: 0, weekUsd: 0, todayEstimatedUsd: 0, weekEstimatedUsd: 0,
    monthUnallocatedUsd: 0 };
  for (const row of rows) {
    if (row.status !== 'settled') continue;
    const usd = row.actualUsd;
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0 ||
        (row.usage?.estimated !== undefined && typeof row.usage.estimated !== 'boolean')) {
      throw new Error('invalid_period_event');
    }
    // A whole-period provider adjustment cannot truthfully be assigned to its import day.
    if (row.source === 'provider-reconciliation') {
      if (row.monthStart === windows.monthStart) totals.monthUnallocatedUsd += usd;
      continue;
    }
    const date = new Date(row.createdAt);
    if (!Number.isFinite(date.getTime())) throw new Error('invalid_period_event');
    const at = date.toISOString();
    if (at > windows.asOf) continue;
    if (at >= windows.weekStart) {
      totals.weekUsd += usd;
      if (row.usage?.estimated === true) totals.weekEstimatedUsd += usd;
    }
    if (at >= windows.dayStart) {
      totals.todayUsd += usd;
      if (row.usage?.estimated === true) totals.todayEstimatedUsd += usd;
    }
  }
  if (Object.values(totals).some((v) => !Number.isFinite(v))) throw new Error('invalid_period_event');
  return { ...windows, ...totals };
}
