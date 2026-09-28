import { createInterface } from 'node:readline';

const readOnlyTools = new Set([
  'mac.active_app', 'mac.screenshot', 'browser.list_tabs', 'browser.get_state',
]);
let awaitingApproval = false;

export async function requireManualApproval(tool, args, {
  input = process.stdin,
  output = process.stdout,
  deadlineMs,
  isConnected = () => true,
} = {}) {
  if (readOnlyTools.has(tool)) return;
  // launchd, redirected pipes and remote tool arguments cannot grant approval.
  // Print private previews only to an interactive local terminal, never logs.
  if (!input.isTTY || !output.isTTY) throw new Error('local_manual_approval_required');
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= Date.now() + 1000) {
    throw new Error('local_approval_expired');
  }
  if (awaitingApproval) throw new Error('local_approval_busy');
  awaitingApproval = true;
  const preview = JSON.stringify({ tool, args }, null, 2)
    .replace(/[\u007f-\u009f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  let reader;
  try {
    output.write(`\nMISSION AI ACTION PREVIEW\n${preview}\nType exactly y then Enter to authorize this one action: `);
    reader = createInterface({ input, output, terminal: false });
    const answer = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('local_approval_expired')),
        Math.min(deadlineMs - Date.now() - 1000, 20000));
      const finish = (value) => { clearTimeout(timer); resolve(value); };
      reader.once('line', finish);
      reader.once('close', () => finish(''));
      reader.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    if (answer !== 'y') throw new Error('local_approval_denied');
    if (Date.now() >= deadlineMs - 1000 || !isConnected()) {
      throw new Error('local_approval_expired');
    }
  } finally {
    reader?.close();
    input.pause();
    awaitingApproval = false;
  }
}
