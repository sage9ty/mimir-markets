import { describe, it, expect, beforeEach } from 'vitest';
import {
  sortDecodedMessagesBySentAt,
  getDecodedMessageText,
  peerIdentifierFromAddress,
  classifyXmtpThreadError,
  XMTP_THREAD_MESSAGE_LIMIT,
  XmtpPeerUnreachableError,
} from '../../lib/xmtp/chat-thread';

type DecodedMessage = {
  id?: string;
  sentAtNs?: bigint;
  content?: unknown;
  text?: string;
  [key: string]: unknown;
};

function msg(
  id: string,
  sentAtNs: bigint,
  content?: unknown,
): DecodedMessage {
  return { id, sentAtNs, content };
}

describe('sortDecodedMessagesBySentAt', () => {
  it('sorts ascending by bigint sentAtNs', () => {
    const a = msg('a', 300n);
    const b = msg('b', 100n);
    const c = msg('c', 200n);
    const out = sortDecodedMessagesBySentAt([a, b, c] as any);
    expect(out.map((m: any) => m.id)).toEqual(['b', 'c', 'a']);
  });

  it('preserves stability for equal timestamps', () => {
    const a = msg('a', 100n, { text: 'a' });
    const b = msg('b', 100n, { text: 'b' });
    const c = msg('c', 100n, { text: 'c' });
    const out = sortDecodedMessagesBySentAt([a, b, c] as any);
    expect(out.map((m: any) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the input array', () => {
    const a = msg('a', 200n);
    const b = msg('b', 100n);
    const input = [a, b];
    const out = sortDecodedMessagesBySentAt(input as any);
    expect(input.map((m) => m.id)).toEqual(['a', 'b']);
    expect(out.map((m: any) => m.id)).toEqual(['b', 'a']);
  });

  it('handles empty array', () => {
    expect(sortDecodedMessagesBySentAt([] as any)).toEqual([]);
  });
});

describe('getDecodedMessageText', () => {
  it('returns text for plain string content', () => {
    expect(getDecodedMessageText(msg('a', 1n, 'hello') as any)).toEqual('hello');
  });

  it('returns text field when present', () => {
    expect(getDecodedMessageText(msg('a', 1n, { text: 'hi' }) as any)).toEqual('hi');
  });

  it('returns empty string for non-text content', () => {
    const out = getDecodedMessageText(msg('a', 1n, { attachment: 'file' }) as any);
    expect(typeof out).toBe('string');
    expect(out).toEqual('');
  });

  it('handles missing content', () => {
    expect(getDecodedMessageText(msg('a', 1n) as any)).toEqual('');
  });
});

describe('peerIdentifierFromAddress', () => {
  it('returns a stable identifier for an address', () => {
    const addr = '0x1234567890abcdef1234567890abcdef123456789';
    const id1 = peerIdentifierFromAddress(addr);
    const id2 = peerIdentifierFromAddress(addr);
    expect(typeof id1).toBe('string');
    expect(id1.length).toBeGreaterThan(0);
    expect(id1).toEqual(id2);
  });

  it('produces different identifiers for different addresses', () => {
    const a = peerIdentifierFromAddress('0x0000000000000000000000000000000000000000');
    const b = peerIdentifierFromAddress('0x1111111111111111111111111111111111111111');
    expect(a).not.toEqual(b);
  });
});

describe('classifyXmtpThreadError', () => {
  it('classifies XmtpPeerUnreachableError', () => {
    const err = new XmtpPeerUnreachableError('peer unreachable');
    const out = classifyXmtpThreadError(err);
    expect(out).toBeTruthy();
    expect(typeof out).toBe('string');
  });

  it('classifies generic Error', () => {
    const out = classifyXmtpThreadError(new Error('boom'));
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });

  it('classifies non-Error values', () => {
    const out = classifyXmtpThreadError('string failure');
    expect(typeof out).toBe('string');
  });

  it('classifies null/undefined', () => {
    expect(typeof classifyXmtpThreadError(null)).toBe('string');
    expect(typeof classifyXmtpThreadError(undefined)).toBe('string');
  });
});

describe('XMTP_THREAD_MESSAGE_LIMIT', () => {
  it('is a positive number', () => {
    expect(typeof XMTP_THREAD_MESSAGE_LIMIT).toBe('number');
    expect(XMTP_THREAD_MESSAGE_LIMIT).toBeGreaterThan(0);
  });
});
