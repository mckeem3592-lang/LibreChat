import { readScheduleFireContext } from '../missionBudget/scheduleFireContext';
import type { ScheduleFireContext } from '../missionBudget/scheduleFireContext';

export { readScheduleFireContext };
export type { ScheduleFireContext };

interface ScheduleTriggerRequest {
  _isAgentTrigger?: boolean;
  _isScheduledFire?: boolean;
  _isManualScheduledFire?: boolean;
  body?: Record<string, unknown>;
}

/**
 * Captures the verified trigger classification once, then projects the minimum
 * schedule fields expected by the existing generation lifecycle hooks.
 */
export function captureScheduleFireContext(
  req: ScheduleTriggerRequest,
): ScheduleFireContext | undefined {
  const context = readScheduleFireContext(req);
  req._isScheduledFire = context != null;
  req._isManualScheduledFire = context?.manual === true;
  if (context != null && req.body != null) {
    req.body.scheduleId = context.scheduleId;
    req.body.scheduledFor = context.scheduledFor;
    if (context.configRevision == null) {
      delete req.body.scheduleConfigRevision;
    } else {
      req.body.scheduleConfigRevision = context.configRevision;
    }
  }
  return context;
}

export function isScheduleFireRequest(req?: ScheduleTriggerRequest): boolean {
  return typeof req?._isScheduledFire === 'boolean'
    ? req._isScheduledFire
    : readScheduleFireContext(req) != null;
}

/** Automatic occurrences are bounded by schedule cadence and global capacity. */
export function exemptFromUserLimiter(req?: ScheduleTriggerRequest): boolean {
  if (typeof req?._isScheduledFire === 'boolean') {
    return req._isScheduledFire && req._isManualScheduledFire !== true;
  }
  const context = readScheduleFireContext(req);
  return context != null && !context.manual;
}

/** Acquire/release sites share this exact predicate to keep counters balanced. */
export function exemptFromConcurrencyLimiter(req?: ScheduleTriggerRequest): boolean {
  return exemptFromUserLimiter(req);
}
