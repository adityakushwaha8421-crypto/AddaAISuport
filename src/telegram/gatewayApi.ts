import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import type { ChatFolders } from '../monitoring/chatFolders.js';
import type { RouteHandler } from '../observability/health.js';
import { scrubber } from '../security/scrubber.js';
import { MediaTooLargeError, type ReadStateApi, type Transport } from './transport.js';

export interface GatewayApiDeps {
  token: string;
  transport: Transport & Partial<ReadStateApi>;
  folders?: Pick<ChatFolders, 'place' | 'leave' | 'humanReplied'>;
  log: Logger;
}

const MAX_BODY = 1 << 20;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

/**
 * The gateway's internal API: the one Telegram session, and the folder service, offered to the
 * workers over HTTP. Bearer token, JSON in, JSON (or raw bytes) out. Never reachable without the
 * token; bind HTTP_HOST to a private interface.
 */
export function gatewayRoutes(deps: GatewayApiDeps): RouteHandler {
  const expected = Buffer.from(deps.token);
  const authorised = (req: IncomingMessage) => {
    const given = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body ?? null));
  };

  return async (req, res) => {
    if (!req.url?.startsWith('/internal/')) return false;
    if (!authorised(req)) {
      json(res, 401, { error: 'unauthorised' });
      return true;
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: 'POST only' });
      return true;
    }
    const op = req.url.slice('/internal/'.length);
    const t = deps.transport;
    try {
      const b = await readJson(req);
      switch (op) {
        case 'ping':
          return json(res, 200, { ok: true }), true;
        case 'telegram/send-text':
          return json(res, 200, await t.sendText(String(b.chatId), String(b.text), b.opts as never)), true;
        case 'telegram/forward':
          return json(res, 200, (await t.forwardMessage(String(b.fromChatId), Number(b.messageId), String(b.toChatId))) ?? null), true;
        case 'telegram/messages-exist':
          return json(res, 200, await t.messagesExist(String(b.chatId), (b.messageIds as number[]) ?? [])), true;
        case 'telegram/typing':
          await t.sendTyping(String(b.chatId));
          return json(res, 200, { ok: true }), true;
        case 'telegram/delete':
          if (t.deleteMessage) await t.deleteMessage(String(b.chatId), Number(b.messageId));
          return json(res, 200, { ok: true }), true;
        case 'telegram/seen-by-human':
          return json(res, 200, t.seenByHuman ? await t.seenByHuman(String(b.chatId), Number(b.messageId)) : false), true;
        case 'telegram/download': {
          const data = await t.downloadMedia(b.ref as never);
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length }).end(data);
          return true;
        }
        case 'folders/place':
          return json(res, 200, deps.folders ? await deps.folders.place(String(b.chatId), b.target as never, b.category as never) : {}), true;
        case 'folders/leave':
          return json(res, 200, deps.folders ? await deps.folders.leave(String(b.chatId), b.kind as never, b.reason as never) : 'unchanged'), true;
        case 'folders/human-replied':
          return json(res, 200, deps.folders ? await deps.folders.humanReplied(String(b.chatId)) : 'unchanged'), true;
        default:
          json(res, 404, { error: `unknown operation ${op}` });
          return true;
      }
    } catch (err) {
      const message = scrubber.scrub((err as Error).message ?? String(err));
      if (err instanceof MediaTooLargeError) json(res, 413, { error: message });
      else if (err instanceof SyntaxError) json(res, 400, { error: message });
      else {
        deps.log.warn({ err, op }, 'internal API call failed');
        json(res, 502, { error: message });
      }
      return true;
    }
  };
}
