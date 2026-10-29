// The story's spine: every chapter, which scene shows it, and the slice of real time it covers.
// Section ids in content/*.html must match these ids (tests/story.test.ts checks).
import type { SceneId } from "../scenes/scene";

export type Act = "intro" | "ping" | "claude" | "outro";

export interface ChapterDef {
  id: string;
  act: Act;
  scene: SceneId;
  /** Short name for the chapter rail. */
  title: string;
  /**
   * Real elapsed time (seconds since Enter) at the chapter's top and bottom edge. Act I counts from
   * the Enter key on `ping google.com`, Act II from the Enter key on the prompt. Null: no clock.
   */
  clock: [number, number] | null;
  /** Clock curve: time runs as p^ease through the window (1 = linear; >1 starts slow, for time-lapses). */
  clockEase?: number;
  /** What part of the system we're in, for the HUD. */
  where: string;
}

const ms = (x: number): number => x / 1000;

export const CHAPTERS: readonly ChapterDef[] = [
  { id: "intro", act: "intro", scene: "globe", title: "The question", clock: null, where: "" },

  // Act I: ping google.com. One illustrative run: a Linux laptop on Wi-Fi, fiber to the house,
  // a cold DNS cache, and Google's edge a few hundred kilometres away (about 12 ms round trip).
  { id: "enter", act: "ping", scene: "machine", title: "Enter", clock: [0, ms(6.2)], where: "keyboard → USB → CPU" },
  {
    id: "shell",
    act: "ping",
    scene: "machine",
    title: "To the shell",
    clock: [ms(6.2), ms(7.1)],
    where: "kernel → terminal → bash",
  },
  {
    id: "fork",
    act: "ping",
    scene: "machine",
    title: "A new process",
    clock: [ms(7.1), ms(8.9)],
    where: "bash → kernel → ping",
  },
  { id: "dns", act: "ping", scene: "globe", title: "Finding google.com", clock: [ms(8.9), ms(38.1)], where: "DNS" },
  {
    id: "packet",
    act: "ping",
    scene: "machine",
    title: "Building the packet",
    clock: [ms(38.1), ms(38.12)],
    where: "the kernel's network stack",
  },
  { id: "wifi", act: "ping", scene: "lan", title: "Into the air", clock: [ms(38.12), ms(38.38)], where: "Wi-Fi" },
  {
    id: "router",
    act: "ping",
    scene: "lan",
    title: "The router",
    clock: [ms(38.38), ms(39.8)],
    where: "NAT, then fiber",
  },
  {
    id: "internet",
    act: "ping",
    scene: "globe",
    title: "Across the internet",
    clock: [ms(39.8), ms(44.7)],
    where: "your ISP → Google's network",
  },
  {
    id: "google",
    act: "ping",
    scene: "edge",
    title: "Google answers",
    clock: [ms(44.7), ms(44.72)],
    where: "Google's edge",
  },
  {
    id: "return",
    act: "ping",
    scene: "globe",
    title: "The way back",
    clock: [ms(44.72), ms(49.86)],
    where: "the reverse path",
  },
  {
    id: "arrive",
    act: "ping",
    scene: "machine",
    title: "Back inside",
    clock: [ms(49.86), ms(49.92)],
    where: "NIC → kernel → ping",
  },
  {
    id: "print",
    act: "ping",
    scene: "machine",
    title: "64 bytes from",
    clock: [ms(49.92), ms(75)],
    where: "terminal → screen → you",
  },

  // Act II: claude. Same machine, same internet; then the part that's new.
  { id: "interlude", act: "claude", scene: "machine", title: "Now: claude", clock: null, where: "" },
  { id: "launch", act: "claude", scene: "machine", title: "claude starts", clock: null, where: "your terminal" },
  {
    id: "prompt",
    act: "claude",
    scene: "context",
    title: "Assembling the request",
    clock: [0, ms(4)],
    where: "Claude Code",
  },
  {
    id: "wire",
    act: "claude",
    scene: "globe",
    title: "Over the wire",
    clock: [ms(4), ms(70)],
    where: "DNS, TCP, TLS, HTTP",
  },
  {
    id: "frontdoor",
    act: "claude",
    scene: "edge",
    title: "The front door",
    clock: [ms(70), ms(85)],
    where: "Anthropic's API",
  },
  {
    id: "datacenter",
    act: "claude",
    scene: "datacenter",
    title: "A building full of chips",
    clock: [ms(85), ms(90)],
    where: "a datacenter",
  },
  {
    id: "prefill",
    act: "claude",
    scene: "model",
    title: "Reading the prompt",
    clock: [ms(90), ms(900)],
    where: "the model: prefill",
  },
  {
    id: "decode",
    act: "claude",
    scene: "model",
    title: "One token at a time",
    clock: [ms(900), 3],
    where: "the model: decode",
  },
  { id: "stream", act: "claude", scene: "globe", title: "Streaming back", clock: [3, 14], where: "server-sent events" },
  {
    id: "loop",
    act: "claude",
    scene: "loop",
    title: "The loop",
    clock: [14, 600],
    clockEase: 3,
    where: "the agent loop",
  },
  { id: "scale", act: "claude", scene: "globe", title: "Scale", clock: null, where: "" },

  { id: "outro", act: "outro", scene: "globe", title: "Round trip", clock: null, where: "" },
];

export function chapterIndex(id: string): number {
  return CHAPTERS.findIndex((c) => c.id === id);
}
