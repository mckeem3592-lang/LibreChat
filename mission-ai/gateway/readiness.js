export function buildReadiness({
  providers = [],
  connectedDevices = [],
  deviceCapabilities = {},
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

  const capabilitySet = new Set(
    connectedDevices.flatMap((deviceId) =>
      Array.isArray(deviceCapabilities?.[deviceId]) ? deviceCapabilities[deviceId] : [],
    ),
  );

  const checks = {
    openai: providerMap.openai === true,
    anthropic: providerMap.anthropic === true,
    google: providerMap.google === true,
    codeApi: Boolean(codeApiConfigured),
    costDashboard: Boolean(costDashboardConfigured),
    delegation: Boolean(delegationEnabled),
    macDevice: connectedDevices.length > 0,
    browserDirect: capabilitySet.has('browser.direct_tabs'),
    browserExtension: capabilitySet.has('browser.page_extension'),
    pairing: Boolean(pairingConfigured),
  };

  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    connectedDevices: [...connectedDevices],
    deviceCapabilities: Object.fromEntries(
      connectedDevices.map((deviceId) => [
        deviceId,
        Array.isArray(deviceCapabilities?.[deviceId]) ? [...deviceCapabilities[deviceId]] : [],
      ]),
    ),
    build,
  };
}
