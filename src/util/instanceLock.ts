import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export class AlreadyRunningError extends Error {}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * One running agent per Telegram account: two copies on the same session would both answer every
 * customer. Takes a PID lock file next to the session; stale locks (dead PID) are replaced.
 * Returns a release function (also runs automatically on process exit).
 */
export function acquireInstanceLock(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      const release = () => {
        try {
          if (readFileSync(path, 'utf8').trim() === String(process.pid)) unlinkSync(path);
        } catch {
          // already gone
        }
      };
      process.once('exit', release);
      return release;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const pid = Number(readFileSync(path, 'utf8').trim());
      if (pid && pid !== process.pid && isAlive(pid)) {
        throw new AlreadyRunningError(`Another copy of the agent (pid ${pid}) is already running on this Telegram account. Stop it first (Ctrl+C in its terminal, or: kill ${pid}).`);
      }
      unlinkSync(path); // stale lock from a crashed run
    }
  }
  throw new Error(`Could not acquire instance lock ${path}`);
}
