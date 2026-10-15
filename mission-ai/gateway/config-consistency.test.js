import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('routing config includes required route classes', async () => {
  const text = await readFile(new URL('../config/router.json', import.meta.url), 'utf8');
  const config = JSON.parse(text);
  for (const name of ['economy', 'primary', 'coding', 'reasoning', 'research', 'computer', 'image']) {
    assert.ok(config.routes[name]);
  }
});

test('LibreChat keeps legacy config separate and pins bounded Tavily search for the chat test profile', async () => {
  const text = await readFile(new URL('../config/librechat.mission-ai.yaml', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /tavily/i);
  const chat = await readFile(new URL('../config/librechat.github-editor.yaml', import.meta.url), 'utf8');
  assert.match(chat, /searchProvider:\s*tavily/);
  assert.match(chat, /scraperProvider:\s*keenable/);
  assert.match(chat, /rerankerType:\s*none/);
  assert.match(chat, /tavilyApiKey:\s*'\$\{TAVILY_API_KEY\}'/);
  assert.match(chat, /maxResults:\s*4/);
  assert.doesNotMatch(chat, /keenableApiKey:/i);
});

test('managed document profile prunes old tool results without model summarization', async () => {
  const text = await readFile(new URL('../config/librechat.github-device.yaml', import.meta.url), 'utf8');
  assert.match(text, /summarization:\s*\n\s+enabled: false\s*\n\s+contextPruning:\s*\n\s+enabled: true/);
  assert.match(text, /keepLastAssistants: 1/);
  assert.match(text, /minPrunableToolChars: 4000/);
});

test('approved Claude presets use the native tool-capable Anthropic transport', async () => {
  for (const profile of ['librechat.free-baseline.yaml', 'librechat.github-editor.yaml',
    'librechat.github-device.yaml']) {
    const text = await readFile(new URL(`../config/${profile}`, import.meta.url), 'utf8');
    const claude = text.match(/    - name: 'MissionAIClaude'\r?\n([\s\S]*?)(?=\r?\n    - name: '|$)/)?.[1] ?? '';
    assert.match(claude, /provider: anthropic/);
    assert.match(claude, /baseURL: '\$\{MISSION_AI_GATEWAY_URL\}\/native\/anthropic'/);
    assert.doesNotMatch(claude, /native\/openai\/v1/);
  }
});

test('Local Documents MCP bypasses the ngrok warning page', async () => {
  const text = await readFile(new URL('../config/librechat.github-device.yaml', import.meta.url), 'utf8');
  const localDocuments = text.split('  mission-ai-local-documents:')[1]?.split('  mission-ai-device:')[0] || '';
  assert.match(localDocuments, /url: '\$\{LOCAL_MCP_PUBLIC_URL\}'/);
  assert.match(localDocuments, /ngrok-skip-browser-warning: 'true'/);
});

test('LibreChat Mission AI config keeps scheduled and background work enabled', async () => {
  const text = await readFile(new URL('../config/librechat.mission-ai.yaml', import.meta.url), 'utf8');
  assert.match(text, /schedules:\s*\n\s+use:\s*true/);
  assert.match(text, /minIntervalMinutes:\s*60/);
  assert.match(text, /backgroundTasks:\s*\n\s+completionWakeups:\s*true/);
  assert.match(text, /defaultPinnedTools:/);
  assert.match(text, /- 'mcp'/);
});


test('LibreChat direct Chrome policy keeps read-only inventory automatic and mutations reviewed', async () => {
  const text = await readFile(new URL('../config/librechat.mission-ai.yaml', import.meta.url), 'utf8');
  const allowSection = text.split('      allow:')[1]?.split('      deny:')[0] || '';
  const askSection = text.split('      ask:')[1]?.split('      reason:')[0] || '';

  assert.match(allowSection, /browser_list_tabs/);
  assert.equal(/browser_close_tabs/.test(allowSection), false);

  for (const tool of [
    'browser_activate_tab',
    'browser_open_new_tab',
    'browser_close_tabs',
  ]) {
    assert.match(askSection, new RegExp(tool));
  }
});

test('primary agent instructions require create-only file output by default', async () => {
  const text = await readFile(
    new URL('../config/primary-agent-instructions.md', import.meta.url),
    'utf8',
  );
  assert.match(text, /overwrite:false/);
  assert.match(text, /fails with a conflict rather than being replaced/);
  assert.match(text, /Replace an existing file only when the user clearly intends an in-place edit/);
});
