import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { writeSecret } from './keychain.js';

if (process.platform !== 'win32') throw new Error('windows_only');
let code = (process.env.MISSION_AI_PAIR_CODE || '').trim();
if (!code) {
  const prompt = readline.createInterface({ input: stdin, output: stdout });
  code = (await prompt.question('Mission AI one-time pairing code: ')).trim();
  prompt.close();
}
if (!code || code.length > 512) throw new Error('invalid_pairing_code');
const response = await fetch('https://mission-ai-gateway-mckee.onrender.com/pair', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code, deviceId: 'windows-work' }),
});
if (!response.ok) throw new Error(`pairing_failed_${response.status}`);
const body = await response.json();
if (body?.ok !== true || typeof body.deviceToken !== 'string' || body.deviceToken.length < 32) {
  throw new Error('pairing_response_invalid');
}
await writeSecret('mission-ai-device-token', body.deviceToken);
stdout.write('Windows companion paired. Device credential stored for this Windows user.\n');
