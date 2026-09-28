import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const root = process.env.MISSION_AI_CODE_APPROVAL_TEST_ROOT;
assert(root, 'Set MISSION_AI_CODE_APPROVAL_TEST_ROOT to the isolated, patched and built pinned worker');
const { BridgeWorker } = await import(pathToFileURL(resolve(root, 'packages/code/dist/worker.js')).href);
const incarnationId = 'incarnation-00000001';

test('the actual patched worker allows a static read and rejects a daemon write before mutation/quarantine', async () => {
  const settlements = [];
  const executions = [];
  const guardEvents = [];
  const workspaceTools = { protocolVersion: 1, operations: ['read_file', 'write_file'],
    workspaces: [{ id: 'primary' }] };
  const worker = new BridgeWorker({ codeApiUrl: 'https://code.example.test/v1', token: 'synthetic-worker-token',
    workerId: 'vm-1', incarnationId, sandboxEndpoint: 'http://127.0.0.1:2000/api/v2',
    capabilities: { statefulWorkspace: true, sandboxProfile: 'nsjail', runtimes: ['bash'], workspaceTools },
    workspaceMutationQuarantine: {
      async assertAvailable() {}, async arm() { guardEvents.push('arm'); },
      async clear() { guardEvents.push('clear'); }, async quarantine() { guardEvents.push('quarantine'); },
    },
    workspaceTools: { capabilities: workspaceTools,
      async execute(request) { executions.push(request.operation); return { protocolVersion: 1, operation: 'read_file',
        workspaceId: 'primary', path: 'example.txt', content: 'Synthetic text', startLine: 1, endLine: 1, truncated: false }; },
    },
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/register')) return Response.json({ protocolVersion: 1, workerId: 'vm-1', incarnationId,
        registeredAt: new Date().toISOString(), leaseTtlMs: 60000, supportedWorkspaceToolOperations: ['read_file', 'write_file'] });
      if (String(url).endsWith('/settle')) settlements.push(JSON.parse(String(init.body)));
      return Response.json({ protocolVersion: 1, accepted: true, cancelled: false });
    },
  });
  await worker.register();
  function assignment(operation) {
    return { protocolVersion: 1, assignmentId: `assignment-${operation}`, workerId: 'vm-1', incarnationId,
      generation: 1, leaseToken: 'synthetic-lease-token-long-enough', expiresAt: new Date(Date.now() + 10000).toISOString(),
      executionKind: 'workspace_tool', request: { protocolVersion: 1, operation, workspaceId: 'primary', path: 'example.txt',
        ...(operation === 'write_file' ? { content: 'Synthetic write', overwrite: false } : {}) } };
  }
  await worker.executeAndSettle(assignment('read_file'));
  await worker.executeAndSettle(assignment('write_file'));
  assert.deepEqual(executions, ['read_file']);
  assert.equal(settlements.length, 2);
  assert.equal(settlements[0].status, 'fulfilled');
  assert.equal(settlements[1].status, 'rejected');
  assert.equal(settlements[1].error, 'local_manual_approval_required');
  assert.deepEqual(guardEvents, []);
});
