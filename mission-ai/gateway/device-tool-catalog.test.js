import assert from 'node:assert/strict';
import test from 'node:test';
import { deviceMcpAllowedTools } from './device-tool-catalog.js';

test('device catalog keeps image generation off by default', () => {
  const tools = deviceMcpAllowedTools();
  assert.equal(tools.has('browser_get_state'), true);
  assert.equal(tools.has('mission_budget_snapshot'), true);
  assert.equal(tools.has('mission_generate_image'), false);
  assert.equal(tools.has('mission_delegate'), false);
});

test('image tool requires both explicit exposure and a budget-backed route', () => {
  assert.equal(deviceMcpAllowedTools({ imageEnabled: true }).has('mission_generate_image'), false);
  assert.equal(
    deviceMcpAllowedTools({ imageBudgetReady: true }).has('mission_generate_image'),
    false,
  );
  const tools = deviceMcpAllowedTools({ imageEnabled: true, imageBudgetReady: true });
  assert.equal(tools.has('mission_generate_image'), true);
  assert.equal(tools.has('mission_delegate'), false);
  assert.equal(tools.has('mission_cost_dashboard'), false);
});
