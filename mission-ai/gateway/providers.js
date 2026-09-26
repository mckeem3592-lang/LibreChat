const PROVIDERS = Object.freeze({
  openai: {
    apiKeyEnv: 'OPENAI_API_KEY',
    baseUrlEnv: 'OPENAI_API_BASE_URL',
    defaultBaseUrl: 'https://api.openai.com/v1',
  },
  anthropic: {
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    baseUrlEnv: 'ANTHROPIC_API_BASE_URL',
    defaultBaseUrl: 'https://api.anthropic.com',
  },
  google: {
    apiKeyEnv: 'GOOGLE_KEY',
    baseUrlEnv: 'GOOGLE_API_BASE_URL',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
  },
});

export function providerConfig(name) {
  const definition = PROVIDERS[name];
  if (!definition) return null;
  return {
    name,
    apiKeyEnv: definition.apiKeyEnv,
    hasApiKey: Boolean(process.env[definition.apiKeyEnv]),
    baseUrl: process.env[definition.baseUrlEnv] || definition.defaultBaseUrl,
  };
}

export function providerStatus() {
  return Object.keys(PROVIDERS).map((name) => providerConfig(name));
}
