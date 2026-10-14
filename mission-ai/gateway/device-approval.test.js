import test from 'node:test';
import assert from 'node:assert/strict';
import approval from '../github-code-editor/approval.mjs';

test('device reads run without approval and mutations ask for one action', async () => {
  const decide = approval()();
  assert.deepEqual(await decide({ toolName: 'mission_readiness_mcp_mission-ai-device' }), {});
  assert.deepEqual(await decide({ toolName: 'browser_get_state_mcp_mission-ai-device' }), {});
  assert.equal((await decide({ toolName: 'file_move_mcp_mission-ai-device' })).decision, 'ask');
  assert.equal((await decide({ toolName: 'browser_click_mcp_mission-ai-device' })).decision, 'ask');
  assert.equal((await decide({ toolName: 'push_files_mcp_github-code-editor' })).decision, 'ask');
});
