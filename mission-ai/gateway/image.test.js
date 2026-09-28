import assert from 'node:assert/strict';
import test from 'node:test';
import { generateImage } from './image.js';
import { createMemoryUsageLedger } from './usage-ledger.js';

function env(values, fn) {
  const original = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.entries(values).forEach(([key, value]) => {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  });
  return Promise.resolve().then(fn).finally(() => {
    Object.entries(original).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  });
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

function dashboard(spendUsd = 0) {
  return async () => ({
    spendUsd,
    hardUsd: 175,
    targetUsd: 100,
    economyUsd: 125,
    timeZone: 'America/Denver',
  });
}

test('image generation is disabled until paid delegation is enabled', async () => {
  await assert.rejects(
    () => generateImage({ prompt: 'moon', enabled: false }),
    /delegation_disabled/,
  );
});

test('generates an image and settles exact modality cost', async () => {
  await env({ GEMINI_API_KEY: 'g' }, async () => {
    const ledger = createMemoryUsageLedger();
    const result = await generateImage({
      prompt: 'moon',
      imageSize: '2K',
      enabled: true,
      dashboardReader: dashboard(0),
      usageLedger: ledger,
      fetchImpl: async () =>
        response({
          id: 'img_1',
          model: 'gemini-3.1-flash-image',
          output_image: { data: 'aW1hZ2U=', mime_type: 'image/png' },
          usage: {
            total_input_tokens: 12,
            total_output_tokens: 1680,
            output_tokens_by_modality: [{ modality: 'image', tokens: 1680 }],
          },
        }),
    });

    assert.equal(result.images[0].mimeType, 'image/png');
    assert.equal(result.cost.usage.imageOutputTokens, 1680);
    assert.ok(result.cost.totalUsd > 0);
    const summary = await ledger.summary({ now: new Date() });
    assert.equal(summary.reservedUsd, 0);
    assert.equal(summary.settledUsd, result.cost.totalUsd);
  });
});

test('supports reference-image editing without persisting image bytes', async () => {
  await env({ GEMINI_API_KEY: 'g' }, async () => {
    const ledger = createMemoryUsageLedger();
    const result = await generateImage({
      prompt: 'make the sky darker',
      referenceImage: { data: 'cmVmZXJlbmNl', mimeType: 'image/png' },
      enabled: true,
      project: 'art',
      conversationId: 'secret-conversation-id',
      dashboardReader: dashboard(0),
      usageLedger: ledger,
      fetchImpl: async () =>
        response({
          id: 'img_edit',
          output_image: { data: 'ZWRpdA==', mime_type: 'image/png' },
          usage: {
            total_input_tokens: 300,
            total_output_tokens: 1120,
            output_tokens_by_modality: [{ modality: 'image', tokens: 1120 }],
          },
        }),
    });
    assert.equal(result.images[0].data, 'ZWRpdA==');
    const breakdown = await ledger.breakdown({ now: new Date() });
    assert.deepEqual(breakdown.byProject.map((row) => row.project), ['art']);
    assert.equal(JSON.stringify(breakdown).includes('cmVmZXJlbmNl'), false);
    assert.equal(JSON.stringify(breakdown).includes('secret-conversation-id'), false);
  });
});

test('hard limit blocks image request before network use', async () => {
  await env({ GEMINI_API_KEY: 'g' }, async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        generateImage({
          prompt: 'moon',
          imageSize: '4K',
          enabled: true,
          dashboardReader: dashboard(174.99),
          usageLedger: createMemoryUsageLedger(),
          fetchImpl: async () => {
            calls += 1;
            return response({});
          },
        }),
      /monthly_hard_limit/,
    );
    assert.equal(calls, 0);
  });
});

test('missing image usage keeps the entire possible charge counted', async () => {
  await env({ GEMINI_API_KEY: 'g' }, async () => {
    const ledger = createMemoryUsageLedger();
    await assert.rejects(() => generateImage({
      prompt: 'moon', enabled: true, dashboardReader: dashboard(), usageLedger: ledger,
      fetchImpl: async () => response({ output_image: { data: 'aW1hZ2U=', mime_type: 'image/png' } }),
    }), /provider_usage_invalid/);
    const summary = await ledger.summary();
    assert.ok(summary.settledUsd > 0);
    assert.equal(summary.reservedUsd, 0);
  });
});

test('image settlement failure does not release a possibly charged reservation', async () => {
  await env({ GEMINI_API_KEY: 'g' }, async () => {
    const ledger = createMemoryUsageLedger();
    await assert.rejects(() => generateImage({
      prompt: 'moon', enabled: true, dashboardReader: dashboard(),
      usageLedger: { ...ledger, settle: async () => { throw new Error('storage_unavailable'); } },
      fetchImpl: async () => response({
        output_image: { data: 'aW1hZ2U=', mime_type: 'image/png' },
        usage: { total_input_tokens: 10, total_output_tokens: 1120, output_tokens_by_modality: [{ modality: 'image', tokens: 1120 }] },
      }),
    }), /storage_unavailable/);
    assert.ok((await ledger.summary()).reservedUsd > 0);
  });
});
