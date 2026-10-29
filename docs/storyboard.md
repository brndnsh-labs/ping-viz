# Storyboard

The plan both the prose (content/*.html) and the scenes (src/scenes/*.ts) follow. Each chapter is a
`<section>` with a fixed number of text cards; scenes key their animation to **beats** (card k's
centre is beat k, the section's edges are -0.5 and cards-0.5), so the picture and the text line up.
If you change a chapter's card count, change it here, in the content, and in the scene.

Story conventions: Linux laptop on Wi-Fi in a house in Asheville, NC; fiber ISP; cold DNS cache;
google.com = 172.253.124.113 (ys-in-f113.1e100.net), a Google front end near Atlanta; RTT 11.8 ms.
Act II: Claude Code (a Bun-compiled native binary), api.anthropic.com = 160.79.104.10 (AS399358,
reached through Cloudflare, AS13335; TLS ends at Cloudflare's edge). Facts and their sources: docs/fact-check.md.

## Look

- Ink-black stage; everything that matters emits light (HDR, bloom does the glow). Dark solid
  geometry (box fills, the globe) only to give structure and occlusion.
- Colour language (src/config.ts `C`, labels use `CSS`): user space amber, kernel cyan, hardware
  violet. Packet layers: data warm white, ICMP orange, IP blue, link magenta. A request heading out
  is amber (`C.out`), a reply coming home is mint (`C.back`). Act II's model output is coral
  (`C.claude`); context sections have their own colours (tools teal, system slate, memory wine,
  history blue, your prompt warm white, cached steel).
- Lines 1-2 px with a 4-6 px halo; packets are bright points with a pulse trail on their path.
- Labels are HTML (scene `labels()`): `name` for components, `note` for secondary, `mono` for
  addresses and values, `big` for an occasional caption in the scene. Keep them few and short;
  fade them in with the beat they belong to.
- Motion: scroll drives the story (deterministic functions of `beat`/`p`); wall time (`f.time`) only
  for ambient life (flows, twinkles, idle drift). Ease everything. Respect `f.reducedMotion`.
- Framing: desktop puts the subject right of the text column (the renderer shifts the lens; just
  frame the subject centred). Phones (`f.narrow`) put it above the text. Keep subjects compact
  enough to read at 390x844.

## Intro (globe) · 1 card
0. The question, and how to read the page (scroll is time; the clock is real elapsed time).

## Act I: ping google.com

### enter (machine) · 3 cards · 0 → 6.2 ms
0. The switch: Enter is pressed; the keyboard's microcontroller scans its key matrix about every
   millisecond, sees the row and column connect, debounces for a few ms.
1. USB: the keyboard can't speak first; the host controller polls it (every 1 to 8 ms). It answers
   with an 8-byte HID report: modifiers, a reserved byte, up to six keycodes (Enter is 0x28).
2. Interrupt: the USB host controller (xHCI) writes the report into memory and interrupts the CPU,
   which drops what it was doing to run the kernel's handler. Pull back to reveal the machine.

### shell (machine) · 3 cards · 6.2 → 7.1 ms
0. Kernel input: the HID driver turns the report into a key event (KEY_ENTER) on /dev/input/event*.
1. Compositor to terminal: the compositor (e.g. a Wayland compositor) reads it, knows which window
   has focus, sends it to the terminal emulator, which turns it into a carriage return byte and
   writes it to the pseudo-terminal (PTY).
2. bash: on the other side of the PTY, bash (readline) has been reading one byte at a time. "\r"
   means the line is done: `ping google.com`.

### fork (machine) · 3 cards · 7.1 → 8.9 ms
0. Parse and look up: two words; not a builtin, alias or function; bash searches PATH (and caches
   the hit): /usr/bin/ping.
1. fork: bash clones itself (clone(2)); the copy shares memory pages until either writes
   (copy-on-write). Parent and child.
2. exec: the child calls execve("/usr/bin/ping", ...); the kernel throws away its memory, maps the
   ELF, the dynamic linker loads shared libraries (libc and friends), main() runs. bash waits.

### dns (globe) · 4 cards · 8.9 → 38.1 ms
0. ping needs a number: getaddrinfo → /etc/nsswitch.conf → /etc/hosts (no) → systemd-resolved
   (127.0.0.53, cache miss) → the ISP's recursive resolver.
1. The root: cold cache, so the resolver asks a root server: 13 names (a to m), about 2,000
   instances, anycast, so the nearest copy answers. Answer: try the .com servers.
2. .com: a .com server (Verisign): ask ns1.google.com (with its address attached).
3. Google's nameserver: google.com A 172.253.124.113, TTL 300; Google chose a front end near the
   resolver. Back home; ping prints `PING google.com (172.253.124.113) 56(84) bytes of data.`

### packet (machine) · 4 cards · 38.1 → 38.12 ms
0. A socket: ping opened an unprivileged ICMP "ping socket"; it builds 8 bytes of ICMP header and
   56 bytes of data and calls sendto(): into the kernel.
1. ICMP + IP: the kernel sets the ICMP identifier and checksum, then wraps it in a 20-byte IPv4
   header (TTL 64, protocol 1). The routing table: not local, so via the default gateway 192.168.1.1.
2. The next hop's MAC: the neighbour (ARP) table already knows the router's hardware address; a
   14-byte Ethernet header goes on. 98 bytes. (Hexdump in the text.)
3. Out: queueing discipline, Wi-Fi driver, DMA into the NIC's ring buffer, out of the machine.

### wifi (lan) · 3 cards · 38.12 → 38.38 ms
0. A Wi-Fi frame: the driver swaps the Ethernet header for an 802.11 one (three addresses,
   LLC/SNAP) and the card encrypts the payload (WPA2/3: AES).
1. Waiting its turn: one radio channel shared by every device; listen, wait a random backoff, then
   talk (CSMA/CA). The phone goes first this time.
2. On the air: bits become QAM symbols on hundreds of OFDM subcarriers; tens of microseconds; the
   router acknowledges.

### router (lan) · 3 cards · 38.38 → 39.8 ms
0. Unwrap and route: decrypt, strip the Wi-Fi header, not for the house's network, so out the WAN.
1. NAT: source 192.168.1.23 becomes 203.0.113.7 (the house's one public address); the router
   remembers (ICMP id 23582); TTL 64 → 63; checksum redone.
2. Light: to the ONT, converted to light; the passive optical network gives the house a time slot
   upstream; pulses bounce down the glass.

### internet (globe) · 3 cards · 39.8 → 44.7 ms
0. The ISP's network: the house → Asheville hub → the core in Charlotte. Every router: longest
   prefix match in hardware, TTL minus one, forward. Light covers about 200 km per millisecond.
1. BGP: Google (AS15169) announces the block holding 172.253.124.113; the ISP's routers know where
   to hand it over: Atlanta.
2. Into Google's network: private fiber to the front end that owns the address.

### google (edge) · 3 cards · 44.7 → 44.72 ms
0. The edge: Google's routers spread traffic over many equal-cost paths by hashing addresses (ECMP).
1. Load balancers and front ends: Maglev, Google's software load balancer, spreads connections
   across front ends (for web traffic; Google doesn't say what answers ICMP); a machine answering
   for the address replies.
2. The reply: type 8 becomes 0, source and destination swap, the rest is echoed, checksum redone,
   sent back (mint from here on).

### return (globe) · 2 cards · 44.72 → 49.86 ms
0. Back the way it came, or not: the return path can differ (here via Greenville).
1. Home: down the fiber, the router reverses its NAT (id 23582 → 192.168.1.23), Wi-Fi to the laptop.

### arrive (machine) · 3 cards · 49.86 → 49.92 ms
0. The NIC: receives, decrypts, DMAs the frame into memory, raises an interrupt (then NAPI polls).
1. Up the stack: Ethernet → IP (for me? checksum fine) → ICMP echo reply id 23582 → that socket.
2. Wake up, ping: asleep in recvmsg() (blocking, with a receive timeout); the scheduler wakes it;
   RTT = receive time − send time: 11.8 ms.

### print (machine) · 4 cards · 49.92 → 75 ms
0. Printing: one more DNS question first (reverse lookup: 172.253.124.113 → ys-in-f113.1e100.net;
   `-n` skips it), then printf → write() → the PTY → the terminal emulator.
1. The terminal draws: parse bytes, lay out glyphs from a font atlas, render on the GPU, hand the
   frame to the compositor.
2. The screen: compositor → display controller scans the frame out on the next refresh (up to
   16.7 ms at 60 Hz), top to bottom; pixels change.
3. You: light crosses half a metre in under 2 ns; noticing it takes you ~200 ms. Then ping sleeps a
   second and sends icmp_seq=2.

## Act II: claude

### interlude (machine) · 1 card
0. Same laptop, same internet. Type `claude` instead.

### launch (machine) · 3 cards · no clock
0. One binary: bash forks and execs again (Act I's chapter, unchanged): a single ~290 MB executable,
   Claude Code compiled with Bun (a JavaScript runtime included).
1. Your setup: settings, CLAUDE.md files, memory, skills; MCP servers start as child processes
   (or remote connections).
2. Raw mode: keys arrive one at a time; the UI is React rendered to text (Ink); you type, Enter.

### prompt (context) · 4 cards · 0 → 4 ms
0. What gets sent: one JSON request: model, system prompt, tools, messages, settings, stream: true.
1. Before your words: the system prompt and the tool definitions (JSON Schemas), CLAUDE.md,
   environment: tens of thousands of tokens. MCP tools go in as names (deferred). The wall stacks
   them in request order (Claude Code prompt-caching docs): tools, system prompt, CLAUDE.md and
   memory, then the conversation, which opens with the environment (directory, platform, git
   status) and the skills list, then your words.
2. Your message: the thin layer on top; often around 1% of the first request.
3. Reusable: most of the request matches a recent one (same tools, system prompt, project files;
   later turns the whole conversation). A cache breakpoint marks the end of the match; the API keeps
   its work 5 minutes, or 1 hour (Claude Code asks for the hour on a subscription).

### wire (globe) · 3 cards · 4 → 70 ms
0. DNS (cached) → 160.79.104.10, Anthropic's block (AS399358) reached via Cloudflare; TCP and TLS 1.3 handshakes
   unless a connection is already open.
1. The body: ~100 KB in ~70 TCP segments; slow start (about 14 KB in the first round trip, doubling).
   An HTTPS POST /v1/messages, stream: true.
2. Every one of those packets is built like Act I's (IP header, then TCP instead of ICMP, then
   encrypted bytes); routers read only the headers. Arrival at the front door.

### frontdoor (edge) · 3 cards · 70 → 85 ms
0. Cloudflare's edge, near you: TLS ends; the request goes on toward Anthropic's servers.
1. Who's asking: API key or OAuth token; limits (per minute for API keys, 5-hour and weekly for
   subscriptions); usage.
2. Where to run it: a deployment of the model with room; maybe a short queue.

### datacenter (datacenter) · 4 cards · 85 → 90 ms
0. One chip: a big die surrounded by stacks of high-bandwidth memory; inside, grids of
   multiply-accumulate units.
1. A server: a few chips joined by fast links.
2. Racks and halls: the model's weights don't fit on one chip; they're split across many, which
   work as one.
3. A campus: hundreds of thousands of chips, gigawatt-scale power. Anthropic runs Claude on TPUs,
   Trainium and GPUs (up to 1M TPUs, Anthropic; Project Rainier ~500k Trainium2, Amazon).

### prefill (model) · 3 cards · 90 → 900 ms
0. Tokens in: text → tokens → vectors.
1. Every layer, all at once: the whole prompt moves up through dozens of layers together;
   attention lets each token look back at the ones before it; it's matrix multiplication.
2. Mostly from cache: the cached prefix's keys and values are loaded, not recomputed; only the new
   part runs. The first token is ready.

### decode (model) · 4 cards · 0.9 → 3 s
0. One token: a probability for every token in the vocabulary; one is picked.
1. Again: that token goes back in; one full pass per token; attention reads the whole context.
2. Not alone: every step, the chips work on many conversations at once (batching).
3. Thinking, then answering: first thinking tokens, then the reply, dozens of tokens per second. Only the
   reply's tokens travel home (the API omits the thinking text, or summarizes it).

### stream (globe) · 3 cards · 3 → 14 s
0. Server-sent events back over the same connection: content_block_delta, text_delta.
1. `event: ping`: the stream has its own pings (keepalives).
2. Claude Code renders the markdown as it arrives.

### loop (loop) · 4 cards · 14 → 600 s
0. Not done: the reply ends in a tool_use block (Bash: `ping -c 1 google.com`), stop_reason "tool_use".
1. Your machine does that part: permission check, run it (Act I minus keyboard and screen: the round trip is ~12 ms), capture.
2. Back again: tool_result appended, the whole conversation sent again (cached), the model goes on.
3. Many laps: dozens to hundreds per task; context grows, compacts; subagents run their own loops.

### scale (globe) · 2 cards
0. Everyone else: at the same moment, requests from everywhere.
1. The comparison table.

## Outro (globe) · 2 cards
0. Round trip.
1. Notes and sources.
