import { pino, stdSerializers, type Logger } from 'pino';
import { scrubber } from '../security/scrubber.js';

export type { Logger };

const REDACT_PATHS = [
  'password', '*.password', 'pdfPassword', '*.pdfPassword', 'otp', '*.otp', 'token', '*.token',
  'apiKey', '*.apiKey', 'apiHash', '*.apiHash', 'session', '*.session', 'sessionString', '*.sessionString',
  'cookie', '*.cookie', 'cookies', '*.cookies', 'authorization', '*.authorization', 'headers.authorization',
  'storageState', '*.storageState',
];

export function createLogger(opts: { level?: string; pretty?: boolean; file?: string } = {}): Logger {
  const targets = [
    opts.pretty ? { target: 'pino-pretty', options: { colorize: true, destination: 1 } } : { target: 'pino/file', options: { destination: 1 } },
    ...(opts.file ? [{ target: 'pino/file', options: { destination: opts.file, mkdir: true } }] : []),
  ];
  return pino({
    level: opts.level ?? process.env.LOG_LEVEL ?? 'info',
    base: { svc: 'fa-support-agent' },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    hooks: {
      // Scrub free-text log messages and nested objects for known secret values / patterns.
      logMethod(args, method) {
        const cleaned = args.map((a) =>
          typeof a === 'string' ? scrubber.scrub(a) : a && typeof a === 'object' ? scrubber.scrubDeep(a) : a,
        );
        return method.apply(this, cleaned as Parameters<typeof method>);
      },
    },
    serializers: {
      err: (e: unknown) => {
        const s = stdSerializers.err(e as Error);
        return { ...s, message: scrubber.scrub(s.message ?? ''), stack: s.stack ? scrubber.scrub(s.stack) : undefined };
      },
    },
    ...(opts.pretty || opts.file ? { transport: { targets } } : {}),
  });
}

/** A logger that discards everything — handy for tests and tools. */
export const silentLogger: Logger = pino({ level: 'silent' });
