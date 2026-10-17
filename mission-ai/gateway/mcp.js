import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { auditEvent } from './audit-log.js';
import { requireBrowserTabIdentity } from './browser-tab-identity.js';
import { requireBrowserTypeRetention } from './browser-type-integrity.js';

function textResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
  };
}

function errorResult(error) {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : 'mission_ai_error',
          ...(error?.code === 'provider_http_error' &&
            Number.isInteger(error.status) && error.status >= 400 && error.status <= 599
            ? { providerStatus: error.status } : {}),
        }),
      },
    ],
  };
}

const defaultDeviceId = (deviceId) => {
  const selected = deviceId || process.env.MISSION_AI_DEFAULT_DEVICE_ID || 'mac-primary';
  if (/-srv-[a-z0-9]+$/i.test(selected)) {
    throw new Error('invalid_device_id: use the exact paired device ID without a service suffix');
  }
  return selected;
};

export function createMissionMcpNodeHandler({
  invoke,
  getReadiness,
  getDashboard,
  route,
  fallback,
  delegate,
  getCostComparison,
  generateImage,
  search,
  getSearchStatus,
  audit = auditEvent,
  allowedTools,
}) {
  const handler = createMcpHandler(() => {
    const server = new McpServer({
      name: 'mission-ai',
      version: '0.1.0',
    });

    const registerTool = (name, config, toolHandler) => {
      if (allowedTools && !allowedTools.has(name)) return;
      server.registerTool(name, config, async (input) => {
        const startedAt = Date.now();
        let result;
        try {
          result = await toolHandler(input);
          audit({
            action: `mcp:${name}`,
            deviceId:
              input && typeof input.deviceId === 'string'
                ? input.deviceId
                : '',
            outcome: result?.isError ? 'error' : 'ok',
            statusCode: result?.isError ? 502 : 200,
            durationMs: Date.now() - startedAt,
          });
          return result;
        } catch (error) {
          audit({
            action: `mcp:${name}`,
            deviceId:
              input && typeof input.deviceId === 'string'
                ? input.deviceId
                : '',
            outcome: 'error',
            statusCode: 500,
            durationMs: Date.now() - startedAt,
          });
          throw error;
        }
      });
    };

    registerTool(
      'mission_readiness',
      {
        description: 'Return non-secret Mission AI provider, device, code, pairing, and cost-telemetry readiness.',
        inputSchema: z.object({}),
      },
      async () => textResult({ ok: true, readiness: await getReadiness() }),
    );

    registerTool(
      'mission_budget_snapshot',
      {
        description: 'Return only current-month Mission AI spend and ceiling numbers for a bounded request. No provider, project, message, or credential details are returned.',
        inputSchema: z.object({}),
      },
      async () => {
        try {
          const dashboard = await getDashboard();
          const snapshot = Object.fromEntries(
            ['monthStart', 'accountingMode', 'spendUsd', 'projectedSpendUsd',
              'remainingUsd', 'reservedUsd', 'hardUsd', 'accountingBlocked']
              .filter((key) => Object.hasOwn(dashboard, key))
              .map((key) => [key, dashboard[key]]),
          );
          return textResult({ ok: true, snapshot });
        } catch (error) {
          return errorResult(error);
        }
      },
    );

    registerTool(
      'mission_cost_dashboard',
      {
        description: 'Return read-only current-month Mission AI spend and token telemetry. No message content or credentials are returned.',
        inputSchema: z.object({}),
      },
      async () => {
        try {
          return textResult({ ok: true, dashboard: await getDashboard() });
        } catch (error) {
          return errorResult(error);
        }
      },
    );

    registerTool(
      'mission_cost_comparison',
      {
        description: 'Compare measured Mission AI monthly spend with the configured $200 ChatGPT Pro baseline.',
        inputSchema: z.object({}),
      },
      async () => {
        try {
          return textResult({ ok: true, comparison: await getCostComparison() });
        } catch (error) {
          return errorResult(error);
        }
      },
    );

    registerTool(
      'mission_route',
      {
        description: 'Choose the configured model/provider role for a task under the current Mission AI budget policy.',
        inputSchema: z.object({
          task: z.string(),
          monthSpendUsd: z.number().nonnegative(),
          text: z.string().optional(),
          conversationId: z.string().optional(),
          project: z.string().optional(),
        }),
      },
      async (input) => {
        const result = await route(input);
        if (result.status >= 400) return { ...textResult(result.body), isError: true };
        return textResult(result.body);
      },
    );

    registerTool(
      'mission_fallback_plan',
      {
        description: 'Return the sole configured provider/model target for a routing role. Automatic provider fallbacks are disabled.',
        inputSchema: z.object({
          role: z.enum(['economy', 'primary', 'coding', 'reasoning', 'research', 'computer', 'image']),
        }),
      },
      async ({ role }) => {
        try {
          return textResult({ ok: true, plan: await fallback(role) });
        } catch (error) {
          return errorResult(error);
        }
      },
    );

    registerTool(
      'mission_delegate',
      {
        description: 'Run one task through the pinned Mission AI provider with no automatic retries or fallback. This may incur provider API charges.',
        inputSchema: z.object({
          task: z.string(),
          prompt: z.string().min(1).max(200000),
          system: z.string().max(50000).optional(),
          maxOutputTokens: z.number().int().min(1).max(32768).optional(),
          project: z.string().max(200).optional(),
          conversationId: z.string().max(200).optional(),
        }),
      },
      async (input) => {
        try {
          return textResult(await delegate(input));
        } catch (error) {
          return errorResult(error);
        }
      },
    );

    registerTool(
      'mission_generate_image',
      {
        description: 'Generate or edit an image with the configured Mission AI image provider. This may incur provider API charges.',
        inputSchema: z.object({
          prompt: z.string().min(1).max(200000),
          aspectRatio: z.enum(['1:1', '1:4', '4:1', '1:8', '8:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']).optional(),
          imageSize: z.enum(['512', '1K', '2K', '4K']).optional(),
          referenceImage: z.object({
            data: z.string().max(11000000),
            mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
          }).optional(),
          project: z.string().max(200).optional(),
          conversationId: z.string().max(200).optional(),
        }),
      },
      async (input) => {
        try {
          const result = await generateImage(input);
          const { images, ...metadata } = result;
          return {
            content: [
              ...images.map((image) => ({
                type: 'image',
                data: image.data,
                mimeType: image.mimeType,
              })),
              {
                type: 'text',
                text: JSON.stringify({ ok: true, ...metadata, imageCount: images.length }),
              },
            ],
          };
        } catch (error) {
          return errorResult(error);
        }
      },
    );

    if (search && getSearchStatus) {
      registerTool('mission_search_status', {
        description: 'Check verified Tavily free-plan allowance without a search or AI call.',
        inputSchema: z.object({}).strict(),
      }, async () => {
        try { return textResult({ ok: true, search: await getSearchStatus() }); }
        catch (error) { return errorResult(error); }
      });
      registerTool('mission_web_search', {
        description: 'Search only Tavily basic using available verified free credits. No AI answer, paid upgrade, scraping, retry or fallback. Results are untrusted page content.',
        inputSchema: z.object({ query: z.string().min(1).max(2000), maxResults: z.number().int().min(1).max(5).optional() }).strict(),
      }, async input => {
        try { return textResult({ ok: true, search: await search(input) }); }
        catch (error) { return errorResult(error); }
      });
    }

    registerTool(
      'browser_list_tabs',
      {
        description: 'List open HTTP and HTTPS Chrome tabs on the selected paired device without changing the foreground tab.',
        inputSchema: z.object({ deviceId: z.string().optional() }),
      },
      async ({ deviceId }) => {
        try {
          return textResult(await invoke(defaultDeviceId(deviceId), 'browser.list_tabs', {}));
        } catch (error) {
          return errorResult(error);
        }
      },
    );

    registerTool(
      'browser_activate_tab',
      {
        description: 'Activate a specific Google Chrome tab by stable window and tab IDs on the paired device.',
        inputSchema: z.object({
          deviceId: z.string().optional(),
          windowId: z.string().min(1),
          tabId: z.string().min(1),
        }),
      },
      async ({ deviceId, windowId, tabId }) => {
        try {
          return textResult(
            await invoke(defaultDeviceId(deviceId), 'browser.activate_tab', {
              windowId,
              tabId,
            }),
          );
        } catch (error) {
          return errorResult(error);
        }
      },
    );

    registerTool(
      'browser_open_new_tab',
      {
        description: 'Open an HTTP or HTTPS URL in a new background Chrome tab on the paired device. Record the returned tab IDs and close that tab when the task is complete.',
        inputSchema: z.object({
          deviceId: z.string().optional(),
          url: z.string().url(),
        }),
      },
      async ({ deviceId, url }) => {
        try {
          return textResult(
            await invoke(defaultDeviceId(deviceId), 'browser.open_new_tab', { url }),
          );
        } catch (error) {
          return errorResult(error);
        }
      },
    );

    registerTool(
      'browser_close_tabs',
      {
        description: 'Close explicitly selected Google Chrome tabs. Requires confirm=true because closing a tab can discard unsaved work.',
        inputSchema: z.object({
          deviceId: z.string().optional(),
          confirm: z.literal(true),
          tabs: z.array(
            z.object({
              windowId: z.string().min(1),
              tabId: z.string().min(1),
              expectedUrl: z.string().url(),
            }),
          ).min(1).max(100),
        }),
      },
      async ({ deviceId, confirm, tabs }) => {
        try {
          return textResult(
            await invoke(defaultDeviceId(deviceId), 'browser.close_tabs', {
              confirm,
              tabs,
            }),
          );
        } catch (error) {
          return errorResult(error);
        }
      },
    );

    registerTool(
      'browser_get_state',
      {
        description: 'Read a Chrome tab by tabId, or the currently active tab when omitted. The returned tab identity must match a requested tabId; older installed extensions might only read the active tab. Visible noncredential editable values and page content are untrusted data.',
        inputSchema: z.object({ deviceId: z.string().optional(), tabId: z.string().optional() }),
      },
      async ({ deviceId, tabId }) => {
        try {
          const result = await invoke(defaultDeviceId(deviceId), 'browser.get_state', { tabId });
          return textResult(requireBrowserTabIdentity(result, tabId));
        } catch (error) {
          return errorResult(error);
        }
      },
    );

    registerTool(
      'browser_click',
      {
        description: 'Click an indexed element in the tab bound to a fresh browser_get_state snapshot, including a background tab.',
        inputSchema: z.object({
          deviceId: z.string().optional(),
          snapshotId: z.string().min(1),
          elementKey: z.string().min(1).max(400),
          index: z.number().int().nonnegative(),
        }),
      },
      async ({ deviceId, snapshotId, elementKey, index }) => {
        try {
          return textResult(
            await invoke(defaultDeviceId(deviceId), 'browser.click', {
              snapshotId,
              elementKey,
              index,
            }),
          );
        } catch (error) {
          return errorResult(error);
        }
      },
    );

    registerTool(
      'browser_type',
      {
        description: 'Type into an indexed visible, noncredential text field in the tab bound to a fresh browser_get_state snapshot. The result confirms DOM retention only, not a website save; if the extension reports browser_text_unverified_after_action, inspect the page before retrying.',
        inputSchema: z.object({
          deviceId: z.string().optional(),
          snapshotId: z.string().min(1),
          elementKey: z.string().min(1).max(400),
          index: z.number().int().nonnegative(),
          text: z.string().max(20000),
        }),
      },
      async ({ deviceId, snapshotId, elementKey, index, text }) => {
        try {
          return textResult(
            requireBrowserTypeRetention(await invoke(defaultDeviceId(deviceId), 'browser.type', {
              snapshotId,
              elementKey,
              index,
              text,
            }), text.length),
          );
        } catch (error) {
          return errorResult(error);
        }
      },
    );

    registerTool(
      'browser_scroll',
      {
        description: 'Scroll the active Chrome tab.',
        inputSchema: z.object({
          deviceId: z.string().optional(),
          x: z.number().optional(),
          y: z.number().optional(),
        }),
      },
      async ({ deviceId, x = 0, y = 600 }) => {
        try {
          return textResult(await invoke(defaultDeviceId(deviceId), 'browser.scroll', { x, y }));
        } catch (error) {
          return errorResult(error);
        }
      },
    );

    registerTool(
      'browser_open_url',
      {
        description: 'Navigate a selected Chrome tab by tabId, or open a new background tab when omitted.',
        inputSchema: z.object({
          deviceId: z.string().optional(),
          url: z.string().url(),
          tabId: z.string().optional(),
        }),
      },
      async ({ deviceId, url, tabId }) => {
        try {
          return textResult(await invoke(defaultDeviceId(deviceId), 'browser.open_url', { url, tabId }));
        } catch (error) {
          return errorResult(error);
        }
      },
    );

    registerTool(
      'file_list',
      {
        description: 'List up to 200 entries in the paired device Desktop, Documents, or Downloads folder. Hidden files and symlink paths are excluded.',
        inputSchema: z.object({
          deviceId: z.string().optional(),
          root: z.enum(['Desktop', 'Documents', 'Downloads']),
          directory: z.string().max(2000).optional(),
        }),
      },
      async ({ deviceId, root, directory = '' }) => {
        try { return textResult(await invoke(defaultDeviceId(deviceId), 'file.list', { root, directory })); }
        catch (error) { return errorResult(error); }
      },
    );

    registerTool(
      'file_move',
      {
        description: 'Move one file between Desktop, Documents, and Downloads on the paired device after user approval. Existing destinations are never replaced.',
        inputSchema: z.object({
          deviceId: z.string().optional(),
          sourceRoot: z.enum(['Desktop', 'Documents', 'Downloads']),
          sourcePath: z.string().min(1).max(2000),
          destinationRoot: z.enum(['Desktop', 'Documents', 'Downloads']),
          destinationPath: z.string().min(1).max(2000),
        }),
      },
      async ({ deviceId, sourceRoot, sourcePath, destinationRoot, destinationPath }) => {
        try { return textResult(await invoke(defaultDeviceId(deviceId), 'file.move',
          { sourceRoot, sourcePath, destinationRoot, destinationPath })); }
        catch (error) { return errorResult(error); }
      },
    );

    registerTool('file_read', {
      description: 'Read one UTF-8 text file up to 1 MB within Desktop, Documents, or Downloads on the paired device. Its content enters the selected model context.',
      inputSchema: z.object({ deviceId: z.string().optional(),
        root: z.enum(['Desktop', 'Documents', 'Downloads']),
        path: z.string().min(1).max(2000) }),
    }, async ({ deviceId, root, path }) => {
      try { return textResult(await invoke(defaultDeviceId(deviceId), 'file.read', { root, path })); }
      catch (error) { return errorResult(error); }
    });

    registerTool('file_write', {
      description: 'Create or update one UTF-8 text file up to 1 MB within Desktop, Documents, or Downloads. Use the exact paired device ID (mac-primary on the Mac); never append a Render service ID. Omit deviceId to use the configured default. An update requires the sha256 from the latest read.',
      inputSchema: z.object({ deviceId: z.string().optional(),
        root: z.enum(['Desktop', 'Documents', 'Downloads']),
        path: z.string().min(1).max(2000), text: z.string().max(1_000_000),
        expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }),
    }, async ({ deviceId, root, path, text, expectedSha256 }) => {
      try { return textResult(await invoke(defaultDeviceId(deviceId), 'file.write',
        { root, path, text, expectedSha256 })); }
      catch (error) { return errorResult(error); }
    });

    registerTool('repo_list', {
      description: 'List up to 200 visible entries in the locally configured Git checkout on the paired device. Hidden entries and links are excluded.',
      inputSchema: z.object({ deviceId: z.string().optional(), directory: z.string().max(2000).optional() }),
    }, async ({ deviceId, directory = '' }) => {
      try { return textResult(await invoke(defaultDeviceId(deviceId), 'repo.list', { directory })); }
      catch (error) { return errorResult(error); }
    });

    registerTool('repo_read', {
      description: 'Read a UTF-8 source file in the paired device repository configured locally by the owner. Returns content and sha256; hidden paths and links are excluded.',
      inputSchema: z.object({ deviceId: z.string().optional(), path: z.string().min(1).max(2000) }),
    }, async ({ deviceId, path }) => {
      try { return textResult(await invoke(defaultDeviceId(deviceId), 'repo.read', { path })); }
      catch (error) { return errorResult(error); }
    });

    registerTool('repo_write', {
      description: 'Create or update one source file in the locally configured repository. Updates require sha256 from a fresh repo_read. Reopen the file and inspect the diff after writing.',
      inputSchema: z.object({ deviceId: z.string().optional(), path: z.string().min(1).max(2000),
        text: z.string().max(256000), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }),
    }, async ({ deviceId, path, text, expectedSha256 }) => {
      try { return textResult(await invoke(defaultDeviceId(deviceId), 'repo.write', { path, text, expectedSha256 })); }
      catch (error) { return errorResult(error); }
    });

    registerTool('repo_check', {
      description: 'Run one named check configured locally by the owner for the paired repository. Returns actual exit code and bounded output; arbitrary tool-supplied commands are refused.',
      inputSchema: z.object({ deviceId: z.string().optional(), checkId: z.string().min(1).max(100) }),
    }, async ({ deviceId, checkId }) => {
      try { return textResult(await invoke(defaultDeviceId(deviceId), 'repo.check', { checkId }, 120_000)); }
      catch (error) { return errorResult(error); }
    });

    registerTool('repo_start_check', {
      description: 'Start one locally configured repository check on the paired device and return a job ID immediately. The check continues across a gateway disconnect while the companion stays running; poll repo_check_status for the actual result.',
      inputSchema: z.object({ deviceId: z.string().optional(), checkId: z.string().min(1).max(100) }),
    }, async ({ deviceId, checkId }) => {
      try { return textResult(await invoke(defaultDeviceId(deviceId), 'repo.start_check', { checkId })); }
      catch (error) { return errorResult(error); }
    });

    registerTool('repo_check_status', {
      description: 'Get the running or terminal result of one repository check job on the paired device. Results are retained in companion memory for up to one hour or 20 jobs; a restart loses them.',
      inputSchema: z.object({ deviceId: z.string().optional(), jobId: z.string().uuid() }),
    }, async ({ deviceId, jobId }) => {
      try { return textResult(await invoke(defaultDeviceId(deviceId), 'repo.check_status', { jobId })); }
      catch (error) { return errorResult(error); }
    });

    registerTool(
      'mac_active_app',
      {
        description: 'Return the frontmost application on the paired personal Mac.',
        inputSchema: z.object({ deviceId: z.string().optional() }),
      },
      async ({ deviceId }) => {
        try {
          return textResult(await invoke(defaultDeviceId(deviceId), 'mac.active_app', {}));
        } catch (error) {
          return errorResult(error);
        }
      },
    );

    registerTool(
      'mac_open_app',
      {
        description: 'Open an application only when it is present on the local companion allowlist.',
        inputSchema: z.object({
          deviceId: z.string().optional(),
          name: z.string(),
        }),
      },
      async ({ deviceId, name }) => {
        try {
          return textResult(await invoke(defaultDeviceId(deviceId), 'mac.open_app', { name }));
        } catch (error) {
          return errorResult(error);
        }
      },
    );

    registerTool(
      'mac_screenshot',
      {
        description: 'Capture a bounded screenshot of the paired Mac primary display, with an ID and image dimensions for correctly scaled clicks.',
        inputSchema: z.object({ deviceId: z.string().optional() }),
      },
      async ({ deviceId }) => {
        try {
          const result = await invoke(defaultDeviceId(deviceId), 'mac.screenshot', {});
          if (!result?.base64 || !result?.mimeType) return textResult(result);
          return {
            content: [{ type: 'image', data: result.base64, mimeType: result.mimeType },
              { type: 'text', text: JSON.stringify({ screenshotId: result.screenshotId, imageWidth: result.imageWidth, imageHeight: result.imageHeight, display: result.display, capturedAt: result.capturedAt }) }],
          };
        } catch (error) {
          return errorResult(error);
        }
      },
    );

    registerTool(
      'mac_click',
      {
        description: 'Click x/y image coordinates from a fresh mac_screenshot on the paired primary display. Supply its screenshotId; the Mac converts coordinates and asks the owner before clicking.',
        inputSchema: z.object({
          deviceId: z.string().optional(),
          screenshotId: z.string().uuid(),
          x: z.number().nonnegative(),
          y: z.number().nonnegative(),
        }),
      },
      async ({ deviceId, screenshotId, x, y }) => {
        try {
          return textResult(await invoke(defaultDeviceId(deviceId), 'mac.click', { screenshotId, x, y }));
        } catch (error) {
          return errorResult(error);
        }
      },
    );

    registerTool(
      'mac_type',
      {
        description: 'Type in an explicitly named allowed app. After approving in Terminal, the owner must return to that app within ten seconds. Terminal input is refused.',
        inputSchema: z.object({
          deviceId: z.string().optional(),
          text: z.string().max(20000),
          expectedApp: z.string().min(1).max(100),
        }),
      },
      async ({ deviceId, text, expectedApp }) => {
        try {
          return textResult(await invoke(defaultDeviceId(deviceId), 'mac.type', { text, expectedApp }));
        } catch (error) {
          return errorResult(error);
        }
      },
    );

    registerTool(
      'mac_key',
      {
        description: 'Send one allowed key to an explicitly named allowed app. After approving in Terminal, return to that app within ten seconds. Terminal input is refused.',
        inputSchema: z.object({
          deviceId: z.string().optional(),
          key: z.enum(['return', 'enter', 'tab', 'escape', 'left', 'right', 'down', 'up', 'pagedown', 'pageup', 'delete']),
          expectedApp: z.string().min(1).max(100),
        }),
      },
      async ({ deviceId, key, expectedApp }) => {
        try {
          return textResult(await invoke(defaultDeviceId(deviceId), 'mac.key', { key, expectedApp }));
        } catch (error) {
          return errorResult(error);
        }
      },
    );

    return server;
  });

  return toNodeHandler(handler);
}
