import { describe, it, expect } from "vitest";
import {
  normalizeXmtpMessageId,
  decodedMessageMatchesPending,
  mergeThreadDisplayRows,
} from "../../lib/xmtp/optimistic-send";

type Row = {
  id: string;
  content?: string;
  senderInboxId?: string;
  sentAt?: number;
  pending?: boolean;
  [key: string]: unknown;
};

describe("normalizeXmtpMessageId", () => {
  const cases: Array<[string | null | undefined, string | null]> = [
    ["abc123", "abc123"],
    ["  abc123  ", "abc123"],
    ["ABC123", "abc123"],
    ["", null],
    ["   ", null],
    [null, null],
    [undefined, null],
  ];

  it.each(cases)("normalizes %s -> %s", (input, expected) => {
    expect(normalizeXmtpMessageId(input as any)).toBe(expected);
  });
});

describe("decodedMessageMatchesPending", () => {
  const pending: Row = {
    id: "pending-1",
    content: "hello there",
    senderInboxId: "inbox-a",
    sentAt: 1000,
    pending: true,
  };

  const cases: Array<{
    name: string;
    decoded: Row;
    expected: boolean;
  }> = [
    {
      name: "matches by id",
      decoded: { id: "pending-1", content: "other", senderInboxId: "inbox-b", sentAt: 99999 },
      expected: true,
    },
    {
      name: "matches by id after normalization",
      decoded: { id: "  PENDING-1 ", content: "x", senderInboxId: "inbox-b", sentAt: 99999 },
      expected: true,
    },
    {
      name: "matches by content+sender+time window",
      decoded: { id: "network-1", content: "hello there", senderInboxId: "inbox-a", sentAt: 1500 },
      expected: true,
    },
    {
      name: "does not match different content",
      decoded: { id: "network-2", content: "different", senderInboxId: "inbox-a", sentAt: 1500 },
      expected: false,
    },
    {
      name: "does not match different sender",
      decoded: { id: "network-3", content: "hello there", senderInboxId: "inbox-b", sentAt: 1500 },
      expected: false,
    },
    {
      name: "does not match outside time window",
      decoded: { id: "network-4", content: "hello there", senderInboxId: "inbox-a", sentAt: 100000 },
      expected: false,
    },
  ];

  it.each(cases)("$name", ({ decoded, expected }) => {
    expect(decodedMessageMatchesPending(decoded as any, pending as any)).toBe(expected);
  });
});

describe("mergeThreadDisplayRows", () => {
  it("preserves network order and replaces confirmed pending items", () => {
    const network: Row[] = [
      { id: "n1", content: "a", senderInboxId: "inbox-a", sentAt: 1000 },
      { id: "n2", content: "b", senderInboxId: "inbox-a", sentAt: 2000 },
    ];
    const pending: Row[] = [
      { id: "p1", content: "a", senderInboxId: "inbox-a", sentAt: 1000, pending: true },
    ];

    const merged = mergeThreadDisplayRows(network as any, pending as any);
    expect(merged.map((r: Row) => r.id)).toEqual(["n1", "n2"]);
  });

  it("appends unconfirmed pending items at the end", () => {
    const network: Row[] = [
      { id: "n1", content: "a", senderInboxId: "inbox-a", sentAt: 1000 },
    ];
    const pending: Row[] = [
      { id: "p1", content: "never confirms", senderInboxId: "inbox-a", sentAt: 5000, pending: true },
    ];

    const merged = mergeThreadDisplayRows(network as any, pending as any);
    expect(merged.map((r: Row) => r.id)).toEqual(["n1", "p1"]);
  });

  it("keeps a pending item that never confirms when there is no network copy", () => {
    const pending: Row[] = [
      { id: "p1", content: "never confirms", senderInboxId: "inbox-a", sentAt: 5000, pending: true },
    ];

    const merged = mergeThreadDisplayRows([] as any, pending as any);
    expect(merged.map((r: Row) => r.id)).toEqual(["p1"]);
  });

  it("does not duplicate a pending item that matches a network copy by content+sender+time", () => {
    const network: Row[] = [
      { id: "n1", content: "hello", senderInboxId: "inbox-a", sentAt: 1000 },
    ];
    const pending: Row[] = [
      { id: "p1", content: "hello", senderInboxId: "inbox-a", sentAt: 1200, pending: true },
    ];

    const merged = mergeThreadDisplayRows(network as any, pending as any);
    expect(merged.map((r: Row) => r.id)).toEqual(["n1"]);
  });

  it("returns network rows unchanged when there are no pending rows", () => {
    const network: Row[] = [
      { id: "n1", content: "a", senderInboxId: "inbox-a", sentAt: 1000 },
      { id: "n2", content: "b", senderInboxId: "inbox-a", sentAt: 2000 },
    ];

    const merged = mergeThreadDisplayRows(network as any, [] as any);
    expect(merged.map((r: Row) => r.id)).toEqual(["n1", "n2"]);
  });
});
