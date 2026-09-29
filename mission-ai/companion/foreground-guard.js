const prohibitedApps = new Set(['Terminal', 'iTerm', 'iTerm2']);

export function validateInputTarget(args, allowedApps) {
  const name = args?.expectedApp;
  if (typeof name !== 'string' || !allowedApps.has(name) || prohibitedApps.has(name)) {
    throw new Error('input_target_not_allowed');
  }
  return name;
}

export async function waitForInputTarget(name, activeApp, deadlineMs, {
  now = Date.now,
  pause = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const expires = Math.min(deadlineMs - 1000, now() + 10000);
  while (now() < expires) {
    if ((await activeApp()).name === name) return;
    await pause(100);
  }
  throw new Error('input_target_not_active');
}

// The foreground check and input occur in the same local script. A focus change
// while the owner approves cannot route input to Terminal or another application.
export const inputTargetScript = [
  'set targetName to item 1 of argv',
  'tell application "System Events"',
  'if (name of first application process whose frontmost is true) is not targetName then error "input_target_not_active"',
];
