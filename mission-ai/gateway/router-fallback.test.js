import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseRoute } from './router.js';

const config = {
  budget: { targetUsd: 100, economyUsd: 125, hardUsd: 175 },
  routes: {
    economy: { premium: false },
    primary: { premium: false },
    coding: { premium: true },
  },
};

test('unknown route uses primary', () => {
  assert.equal(chooseRoute('unknown', 0, config).route, config.routes.primary);
});

test('economy mode replaces premium route', () => {
  assert.equal(chooseRoute('coding', 125, config).route, config.routes.economy);
});
