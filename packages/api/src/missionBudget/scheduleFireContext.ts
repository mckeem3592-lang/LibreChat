interface ScheduleTriggerRequest {
  _isAgentTrigger?: boolean;
  body?: Record<string, unknown>;
}

interface TriggerRecord {
  [key: string]: unknown;
}

export interface ScheduleFireContext {
  scheduleId: string;
  scheduledFor: string;
  manual: boolean;
  configRevision?: number;
}

function record(value: unknown): TriggerRecord | undefined {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as TriggerRecord)
    : undefined;
}

/** Read schedule identity only after the trusted trigger host classifies it. */
export function readScheduleFireContext(
  req?: ScheduleTriggerRequest,
): ScheduleFireContext | undefined {
  if (req?._isAgentTrigger !== true) {
    return undefined;
  }
  const trigger = record(req.body?.agentTrigger);
  const event = record(trigger?.event);
  const source = record(event?.source);
  const metadata = record(trigger?.metadata);
  if (
    trigger?.version !== 1 ||
    event?.type !== 'schedule.occurrence' ||
    source?.type !== 'schedule' ||
    typeof source.id !== 'string' ||
    source.id.trim().length === 0 ||
    typeof event.occurredAt !== 'number' ||
    !Number.isSafeInteger(event.occurredAt) ||
    event.occurredAt < 0
  ) {
    return undefined;
  }
  if (metadata?.manual != null && typeof metadata.manual !== 'boolean') {
    return undefined;
  }
  if (
    metadata?.configRevision != null &&
    (typeof metadata.configRevision !== 'number' ||
      !Number.isSafeInteger(metadata.configRevision) ||
      metadata.configRevision < 0)
  ) {
    return undefined;
  }
  return {
    scheduleId: source.id,
    scheduledFor: new Date(event.occurredAt).toISOString(),
    manual: metadata?.manual === true,
    ...(typeof metadata?.configRevision === 'number' && {
      configRevision: metadata.configRevision,
    }),
  };
}
