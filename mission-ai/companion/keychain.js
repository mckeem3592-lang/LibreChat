import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const WINDOWS_SECRET = /^mission-ai-(device-token|browser-token|code-pairing-code)$/;

function windowsSecret(service, script, input = '') {
  if (!WINDOWS_SECRET.test(service)) throw new Error('secret_name_not_allowed');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      env: { ...process.env, MISSION_AI_SECRET_NAME: service },
    });
    let output = '';
    let error = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { error += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(output) : reject(new Error(error || 'secret_store_failed')));
    child.stdin.end(input);
  });
}

const secretPath = '$directory = Join-Path $env:LOCALAPPDATA "MissionAI\\Secrets"; $path = Join-Path $directory ($env:MISSION_AI_SECRET_NAME + ".txt");';

export async function readSecret(service) {
  try {
    if (process.platform === 'win32') {
      return (await windowsSecret(service, `${secretPath} if (Test-Path $path) { $secure = Get-Content -Raw $path | ConvertTo-SecureString; $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) } }`)).trim();
    }
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-a',
      process.env.USER || '',
      '-s',
      service,
      '-w',
    ]);
    return stdout.trim();
  } catch {
    return '';
  }
}

export async function writeSecret(service, value) {
  if (process.platform === 'win32') {
    await windowsSecret(service, `${secretPath} New-Item -ItemType Directory -Force -Path $directory | Out-Null; $secure = ConvertTo-SecureString ([Console]::In.ReadToEnd()) -AsPlainText -Force; $secure | ConvertFrom-SecureString | Set-Content -Encoding ASCII -Path $path`, String(value));
    return;
  }
  await execFileAsync('security', [
    'add-generic-password',
    '-U',
    '-a',
    process.env.USER || '',
    '-s',
    service,
    '-w',
    String(value),
  ]);
}
