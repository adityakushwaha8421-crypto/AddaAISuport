import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Pulls a few representative still frames out of a screen recording. */
export interface FrameExtractor {
  available(): Promise<boolean>;
  extract(video: Buffer, durationSec?: number, count?: number): Promise<Buffer[]>;
}

export class FfmpegFrameExtractor implements FrameExtractor {
  private ok?: boolean;
  constructor(private readonly ffmpegPath = 'ffmpeg') {}

  async available(): Promise<boolean> {
    if (this.ok !== undefined) return this.ok;
    try {
      if (this.ffmpegPath.includes('/')) await access(this.ffmpegPath);
      await run(this.ffmpegPath, ['-version'], { timeout: 5000 });
      this.ok = true;
    } catch {
      this.ok = false;
    }
    return this.ok;
  }

  async extract(video: Buffer, durationSec?: number, count = 4): Promise<Buffer[]> {
    const dir = await mkdtemp(join(tmpdir(), 'fa-frames-'));
    try {
      const input = join(dir, 'in.bin');
      await writeFile(input, video, { mode: 0o600 });
      const d = durationSec && durationSec > 0 ? durationSec : 10;
      // Evenly spaced timestamps, skipping the very first/last moments (often blank/transitions).
      const stamps = Array.from({ length: count }, (_, i) => ((i + 1) / (count + 1)) * d);
      const frames: Buffer[] = [];
      for (const [i, t] of stamps.entries()) {
        const out = join(dir, `f${i}.jpg`);
        try {
          await run(this.ffmpegPath, ['-v', 'error', '-ss', t.toFixed(2), '-i', input, '-frames:v', '1', '-q:v', '3', '-vf', 'scale=1280:-2', out], { timeout: 20_000 });
          frames.push(await readFile(out));
        } catch {
          // Timestamp beyond the end etc. — skip that frame.
        }
      }
      return frames;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

export class NoFrameExtractor implements FrameExtractor {
  async available() {
    return false;
  }
  async extract(): Promise<Buffer[]> {
    return [];
  }
}
