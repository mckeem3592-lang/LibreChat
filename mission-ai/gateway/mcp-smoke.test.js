import http from 'node:http';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMissionMcpNodeHandler } from './mcp.js';

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

    assert.equal(audits.some((event) => event.action === 'mcp:mission_readiness'), true);
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
