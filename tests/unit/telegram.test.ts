import bigInt from 'big-integer';
import { Api } from 'telegram';
import { describe, expect, it } from 'vitest';
import { buildInbound, exportForwardOf, mediaFromUserMessage, parseAllowedUsers, screenSender } from '../../src/telegram/user/userTransport.js';

const SELF = '777';
const CHAT = '42';
const peer = new Api.PeerUser({ userId: bigInt(42) });
const sender = new Api.User({ id: bigInt(42), firstName: 'Rahul', username: 'rahul_k', langCode: 'hi' });

const msg = (over: Partial<ConstructorParameters<typeof Api.Message>[0]>) =>
  new Api.Message({ id: 1, peerId: peer, date: 1_788_000_000, message: '', ...over });

const photo = (id: number) =>
  new Api.MessageMediaPhoto({ photo: new Api.Photo({ id: bigInt(id), accessHash: bigInt(1), fileReference: Buffer.alloc(0), date: 0, sizes: [], dcId: 1 }) });

const document = (mimeType: string, attributes: Api.TypeDocumentAttribute[], size = 1234) =>
  new Api.MessageMediaDocument({
    document: new Api.Document({ id: bigInt(77), accessHash: bigInt(1), fileReference: Buffer.alloc(0), date: 0, mimeType, size: bigInt(size), dcId: 1, attributes }),
  });

describe('Telegram account message mapping', () => {
  it('preserves swipe-reply context: replied text, media and whether it was ours', () => {
    const replied = msg({ id: 10, out: true, message: 'Sir, screenshot mein 3 withdrawals dikh rahe hain. Kaunsa wala check karna hai?' });
    const m = msg({ id: 11, message: 'upper wala', replyTo: new Api.MessageReplyHeader({ replyToMsgId: 10 }) });
    expect(buildInbound(m, CHAT, sender, replied, SELF)).toMatchObject({
      chatId: '42', userId: '42', messageId: 11, text: 'upper wala',
      replyTo: { messageId: 10, fromSelf: true, text: replied.message, media: [] },
      sender: { username: 'rahul_k', firstName: 'Rahul', languageCode: 'hi' },
    });
  });

  it('keeps the reply pointer when Telegram cannot return the replied message', () => {
    const m = msg({ id: 11, message: 'ye wala', replyTo: new Api.MessageReplyHeader({ replyToMsgId: 3 }) });
    expect(buildInbound(m, CHAT, sender, undefined, SELF).replyTo).toEqual({ messageId: 3, media: [], fromSelf: false });
  });

  it('treats a reply to the customer\'s own screenshot as theirs, with its media', () => {
    const shot = msg({ id: 5, out: false, message: 'ye dekho', media: photo(555) });
    const m = msg({ id: 6, message: 'upar wala', replyTo: new Api.MessageReplyHeader({ replyToMsgId: 5 }) });
    const inbound = buildInbound(m, CHAT, sender, shot, SELF);
    expect(inbound.replyTo).toMatchObject({ fromSelf: false, caption: 'ye dekho', media: [{ kind: 'photo', fileUniqueId: 'photo:555' }] });
  });

  it('maps photos with caption and album id', () => {
    const m = msg({ id: 7, message: 'payment ka screenshot', media: photo(555), groupedId: bigInt(9) });
    const inbound = buildInbound(m, CHAT, sender, undefined, SELF);
    expect(inbound).toMatchObject({ text: undefined, caption: 'payment ka screenshot', mediaGroupId: '9' });
    expect(inbound.media).toEqual([{ kind: 'photo', fileRef: '42:7', fileUniqueId: 'photo:555', mimeType: 'image/jpeg' }]);
  });

  it('classifies documents, voice notes, round videos and stickers', () => {
    const pdf = mediaFromUserMessage(msg({ id: 8, media: document('application/pdf', [new Api.DocumentAttributeFilename({ fileName: 'stmt.pdf' })]) }), CHAT);
    expect(pdf[0]).toMatchObject({ kind: 'document', mimeType: 'application/pdf', fileName: 'stmt.pdf', fileSize: 1234, fileRef: '42:8' });

    const voice = mediaFromUserMessage(msg({ id: 9, media: document('audio/ogg', [new Api.DocumentAttributeAudio({ duration: 4, voice: true })]) }), CHAT);
    expect(voice[0]).toMatchObject({ kind: 'voice', durationSec: 4 });

    const round = mediaFromUserMessage(msg({ id: 10, media: document('video/mp4', [new Api.DocumentAttributeVideo({ duration: 6, w: 240, h: 240, roundMessage: true })]) }), CHAT);
    expect(round[0]).toMatchObject({ kind: 'video_note', durationSec: 6 });

    const sticker = mediaFromUserMessage(msg({ id: 11, media: document('image/webp', [new Api.DocumentAttributeSticker({ alt: '👍', stickerset: new Api.InputStickerSetEmpty() })]) }), CHAT);
    expect(sticker[0]).toMatchObject({ kind: 'sticker' });

    expect(mediaFromUserMessage(msg({ id: 12, message: 'just text' }), CHAT)).toEqual([]);
  });
});

describe('who the AI may answer (personal account)', () => {
  const user = (over: Partial<ConstructorParameters<typeof Api.User>[0]> = {}) => new Api.User({ id: bigInt(42), firstName: 'Rahul', username: 'Rahul_K', ...over });

  it('never answers Telegram itself, its own account or bots', () => {
    expect(screenSender(user({ id: bigInt(777000) }), { ignoreContacts: false })).toMatchObject({ ok: false, reason: 'Telegram service account' });
    expect(screenSender(user({ self: true }), { ignoreContacts: false }).ok).toBe(false);
    expect(screenSender(user({ bot: true }), { ignoreContacts: false }).ok).toBe(false);
  });

  it('skips saved contacts by default, answers strangers (customers)', () => {
    expect(screenSender(user({ contact: true }), { ignoreContacts: true }).ok).toBe(false);
    expect(screenSender(user(), { ignoreContacts: true }).ok).toBe(true);
    expect(screenSender(user({ contact: true }), { ignoreContacts: false }).ok).toBe(true);
  });

  it('allow-list limits replies to test users by id or @username (even if they are contacts)', () => {
    const allowed = parseAllowedUsers(' 42 , @someone,other ');
    expect([...allowed!]).toEqual(['42', '@someone', '@other']);
    expect(screenSender(user({ contact: true }), { allowed, ignoreContacts: true }).ok).toBe(true);
    expect(screenSender(user({ id: bigInt(9), username: 'Other' }), { allowed, ignoreContacts: true }).ok).toBe(true);
    expect(screenSender(user({ id: bigInt(9), username: 'stranger' }), { allowed, ignoreContacts: true })).toMatchObject({ ok: false });
    expect(parseAllowedUsers('')).toBeUndefined();
  });
});

describe('forwards the account makes into the export bot chat', () => {
  const fwd = (over: Partial<ConstructorParameters<typeof Api.MessageFwdHeader>[0]>) => new Api.MessageFwdHeader({ date: 1_788_000_000, ...over });

  it('names the customer a forward came from, and what it is', () => {
    const from = fwd({ fromId: new Api.PeerUser({ userId: bigInt(8939686943) }) });
    expect(exportForwardOf(msg({ id: 31, out: true, fwdFrom: from, media: photo(555) }))).toMatchObject({ messageId: 31, fromUserId: '8939686943', kind: 'photo', fileUniqueId: 'photo:555' });
    expect(exportForwardOf(msg({ id: 32, out: true, fwdFrom: from, message: '9810822372' }))).toMatchObject({ kind: 'text', text: '9810822372', fromUserId: '8939686943' });
    const pdf = document('application/pdf', [new Api.DocumentAttributeFilename({ fileName: 'statement.pdf' })]);
    expect(exportForwardOf(msg({ id: 33, out: true, fwdFrom: from, media: pdf }))).toMatchObject({ kind: 'document', mimeType: 'application/pdf', fileName: 'statement.pdf', fileUniqueId: 'doc:77' });
    const video = document('video/mp4', [new Api.DocumentAttributeVideo({ duration: 11, w: 720, h: 1280 })]);
    expect(exportForwardOf(msg({ id: 34, out: true, fwdFrom: from, media: video }))).toMatchObject({ kind: 'video' });
  });

  it('a customer who hides their account leaves only a name; the file id still identifies the file', () => {
    const e = exportForwardOf(msg({ id: 35, out: true, fwdFrom: fwd({ fromName: 'Hidden User' }), media: photo(556) }));
    expect(e.fromUserId).toBeUndefined();
    expect(e).toMatchObject({ fromName: 'Hidden User', fileUniqueId: 'photo:556' });
  });
});
