const DELEGATE_FIELDS = [
  'task', 'prompt', 'system', 'maxOutputTokens', 'project', 'conversationId',
];
const IMAGE_FIELDS = [
  'prompt', 'aspectRatio', 'imageSize', 'referenceImage', 'project', 'conversationId',
];

// Internal provider/database injection hooks must never come from an HTTP body.
export function createPaidHttpHandlers({
  delegateRequest,
  generateImage,
  env = process.env,
  imageAcceptanceEnabled = () => false,
}) {
  async function invoke(operation, body, fields, image = false) {
    if (String(env.MISSION_AI_DELEGATION_ENABLED || '').toLowerCase() !== 'true' && !(image && imageAcceptanceEnabled() === true)) {
      throw new Error('delegation_disabled');
    }

    const input = {};
    for (const field of fields) {
      if (body && Object.hasOwn(body, field)) input[field] = body[field];
    }
    return operation(input);
  }

  return {
    delegate: (body) => invoke(delegateRequest, body, DELEGATE_FIELDS),
    image: (body) => invoke(generateImage, body, IMAGE_FIELDS, true),
  };
}

