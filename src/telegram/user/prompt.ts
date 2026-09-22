import { createInterface } from 'node:readline';

/** Terminal prompt; `hidden` suppresses echo (login codes, 2FA passwords). */
export function prompt(question: string, opts: { hidden?: boolean } = {}): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (opts.hidden) {
      const rlAny = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WritableStream };
      rlAny._writeToOutput = (s: string) => {
        // Echo only the question and newlines, never the typed characters.
        if (s.includes(question) || s === '\r\n' || s === '\n') rlAny.output.write(s);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (opts.hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}
