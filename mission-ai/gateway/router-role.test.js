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

test('router reports selected role', () => {
  assert.equal(chooseRoute('primary', 0, config).routeName, 'primary');
  assert.equal(chooseRoute('coding', 125, config).routeName, 'economy');
});
