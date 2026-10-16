import test from 'node:test';
import assert from 'node:assert/strict';
import { requireManualApproval } from './approval-gate.js';

test('background companion approves only configured local actions', async () => {
  const previous = process.env.MISSION_AI_AUTONOMOUS_TOOLS;
  process.env.MISSION_AI_AUTONOMOUS_TOOLS = 'browser.click,file.move,repo.write,repo.check,unknown.tool';
  try {
    await requireManualApproval('browser.click', { index: 1 });
    await requireManualApproval('file.move', { sourcePath: 'a', destinationPath: 'b' });
    await requireManualApproval('file.read', { path: 'a.txt' });
    await requireManualApproval('repo.read', { path: 'src/app.js' });
    await requireManualApproval('repo.list', { directory: 'src' });
    await requireManualApproval('repo.write', { path: 'src/app.js', text: 'new' });
    await requireManualApproval('repo.check', { checkId: 'diff-check' });
    await assert.rejects(requireManualApproval('browser.type', { text: 'x' }),
      /local_manual_approval_required/);
    await assert.rejects(requireManualApproval('unknown.tool', {}),
      /local_manual_approval_required/);
  } finally {
    if (previous === undefined) delete process.env.MISSION_AI_AUTONOMOUS_TOOLS;
    else process.env.MISSION_AI_AUTONOMOUS_TOOLS = previous;
  }
});
