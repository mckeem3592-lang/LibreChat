import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import XLSX from 'xlsx';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const TOOL = 'create_spreadsheet';
const MAX_CELLS = 1000;
const MAX_BYTES = 5 * 1024 * 1024;
const CELL = /^([A-Z]{1,2})([1-9][0-9]{0,3})$/;
const FILENAME = /^[\p{L}\p{N} ._()-]{1,120}\.xlsx$/iu;
const INVALID_SHEET_CHARS = new Set(['[', ']', ':', '*', '?', '/', '\\']);

export function createWorkbookBytes(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('invalid_spreadsheet_request');
  }
  const { filename, sheetName = 'Sheet1', cells } = input;
  if (
    typeof filename !== 'string' ||
    !FILENAME.test(filename) ||
    filename.startsWith('.') ||
    [...filename].some((char) => char.charCodeAt(0) < 32)
  ) {
    throw new Error('invalid_spreadsheet_filename');
  }
  if (
    typeof sheetName !== 'string' ||
    !sheetName.trim() ||
    sheetName.length > 31 ||
    [...sheetName].some((char) => INVALID_SHEET_CHARS.has(char))
  ) {
    throw new Error('invalid_sheet_name');
  }
  if (!Array.isArray(cells) || cells.length < 1 || cells.length > MAX_CELLS) {
    throw new Error('invalid_cell_count');
  }

  const seen = new Set();
  const sheet = {};
  let maxRow = 0;
  let maxCol = 0;
  for (const entry of cells) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      Object.keys(entry).sort().join(',') !== 'address,value'
    ) {
      throw new Error('invalid_cell');
    }
    const address = String(entry.address ?? '').toUpperCase();
    const match = CELL.exec(address);
    if (!match || seen.has(address)) throw new Error('invalid_cell_address');
    seen.add(address);
    const value = entry.value;
    const validValue =
      (typeof value === 'string' && value.length <= 2000) ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value));
    if (!validValue) throw new Error('invalid_cell_value');
    const col = XLSX.utils.decode_col(match[1]);
    const row = Number(match[2]) - 1;
    maxRow = Math.max(maxRow, row);
    maxCol = Math.max(maxCol, col);
    let type = 'n';
    if (typeof value === 'string') type = 's';
    else if (typeof value === 'boolean') type = 'b';
    sheet[address] = { t: type, v: value };
  }
  sheet['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxRow, c: maxCol } });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true });
  if (bytes.length < 1 || bytes.length > MAX_BYTES) throw new Error('workbook_size_limit');
  return { filename, bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

export async function publishWorkbook(input, options) {
  const { userId, token, port, fetchImpl = fetch } = options;
  if (
    !/^[a-f0-9]{24}$/i.test(userId ?? '') ||
    typeof token !== 'string' ||
    token.length < 32 ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error('spreadsheet_publisher_unconfigured');
  }
  const artifact = createWorkbookBytes(input);
  const form = new FormData();
  form.append(
    'file',
    new Blob([artifact.bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
    artifact.filename,
  );
  const response = await fetchImpl(`http://127.0.0.1:${port}/api/files/edited/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-LibreChat-User-ID': userId,
    },
    body: form,
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`spreadsheet_publish_failed_${response.status}`);
  const published = await response.json();
  if (
    published.filename !== artifact.filename ||
    published.bytes !== artifact.bytes.length ||
    !/^\/api\/files\/edited\/[a-f0-9-]{36}$/i.test(published.downloadUrl ?? '')
  ) {
    throw new Error('spreadsheet_publish_result_invalid');
  }
  return {
    ok: true,
    filename: artifact.filename,
    bytes: artifact.bytes.length,
    sha256: artifact.sha256,
    downloadUrl: published.downloadUrl,
    downloadMarkdown: `[Download workbook](${published.downloadUrl})`,
    expiresAt: published.expiredAt,
  };
}

export async function main() {
  const options = {
    userId: process.env.MISSION_AI_SPREADSHEET_USER_ID,
    token: process.env.LOCAL_MCP_TOKEN,
    port: Number(process.env.PORT),
  };
  if (
    !/^[a-f0-9]{24}$/i.test(options.userId ?? '') ||
    typeof options.token !== 'string' ||
    options.token.length < 32 ||
    !Number.isInteger(options.port) ||
    options.port < 1 ||
    options.port > 65535
  ) {
    throw new Error('spreadsheet_publisher_unconfigured');
  }
  const server = new Server(
    { name: 'mission-ai-spreadsheet-creator', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: TOOL,
        description:
          'Create a new XLSX workbook from explicit plain values and publish it as a private, expiring LibreChat download. Include the returned downloadMarkdown verbatim in your final answer so the owner can click it. Does not read existing files or accept formulas.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['filename', 'cells'],
          properties: {
            filename: {
              type: 'string',
              description: 'Output filename ending in .xlsx, without a path.',
            },
            sheetName: { type: 'string', description: 'Optional first sheet name.' },
            cells: {
              type: 'array',
              minItems: 1,
              maxItems: MAX_CELLS,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['address', 'value'],
                properties: {
                  address: { type: 'string' },
                  value: { type: ['string', 'number', 'boolean'] },
                },
              },
            },
          },
        },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (params.name !== TOOL) throw new Error('unknown_tool');
    try {
      const result = await publishWorkbook(params.arguments, options);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              error: error instanceof Error ? error.message : 'spreadsheet_create_failed',
            }),
          },
        ],
      };
    }
  });
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Mission AI spreadsheet creator unavailable');
    process.exitCode = 1;
  });
}
