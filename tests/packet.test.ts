import { describe, expect, it } from "vitest";
import {
  AFTER_NAT,
  ETH_HEADER,
  FRAME_LENGTH,
  type Frame,
  IP_HEADER,
  internetChecksum,
  REPLY,
  REQUEST,
} from "../src/net/packet";

const frames: [string, Frame][] = [
  ["request", REQUEST],
  ["after NAT", AFTER_NAT],
  ["reply", REPLY],
];

describe("echo frames", () => {
  it.each(frames)("%s is 98 bytes: 14 Ethernet + 20 IP + 8 ICMP + 56 data", (_n, f) => {
    expect(FRAME_LENGTH).toBe(98);
    expect(f.bytes.length).toBe(98);
  });

  it.each(frames)("%s has a valid IP header checksum", (_n, f) => {
    // A correct header sums (with its checksum) to 0xffff, so the "checksum of it" is 0.
    expect(internetChecksum(f.bytes, ETH_HEADER, ETH_HEADER + IP_HEADER)).toBe(0);
  });

  it.each(frames)("%s has a valid ICMP checksum", (_n, f) => {
    expect(internetChecksum(f.bytes, ETH_HEADER + IP_HEADER, FRAME_LENGTH)).toBe(0);
  });

  it.each(frames)("%s fields tile the frame exactly", (_n, f) => {
    let at = 0;
    for (const field of [...f.fields].sort((a, b) => a.offset - b.offset)) {
      expect(field.offset).toBe(at);
      at += field.length;
    }
    expect(at).toBe(98);
  });

  it("matches what ping and Wireshark would show", () => {
    const b = REQUEST.bytes;
    expect(b[12]).toBe(0x08); // EtherType IPv4
    expect(b[14]).toBe(0x45); // IPv4, 20-byte header
    expect((b[16] as number) * 256 + (b[17] as number)).toBe(84); // "56(84) bytes of data"
    expect(b[22]).toBe(64); // TTL
    expect(b[23]).toBe(1); // ICMP
    expect(b[34]).toBe(8); // echo request
    expect(REPLY.bytes[34]).toBe(0); // echo reply
    expect(REPLY.bytes[22]).toBe(117); // "ttl=117"
    // iputils fills the data after the timeval with its own offset: 0x10, 0x11, ...
    expect(Array.from(b.slice(42 + 16, 42 + 20))).toEqual([0x10, 0x11, 0x12, 0x13]);
    expect(b[97]).toBe(0x37);
  });

  it("NAT changes only the addresses, TTL and checksums of the IP/ICMP part", () => {
    const changed: number[] = [];
    for (let i = ETH_HEADER; i < FRAME_LENGTH; i++) if (REQUEST.bytes[i] !== AFTER_NAT.bytes[i]) changed.push(i);
    // TTL (22), IP checksum (24, 25), source address (26-29).
    expect(changed.every((i) => i === 22 || i === 24 || i === 25 || (i >= 26 && i <= 29))).toBe(true);
  });
});
