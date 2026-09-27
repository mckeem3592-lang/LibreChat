export function normalizeMacControlError(kind, error) {
  const message = [
    error?.message,
    error?.stderr,
    error?.stdout,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (
    kind === 'accessibility' &&
    (
      message.includes('assistive access') ||
      message.includes('not authorized') ||
      message.includes('not permitted') ||
      message.includes('operation not permitted') ||
      message.includes('-1743')
    )
  ) {
    return new Error('accessibility_permission_required');
  }

  if (
    kind === 'screen-recording' &&
    (
      message.includes('could not create image') ||
      message.includes('screen recording') ||
      message.includes('not authorized') ||
      message.includes('not permitted') ||
      message.includes('operation not permitted')
    )
  ) {
    return new Error('screen_recording_permission_required');
  }

  return error instanceof Error ? error : new Error('mac_control_error');
}
