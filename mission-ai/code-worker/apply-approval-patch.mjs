import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, copyFile, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const UPSTREAM_WORKER_SHA256 = 'd66af84a57277e5318f61d26980c8439a340479a56acacf4a3b390379109bbfb';
const hash = value => createHash('sha256').update(value).digest('hex');
const marker = '      credentialMaintenance = this.maintainCredential(';
const approval = `      // Mission AI local checkpoint: snapshot exactly what is previewed and executed.
      assignment = { ...assignment, request: structuredClone(assignment.request) };
      await requireCodeApproval(assignment, {
        deadlineMs: localDeadlineAtMs,
        isConnected: () => !executionController.signal.aborted && !signal?.aborted && heartbeatError == null,
      });
`;
const declaration = `export declare function requireCodeApproval(assignment: unknown, options: {
  deadlineMs: number; isConnected: () => boolean;
}): Promise<void>;
`;

export function patchWorker(source) {
  assert.equal(hash(source), UPSTREAM_WORKER_SHA256, 'Unreviewed worker source: refusing approval patch');
  assert.equal(source.split(marker).length, 2, 'Ambiguous execution boundary');
  return "import { requireCodeApproval } from './mission-approval.js';\n" + source.replace(marker, approval + marker);
}

export async function applyApprovalPatch(root, phase) {
  const worker = join(root, 'packages/code/src/worker.ts');
  assert((await lstat(worker)).isFile(), 'Worker must be a regular file');
  if (phase === 'prepare') {
    const current = await readFile(worker, 'utf8');
    if (current.startsWith("import { requireCodeApproval } from './mission-approval.js';\n")) {
      const original = current.slice(current.indexOf('\n') + 1).replace(approval, '');
      assert.equal(patchWorker(original), current, 'Modified approval integration');
    } else await writeFile(worker, patchWorker(current));
    await writeFile(join(root, 'packages/code/src/mission-approval.d.ts'), declaration);
    return;
  }
  assert.equal(phase, 'runtime', 'Unknown patch phase');
  const compiled = await readFile(join(root, 'packages/code/dist/worker.js'), 'utf8');
  assert(compiled.includes("import { requireCodeApproval } from './mission-approval.js';"), 'Worker was not rebuilt with approval integration');
  assert(compiled.includes('await requireCodeApproval(assignment,'), 'Missing execution checkpoint');
  await copyFile(new URL('./code-approval.js', import.meta.url), join(root, 'packages/code/dist/mission-approval.js'));
  await copyFile(new URL('../companion/approval-gate.js', import.meta.url), join(root, 'packages/code/dist/approval-gate.js'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 4, 'Expected root and phase');
  await applyApprovalPatch(resolve(process.argv[2]), process.argv[3]);
}
