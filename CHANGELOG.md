# Changelog

## 0.1.0

First release.

- Project Explorer tab in the thread right panel: workspace file tree on the
  left, viewer and editor on the right.
- Git colouring from the environment's working tree, in VS Code's language:
  amber for modified, green for added or untracked, red for deleted, purple
  for an unmerged conflict. A collapsed folder inherits amber.
- Lazy per-directory listing through a `bb.host` entry, so a repository with
  `node_modules` opens as quickly as an empty one.
- Dotfiles are listed. BB's own directory endpoint hides them; the host entry
  reads the directory itself. `.git` stays hidden.
- Compare-and-swap saves: the SHA-256 from the read is sent back on write, so
  a concurrent change by an agent reports a conflict instead of being
  overwritten.
- `bb project-explorer ls <path>` lists any directory as the tree sees it.
