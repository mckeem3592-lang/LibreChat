export function monthlySpendPipeline(start) {
  if (!(start instanceof Date) || Number.isNaN(start.getTime())) {
    throw new Error('invalid_month_start');
  }

  return [
    {
      $match: {
        createdAt: { $gte: start },
        tokenType: { $in: ['prompt', 'completion'] },
        tokenValue: { $lt: 0 },
      },
    },
    {
      $group: {
        _id: null,
        settledCredits: { $sum: { $multiply: ['$tokenValue', -1] } },
      },
    },
  ];
}

export function settledCreditsFromRows(rows = []) {
  const value = Number(rows?.[0]?.settledCredits ?? 0);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('invalid_settled_credits');
  }
  return value;
}
