import { describe, expect, test } from "bun:test";
import {
  attachMarker,
  decodeAttachTicket,
  encodeAttachTicket,
  type AttachTicket,
} from "./attach-ticket";

const ticket: AttachTicket = {
  v: 1,
  endpoint: "/tmp/pw-1/browser/browser-97e462.sock",
  marker: attachMarker("abc"),
  tab: "t3",
  origin: "http://att-1.localhost:9000",
  playwright: "1.62.1",
};

describe("attach ticket", () => {
  test("round-trips, url-safe", () => {
    const raw = encodeAttachTicket(ticket);
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeAttachTicket(raw)).toEqual(ticket);
  });

  test("rejects garbage and wrong shapes loudly", () => {
    expect(() => decodeAttachTicket("not a ticket!")).toThrow(/not a ticket/);
    const wrong = encodeAttachTicket({ ...ticket, origin: "nope" });
    expect(() => decodeAttachTicket(wrong)).toThrow(/malformed ticket/);
  });
});
