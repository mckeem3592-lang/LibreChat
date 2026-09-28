import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('.', import.meta.url);

async function text(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('direct Chrome tab tools are exposed through gateway and MCP', async () => {
  const [server, mcp, openapi] = await Promise.all([
    text('./server.js'),
    text('./mcp.js'),
    text('./openapi.yaml'),
  ]);

  for (const token of [
    "browser.list_tabs",
    "browser.activate_tab",
    "browser.close_tabs",
    "browser.open_new_tab",
  ]) {
    assert.ok(server.includes(token), `server missing ${token}`);
    assert.ok(mcp.includes(token), `mcp missing ${token}`);
  }

  for (const operation of [
    'browserListTabs',
    'browserActivateTab',
    'browserCloseTabs',
    'browserOpenNewTab',
  ]) {
    assert.ok(openapi.includes(operation), `OpenAPI missing ${operation}`);
  }
});

test('direct Chrome tab close requires explicit confirmation locally and over MCP', async () => {
  const [companion, directTabs, mcp, openapi] = await Promise.all([
    readFile(new URL('../companion/companion.js', root), 'utf8'),
    readFile(new URL('../companion/direct-tabs.js', root), 'utf8'),
    text('./mcp.js'),
    text('./openapi.yaml'),
  ]);

  assert.ok(companion.includes("normalizeCloseTabRequest(args)"));
  assert.ok(directTabs.includes("args?.confirm !== true"));
  assert.ok(directTabs.includes("confirmation_required"));
  assert.ok(companion.includes("windowId"));
  assert.ok(companion.includes("tabId"));
  assert.ok(companion.includes("expectedUrl"));
  assert.ok(companion.includes("tab_stale"));
  assert.ok(mcp.includes("confirm: z.literal(true)"));
  assert.ok(mcp.includes("windowId: z.string().min(1)"));
  assert.ok(mcp.includes("expectedUrl: z.string().url()"));
  assert.ok(openapi.includes("required: [confirm, tabs]"));
  assert.ok(openapi.includes("required: [windowId, tabId, expectedUrl]"));
});


test('Mac companion capability handshake is privacy-safe and browser-specific', async () => {
  const [companion, server] = await Promise.all([
    readFile(new URL('../companion/companion.js', root), 'utf8'),
    text('./server.js'),
  ]);
  for (const capability of ['mac.control', 'browser.direct_tabs', 'browser.page_extension']) {
    assert.ok(companion.includes(capability));
    assert.ok(server.includes(capability));
  }
  assert.ok(companion.includes("type: 'device_capabilities'"));
  assert.ok(server.includes("message?.type === 'device_capabilities'"));
});
