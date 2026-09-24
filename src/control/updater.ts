import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Logger } from 'pino';
import { scrubber } from '../security/scrubber.js';

const run = promisify(execFile);

export interface UpdateResult {
  /** Commit before and after the pull (short hashes). */
  before: string;
  after: string;
  /** Files the pull changed (empty when already up to date). */
  files: string[];
  /** Whether dependencies were (re)installed. */
  installed: boolean;
}

export class UpdateError extends Error {}

/**
 * Bring the working copy up to date with GitHub and build it: `git pull --ff-only`, `npm install`
 * when the lockfile changed, `npm run build`. Never touches `.env`, `secrets/` or `data/` (all
 * ignored by git). Throws an UpdateError with a short, secret-free reason on any failure — the
 * caller keeps the current agent running in that case.
 */
export async function updateFromGit(opts: { cwd: string; log: Logger; timeoutMs?: number }): Promise<UpdateResult> {
  const { cwd, log } = opts;
  const timeout = opts.timeoutMs ?? 5 * 60_000;
  const step = async (what: string, cmd: string, args: string[]) => {
    try {
      const { stdout } = await run(cmd, args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      return stdout.trim();
    } catch (err) {
      const e = err as { stderr?: string; stdout?: string; message?: string; killed?: boolean };
      const detail = scrubber.scrub((e.stderr || e.stdout || e.message || '').trim().split('\n').slice(-3).join(' ')).slice(0, 300);
      throw new UpdateError(`${what} failed${e.killed ? ' (timed out)' : ''}: ${detail || 'unknown error'}`);
    }
  };
  const before = await step('git', 'git', ['rev-parse', '--short', 'HEAD']);
  log.info({ before }, 'update: pulling from GitHub');
  await step('git pull', 'git', ['pull', '--ff-only']);
  const after = await step('git', 'git', ['rev-parse', '--short', 'HEAD']);
  const files = before === after ? [] : (await step('git diff', 'git', ['diff', '--name-only', `${before}..${after}`])).split('\n').filter(Boolean);
  let installed = false;
  if (files.some((f) => f === 'package.json' || f === 'package-lock.json')) {
    log.info('update: dependencies changed, installing');
    await step('npm install', 'npm', ['install', '--no-audit', '--no-fund']);
    installed = true;
  }
  log.info({ before, after, changed: files.length }, 'update: building');
  await step('build', 'npm', ['run', '-s', 'build']);
  return { before, after, files, installed };
}
