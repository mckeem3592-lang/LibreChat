import { policyMode } from './routing-policy.js';

export function budgetMode(spendUsd, budget) {
  return policyMode(spendUsd, budget);
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
