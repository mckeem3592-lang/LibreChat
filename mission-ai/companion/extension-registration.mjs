import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function findMissionAIExtensionPaths(chromeRoot) {
  if (!fs.existsSync(chromeRoot)) return [];
  const found = [];
  for (const profile of fs.readdirSync(chromeRoot, { withFileTypes: true })) {
    if (!profile.isDirectory()) continue;
    for (const filename of ['Secure Preferences', 'Preferences']) {
      const file = path.join(chromeRoot, profile.name, filename);
      if (!fs.existsSync(file)) continue;
      let settings;
      try {
        settings = JSON.parse(fs.readFileSync(file, 'utf8')).extensions?.settings ?? {};
      } catch {
        continue;
      }
      for (const [id, extension] of Object.entries(settings)) {
        const registeredPath = extension?.path;
        if (typeof registeredPath !== 'string') continue;
        if (id !== 'ggkpmldfojmlehhbadliodeplhneelmb' &&
            !/mission.?ai.*chrome.?extension/i.test(registeredPath)) continue;
        found.push({ profile: profile.name, id, path: path.resolve(registeredPath) });
      }
    }
  }
  return [...new Map(found.map((entry) =>
    [`${entry.profile}:${entry.id}:${entry.path}`, entry])).values()];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const expected = path.resolve(process.argv[2] ?? '');
  const chromeRoot = path.join(process.env.HOME, 'Library/Application Support/Google/Chrome');
  const registrations = findMissionAIExtensionPaths(chromeRoot);
  if (registrations.length === 0) {
    console.log(`Chrome has not registered Mission AI Browser Bridge. Load unpacked: ${expected}`);
  }
  const locations = new Map();
  for (const entry of registrations) {
    const key = `${entry.profile}:${entry.path}`;
    locations.set(key, { ...entry, count: (locations.get(key)?.count ?? 0) + 1 });
  }
  for (const entry of locations.values()) {
    const count = entry.count > 1 ? ` (${entry.count} registrations)` : '';
    if (entry.path === expected) {
      console.log(`Chrome ${entry.profile}${count} points to the installed Mission AI extension. Reload it in Chrome Extensions to use updated files.`);
    } else {
      console.log(`Chrome ${entry.profile}${count} still points to an older Mission AI extension folder: ${entry.path}`);
      console.log(`In Chrome Extensions, replace that older copy with Load unpacked: ${expected}`);
    }
  }
}
