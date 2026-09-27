import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function readSecret(service) {
  try {
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
