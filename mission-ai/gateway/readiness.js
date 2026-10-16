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
  const macCapabilities = connectedDevices
    .map((deviceId) => deviceCapabilities?.[deviceId])
    .filter((capabilities) => Array.isArray(capabilities) && capabilities.includes('mac.control'));

  const checks = {
    openai: providerMap.openai === true,
    anthropic: providerMap.anthropic === true,
    google: providerMap.google === true,
    codeApi: Boolean(codeApiConfigured),
    costDashboard: Boolean(costDashboardConfigured),
    delegation: Boolean(delegationEnabled),
    macDevice: macCapabilities.length > 0,
    macBrowserDirect: macCapabilities.some((capabilities) =>
      capabilities.includes('browser.direct_tabs'),
    ),
    macBrowserExtension: macCapabilities.some((capabilities) =>
      capabilities.includes('browser.page_extension'),
    ),
    browserDirect: capabilitySet.has('browser.direct_tabs'),
    browserExtension: capabilitySet.has('browser.page_extension'),
    pairing: Boolean(pairingConfigured) || connectedDevices.length > 0,
  };

  const missing = Object.entries(checks)
    .filter(([, ready]) => !ready)
    .map(([name]) => name);

  return {
    ok: missing.length === 0,
    checks,
    missing,
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
