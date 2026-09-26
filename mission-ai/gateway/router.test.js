import test from 'node:test';
import assert from 'node:assert/strict';
import { budgetMode, chooseRoute } from './router.js';

const config = {
  budget: { targetUsd: 100, economyUsd: 125, hardUsd: 175 },
  routes: {
    economy: { provider: 'low', premium: false },
    primary: { provider: 'primary', premium: false },
    coding: { provider: 'specialist', premium: true },
  },
};

test('budget modes follow configured thresholds', () => {
  assert.equal(budgetMode(0, config.budget), 'normal');
  assert.equal(budgetMode(100, config.budget), 'notice');
  assert.equal(budgetMode(125, config.budget), 'economy');
  assert.equal(budgetMode(175, config.budget), 'blocked');
});

test('economy mode avoids a premium route', () => {
  assert.equal(chooseRoute('coding', 50, config).route.provider, 'specialist');
  assert.equal(chooseRoute('coding', 130, config).route.provider, 'low');
});

test('hard limit returns no route', () => {
  assert.equal(chooseRoute('chat', 200, config).route, null);
});
