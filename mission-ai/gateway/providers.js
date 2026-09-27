const PROVIDERS = Object.freeze({
  openai: {
    apiKeyEnvs: ['OPENAI_API_KEY'],
    baseUrlEnv: 'OPENAI_API_BASE_URL',
    defaultBaseUrl: 'https://api.openai.com/v1',
  },
  anthropic: {
    apiKeyEnvs: ['ANTHROPIC_API_KEY'],
    baseUrlEnv: 'ANTHROPIC_API_BASE_URL',
    defaultBaseUrl: 'https://api.anthropic.com',
  },
  google: {
    apiKeyEnvs: ['GEMINI_API_KEY', 'GOOGLE_KEY'],
    baseUrlEnv: 'GOOGLE_API_BASE_URL',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
  },
});

function configuredKeyEnv(definition) {
  return definition.apiKeyEnvs.find((name) => Boolean(process.env[name])) || definition.apiKeyEnvs[0];
}

export function providerConfig(name) {
  const definition = PROVIDERS[name];
  if (!definition) return null;
  const apiKeyEnv = configuredKeyEnv(definition);
  return {
    name,
    apiKeyEnv,
    hasApiKey: Boolean(process.env[apiKeyEnv]),
    baseUrl: process.env[definition.baseUrlEnv] || definition.defaultBaseUrl,
  };
}

export function providerStatus() {
  return Object.keys(PROVIDERS).map((name) => providerConfig(name));
}
