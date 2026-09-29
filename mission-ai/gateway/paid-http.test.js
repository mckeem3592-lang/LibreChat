import assert from 'node:assert/strict';
import test from 'node:test';
import { createPaidHttpHandlers } from './paid-http.js';

for (const route of ['delegate', 'image']) {
  test(`${route} refuses HTTP enabled overrides while delegation is disabled`, async () => {
    for (const flag of [undefined, '', 'false', 'FALSE', '1']) {
      let calls = 0;
      const operation = async () => {
        calls += 1;
        return { ok: true };
      };
      const handlers = createPaidHttpHandlers({
        delegateRequest: operation,
        generateImage: operation,
        env: { MISSION_AI_DELEGATION_ENABLED: flag },
      });

      await assert.rejects(
        () => handlers[route]({ enabled: true, prompt: 'Do not execute this request' }),
        { message: 'delegation_disabled' },
      );
      assert.equal(calls, 0, 'Disabled requests must not reach provider or ledger code');
    }
  });

  test(`${route} discards caller-supplied internal dependencies when enabled`, async () => {
    const input = {
      prompt: 'A permitted input',
      project: 'accounting-validation',
      conversationId: 'conversation-id',
      enabled: true,
      now: '2000-01-01T00:00:00.000Z',
      dashboardReader: { spendUsd: 0 },
      usageLedger: {},
      pricingLoader: {},
      fetchImpl: {},
    };
    let received;
    const operation = async (body) => {
      received = body;
      return { ok: true };
    };
    const handlers = createPaidHttpHandlers({
      delegateRequest: operation,
      generateImage: operation,
      env: { MISSION_AI_DELEGATION_ENABLED: 'true' },
    });

    assert.deepEqual(await handlers[route](input), { ok: true });
    assert.deepEqual(received, {
      prompt: 'A permitted input',
      project: 'accounting-validation',
      conversationId: 'conversation-id',
    });
    assert.equal(input.enabled, true, 'The original request must not be mutated');
  });
}

test('delegation forwards its supported request fields', async () => {
  const input = {
    task: 'coding',
    prompt: 'Explain this code',
    system: 'Be brief',
    maxOutputTokens: 256,
    project: 'demo',
    conversationId: 'c1',
  };
  const handlers = createPaidHttpHandlers({
    delegateRequest: async (body) => body,
    generateImage: async () => assert.fail('Wrong operation'),
    env: { MISSION_AI_DELEGATION_ENABLED: 'TRUE' },
  });
  assert.deepEqual(await handlers.delegate(input), input);
});

test('image generation forwards its supported request fields', async () => {
  const input = {
    prompt: 'A mountain',
    aspectRatio: '16:9',
    imageSize: '1K',
    referenceImage: { data: 'fixture', mimeType: 'image/png' },
    project: 'demo',
    conversationId: 'c2',
  };
  const handlers = createPaidHttpHandlers({
    delegateRequest: async () => assert.fail('Wrong operation'),
    generateImage: async (body) => body,
    env: { MISSION_AI_DELEGATION_ENABLED: 'true' },
  });
  assert.deepEqual(await handlers.image(input), input);
});

test('an environment disable takes effect after handler creation', async () => {
  const env = { MISSION_AI_DELEGATION_ENABLED: 'true' };
  let calls = 0;
  const operation = async () => { calls += 1; };
  const handlers = createPaidHttpHandlers({
    delegateRequest: operation,
    generateImage: operation,
    env,
  });
  env.MISSION_AI_DELEGATION_ENABLED = 'false';

  await assert.rejects(() => handlers.delegate({ enabled: true }), /delegation_disabled/);
  await assert.rejects(() => handlers.image({ enabled: true }), /delegation_disabled/);
  assert.equal(calls, 0);
});

test('provider or accounting errors retain the existing route error handling', async () => {
  const failure = new Error('monthly_hard_limit');
  const operation = async () => { throw failure; };
  const handlers = createPaidHttpHandlers({
    delegateRequest: operation,
    generateImage: operation,
    env: { MISSION_AI_DELEGATION_ENABLED: 'true' },
  });
  await assert.rejects(() => handlers.delegate({ prompt: 'test' }), (error) => error === failure);
  await assert.rejects(() => handlers.image({ prompt: 'test' }), (error) => error === failure);
});


test('explicit image acceptance admits only the image handler and does not trust body overrides', async () => {
 let imageCalls=0;let delegateCalls=0;let admitted=true;let received;
 const handlers=createPaidHttpHandlers({env:{MISSION_AI_DELEGATION_ENABLED:'false'},
  imageAcceptanceEnabled:()=>admitted,
  generateImage:async(input)=>{received=input;imageCalls++;},delegateRequest:async()=>{delegateCalls++;}});
 await handlers.image({prompt:'Unique test',enabled:true,usageLedger:{},maxOutputTokens:99999});
 assert.deepEqual(received,{prompt:'Unique test'});assert.equal(imageCalls,1);
 await assert.rejects(handlers.delegate({task:'coding',prompt:'x'}),/delegation_disabled/);
 assert.equal(delegateCalls,0);admitted=false;
 await assert.rejects(handlers.image({prompt:'x',enabled:true}),/delegation_disabled/);
 assert.equal(imageCalls,1);
});
