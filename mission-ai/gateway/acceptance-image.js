import crypto from 'node:crypto';
import { acceptanceWindow } from './acceptance-window.js';

/** Fixed, default-off image cases; shares the native ceiling and durable replay claims. */
export function createAcceptanceImage({ env, ledger, store, generateImage, now = () => new Date() }) {
  return async (body = {}) => {
    const input = {};
    for (const key of ['prompt', 'aspectRatio', 'imageSize', 'referenceImage', 'project', 'conversationId']) {
      if (Object.hasOwn(body, key)) input[key] = body[key];
    }
    if (String(env.MISSION_AI_DELEGATION_ENABLED || '').toLowerCase() === 'true') return generateImage(input);
    const current = now(); const window = acceptanceWindow(env, current);
    if (window?.scope !== 'final-workflows') throw Error('delegation_disabled');
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 2000 ||
        (input.imageSize !== undefined && input.imageSize !== '512') ||
        (input.aspectRatio !== undefined && input.aspectRatio !== '1:1')) throw Error('image_config_invalid');
    const reference = input.referenceImage;
    if (reference != null && (typeof reference !== 'object' || Array.isArray(reference) ||
        Object.keys(reference).some(key => !['data', 'mimeType'].includes(key)) ||
        typeof reference.data !== 'string' || !reference.data.length || reference.data.length > 400000 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(reference.data) ||
        !['image/png', 'image/jpeg', 'image/webp'].includes(reference.mimeType))) throw Error('image_config_invalid');
    const hashImage = (image) => crypto.createHash('sha256').update(image.mimeType + ':' + image.data).digest('hex');
    if (reference) {
      const original = await store.readClaim(`final-workflows:${window.runId}:image-generation`);
      if (original?.stage !== 'finished' || original.result?.imageHash !== hashImage(reference)) throw Error('image_config_invalid');
    }
    const kind = reference ? 'image-edit' : 'image-generation';
    const id = `final-workflows:${window.runId}:${kind}`;
    await store.claim({ _id: id, stage: 'claimed', kind, createdAt: current,
      ceilingUsd: window.ceilingUsd, expiresAt: window.expiresAt });
    const boundedLedger = { ...ledger, async reserve(request) {
      const latest = acceptanceWindow(env, now());
      if (latest?.scope !== 'final-workflows' || latest.runId !== window.runId ||
          latest.ceilingUsd !== window.ceilingUsd) throw Error('delegation_disabled');
      if (!(await ledger.sharedBudget())) throw Error('shared_budget_unready');
      const reservation = await ledger.reserve({ ...request,
        directCapUsd: Math.min(request.directCapUsd, window.ceilingUsd) });
      try { await store.markDispatch(id, reservation.reservationId); }
      catch (error) {
        // Provider not dispatched: do not strand an image reservation on a failed durable claim.
        await ledger.release({ reservationId: reservation.reservationId }); throw error;
      }
      return reservation;
    } };
    const result = await generateImage({ ...input, imageSize: '512', aspectRatio: '1:1',
      project: 'mission-ai-final-validation', enabled: true, maxOutputTokens: 2048,
      now: current, usageLedger: boundedLedger });
    if (result.images?.length !== 1) throw Error('acceptance_output_missing');
    if (reference && hashImage(result.images[0]) === hashImage(reference)) throw Error('acceptance_output_unchanged');
    await store.complete(id, { ok: result.ok, totalUsd: result.cost.totalUsd,
      imageHash: hashImage(result.images[0]) });
    return result;
  };
}
