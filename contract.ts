// Runtime contract shared by server.ts and host.ts.
//
// The SDK's `hosts.directory` is bb's folder picker: it hides dotfiles, so
// .claude, .env and .github never reach the tree. This entry lists a single
// directory with fs.readdir instead — dotfiles included, still non-recursive,
// and still routed through the daemon so remote hosts work the same way.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const hostContract = defineRpcContract({
  listDirectory: {
    input: z.object({ path: z.string() }).strict(),
    output: z
      .object({
        entries: z.array(
          z.object({
            name: z.string(),
            kind: z.enum(["directory", "file"]),
          }),
        ),
      })
      .strict(),
  },
});
