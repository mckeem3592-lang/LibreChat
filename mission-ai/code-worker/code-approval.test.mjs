import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { requireCodeApproval } from './code-approval.js';
import { patchWorker } from './apply-approval-patch.mjs';

function terminal() {
  const input = new PassThrough(); const output = new PassThrough();
  input.isTTY = output.isTTY = true;
  let preview = '';
  output.on('data', value => { preview += value; });
  return { input, output, deadlineMs: Date.now() + 10000, preview: () => preview };
}
const assignment = (operation, extra = {}) => ({ executionKind: 'workspace_tool',
  request: { operation, workspaceId: 'synthetic-workspace', ...extra } });

test('static read-only workspace requests require no mutation approval', async () => {
  for (const operation of ['read_file', 'list_files', 'search_text', 'preview_edit', 'read_repository_instructions']) {
    await requireCodeApproval(assignment(operation));
  }
});

test('all coding mutation lanes fail in a daemon without exposing code or paths to logs', async () => {
  for (const input of [assignment('write_file', { path: 'private.txt', content: 'private' }),
    assignment('edit_file'), assignment('execute_command', { command: 'synthetic command' }),
    { executionKind: 'workspace_programmatic', request: { body: { code: 'synthetic code' } } },
    { executionKind: 'sandbox', request: { code: 'synthetic code' } }]) {
    const t = terminal(); t.input.isTTY = false;
    await assert.rejects(requireCodeApproval(input, t), /local_manual_approval_required/);
    assert.equal(t.preview(), '');
  }
});

test('the exact file content or command is previewed; remote approval flags cannot authorize execution', async () => {
  for (const request of [assignment('write_file', { path: 'example.txt', content: 'line 1\nline 2', approved: true }),
    assignment('execute_command', { command: 'python3 example.py', confirm: true })]) {
    const t = terminal();
    const pending = requireCodeApproval(request, t);
    const encoded = t.preview().slice(t.preview().indexOf('{'), t.preview().lastIndexOf('}') + 1);
    assert.deepEqual(JSON.parse(encoded).args.request, request.request);
    t.input.write('yes\n');
    await assert.rejects(pending, /local_approval_denied/);
  }
  const t = terminal();
  const pending = requireCodeApproval(assignment('execute_command', { command: 'synthetic command' }), t);
  t.input.write('y\n');
  await pending;
});

test('implicit checkouts and named environment scripts are refused because their resolved work cannot be previewed', async () => {
  for (const request of [assignment('read_file', { workspaceInstanceId: 'dynamic' }),
    assignment('execute_command', { environmentAction: 'hidden-script' }),
    { executionKind: 'workspace_programmatic', request: { body: { workspace_instance_id: 'dynamic' } } }]) {
    const t = terminal();
    await assert.rejects(requireCodeApproval(request, t), /local_approval_unsupported/);
    assert.equal(t.preview(), '');
  }
});

test('a changed upstream worker cannot be patched or silently bypass the local checkpoint', () => {
  assert.throws(() => patchWorker('unreviewed source'), /Unreviewed worker source/);
});
