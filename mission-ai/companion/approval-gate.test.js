import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { requireManualApproval } from './approval-gate.js';

function terminal() {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = output.isTTY = true;
  let preview = '';
  output.on('data', (data) => { preview += data; });
  return { input, output, preview: () => preview, deadlineMs: Date.now() + 10000 };
}

test('read-only tools need no mutation approval', async () => {
  for (const tool of ['mac.active_app', 'mac.screenshot', 'browser.list_tabs', 'browser.get_state']) {
    await requireManualApproval(tool, {});
  }
});

test('daemon/pipe approval fails without printing private arguments', async () => {
  const t = terminal(); t.input.isTTY = false;
  await assert.rejects(requireManualApproval('mac.type', { text: 'private' }, t), /local_manual_approval_required/);
  assert.equal(t.preview(), '');
});

test('exact operation preview precedes approval and only literal y authorizes', async () => {
  for (const answer of ['yes', 'Y', ' y', 'y ', '']) {
    const t = terminal();
    const pending = requireManualApproval('browser.close_tabs', { tabs: [123], confirm: true }, t);
    assert.match(t.preview(), /"tabs": \[\s*123/);
    t.input.write(`${answer}\n`);
    await assert.rejects(pending, /local_approval_denied/);
  }
  const t = terminal();
  const pending = requireManualApproval('mac.click', { x: 10, y: 20, approved: true }, t);
  assert.match(t.preview(), /"tool": "mac.click"/);
  t.input.write('y\n');
  await pending;
});

test('approval cannot be transferred across concurrent actions or expired/disconnected requests', async () => {
  const t = terminal(); const pending = requireManualApproval('mac.key', { key: 'RETURN' }, t);
  await assert.rejects(requireManualApproval('mac.type', {}, terminal()), /local_approval_busy/);
  t.input.write('n\n'); await assert.rejects(pending, /local_approval_denied/);
  await assert.rejects(requireManualApproval('mac.key', {}, { ...terminal(), deadlineMs: Date.now() }), /local_approval_expired/);
  const offline = terminal();
  const stale = requireManualApproval('mac.key', {}, { ...offline, isConnected: () => false });
  offline.input.write('y\n'); await assert.rejects(stale, /local_approval_expired/);
});
