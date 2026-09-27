import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCostDashboard,
  providerForModel,
  transactionBreakdownPipeline,
} from './dashboard.js';

const catalog = {
  providers: {
    openai: { primary: 'gpt-primary' },
    anthropic: { coding: 'claude-coding' },
  },
};

test('provider mapping uses configured model catalog', () => {
  assert.equal(providerForModel('gpt-primary', catalog), 'openai');
  assert.equal(providerForModel('claude-coding', catalog), 'anthropic');
  assert.equal(providerForModel('other', catalog), 'unknown');
});

test('dashboard aggregates spend by provider and model', () => {
  const dashboard = buildCostDashboard({
    catalog,
    now: new Date('2026-09-27T18:00:00Z'),
    timeZone: 'America/Denver',
    rows: [
      {
        _id: { model: 'gpt-primary', tokenType: 'prompt' },
        settledCredits: 2500000,
        inputTokens: 1000,
        readTokens: 200,
      },
      {
        _id: { model: 'gpt-primary', tokenType: 'completion' },
        settledCredits: 1500000,
        rawAmount: 400,
      },
      {
        _id: { model: 'claude-coding', tokenType: 'completion' },
        settledCredits: 6000000,
        rawAmount: 900,
      },
    ],
  });

  assert.equal(dashboard.spendUsd, 10);
  assert.equal(dashboard.remainingUsd, 165);
  assert.equal(dashboard.mode, 'normal');
  assert.deepEqual(
    dashboard.byProvider.map(({ provider, spendUsd }) => ({ provider, spendUsd })),
    [
      { provider: 'anthropic', spendUsd: 6 },
      { provider: 'openai', spendUsd: 4 },
    ],
  );
  assert.equal(dashboard.byModel[1].inputTokens, 1000);
  assert.equal(dashboard.byModel[1].readTokens, 200);
});

test('transaction aggregation only reads settled paid prompt/completion rows', () => {
  const start = new Date('2026-09-01T06:00:00Z');
  const pipeline = transactionBreakdownPipeline(start);
  assert.deepEqual(pipeline[0].$match, {
    createdAt: { $gte: start },
    tokenType: { $in: ['prompt', 'completion'] },
    tokenValue: { $lt: 0 },
  });
});
