/** The owner device token is already scoped to these tools. Image generation
 * requires a separate opt-in and an active budget-backed provider route. */
const DEVICE_TOOLS = [
  'mission_readiness',
  'mission_budget_snapshot',
  'browser_list_tabs',
  'browser_activate_tab',
  'browser_open_new_tab',
  'browser_close_tabs',
  'browser_get_state',
  'browser_click',
  'browser_type',
  'browser_scroll',
  'browser_open_url',
  'file_list',
  'file_read',
  'file_write',
  'file_move',
  'repo_list',
  'repo_read',
  'repo_write',
  'repo_check',
  'repo_start_check',
  'repo_check_status',
  'mac_active_app',
  'mac_open_app',
  'mac_screenshot',
  'mac_click',
  'mac_type',
  'mac_key',
];

export function deviceMcpAllowedTools({ imageEnabled = false, imageBudgetReady = false } = {}) {
  const tools = new Set(DEVICE_TOOLS);
  if (imageEnabled && imageBudgetReady) tools.add('mission_generate_image');
  return tools;
}
