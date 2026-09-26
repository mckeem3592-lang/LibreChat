export function budgetMode(spendUsd, budget) {
  const spend = Number(spendUsd || 0);
  if (spend >= Number(budget.hardUsd)) return 'blocked';
  if (spend >= Number(budget.economyUsd)) return 'economy';
  if (spend >= Number(budget.targetUsd)) return 'notice';
  return 'normal';
}

export function chooseRoute(task, spendUsd, config) {
  const mode = budgetMode(spendUsd, config.budget);
  if (mode === 'blocked') return { mode, route: null };
  const fallback = config.routes.economy || config.routes.primary;
  const selected = config.routes[task] || config.routes.primary || fallback;
  const route = mode === 'economy' && selected?.premium ? fallback : selected;
  return { mode, route };
}
