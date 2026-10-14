import { readSecret } from './keychain.js';

process.stdout.write((await readSecret('mission-ai-device-token')) ? 'yes' : 'no');
