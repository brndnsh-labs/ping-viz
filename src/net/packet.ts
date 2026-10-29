// The actual bytes. An ICMP echo request as Linux `ping` (iputils) sends it over an unprivileged
// ping socket, framed for Ethernet, plus the same packet after the home router's NAT and the reply.
// Addresses: RFC 1918 inside the house, RFC 5737 documentation space for the house's public address,
// RFC 7042 documentation MACs, and a real Google front-end address for google.com.

export type Layer = "link" | "ip" | "icmp" | "data";

export interface Field {
  /** Stable id used for highlighting (e.g. "ip.ttl"). */
  id: string;
  layer: Layer;
  name: string;
  offset: number;
  length: number;
  /** Human-readable value. */
  value: string;
  /** One line on what it's for. */
  note: string;
}

export interface Frame {
  bytes: Uint8Array;
  fields: Field[];
}

type Mac = readonly [number, number, number, number, number, number];
type Ip = readonly [number, number, number, number];

export interface EchoSpec {
  dstMac: Mac;
  srcMac: Mac;
  srcIp: Ip;
  dstIp: Ip;
  ttl: number;
  /** IP identification. */
  ipId: number;
  dontFragment: boolean;
  /** 8: echo request, 0: echo reply. */
  icmpType: 8 | 0;
  icmpId: number;
  seq: number;
  /** Send time, Unix seconds (with fraction): the payload carries it as a struct timeval. */
  sentAt: number;
  /** What the two hardware addresses are, on this hop. */
  linkNotes: { dst: string; src: string };
}

export const ETH_HEADER = 14;
export const IP_HEADER = 20;
export const ICMP_HEADER = 8;
/** ping's default: 56 data bytes, so 64 bytes of ICMP and an 84-byte IP packet. */
export const PAYLOAD = 56;
export const FRAME_LENGTH = ETH_HEADER + IP_HEADER + ICMP_HEADER + PAYLOAD;

/** RFC 1071: one's-complement sum of 16-bit big-endian words, folded and complemented. */
export function internetChecksum(b: Uint8Array, start: number, end: number): number {
  let sum = 0;
  for (let i = start; i < end; i += 2) {
    const hi = b[i] as number;
    const lo = i + 1 < end ? (b[i + 1] as number) : 0;
    sum += (hi << 8) | lo;
  }
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
  return ~sum & 0xffff;
}

const hex = (n: number, w = 2): string => n.toString(16).padStart(w, "0");
const macStr = (m: Mac): string => m.map((x) => hex(x)).join(":");
const ipStr = (a: Ip): string => a.join(".");

export function buildEcho(s: EchoSpec): Frame {
  const b = new Uint8Array(FRAME_LENGTH);
  const v = new DataView(b.buffer);
  // Ethernet II
  b.set(s.dstMac, 0);
  b.set(s.srcMac, 6);
  v.setUint16(12, 0x0800);
  // IPv4
  const ip = ETH_HEADER;
  b[ip] = 0x45;
  b[ip + 1] = 0;
  v.setUint16(ip + 2, IP_HEADER + ICMP_HEADER + PAYLOAD);
  v.setUint16(ip + 4, s.ipId);
  v.setUint16(ip + 6, s.dontFragment ? 0x4000 : 0);
  b[ip + 8] = s.ttl;
  b[ip + 9] = 1;
  b.set(s.srcIp, ip + 12);
  b.set(s.dstIp, ip + 16);
  v.setUint16(ip + 10, internetChecksum(b, ip, ip + IP_HEADER));
  // ICMP echo
  const ic = ip + IP_HEADER;
  b[ic] = s.icmpType;
  b[ic + 1] = 0;
  v.setUint16(ic + 4, s.icmpId);
  v.setUint16(ic + 6, s.seq);
  // Payload: struct timeval (x86-64, little-endian), then the bytes 0x10, 0x11, ... like iputils.
  const d = ic + ICMP_HEADER;
  const sec = Math.floor(s.sentAt);
  const usec = Math.round((s.sentAt - sec) * 1e6);
  v.setBigUint64(d, BigInt(sec), true);
  v.setBigUint64(d + 8, BigInt(usec), true);
  for (let i = 16; i < PAYLOAD; i++) b[d + i] = i;
  v.setUint16(ic + 2, internetChecksum(b, ic, FRAME_LENGTH));

  const ipCsum = v.getUint16(ip + 10);
  const icmpCsum = v.getUint16(ic + 2);
  const sent = new Date(sec * 1000)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, " UTC");
  const fields: Field[] = [
    {
      id: "eth.dst",
      layer: "link",
      name: "Destination MAC",
      offset: 0,
      length: 6,
      value: macStr(s.dstMac),
      note: s.linkNotes.dst,
    },
    {
      id: "eth.src",
      layer: "link",
      name: "Source MAC",
      offset: 6,
      length: 6,
      value: macStr(s.srcMac),
      note: s.linkNotes.src,
    },
    {
      id: "eth.type",
      layer: "link",
      name: "EtherType",
      offset: 12,
      length: 2,
      value: "0x0800 (IPv4)",
      note: "What's inside the frame.",
    },
    {
      id: "ip.vihl",
      layer: "ip",
      name: "Version, header length",
      offset: ip,
      length: 1,
      value: "4, 20 bytes",
      note: "IPv4 with no options.",
    },
    {
      id: "ip.tos",
      layer: "ip",
      name: "DSCP / ECN",
      offset: ip + 1,
      length: 1,
      value: "0",
      note: "No special handling asked for.",
    },
    {
      id: "ip.len",
      layer: "ip",
      name: "Total length",
      offset: ip + 2,
      length: 2,
      value: `${IP_HEADER + ICMP_HEADER + PAYLOAD} bytes`,
      note: "IP header plus everything after it.",
    },
    {
      id: "ip.id",
      layer: "ip",
      name: "Identification",
      offset: ip + 4,
      length: 2,
      value: String(s.ipId),
      note: s.dontFragment
        ? "Only used to reassemble fragments; Linux leaves it 0 when fragmenting isn't allowed."
        : "Only used to reassemble fragments.",
    },
    {
      id: "ip.flags",
      layer: "ip",
      name: "Flags, fragment offset",
      offset: ip + 6,
      length: 2,
      value: s.dontFragment ? "Don't Fragment" : "none",
      note: s.dontFragment
        ? "Routers must drop it rather than split it."
        : "Routers may split it if a link is too small.",
    },
    {
      id: "ip.ttl",
      layer: "ip",
      name: "Time to live",
      offset: ip + 8,
      length: 1,
      value: String(s.ttl),
      note: "Each router subtracts 1; at 0 the packet dies. Stops loops.",
    },
    {
      id: "ip.proto",
      layer: "ip",
      name: "Protocol",
      offset: ip + 9,
      length: 1,
      value: "1 (ICMP)",
      note: "What the IP payload is.",
    },
    {
      id: "ip.csum",
      layer: "ip",
      name: "Header checksum",
      offset: ip + 10,
      length: 2,
      value: `0x${hex(ipCsum, 4)}`,
      note: "Covers the IP header only. Every router recomputes it after changing the TTL.",
    },
    {
      id: "ip.src",
      layer: "ip",
      name: "Source address",
      offset: ip + 12,
      length: 4,
      value: ipStr(s.srcIp),
      note: s.icmpType === 8 ? "Who to answer." : "Google's front end, answering.",
    },
    {
      id: "ip.dst",
      layer: "ip",
      name: "Destination address",
      offset: ip + 16,
      length: 4,
      value: ipStr(s.dstIp),
      note: s.icmpType === 8 ? "google.com, as DNS answered." : "Back to the laptop (the router undid its NAT).",
    },
    {
      id: "icmp.type",
      layer: "icmp",
      name: "Type",
      offset: ic,
      length: 1,
      value: s.icmpType === 8 ? "8 (echo request)" : "0 (echo reply)",
      note: "The whole of ping's protocol is this one byte.",
    },
    { id: "icmp.code", layer: "icmp", name: "Code", offset: ic + 1, length: 1, value: "0", note: "Always 0 for echo." },
    {
      id: "icmp.csum",
      layer: "icmp",
      name: "Checksum",
      offset: ic + 2,
      length: 2,
      value: `0x${hex(icmpCsum, 4)}`,
      note: "Covers the ICMP header and data. The kernel fills it in.",
    },
    {
      id: "icmp.id",
      layer: "icmp",
      name: "Identifier",
      offset: ic + 4,
      length: 2,
      value: String(s.icmpId),
      note: "Picked by the kernel for this ping socket, so replies find their way to the right process.",
    },
    {
      id: "icmp.seq",
      layer: "icmp",
      name: "Sequence",
      offset: ic + 6,
      length: 2,
      value: String(s.seq),
      note: "1, 2, 3... one per second. Gaps mean loss.",
    },
    {
      id: "data.time",
      layer: "data",
      name: "Timestamp",
      offset: d,
      length: 16,
      value: sent,
      note: "When ping sent it (a struct timeval). The reply echoes it back, which is how ping measures time.",
    },
    {
      id: "data.pad",
      layer: "data",
      name: "Filler",
      offset: d + 16,
      length: PAYLOAD - 16,
      value: "0x10 0x11 … 0x37",
      note: "Counting bytes, to make 56. Corruption would show.",
    },
  ];
  return { bytes: b, fields };
}

/** Hardware and addresses for the illustrative house. */
export const HOUSE = {
  laptopMac: [0x00, 0x00, 0x5e, 0x00, 0x53, 0x23] as Mac,
  routerMac: [0x00, 0x00, 0x5e, 0x00, 0x53, 0x01] as Mac,
  laptopIp: [192, 168, 1, 23] as Ip,
  routerIp: [192, 168, 1, 1] as Ip,
  publicIp: [203, 0, 113, 7] as Ip,
};

/** google.com's address in this story: a Google front end near Atlanta (ys-in-f113.1e100.net). */
export const GOOGLE_IP: Ip = [172, 253, 124, 113];
export const GOOGLE_HOST = "ys-in-f113.1e100.net";

/** 2026-10-29 16:20:07.412581 UTC. */
export const SENT_AT = Date.UTC(2026, 9, 29, 16, 20, 7) / 1000 + 0.412581;
export const ICMP_ID = 23582;

/** What leaves the laptop. */
export const REQUEST = buildEcho({
  dstMac: HOUSE.routerMac,
  srcMac: HOUSE.laptopMac,
  srcIp: HOUSE.laptopIp,
  dstIp: GOOGLE_IP,
  ttl: 64,
  ipId: 0,
  dontFragment: true,
  icmpType: 8,
  icmpId: ICMP_ID,
  seq: 1,
  sentAt: SENT_AT,
  linkNotes: { dst: "The router's hardware address: the next hop, not Google.", src: "This laptop's Wi-Fi card." },
});

/** The same packet leaving the router: public source address, TTL one lower, both checksums redone. */
export const AFTER_NAT = buildEcho({
  dstMac: [0x00, 0x00, 0x5e, 0x00, 0x53, 0x90],
  srcMac: [0x00, 0x00, 0x5e, 0x00, 0x53, 0x02],
  srcIp: HOUSE.publicIp,
  dstIp: GOOGLE_IP,
  ttl: 63,
  ipId: 0,
  dontFragment: true,
  icmpType: 8,
  icmpId: ICMP_ID,
  seq: 1,
  sentAt: SENT_AT,
  linkNotes: { dst: "The ISP's equipment: the next hop out of the house.", src: "The router's outside (WAN) port." },
});

/** The reply as it reaches the laptop (after NAT is undone): type 0, addresses swapped, TTL 117. */
export const REPLY = buildEcho({
  dstMac: HOUSE.laptopMac,
  srcMac: HOUSE.routerMac,
  srcIp: GOOGLE_IP,
  dstIp: HOUSE.laptopIp,
  ttl: 117,
  ipId: 0,
  dontFragment: false,
  icmpType: 0,
  icmpId: ICMP_ID,
  seq: 1,
  sentAt: SENT_AT,
  linkNotes: { dst: "This laptop's Wi-Fi card: the last hop.", src: "The router, handing it over." },
});

/** Which field a byte belongs to. */
export function fieldAt(frame: Frame, offset: number): Field | undefined {
  return frame.fields.find((f) => offset >= f.offset && offset < f.offset + f.length);
}
