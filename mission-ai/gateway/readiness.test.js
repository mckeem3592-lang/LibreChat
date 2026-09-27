import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReadiness } from './readiness.js';

test('reports incomplete readiness without exposing secrets', () => {
  const result = buildReadiness({
    providers: [
      { name: 'openai', hasApiKey: true, apiKeyEnv: 'OPENAI_API_KEY' },
      { name: 'anthropic', hasApiKey: true, apiKeyEnv: 'ANTHROPIC_API_KEY' },
      { name: 'google', hasApiKey: false, apiKeyEnv: 'GOOGLE_KEY' },
    ],
    connectedDevices: [],
    deviceCapabilities: {},
    codeApiConfigured: true,
    pairingConfigured: true,
    costDashboardConfigured: true,
    delegationEnabled: false,
    build: 'abc123',
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.checks, {
    openai: true,
    anthropic: true,
    google: false,
    codeApi: true,
    costDashboard: true,
    delegation: false,
    macDevice: false,
    browserDirect: false,
    browserExtension: false,
    pairing: true,
  });
  assert.equal(JSON.stringify(result).includes('OPENAI_API_KEY'), false);
  assert.equal(JSON.stringify(result).includes('ANTHROPIC_API_KEY'), false);
});


test('reports direct and extension browser capability readiness separately', () => {
  const result = buildReadiness({
    providers: [
      { name: 'openai', hasApiKey: true },
      { name: 'anthropic', hasApiKey: true },
      { name: 'google', hasApiKey: true },
    ],
    connectedDevices: ['mac-primary'],
    deviceCapabilities: {
      'mac-primary': ['mac.control', 'browser.direct_tabs'],
    },
    codeApiConfigured: true,
    pairingConfigured: true,
    costDashboardConfigured: true,
    delegationEnabled: true,
  });

  assert.equal(result.checks.macDevice, true);
  assert.equal(result.checks.browserDirect, true);
  assert.equal(result.checks.browserExtension, false);
  assert.equal(result.ok, false);
  assert.deepEqual(result.deviceCapabilities['mac-primary'], [
    'mac.control',
    'browser.direct_tabs',
  ]);
});
