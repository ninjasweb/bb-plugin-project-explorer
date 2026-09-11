# Project Explorer

A git-aware file tree and editor inside the bb thread right panel.

Open a thread, click **New tab** in the right panel, and pick **Project
Explorer**. The tab shows the thread environment's workspace: a file tree on
the left, a viewer/editor on the right.

## What it does

- **Lazy tree.** Directories load one level at a time, on expand.
- **Git colours**, following VS Code's language:
  - amber — modified (`M`), renamed (`R`), copied (`C`)
  - green — added (`A`) or untracked (`??`)
  - red, struck through — deleted (`D`)
  - purple — unmerged / conflict (`U`)
  - A collapsed folder inherits amber when anything beneath it changed.
- **View** with bb's own syntax highlighting and code theme.
  Files ending in a newline are normalized only for the preview to avoid a
  host renderer line-count mismatch; their editable contents stay unchanged.
  If the host highlighter cannot render a file, the panel keeps working and
  shows a plain-text preview instead.
- **Inspect changed lines.** Git-modified text files open on a unified diff
  with old/new line numbers and added/deleted lines. Switch between
  **Changes** and the complete **Code** view from the file header.
- **Preview images** including PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, and SVG.
- **Resize the file tree** by dragging its divider down to a 160 px minimum.
  The width is remembered; double-click the divider to reset it.
- **Edit** in place. `Cmd/Ctrl+S` saves, `Tab` inserts two spaces, `Esc`-free
  cancel restores the file.

## Why it stays fast

The panel is built so that opening a large repository costs the same as
opening a small one:

- The tree calls `hosts.directory`, which lists **one** directory. Nothing
  ever walks the repo, so `node_modules` is free until you click into it.
- Directory listings are cached per path in a ref for the life of the tab, so
  re-expanding a folder is instant and a cache write never re-renders.
- Collapsed folders unmount their children entirely — no hidden component
  tree, no retained memory.
- Git status is **one** call for the whole workspace, indexed into a `Map`
  once per refresh, not a call per file.
- Viewing reuses bb's `experimental_SourceCode`, and editing is a plain
  `textarea`. The plugin ships no editor engine and no highlighter, so the
  frontend bundle stays small.
- Images stream through bb's temporary, workspace-confined preview URLs instead
  of crossing the plugin RPC as base64.

## Safety

- Every path is confined beneath the environment's workspace root, on both
  read and list, before it reaches the host.
- Saves are compare-and-swap: the read's `sha256` is sent back as
  `expectedSha256`. If an agent (or anything else) changed the file
  meanwhile, the save reports a conflict instead of clobbering that work.
- Text files over 2 MB and binary files that are not supported images are
  refused rather than loaded into the editor. Image previews are capped at
  25 MB.

## Settings

**Show dotfiles** (default on) — include entries beginning with `.` in the
tree.

See [CHANGELOG.md](./CHANGELOG.md) for release notes.

## Development

```
npm install --include=dev
bb plugin build
bb plugin install .
bb plugin dev                                # rebuild + reload on save
```

Git colours need a thread whose environment is a git repository. In a
non-git workspace the tree still lists and edits files; it just renders
uncoloured.
