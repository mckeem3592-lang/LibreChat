import crypto from 'node:crypto';
import { providerConfig } from './providers.js';
import { catalogModel } from './model-catalog.js';
import { modelOverride } from './model-overrides.js';
import { executeImageProvider, ProviderRequestError } from './provider-client.js';
import { queryCostDashboard } from './dashboard.js';
import { defaultUsageLedger } from './usage-ledger.js';
import { calculateUsageCost, loadPricing, maximumImageRequestCost } from './cost.js';

function enabled(value) {
  if (typeof value === 'boolean') return value;
  return String(process.env.MISSION_AI_DELEGATION_ENABLED || '').toLowerCase() === 'true';
}

function conversationHash(value) {
  if (!value) return null;
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function uncertain(error) {
  return (
    error instanceof ProviderRequestError &&
    (error.code === 'provider_timeout' || error.code === 'provider_network_error')
  );
}

export async function generateImage({
  prompt,
  aspectRatio = '1:1',
  imageSize = '1K',
  referenceImage = null,
  project = 'unassigned',
  conversationId = '',
  enabled: enabledOverride,
  fetchImpl = fetch,
  now = new Date(),
  dashboardReader = queryCostDashboard,
  usageLedger,
  pricingLoader = loadPricing,
} = {}) {
  if (!enabled(enabledOverride)) throw new Error('delegation_disabled');
  if (!prompt || typeof prompt !== 'string') throw new Error('image_prompt_required');

  const google = providerConfig('google');
  if (!google?.hasApiKey) throw new Error('provider_not_configured');

  const model = modelOverride('image') || await catalogModel('google', 'image');
  if (!model) throw new Error('image_model_not_configured');

  const dashboard = await dashboardReader({ now });
  const ledger = usageLedger || defaultUsageLedger();
  if (typeof ledger.reconcileStaleReservations === 'function') {
    await ledger.reconcileStaleReservations({ now });
  }
  const summary = await ledger.summary({ now, timeZone: dashboard.timeZone });
  const spentUsd = Number(dashboard.spendUsd || 0) + Number(summary.settledUsd || 0);
  if (spentUsd >= Number(dashboard.hardUsd || 175)) throw new Error('monthly_hard_limit');

  const pricing = await pricingLoader();
  const referenceUpperBound = referenceImage?.data
    ? String(referenceImage.data).length
    : 0;
  const reserveUsd = maximumImageRequestCost({
    provider: 'google',
    model,
    prompt,
    imageSize,
    pricing,
    maxImages: 4,
    referenceInputTokens: referenceUpperBound,
  });
  const directCapUsd = Math.max(0, Number(dashboard.hardUsd || 175) - Number(dashboard.spendUsd || 0));
  const safeProject = String(project || 'unassigned').slice(0, 200);
  const conversationRef = conversationHash(conversationId);

  const reservation = await ledger.reserve({
    reserveUsd,
    directCapUsd,
    now,
    timeZone: dashboard.timeZone,
    metadata: {
      provider: 'google',
      model,
      role: 'image',
      task: referenceImage ? 'image_edit' : 'image_generation',
      project: safeProject,
      ...(conversationRef ? { conversationRef } : {}),
    },
  });

  try {
    const output = await executeImageProvider({
      provider: 'google',
      model,
      prompt,
      aspectRatio,
      imageSize,
      referenceImage,
      fetchImpl,
    });
    const cost = calculateUsageCost('google', model, output.usage, pricing);
    await ledger.settle({
      reservationId: reservation.reservationId,
      actualUsd: cost.totalUsd,
      usage: {
        provider: 'google',
        model,
        role: 'image',
        task: referenceImage ? 'image_edit' : 'image_generation',
        project: safeProject,
        ...(conversationRef ? { conversationRef } : {}),
        ...output.usage,
        pricingVerifiedOn: cost.pricingVerifiedOn,
      },
    });
    return {
      ok: true,
      provider: 'google',
      model,
      images: output.images,
      text: output.text,
      requestId: output.requestId,
      cost,
      budget: {
        nativeSpendUsd: Number(dashboard.spendUsd || 0),
        delegatedSpendUsd: Number(summary.settledUsd || 0) + cost.totalUsd,
        hardUsd: Number(dashboard.hardUsd || 175),
      },
    };
  } catch (error) {
    if (uncertain(error)) {
      await ledger.settle({
        reservationId: reservation.reservationId,
        actualUsd: reserveUsd,
        usage: {
          provider: 'google',
          model,
          role: 'image',
          task: referenceImage ? 'image_edit' : 'image_generation',
          project: safeProject,
          ...(conversationRef ? { conversationRef } : {}),
          estimated: true,
          reason: error.code,
        },
      });
    } else {
      await ledger.release({
        reservationId: reservation.reservationId,
        reason: error instanceof Error ? error.message : 'image_error',
      });
    }
    throw error;
  }
}
