import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export const REPOSITORY = 'mckeem3592-lang/mission-program-hub';
export const TOOLS = new Set(['get_file_contents', 'create_branch', 'push_files']);
const [OWNER, REPO] = REPOSITORY.split('/');

export function authorizeTool(name, args) {
  if (!TOOLS.has(name) || !args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('GitHub tool not permitted');
  }
  if (args.owner !== OWNER || args.repo !== REPO) {
    throw new Error('GitHub repository not permitted');
  }
  return args;
}

async function main() {
  const token = process.env.MISSION_AI_GITHUB_MCP_TOKEN;
  if (!token || /\s/.test(token)) throw new Error('GitHub MCP credential unavailable');

  const upstream = new Client({ name: 'mission-ai-github-bridge', version: '1.0.0' });
  await upstream.connect(new StreamableHTTPClientTransport(
    new URL('https://api.githubcopilot.com/mcp/'),
    { requestInit: { headers: {
      Authorization: `Bearer ${token}`,
      'X-MCP-Tools': [...TOOLS].join(','),
    } } },
  ));

  const catalog = await upstream.listTools();
  const available = catalog.tools.filter((tool) => TOOLS.has(tool.name));
  if (available.length !== TOOLS.size) throw new Error('GitHub MCP tool catalog incomplete');

  const server = new Server(
    { name: 'github-code-editor', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: available }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    authorizeTool(params.name, params.arguments);
    return upstream.callTool({ name: params.name, arguments: params.arguments });
  });
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('GitHub MCP bridge unavailable');
    process.exitCode = 1;
  });
}
