# Changelog

## 0.1.4

- Open Git-modified text files on a line-numbered unified diff that shows
  additions and deletions.
- Add a `Changes` / `Code` switch so the full syntax-highlighted file remains
  one click away.

## 0.1.3

- Fix `FileRenderer.processFileResult: Line doesnt exist` for text files that
  end with a newline by normalizing only the syntax-preview copy. Editing and
  saving still use the file's exact original contents.

## 0.1.2

- Remount the syntax-highlighting viewer for each file revision so an async
  result from the previous file cannot be applied to new contents.
- Contain source-renderer failures and fall back to a scrollable plain-text
  preview instead of crashing the whole Project Explorer panel.

## 0.1.1

- Add a proper draggable divider for the file tree, with a 160 px minimum,
  keyboard resizing, persisted width, and double-click reset.
- Preview common raster image formats directly in the panel.
- Render SVG and SVGZ files as images instead of treating them as binary.
- Stream images through bb's temporary root-confined preview route and cap
  previews at 25 MB.

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
