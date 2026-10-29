import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/** Run a git command, output trimmed; git's own errors stay quiet (the caller falls back). */
function git(args: string): string {
  return execSync(`git ${args}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** The commit being built (short sha, `-dirty` with uncommitted changes), or "unknown" without git. */
function commit(): string {
  try {
    const sha = git("rev-parse --short HEAD");
    const dirty = git("status --porcelain") !== "";
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return "unknown";
  }
}

/** Stamps index.html with `<meta name="version">`, so the live site says which commit it is. */
function versionStamp(): Plugin {
  const version = commit();
  return {
    name: "version-stamp",
    transformIndexHtml: () => [{ tag: "meta", attrs: { name: "version", content: version }, injectTo: "head" }],
  };
}

const INCLUDE = /<!--\s*include:\s*([\w./-]+)\s*-->/g;

/**
 * The story's prose lives in content/*.html, one file per act, so it reads (and diffs) like a
 * document. `<!-- include: content/act1.html -->` in index.html is replaced with that file.
 */
function includes(): Plugin {
  const root = process.cwd();
  return {
    name: "html-includes",
    transformIndexHtml: {
      order: "pre",
      handler: (html) => html.replace(INCLUDE, (_m, file: string) => readFileSync(resolve(root, file), "utf8")),
    },
    handleHotUpdate: ({ file, server }) => {
      if (file.startsWith(resolve(root, "content"))) {
        server.ws.send({ type: "full-reload" });
        return [];
      }
    },
  };
}

export default defineConfig({
  plugins: [includes(), versionStamp()],
  build: { target: "es2022" },
  test: { include: ["tests/**/*.test.ts"] },
});
