export function budgetMode(spendUsd, budget) {
  const spend = Number(spendUsd || 0);
  if (spend >= Number(budget.hardUsd)) return 'blocked';
  if (spend >= Number(budget.economyUsd)) return 'economy';
  if (spend >= Number(budget.targetUsd)) return 'notice';
  return 'normal';
}

export function chooseRoute(task, spendUsd, config) {
  const mode = budgetMode(spendUsd, config.budget);
  if (mode === 'blocked') return { mode, routeName: null, route: null };

  const fallbackName = config.routes.economy ? 'economy' : 'primary';
  const selectedName = config.routes[task] ? task : (config.routes.primary ? 'primary' : fallbackName);
  const selected = config.routes[selectedName] || config.routes[fallbackName];

  if (mode === 'economy' && selected?.premium) {
    return { mode, routeName: fallbackName, route: config.routes[fallbackName] };
  }

  return { mode, routeName: selectedName, route: selected };
}
