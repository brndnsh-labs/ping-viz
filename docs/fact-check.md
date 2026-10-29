# Fact check

Every factual claim in the prose (`content/*.html`) and the scene labels (`src/scenes/*.ts`), with
where it comes from. Checked 2026-10-29: four independent passes, every finding re-verified before it
was changed. When you change a claim, update its row.

Kinds: **sourced** (a primary source says so), **scenario** (a choice for this one plausible run; the
Notes card says so), **estimate** (no single source; the reasoning is given), **measured** (looked up
live on the date above).

## Act I

| Chapter | Claim | Kind | Source |
|---|---|---|---|
| enter | key matrix; firmware scans ~1,000×/s and debounces a few ms | estimate | QMK docs; Cherry MX datasheet (bounce < 5 ms) |
| enter | USB polled every 1-8 ms; 8-byte boot report; Enter = 0x28 | sourced | USB 2.0 §9.6.6; HID 1.11 App. B.1; HID Usage Tables |
| enter | xHCI DMA + interrupt; ~6 ms elapsed | sourced / scenario | xHCI 1.2 §4.9; chapters.ts enter window |
| shell | HID driver → evdev `KEY_ENTER, value 1`; Wayland compositor; CR into a PTY | sourced | hid-input.c; event-codes.rst; pty(7) |
| shell | readline reads raw bytes and sees `\r` (ICRNL off); tty canonical mode; Ctrl-C → SIGINT | sourced | readline rltty.c; termios(3) |
| fork | `$PATH` walk and hash; fork = clone; copy-on-write (page tables are copied, memory isn't) | sourced | bash(1); glibc arch-fork.h; fork(2) |
| fork | execve, ELF + PT_INTERP, ld.so maps libc; vfork/posix_spawn, posix_spawn file actions | sourced | execve(2), ld.so(8), posix_spawn(3) |
| dns | getaddrinfo → nsswitch (files, dns); systemd-resolved at 127.0.0.53 | sourced | nsswitch.conf(5); systemd-resolved.service(8) |
| dns | both caches cold | scenario | Notes card |
| dns | 13 root names, 12 operators, ~2,000 instances, anycast | sourced | root-servers.org (2,049 instances) |
| dns | .com (Verisign) refers to ns1-4.google.com with glue | measured | `dig google.com @a.gtld-servers.net` |
| dns | Google's NS answers six A records, TTL 300; ping uses the first, 172.253.124.113 | measured | `dig google.com @ns1.google.com +subnet=…` |
| dns | 172.253.124.113 is near Atlanta; PTR ys-in-f113.1e100.net | measured | ipinfo; `dig -x` |
| dns | cache hit: local < 1 ms, ISP resolver a few ms | estimate | one Wi-Fi + access round trip |
| dns | IPv6 first when it works; ECS | sourced | RFC 6724; RFC 7871 |
| packet | unprivileged ping socket; 8 + 56 bytes; time then filler | sourced | iputils ping.c; net/ipv4/ping.c |
| packet | kernel sets identifier and checksum; IPv4 TTL 64, protocol 1 | sourced | net/ipv4/ping.c; RFC 791; ip_default_ttl |
| packet | ID 0: DF set and socket unconnected | sourced | include/net/ip.h (`ip_select_ident_segs`); RFC 6864 |
| packet | Wi-Fi interfaces have no qdisc; mac80211 queues per station | sourced | net/mac80211/iface.c (`IFF_NO_QUEUE`) |
| packet | all bytes and checksums | sourced | src/net/packet.ts, rebuilt independently (RFC 791/792/1071) |
| wifi | mac80211 builds the 802.11 header (3 addresses, LLC/SNAP); card encrypts (CCMP/GCMP, AES) | sourced | net/mac80211/tx.c; IEEE 802.11i; WPA3 spec |
| wifi | CSMA/CA backoff; OFDMA subcarriers; 1024-QAM = 10 bits; ACK and retry | sourced | IEEE 802.11ax |
| wifi | tens of µs on air, mostly preamble | estimate | HE SU preamble ~36-48 µs + one symbol |
| router | NAT keyed on ICMP identifier; TTL 63; IP checksum only | sourced | nf_conntrack_proto_icmp; RFC 5508; RFC 1812 |
| router | GPON: split among dozens of homes, time slots; ~9 µm core; ~2/3 c | sourced | ITU-T G.984; G.652 |
| internet | longest-prefix match, TTL − 1; billions of pps per router | sourced | RFC 1812; vendor specs |
| internet | Asheville → Charlotte → Atlanta, ~5 ms one way | scenario / estimate | ~650 km of fiber at 200 km/ms + hops |
| internet | AS15169 announces the block via BGP | measured | RIPEstat |
| internet | Google peers directly with most large ISPs | sourced | Chiu et al., IMC 2015 (> 60% of prefixes) |
| google | ECMP; Maglev (consistent hashing) for web traffic | sourced | Maglev, NSDI 2016 |
| google | what answers ICMP for a VIP | not public | prose says so |
| google | echo reply: type 0, swap, echo id/seq/data | sourced | RFC 792 |
| return | asymmetric routing; via Greenville | sourced / scenario | Paxson 1997 |
| arrive | NAPI; recvmsg with timeout; SO_TIMESTAMP | sourced | docs.kernel.org/networking/napi.html; iputils |
| print | reverse lookup unless -n; 1e100 = googol | sourced | iputils; Google FAQ |
| print | 16.7 ms frame at 60 Hz; ~200 ms to notice | estimate | display timing; visual reaction time |
| outro | Muuss, December 1983, the quote, sonar | sourced | ftp.arl.army.mil/~mike/ping.html |

## Act II

| Chapter | Claim | Kind | Source |
|---|---|---|---|
| launch | one ~290 MB executable; TypeScript compiled with Bun | measured / sourced | v2.1.312 binary; Anthropic's Bun announcement |
| launch | MCP servers over pipes or remote; Ink (modified) | sourced | code.claude.com/docs/en/mcp |
| prompt | request: model, system, tools, messages, max_tokens, stream | sourced | Messages API docs |
| prompt | built-in tools with schemas; MCP tools deferred (names only) | sourced | code.claude.com/docs/en/how-claude-code-works |
| prompt | order: tools + system prompt, CLAUDE.md + memory, then the conversation (environment first) | sourced | code.claude.com/docs/en/prompt-caching (layers, "Cache scope") |
| prompt | section token counts | estimate | `/context`; labels say ≈ |
| prompt | ~3 English characters per token for Claude | sourced | platform.claude.com glossary (3.5 on older models, ~30% more tokens on 4.7+) |
| prompt | cache: prefix match, 5 min or 1 h (1 h on a subscription) | sourced | prompt-caching docs (API and Claude Code) |
| wire | 160.79.104.10, AS399358, reached through Cloudflare | measured | `dig`; RIPEstat paths all `13335 399358` |
| wire | ~100 KB, ~70 segments, IW10 slow start; HTTP/2 POST /v1/messages | sourced / estimate | RFC 6928; `curl -v` |
| frontdoor | first machines are Cloudflare's; TLS ends there | measured | response headers `server: cloudflare`, `cf-ray …-IAD` |
| frontdoor | API key or subscription OAuth; per-minute vs 5-hour/weekly limits | sourced | code.claude.com/docs/en/authentication; API rate-limits docs; Claude support |
| frontdoor | routed to a deployment with room, maybe a queue | estimate | generic serving; no specifics claimed |
| datacenter | three chip platforms; up to 1M TPUs, > 1 GW in 2026 | sourced | Anthropic, Oct 2025 and Apr 2026 |
| datacenter | Rainier opened Oct 2025 with ~500k Trainium2, multiple US datacenters | sourced | Amazon's Project Rainier page |
| datacenter | the globe's datacenter at New Carlisle, IN | sourced | Rainier's public site; Notes card says so |
| datacenter | a frontier model is too big for one chip | estimate | Claude's size isn't public |
| prefill | embeddings, attention, FFN; prefill parallel; KV cache | sourced | Vaswani et al. 2017 |
| prefill | ~2 operations per parameter per token; ~10^16 for 25k tokens | sourced / estimate | Kaplan et al. 2020; hypothetical size, framed as such |
| prefill | first token in about a second | estimate | cached prefix; matches the clock |
| decode | serial decode, memory-bound, batching | sourced | standard (Orca, vLLM papers) |
| decode | thinking first; returned at most as a summary; dozens of tokens/s | sourced / estimate | thinking docs; typical speeds |
| stream | SSE events, `content_block_delta`, `ping` events | sourced | streaming docs |
| stream | why pings exist | not documented | prose says so |
| loop | tool_use / stop_reason; tool runs locally; permission check | sourced | tool-use docs; how-claude-code-works |
| loop | 1M context window by default; compaction near it; subagents own context | sourced | code.claude.com/docs/en/model-config; how-claude-code-works |
| scale | ~10^15 operations per reply | estimate | Kaplan 2N × hypothetical size × reply length |
