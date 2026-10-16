import http from 'node:http';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMissionMcpNodeHandler } from './mcp.js';
import { deviceMcpAllowedTools } from './device-tool-catalog.js';

async function listen(handler) {
  const server = http.createServer((req, res) => {
    void handler(req, res, undefined);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test_server_address_missing');
  return {
    server,
    url: new URL(`http://127.0.0.1:${address.port}/mcp`),
  };
}

test('MCP streamable HTTP initializes, lists tools, calls readiness, and audits safely', async () => {
  const audits = [];
  const handler = createMissionMcpNodeHandler({
    invoke: async () => ({ ok: true }),
    getReadiness: async () => ({
      ok: false,
      checks: {
        openai: false,
        anthropic: false,
        google: false,
        codeApi: true,
        costDashboard: false,
        delegation: false,
        macDevice: false,
        pairing: false,
      },
      connectedDevices: [],
      build: 'test',
    }),
    getDashboard: async () => ({ spendUsd: 0 }),
    getCostComparison: async () => ({ baselineMonthlyUsd: 200, missionSpendUsd: 0 }),
    route: async () => ({ status: 200, body: { ok: true, mode: 'normal' } }),
    fallback: async () => ({ available: false, targets: [] }),
    delegate: async () => {
      throw new Error('delegation_disabled');
    },
    generateImage: async () => {
      throw new Error('delegation_disabled');
    },
    audit: (event) => audits.push(event),
  });

  const { server, url } = await listen(handler);
  const client = new Client({ name: 'mission-ai-test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(url));
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    assert.ok(names.includes('mission_readiness'));
    assert.ok(names.includes('mission_cost_dashboard'));
    assert.ok(names.includes('mission_generate_image'));
    assert.ok(names.includes('browser_get_state'));

    const result = await client.callTool({
      name: 'mission_readiness',
      arguments: {},
    });
    assert.equal(result.isError, undefined);
    const text = result.content.find((block) => block.type === 'text');
    assert.ok(text && text.type === 'text');
    const body = JSON.parse(text.text);
    assert.equal(body.ok, true);
    assert.equal(body.readiness.build, 'test');

    const browser = await client.callTool({
      name: 'browser_get_state',
      arguments: { deviceId: 'mac-primary' },
    });
    assert.equal(browser.isError, undefined);

    assert.equal(
      audits.some((event) => event.action === 'mcp:mission_readiness'),
      true,
    );
    const browserAudit = audits.find((event) => event.action === 'mcp:browser_get_state');
    assert.ok(browserAudit);
    assert.equal(browserAudit.deviceId, 'mac-primary');
    const serialized = JSON.stringify(audits);
    assert.equal(serialized.includes('arguments'), false);
    assert.equal(serialized.includes('prompt'), false);
    assert.equal(serialized.includes('browserToken'), false);
  } finally {
    await client.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
});

test('device MCP catalog exposes browser tools without paid delegation or desktop focus tools', async () => {
  const allowedTools = new Set(['mission_readiness', 'browser_list_tabs', 'browser_get_state']);
  const handler = createMissionMcpNodeHandler({
    allowedTools,
    invoke: async () => ({ tabs: [] }),
    getReadiness: async () => ({ ok: true }),
    audit: () => {},
  });
  const { server, url } = await listen(handler);
  const client = new Client({ name: 'mission-ai-device-test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(url));
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.deepEqual(names.sort(), [...allowedTools].sort());
  } finally {
    await client.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
});

test('device budget snapshot excludes detailed spending and other private fields', async () => {
  const handler = createMissionMcpNodeHandler({
    allowedTools: deviceMcpAllowedTools(),
    getDashboard: async () => ({
      monthStart: '2026-10-01T06:00:00.000Z',
      accountingMode: 'shared',
      spendUsd: 0.21,
      projectedSpendUsd: 0.23,
      remainingUsd: 9.77,
      reservedUsd: 0.02,
      hardUsd: 10,
      byProject: [{ project: 'private-project', spendUsd: 0.21 }],
      native: { secret: 'never-return' },
    }),
    audit: () => {},
  });
  const { server, url } = await listen(handler);
  const client = new Client({ name: 'mission-ai-budget-snapshot-test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(url));
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    assert.equal(tools.includes('mission_budget_snapshot'), true);
    assert.equal(tools.includes('mission_cost_dashboard'), false);
    const result = await client.callTool({ name: 'mission_budget_snapshot', arguments: {} });
    assert.equal(result.isError, undefined);
    const body = JSON.parse(result.content.find((block) => block.type === 'text').text);
    assert.deepEqual(body, {
      ok: true,
      snapshot: {
        monthStart: '2026-10-01T06:00:00.000Z',
        accountingMode: 'shared',
        spendUsd: 0.21,
        projectedSpendUsd: 0.23,
        remainingUsd: 9.77,
        reservedUsd: 0.02,
        hardUsd: 10,
      },
    });
    assert.equal(JSON.stringify(body).includes('private-project'), false);
    assert.equal(JSON.stringify(body).includes('never-return'), false);
  } finally {
    await client.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
});

test('opted-in device catalog exposes only the budget-backed image action', async () => {
  const calls = [];
  const handler = createMissionMcpNodeHandler({
    allowedTools: deviceMcpAllowedTools({ imageEnabled: true, imageBudgetReady: true }),
    generateImage: async (input) => {
      calls.push(input);
      return {
        ok: true,
        images: [{ mimeType: 'image/png', data: 'cG5n' }],
        cost: { totalUsd: 0.01 },
      };
    },
    audit: () => {},
  });
  const { server, url } = await listen(handler);
  const client = new Client({ name: 'mission-ai-image-test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(url));
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.equal(names.includes('mission_generate_image'), true);
    assert.equal(names.includes('mission_delegate'), false);
    assert.equal(names.includes('mission_cost_dashboard'), false);
    const result = await client.callTool({
      name: 'mission_generate_image',
      arguments: { prompt: 'one original test image' },
    });
    assert.equal(result.isError, undefined);
    assert.equal(
      result.content.some((block) => block.type === 'image'),
      true,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].prompt, 'one original test image');
  } finally {
    await client.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
});

test('image provider failure exposes only the safe HTTP status', async () => {
  const handler = createMissionMcpNodeHandler({
    allowedTools: deviceMcpAllowedTools({ imageEnabled: true, imageBudgetReady: true }),
    generateImage: async () => {
      const error = new Error('provider_http_error');
      error.code = 'provider_http_error';
      error.status = 403;
      error.privateDetail = 'never-return';
      throw error;
    },
    audit: () => {},
  });
  const { server, url } = await listen(handler);
  const client = new Client({ name: 'mission-ai-image-error-test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(url));
    const result = await client.callTool({
      name: 'mission_generate_image',
      arguments: { prompt: 'diagnose image failure' },
    });
    assert.equal(result.isError, true);
    assert.deepEqual(JSON.parse(result.content[0].text), {
      ok: false,
      error: 'provider_http_error',
      providerStatus: 403,
    });
  } finally {
    await client.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
});

test('device MCP routes scoped text tools to the configured Windows device', async () => {
  const previous = process.env.MISSION_AI_DEFAULT_DEVICE_ID;
  process.env.MISSION_AI_DEFAULT_DEVICE_ID = 'windows-work';
  const calls = [];
  const handler = createMissionMcpNodeHandler({
    allowedTools: new Set(['file_read', 'file_write']),
    invoke: async (...args) => {
      calls.push(args);
      return { ok: true };
    },
    audit: () => {},
  });
  const { server, url } = await listen(handler);
  const client = new Client({ name: 'mission-ai-file-test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(url));
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [
      'file_read',
      'file_write',
    ]);
    await client.callTool({
      name: 'file_read',
      arguments: { root: 'Documents', path: 'notes.txt' },
    });
    await client.callTool({
      name: 'file_write',
      arguments: {
        root: 'Documents',
        path: 'notes.txt',
        text: 'updated',
        expectedSha256: 'a'.repeat(64),
      },
    });
    assert.deepEqual(
      calls.map(([device, tool]) => [device, tool]),
      [
        ['windows-work', 'file.read'],
        ['windows-work', 'file.write'],
      ],
    );
  } finally {
    await client.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.MISSION_AI_DEFAULT_DEVICE_ID;
    else process.env.MISSION_AI_DEFAULT_DEVICE_ID = previous;
  }
});

test('device MCP exposes scoped repository read, write and named checks without accepting a command', async () => {
  const calls = [];
  const handler = createMissionMcpNodeHandler({
    allowedTools: new Set(['repo_read', 'repo_write', 'repo_check']),
    invoke: async (...args) => { calls.push(args); return { ok: true }; },
    audit: () => {},
  });
  const { server, url } = await listen(handler);
  const client = new Client({ name: 'mission-ai-repo-test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(url));
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(),
      ['repo_check', 'repo_read', 'repo_write']);
    await client.callTool({ name: 'repo_read', arguments: { deviceId: 'windows-work', path: 'src/app.js' } });
    await client.callTool({ name: 'repo_write', arguments: { deviceId: 'windows-work', path: 'src/app.js',
      text: 'new', expectedSha256: 'a'.repeat(64) } });
    await client.callTool({ name: 'repo_check', arguments: { deviceId: 'windows-work', checkId: 'diff-check' } });
    assert.deepEqual(calls, [
      ['windows-work', 'repo.read', { path: 'src/app.js' }],
      ['windows-work', 'repo.write', { path: 'src/app.js', text: 'new', expectedSha256: 'a'.repeat(64) }],
      ['windows-work', 'repo.check', { checkId: 'diff-check' }, 120_000],
    ]);
  } finally {
    await client.close().catch(() => {});
    await new Promise(resolve => server.close(resolve));
  }
});
