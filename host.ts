// Host entry — runs on the daemon that owns the workspace files.
//
// One job: list a single directory, dotfiles included. `fs.readdir` with
// `withFileTypes` is a single syscall-backed read of that directory, so the
// cost is the folder you clicked, never the tree beneath it.
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./contract.js";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    listDirectory: async ({ path }) => {
      const dirents = await readdir(path, { withFileTypes: true });
      const entries = await Promise.all(
        dirents.map(async (dirent) => {
          // A symlink reports neither isDirectory nor isFile, so resolve it
          // to whatever it points at. A broken link degrades to "file"
          // rather than failing the whole listing.
          let isDirectory = dirent.isDirectory();
          if (dirent.isSymbolicLink()) {
            try {
              isDirectory = (await stat(join(path, dirent.name))).isDirectory();
            } catch {
              isDirectory = false;
            }
          }
          return {
            name: dirent.name,
            kind: isDirectory ? ("directory" as const) : ("file" as const),
          };
        }),
      );
      return { entries };
    },
  },
});
