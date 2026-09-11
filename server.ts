// bb-plugin-project-explorer — backend entry.
//
// Six RPC methods back a VS Code-style file tree in the thread right panel:
//
//   explorer_root   thread -> { hostId, rootPath, environmentId, git info }
//   explorer_list   ONE directory (never recursive) so a repo with
//                   node_modules costs the same as an empty one
//   explorer_git    working-tree status, keyed by workspace-relative path
//   explorer_read   file content + sha256 (the CAS token for a later save)
//   explorer_preview temporary root-confined URL for an image file
//   explorer_write  compare-and-swap save; a stale sha reports "conflict"
//
// Every path crossing the wire is confined beneath the environment's
// workspace root before it reaches the host.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract } from "./contract.js";

/** Git porcelain codes bb reports for a working-tree file. */
const gitStatusSchema = z.enum(["?", "??", "A", "C", "D", "M", "R", "U"]);
export type GitStatus = z.infer<typeof gitStatusSchema>;

const entrySchema = z.object({
  name: z.string(),
  /** Absolute path on the host. */
  path: z.string(),
  /** Path relative to the workspace root — the key git status uses. */
  relativePath: z.string(),
  kind: z.enum(["directory", "file"]),
});
export type Entry = z.infer<typeof entrySchema>;

const rootSchema = z.object({
  hostId: z.string(),
  rootPath: z.string(),
  environmentId: z.string(),
  isGitRepo: z.boolean(),
  branch: z.string().nullable(),
});

/** Refuse to open anything that would stall the panel or render as mojibake. */
const MAX_EDITABLE_BYTES = 2 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 25 * 1024 * 1024;
const PREVIEWABLE_IMAGE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "svgz",
  "webp",
]);

export const rpcContract = defineRpcContract({
  explorer_root: {
    input: z.object({ threadId: z.string() }),
    output: rootSchema,
  },
  explorer_list: {
    input: z.object({
      hostId: z.string(),
      rootPath: z.string(),
      /** Absolute directory to list; defaults to the root itself. */
      path: z.string().optional(),
    }),
    output: z.object({ entries: z.array(entrySchema) }),
  },
  explorer_git: {
    input: z.object({ environmentId: z.string() }),
    output: z.object({
      available: z.boolean(),
      branch: z.string().nullable(),
      files: z.array(
        z.object({ path: z.string(), status: gitStatusSchema }),
      ),
    }),
  },
  explorer_read: {
    input: z.object({
      hostId: z.string(),
      rootPath: z.string(),
      path: z.string(),
    }),
    output: z.discriminatedUnion("outcome", [
      z.object({
        outcome: z.literal("ok"),
        content: z.string(),
        sha256: z.string(),
        sizeBytes: z.number(),
      }),
      z.object({
        outcome: z.literal("too_large"),
        sizeBytes: z.number(),
      }),
      z.object({
        outcome: z.literal("binary"),
        sizeBytes: z.number(),
      }),
    ]),
  },
  explorer_preview: {
    input: z.object({
      hostId: z.string(),
      rootPath: z.string(),
      path: z.string(),
    }),
    output: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("ok"), url: z.string() }),
      z.object({ outcome: z.literal("too_large"), sizeBytes: z.number() }),
    ]),
  },
  explorer_write: {
    input: z.object({
      hostId: z.string(),
      rootPath: z.string(),
      path: z.string(),
      content: z.string(),
      /** The sha256 from the read this edit started from. */
      expectedSha256: z.string(),
    }),
    output: z.discriminatedUnion("outcome", [
      z.object({
        outcome: z.literal("written"),
        sha256: z.string(),
        sizeBytes: z.number(),
      }),
      z.object({
        outcome: z.literal("conflict"),
        currentSha256: z.string().nullable(),
      }),
    ]),
  },
});

/** Realtime channel the panel listens on to refresh git colors after a save. */
const TREE_CHANGED = "tree-changed";

/**
 * True when `candidate` is the root itself or sits beneath it. Guards against
 * a frontend that sends `..` segments or an unrelated absolute path; the host
 * enforces `rootPath` on write, but read and list need the same rule.
 */
function isInsideRoot(root: string, candidate: string): boolean {
  const normalizedRoot = root.endsWith("/") ? root.slice(0, -1) : root;
  return (
    candidate === normalizedRoot ||
    candidate.startsWith(`${normalizedRoot}/`)
  );
}

/** Workspace-relative path, matching the keys git status reports. */
function toRelative(root: string, absolute: string): string {
  const normalizedRoot = root.endsWith("/") ? root.slice(0, -1) : root;
  if (absolute === normalizedRoot) return "";
  return absolute.startsWith(`${normalizedRoot}/`)
    ? absolute.slice(normalizedRoot.length + 1)
    : absolute;
}

function previewUrl(baseUrl: string, relativePath: string): string {
  const encodedPath = relativePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${baseUrl.replace(/\/$/u, "")}/${encodedPath}`;
}

function isPreviewableImage(path: string): boolean {
  const extension = path.split(".").pop()?.toLowerCase();
  return extension !== undefined && PREVIEWABLE_IMAGE_EXTENSIONS.has(extension);
}

/** NUL in the first block is the same heuristic git uses to call a file binary. */
function looksBinary(content: string): boolean {
  return content.slice(0, 8000).includes("\u0000");
}

/** Directories first, then files, each case-insensitively alphabetical. */
function compareEntries(a: Entry, b: Entry): number {
  if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  // Listing goes through our own host entry: the SDK's hosts.directory
  // hides dotfiles, and .claude / .env / .github belong in the tree.
  const host = bb.hosts.experimental_client({ contract: hostContract });

  const settings = bb.settings.define({
    hiddenFiles: {
      type: "boolean",
      label: "Show dotfiles",
      default: true,
    },
  });

  /** Resolves a thread to the workspace its files live in. */
  async function resolveRoot(threadId: string) {
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.environmentId === null) {
      throw new Error("This thread has no environment, so it has no files.");
    }
    const environment = await bb.sdk.environments.get({
      environmentId: thread.environmentId,
    });
    if (environment.path === null) {
      throw new Error("This thread's environment has no workspace path yet.");
    }
    return {
      hostId: environment.hostId,
      rootPath: environment.path,
      environmentId: environment.id,
      isGitRepo: environment.isGitRepo,
      branch: environment.branchName,
    };
  }

  bb.rpc.register(rpcContract, {
    explorer_root: ({ threadId }) => resolveRoot(threadId),

    // One directory per call. The tree expands lazily, so opening a repo
    // never walks node_modules — the cost is the directory you clicked.
    explorer_list: async ({ hostId, rootPath, path }) => {
      const target = path ?? rootPath;
      if (!isInsideRoot(rootPath, target)) {
        throw new Error("Path is outside the workspace root.");
      }
      const { hiddenFiles: showDotfiles } = await settings.get();
      const base = target.endsWith("/") ? target.slice(0, -1) : target;
      const listing = await host.call("listDirectory", { path: target }, { hostId });
      const entries = listing.entries
        .filter((entry) => showDotfiles || !entry.name.startsWith("."))
        // .git is bb's own bookkeeping and is never useful to browse.
        .filter((entry) => entry.name !== ".git")
        .map((entry) => {
          const absolute = `${base}/${entry.name}`;
          return {
            name: entry.name,
            path: absolute,
            relativePath: toRelative(rootPath, absolute),
            kind: entry.kind,
          };
        })
        .sort(compareEntries);
      return { entries };
    },

    explorer_git: async ({ environmentId }) => {
      const status = await bb.sdk.environments.status({ environmentId });
      if (status.outcome !== "available") {
        return { available: false, branch: null, files: [] };
      }
      const { workspace } = status;
      return {
        available: true,
        branch: workspace.branch.currentBranch,
        files: workspace.workingTree.files.map((file) => ({
          path: file.path,
          status: file.status,
        })),
      };
    },

    explorer_read: async ({ hostId, rootPath, path }) => {
      if (!isInsideRoot(rootPath, path)) {
        throw new Error("Path is outside the workspace root.");
      }
      const file = await bb.sdk.files.read({ hostId, path, rootPath });
      if (file.sizeBytes > MAX_EDITABLE_BYTES) {
        return { outcome: "too_large" as const, sizeBytes: file.sizeBytes };
      }
      if (file.contentEncoding === "base64" || looksBinary(file.content)) {
        return { outcome: "binary" as const, sizeBytes: file.sizeBytes };
      }
      return {
        outcome: "ok" as const,
        content: file.content,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
      };
    },

    // Preview tokens are created on demand instead of at panel startup. They
    // stream bytes from the owning host and keep absolute paths off the wire.
    explorer_preview: async ({ hostId, rootPath, path }) => {
      if (!isInsideRoot(rootPath, path)) {
        throw new Error("Path is outside the workspace root.");
      }
      if (!isPreviewableImage(path)) {
        throw new Error("This file type is not a supported image preview.");
      }
      const metadata = await host.call("statFile", { path }, { hostId });
      if (metadata.sizeBytes > MAX_PREVIEW_BYTES) {
        return {
          outcome: "too_large" as const,
          sizeBytes: metadata.sizeBytes,
        };
      }
      const relativePath = toRelative(rootPath, path);
      const preview = await bb.sdk.files.createPreview({
        hostId,
        rootPath,
        ttlMs: 60 * 60 * 1000,
      });
      return {
        outcome: "ok" as const,
        url: previewUrl(preview.baseUrl, relativePath),
      };
    },

    // expectedSha256 makes this a compare-and-swap: if the agent (or anything
    // else) touched the file since the read, the save reports a conflict
    // instead of silently overwriting that work.
    explorer_write: async ({
      hostId,
      rootPath,
      path,
      content,
      expectedSha256,
    }) => {
      if (!isInsideRoot(rootPath, path)) {
        throw new Error("Path is outside the workspace root.");
      }
      const saved = await bb.sdk.files.write({
        hostId,
        path,
        rootPath,
        content,
        expectedSha256,
      });
      if (saved.outcome === "conflict") {
        return {
          outcome: "conflict" as const,
          currentSha256: saved.currentSha256,
        };
      }
      bb.realtime.publish(TREE_CHANGED, { path });
      return {
        outcome: "written" as const,
        sha256: saved.sha256,
        sizeBytes: saved.sizeBytes,
      };
    },
  });

  // `bb project-explorer ls <path>` — the same listing the tree renders.
  bb.cli.register({
    name: "project-explorer",
    summary: "Inspect the workspace listing Project Explorer renders",
    commands: [
      {
        name: "ls",
        summary: "List one directory on a host",
        usage: "bb project-explorer ls <absolute-path> [--json]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const [command, ...args] = argv.filter((arg) => arg !== "--json");
      const target = args[0];
      if (command !== "ls" || target === undefined) {
        return {
          exitCode: 1,
          stderr: "Usage: bb project-explorer ls <absolute-path> [--json]",
        };
      }
      const hosts = await bb.sdk.hosts.list();
      const hostId = hosts[0]?.id;
      if (hostId === undefined) {
        return { exitCode: 1, stderr: "No host available." };
      }
      const listing = await host.call("listDirectory", { path: target }, { hostId });
      if (json) return { exitCode: 0, stdout: JSON.stringify(listing) };
      const lines = listing.entries.map(
        (entry) => `${entry.kind === "directory" ? "d" : "-"} ${entry.name}`,
      );
      return {
        exitCode: 0,
        stdout: lines.length === 0 ? "(empty)" : lines.join("\n"),
      };
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
