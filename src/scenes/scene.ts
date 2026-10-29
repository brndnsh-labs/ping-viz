// The contract between the story and a 3D scene. A scene is a "set": it can serve several chapters
// (shots), and is told where the reader is; it answers with a camera pose, draw calls and labels.
import type { CameraPose } from "../render/camera";
import type { Gfx } from "../render/gfx";
import type { Vec3 } from "../util/math";

export type SceneId = "globe" | "machine" | "lan" | "edge" | "datacenter" | "model" | "context" | "loop";

export interface SceneFrame {
  /** The chapter being shown (always one whose `scene` is this scene). */
  chapter: string;
  /** Scroll progress through that chapter, 0..1. */
  p: number;
  /**
   * Progress in card units: the k-th text card's centre is at k, the chapter's top edge at -0.5 and
   * its bottom edge at (cards - 0.5). Key visual events to cards so text and picture line up.
   */
  beat: number;
  /** How many text cards the chapter has. */
  cards: number;
  /**
   * Position on this scene's own timeline: (index of the chapter among this scene's chapters) + p.
   * Camera keyframes on this axis stay continuous across consecutive chapters of the same scene.
   */
  local: number;
  /** Wall-clock seconds, for ambient motion that shouldn't depend on scrolling. */
  time: number;
  dt: number;
  /** 0..1 while crossfading with another scene. */
  weight: number;
  /** Canvas width / height. */
  aspect: number;
  /** Phone-portrait layout: text at the bottom, subject higher up. */
  narrow: boolean;
  /** What the reader is hovering in the text (e.g. a packet field id), if anything. */
  focus: string | null;
  reducedMotion: boolean;
}

export interface Label {
  /** Stable id (the DOM element is reused across frames). */
  id: string;
  pos: Vec3;
  text: string;
  /** name: component names; note: secondary; mono: addresses/values; big: titles in the scene. */
  kind?: "name" | "note" | "mono" | "big";
  align?: "left" | "center" | "right";
  /** Screen-space offset from the anchor in CSS px. */
  dx?: number;
  dy?: number;
  opacity?: number;
  /** CSS colour for the text (defaults by kind). */
  color?: string;
}

export interface Scene {
  readonly id: SceneId;
  /** Advance to this frame and return where the camera should be. */
  update(f: SceneFrame): CameraPose;
  /** Record draws into the scene pass (the camera is already bound at group 0). */
  draw(pass: GPURenderPassEncoder): void;
  /** Labels for this frame (after update). */
  labels(out: Label[]): void;
}

export type SceneFactory = (gfx: Gfx) => Scene;
