export function buildReadiness({
  providers = [],
  connectedDevices = [],
  codeApiConfigured = false,
  pairingConfigured = false,
  costDashboardConfigured = false,
  delegationEnabled = false,
  build = null,
} = {}) {
  const providerMap = Object.fromEntries(
    providers
      .filter((item) => item && typeof item.name === 'string')
      .map((item) => [item.name, Boolean(item.hasApiKey)]),
  );

  const checks = {
    openai: providerMap.openai === true,
    anthropic: providerMap.anthropic === true,
    google: providerMap.google === true,
    codeApi: Boolean(codeApiConfigured),
    costDashboard: Boolean(costDashboardConfigured),
    delegation: Boolean(delegationEnabled),
    macDevice: connectedDevices.length > 0,
    pairing: Boolean(pairingConfigured),
  };

  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    connectedDevices: [...connectedDevices],
    build,
  };
}
