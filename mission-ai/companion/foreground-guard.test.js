import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateInputTarget, waitForInputTarget, inputTargetScript } from './foreground-guard.js';

test('input requires a named allowed app and never permits a terminal', () => {
  const apps = new Set(['Finder', 'Terminal', 'iTerm2']);
  assert.equal(validateInputTarget({ expectedApp: 'Finder' }, apps), 'Finder');
  for (const expectedApp of [undefined, '', 'Terminal', 'iTerm2', 'Unknown']) {
    assert.throws(() => validateInputTarget({ expectedApp }, apps), /input_target_not_allowed/);
  }
});

test('after manual approval, input waits for the owner to return to the intended app', async () => {
  let time = 0, calls = 0;
  await waitForInputTarget('Finder', async () => ({ name: ++calls === 3 ? 'Finder' : 'Terminal' }), 20000,
    { now: () => time, pause: async ms => { time += ms; } });
  assert.equal(calls, 3);
  assert.equal(time, 200);
});

test('input is denied if the app never becomes active or the action expires', async () => {
  let time = 0;
  await assert.rejects(waitForInputTarget('Finder', async () => ({ name: 'Terminal' }), 1500,
    { now: () => time, pause: async ms => { time += ms; } }), /input_target_not_active/);
  assert.equal(time, 500);
  await assert.rejects(waitForInputTarget('Finder', async () => { throw Error('must not inspect'); }, 0,
    { now: () => 0 }), /input_target_not_active/);
  assert.ok(inputTargetScript.some(line => line.includes('frontmost is true')));
});
