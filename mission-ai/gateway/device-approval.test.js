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

test('local document reads stay available and all other actions require approval', async () => {
  const decide = approval()();
  for (const tool of ['list_files', 'read_document']) {
    assert.deepEqual(await decide({ toolName: `${tool}_mcp_mission-ai-local-documents` }), {});
  }
  for (const tool of [
    'write_document_text', 'revise_document_text', 'write_spreadsheet_cells',
    'move_folder', 'write_web_file', 'browser_drive_action',
    'screen_capture_control', 'stockedge_run_triage', 'stockedge_calculate_position',
    'unrecognized_future_tool',
  ]) {
    assert.equal(
      (await decide({ toolName: `${tool}_mcp_mission-ai-local-documents` })).decision,
      'ask',
      tool,
    );
  }
  assert.equal(
    (await decide({ toolName: 'read_document_mcp_mission-ai-local-documents-extra' })).decision,
    'ask',
  );
  assert.equal(
    (await decide({ toolName: 'create_spreadsheet_mcp_mission-ai-spreadsheet-creator' })).decision,
    'ask',
  );
});
