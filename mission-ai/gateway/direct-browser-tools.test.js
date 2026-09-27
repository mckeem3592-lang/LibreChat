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
  const [companion, mcp, openapi] = await Promise.all([
    readFile(new URL('../companion/companion.js', root), 'utf8'),
    text('./mcp.js'),
    text('./openapi.yaml'),
  ]);

  assert.ok(companion.includes("args?.confirm !== true"));
  assert.ok(companion.includes("confirmation_required"));
  assert.ok(mcp.includes("confirm: z.literal(true)"));
  assert.ok(openapi.includes("required: [confirm, tabs]"));
});
