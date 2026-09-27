export function localParts(date, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const out = {};
  for (const part of parts) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return out;
}

export function zonedMidnightUtc(year, month, day, zone) {
  const desired = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guess = desired;

  for (let i = 0; i < 4; i += 1) {
    const actual = localParts(new Date(guess), zone);
    const represented = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const delta = desired - represented;
    guess += delta;
    if (delta === 0) break;
  }

  return new Date(guess);
}

export function monthStartFor(date, zone) {
  const p = localParts(date, zone);
  return zonedMidnightUtc(p.year, p.month, 1, zone);
}
