import assert from 'node:assert/strict';
import test from 'node:test';
import {
  openMacBuiltInMicrophone,
  selectMacBuiltInMicrophone,
} from './selectMacBuiltInMicrophone.ts';

test('selects the MacBook mic even when Chrome ranks the iPhone first', () => {
  const devices = [
    { kind: 'audioinput', label: 'iPhone Microphone', deviceId: 'iphone' },
    { kind: 'audioinput', label: 'MacBook Air Microphone (Built-in)', deviceId: 'macbook' },
  ];
  assert.equal(selectMacBuiltInMicrophone(devices)?.deviceId, 'macbook');
});

test('never silently falls back to an iPhone mic', () => {
  const devices = [{ kind: 'audioinput', label: 'iPhone Microphone', deviceId: 'iphone' }];
  assert.equal(selectMacBuiltInMicrophone(devices), undefined);
});

test('recognizes Chrome’s default label when it names the MacBook mic', () => {
  const devices = [
    { kind: 'audioinput', label: 'Default - MacBook Air Microphone', deviceId: 'default-mac' },
    { kind: 'audioinput', label: 'iPhone Microphone', deviceId: 'iphone' },
  ];
  assert.equal(selectMacBuiltInMicrophone(devices)?.deviceId, 'default-mac');
});

test('opens the MacBook audio track with an exact device constraint', async () => {
  const stream = { getAudioTracks: () => [{ id: 'macbook-track' }] };
  let requested;
  const mediaDevices = {
    enumerateDevices: async () => [
      { kind: 'audioinput', label: 'iPhone Microphone', deviceId: 'iphone' },
      { kind: 'audioinput', label: 'MacBook Air Microphone (Built-in)', deviceId: 'macbook' },
    ],
    getUserMedia: async (constraints) => {
      requested = constraints;
      return stream;
    },
  };
  assert.equal(await openMacBuiltInMicrophone(mediaDevices), stream);
  assert.deepEqual(requested, {
    audio: { deviceId: { exact: 'macbook' } },
    video: false,
  });
});

test('does not activate the iPhone if the MacBook mic is absent', async () => {
  let requested = false;
  await assert.rejects(
    openMacBuiltInMicrophone({
      enumerateDevices: async () => [
        { kind: 'audioinput', label: 'iPhone Microphone', deviceId: 'iphone' },
      ],
      getUserMedia: async () => {
        requested = true;
      },
    }),
    /MacBook microphone unavailable/,
  );
  assert.equal(requested, false);
});
