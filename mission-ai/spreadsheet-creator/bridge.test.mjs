import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import XLSX from 'xlsx';
import { createWorkbookBytes, publishWorkbook } from './bridge.mjs';

const input = {
  filename: 'Mission AI spreadsheet acceptance.xlsx',
  cells: [
    { address: 'A1', value: 'Item' },
    { address: 'B1', value: 'Count' },
    { address: 'A2', value: 'Probe' },
    { address: 'B2', value: 7 },
    { address: 'C2', value: '=1+1' },
  ],
};

test('creates a valid new XLSX with exact values and no executable formula', () => {
  const { bytes, sha256 } = createWorkbookBytes(input);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), sha256);
  const workbook = XLSX.read(bytes, { type: 'buffer' });
  assert.deepEqual(workbook.SheetNames, ['Sheet1']);
  const sheet = workbook.Sheets.Sheet1;
  assert.equal(sheet.A1.v, 'Item');
  assert.equal(sheet.B1.v, 'Count');
  assert.equal(sheet.A2.v, 'Probe');
  assert.equal(sheet.B2.v, 7);
  assert.equal(sheet.C2.v, '=1+1');
  assert.equal(sheet.C2.f, undefined);
});

test('rejects paths, duplicate cells, oversized addresses, and unsupported values', () => {
  for (const filename of [
    '../private.xlsx',
    'subfolder/private.xlsx',
    '.hidden.xlsx',
    'not-xlsx.pdf',
  ]) {
    assert.throws(() => createWorkbookBytes({ ...input, filename }));
  }
  assert.throws(() => createWorkbookBytes({ ...input, cells: [input.cells[0], input.cells[0]] }));
  assert.throws(() =>
    createWorkbookBytes({ ...input, cells: [{ address: 'A99999', value: 'x' }] }),
  );
  assert.throws(() =>
    createWorkbookBytes({ ...input, cells: [{ address: 'A1', value: { f: '1+1' } }] }),
  );
});

test('publishes only to localhost with the injected owner identity and verifies response metadata', async () => {
  let observed;
  const result = await publishWorkbook(input, {
    userId: 'a'.repeat(24),
    token: 't'.repeat(32),
    port: 12345,
    fetchImpl: async (url, request) => {
      observed = { url, request };
      const file = request.body.get('file');
      assert.equal(file.name, input.filename);
      assert.ok((await file.arrayBuffer()).byteLength > 100);
      return new Response(
        JSON.stringify({
          filename: input.filename,
          bytes: file.size,
          downloadUrl: '/api/files/edited/129ebfc1-6bc1-4571-aceb-49c67e71f22a',
          expiredAt: '2026-10-17T00:00:00.000Z',
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    },
  });
  assert.equal(observed.url, 'http://127.0.0.1:12345/api/files/edited/mcp');
  assert.equal(observed.request.headers['X-LibreChat-User-ID'], 'a'.repeat(24));
  assert.equal(result.ok, true);
  assert.equal(result.downloadUrl, '/api/files/edited/129ebfc1-6bc1-4571-aceb-49c67e71f22a');
});

test('the stdio MCP tool creates and publishes for its injected LibreChat user', async () => {
  let seenPath = '';
  let seenUser = '';
  const expectedBytes = createWorkbookBytes(input).bytes.length;
  const api = http.createServer((request, response) => {
    seenPath = request.url;
    seenUser = request.headers['x-librechat-user-id'];
    request.resume();
    request.on('end', () => {
      response.writeHead(201, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          filename: input.filename,
          bytes: expectedBytes,
          downloadUrl: '/api/files/edited/129ebfc1-6bc1-4571-aceb-49c67e71f22a',
          expiredAt: '2026-10-17T00:00:00.000Z',
        }),
      );
    });
  });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  const port = api.address().port;
  const client = new Client({ name: 'spreadsheet-test', version: '1.0.0' });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL('./bridge.mjs', import.meta.url))],
        env: {
          ...process.env,
          PORT: String(port),
          LOCAL_MCP_TOKEN: 't'.repeat(32),
          MISSION_AI_SPREADSHEET_USER_ID: 'a'.repeat(24),
        },
      }),
    );
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      ['create_spreadsheet'],
    );
    const called = await client.callTool({ name: 'create_spreadsheet', arguments: input });
    assert.equal(called.isError, undefined);
    const result = JSON.parse(called.content[0].text);
    assert.equal(result.ok, true);
    assert.equal(result.bytes, expectedBytes);
    assert.equal(result.downloadMarkdown, `[Download workbook](${result.downloadUrl})`);
    assert.equal(seenPath, '/api/files/edited/mcp');
    assert.equal(seenUser, 'a'.repeat(24));
  } finally {
    await client.close().catch(() => {});
    await new Promise((resolve) => api.close(resolve));
  }
});
