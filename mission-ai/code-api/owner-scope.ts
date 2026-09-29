/** Dedicated Mission AI deployment: reject every client except its configured owner. */
export function missionAiOwnerMatches(
  userId: unknown,
  tenantId: unknown,
  settings: Record<string, string | undefined>,
): boolean {
  const ownerId = settings.MISSION_AI_CODE_OWNER_ID;
  return typeof ownerId === 'string' && /^[a-f0-9]{24}$/.test(ownerId) &&
    settings.CODEAPI_JWT_SINGLE_TENANT_ID === 'mission-ai-chat-test' &&
    userId === ownerId && tenantId === 'mission-ai-chat-test';
}
