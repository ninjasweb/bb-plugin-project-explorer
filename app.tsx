// bb-plugin-project-explorer — frontend entry.
//
// Registers a "Project Explorer" action in the thread right panel's New tab
// list. The tab is a two-pane surface: a lazy file tree on the left, a viewer
// / editor on the right.
//
// Performance shape:
//   - The tree fetches ONE directory per expand. Nothing walks the repo, so
//     node_modules costs nothing until you actually click into it.
//   - Directory listings are cached per path for the life of the tab.
//   - Git status is one call for the whole workspace, refreshed on save and
//     on demand — not per file, and not on every render.
//   - Viewing uses bb's own SourceCode component (host-owned highlighting,
//     zero bundle cost). Editing swaps in a plain textarea, so the plugin
//     ships no editor engine.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  useRpc,
  experimental_SourceCode as SourceCode,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { Entry, GitStatus, rpcContract } from "./server";
import "./app.css";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

interface Root {
  hostId: string;
  rootPath: string;
  environmentId: string;
  isGitRepo: boolean;
  branch: string | null;
}

interface OpenTextFile {
  kind: "text";
  path: string;
  relativePath: string;
  name: string;
  content: string;
  sha256: string;
}

interface OpenImageFile {
  kind: "image";
  path: string;
  relativePath: string;
  name: string;
  url: string;
}

type OpenFile = OpenTextFile | OpenImageFile;

const IMAGE_EXTENSIONS = new Set([
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

const DEFAULT_SIDEBAR_WIDTH = 260;
const MIN_SIDEBAR_WIDTH = 160;
const MIN_CONTENT_WIDTH = 220;
const RESIZER_WIDTH = 5;
const SIDEBAR_STORAGE_KEY = "project-explorer.sidebar-width";

function isImagePath(path: string): boolean {
  const extension = path.split(".").pop()?.toLowerCase();
  return extension !== undefined && IMAGE_EXTENSIONS.has(extension);
}

function readStoredSidebarWidth(): number {
  try {
    const stored = Number(window.localStorage.getItem(SIDEBAR_STORAGE_KEY));
    return Number.isFinite(stored)
      ? Math.max(stored, MIN_SIDEBAR_WIDTH)
      : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

/**
 * VS Code's colour language, mapped to bb's theme tokens:
 * modified -> amber, new/untracked -> green, deleted -> red, conflict -> purple.
 */
const STATUS_CLASS: Record<GitStatus, string> = {
  M: "pe-status-modified",
  R: "pe-status-modified",
  C: "pe-status-modified",
  A: "pe-status-added",
  "?": "pe-status-added",
  "??": "pe-status-added",
  D: "pe-status-deleted",
  U: "pe-status-conflict",
};

const STATUS_BADGE: Record<GitStatus, string> = {
  M: "M",
  R: "R",
  C: "C",
  A: "A",
  "?": "U",
  "??": "U",
  D: "D",
  U: "!",
};

/**
 * A directory inherits a colour when anything beneath it changed, the same
 * way VS Code tints a collapsed folder. Built once per git refresh.
 */
function buildStatusIndex(
  files: { path: string; status: GitStatus }[],
): { exact: Map<string, GitStatus>; dirty: Set<string> } {
  const exact = new Map<string, GitStatus>();
  const dirty = new Set<string>();
  for (const file of files) {
    exact.set(file.path, file.status);
    const segments = file.path.split("/");
    segments.pop();
    let prefix = "";
    for (const segment of segments) {
      prefix = prefix === "" ? segment : `${prefix}/${segment}`;
      dirty.add(prefix);
    }
  }
  return { exact, dirty };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Chevron for directories; a dot keeps files aligned with their siblings. */
function Twisty({ open, visible }: { open: boolean; visible: boolean }) {
  if (!visible) return <span className="pe-twisty" aria-hidden="true" />;
  return (
    <span className="pe-twisty" aria-hidden="true">
      <svg viewBox="0 0 16 16" width="10" height="10">
        <path
          d={open ? "M3 6l5 5 5-5" : "M6 3l5 5-5 5"}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

interface TreeProps {
  rpc: Rpc;
  root: Root;
  /** Absolute directory this node lists. */
  path: string;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  cache: Map<string, Entry[]>;
  status: { exact: Map<string, GitStatus>; dirty: Set<string> };
  activePath: string | null;
  onOpenFile: (entry: Entry) => void;
}

/**
 * One directory level. Children mount only while expanded, so a collapsed
 * folder holds no component tree and costs no memory.
 */
function TreeLevel({
  rpc,
  root,
  path,
  depth,
  expanded,
  onToggle,
  cache,
  status,
  activePath,
  onOpenFile,
}: TreeProps) {
  const [entries, setEntries] = useState<Entry[] | null>(
    () => cache.get(path) ?? null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const cached = cache.get(path);
    if (cached !== undefined) {
      setEntries(cached);
      return;
    }
    let cancelled = false;
    void rpc
      .call("explorer_list", {
        hostId: root.hostId,
        rootPath: root.rootPath,
        path,
      })
      .then((result) => {
        if (cancelled) return;
        cache.set(path, result.entries);
        setEntries(result.entries);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, root.hostId, root.rootPath, path, cache]);

  if (error !== null) {
    return (
      <div className="pe-tree-message pe-tree-error" style={indent(depth)}>
        {error}
      </div>
    );
  }
  if (entries === null) {
    return (
      <div className="pe-tree-message" style={indent(depth)}>
        Loading…
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <div className="pe-tree-message" style={indent(depth)}>
        Empty
      </div>
    );
  }

  return (
    <>
      {entries.map((entry) => {
        const isDirectory = entry.kind === "directory";
        const isOpen = expanded.has(entry.path);
        const exact = status.exact.get(entry.relativePath);
        const inherited = isDirectory && status.dirty.has(entry.relativePath);
        const statusClass =
          exact !== undefined
            ? STATUS_CLASS[exact]
            : inherited
              ? "pe-status-modified"
              : "";

        return (
          <div key={entry.path}>
            <button
              type="button"
              className={`pe-row ${statusClass} ${
                activePath === entry.path ? "pe-row-active" : ""
              }`}
              style={indent(depth)}
              onClick={() =>
                isDirectory ? onToggle(entry.path) : onOpenFile(entry)
              }
              title={entry.relativePath}
            >
              <Twisty open={isOpen} visible={isDirectory} />
              <span className="pe-name">{entry.name}</span>
              {exact !== undefined ? (
                <span className="pe-badge">{STATUS_BADGE[exact]}</span>
              ) : null}
            </button>
            {isDirectory && isOpen ? (
              <TreeLevel
                rpc={rpc}
                root={root}
                path={entry.path}
                depth={depth + 1}
                expanded={expanded}
                onToggle={onToggle}
                cache={cache}
                status={status}
                activePath={activePath}
                onOpenFile={onOpenFile}
              />
            ) : null}
          </div>
        );
      })}
    </>
  );
}

function indent(depth: number): React.CSSProperties {
  return { paddingLeft: `${depth * 12 + 8}px` };
}

/** Viewer + editor for one file. */
function Editor({
  rpc,
  root,
  file,
  onSaved,
  onClose,
}: {
  rpc: Rpc;
  root: Root;
  file: OpenTextFile;
  onSaved: (sha256: string, content: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(file.content);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // A different file (or an external change we picked up) resets the draft.
  useEffect(() => {
    setDraft(file.content);
    setIsEditing(false);
  }, [file.path, file.content]);

  const isDirty = draft !== file.content;

  const save = useCallback(async () => {
    if (!isDirty || isSaving) return;
    setIsSaving(true);
    try {
      const result = await rpc.call("explorer_write", {
        hostId: root.hostId,
        rootPath: root.rootPath,
        path: file.path,
        content: draft,
        expectedSha256: file.sha256,
      });
      if (result.outcome === "conflict") {
        toast.error(
          result.currentSha256 === null
            ? `${file.name} was deleted on disk. Reopen it before saving.`
            : `${file.name} changed on disk since you opened it. Reopen it to merge.`,
        );
        return;
      }
      onSaved(result.sha256, draft);
      toast.success(`Saved ${file.name}`);
    } catch (cause: unknown) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsSaving(false);
    }
  }, [rpc, root, file, draft, isDirty, isSaving, onSaved]);

  // Closing an edited file confirms first, so a stray click cannot discard
  // work the user has not saved.
  const requestClose = useCallback(() => {
    if (isDirty && !window.confirm(`Discard unsaved changes to ${file.name}?`)) {
      return;
    }
    onClose();
  }, [isDirty, file.name, onClose]);

  // Cmd/Ctrl+S saves; Tab inserts a tab instead of leaving the textarea.
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "s") {
        event.preventDefault();
        void save();
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        const target = event.currentTarget;
        const { selectionStart, selectionEnd, value } = target;
        const next = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`;
        setDraft(next);
        requestAnimationFrame(() => {
          target.selectionStart = selectionStart + 2;
          target.selectionEnd = selectionStart + 2;
        });
      }
    },
    [save],
  );

  return (
    <div className="pe-editor">
      <div className="pe-editor-header">
        <span className="pe-editor-path" title={file.relativePath}>
          {file.relativePath}
        </span>
        {isDirty ? <span className="pe-dirty-dot" title="Unsaved" /> : null}
        <span className="pe-editor-spacer" />
        {isEditing ? (
          <>
            <button
              type="button"
              className="pe-button"
              onClick={() => {
                setDraft(file.content);
                setIsEditing(false);
              }}
              disabled={isSaving}
            >
              Cancel
            </button>
            <button
              type="button"
              className="pe-button pe-button-primary"
              onClick={() => void save()}
              disabled={!isDirty || isSaving}
            >
              {isSaving ? "Saving…" : "Save"}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="pe-button"
            onClick={() => {
              setIsEditing(true);
              requestAnimationFrame(() => textareaRef.current?.focus());
            }}
          >
            Edit
          </button>
        )}
        <button
          type="button"
          className="pe-icon-button pe-close"
          onClick={requestClose}
          title="Close file"
          aria-label="Close file"
        >
          <svg viewBox="0 0 16 16" width="11" height="11">
            <path
              d="M4 4l8 8M12 4l-8 8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
      <div className="pe-editor-body">
        {isEditing ? (
          <textarea
            ref={textareaRef}
            className="pe-textarea"
            value={draft}
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />
        ) : (
          <SourceCode content={file.content} path={file.path} />
        )}
      </div>
    </div>
  );
}

/** Lightweight browser-native preview for raster images and SVG files. */
function ImagePreview({
  file,
  onClose,
}: {
  file: OpenImageFile;
  onClose: () => void;
}) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [file.path]);

  return (
    <div className="pe-editor">
      <div className="pe-editor-header">
        <span className="pe-editor-path" title={file.relativePath}>
          {file.relativePath}
        </span>
        <span className="pe-editor-spacer" />
        <button
          type="button"
          className="pe-icon-button pe-close"
          onClick={onClose}
          title="Close file"
          aria-label="Close file"
        >
          <svg viewBox="0 0 16 16" width="11" height="11">
            <path
              d="M4 4l8 8M12 4l-8 8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
      <div className="pe-image-stage">
        {failed ? (
          <div className="pe-empty">
            {file.name} could not be rendered by this browser.
          </div>
        ) : (
          <img
            className="pe-image"
            src={file.url}
            alt={file.name}
            onError={() => setFailed(true)}
          />
        )}
      </div>
    </div>
  );
}

function ProjectExplorerPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [root, setRoot] = useState<Root | null>(null);
  const [rootError, setRootError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [gitFiles, setGitFiles] = useState<
    { path: string; status: GitStatus }[]
  >([]);
  const [branch, setBranch] = useState<string | null>(null);
  const [file, setFile] = useState<OpenFile | null>(null);
  const [fileNotice, setFileNotice] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(readStoredSidebarWidth);
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // Directory listings live for the life of the tab. A Map in a ref keeps
  // them out of React state so a cache write never triggers a render.
  const cacheRef = useRef<Map<string, Entry[]>>(new Map());

  useEffect(() => {
    let cancelled = false;
    void rpc
      .call("explorer_root", { threadId })
      .then((result) => {
        if (cancelled) return;
        setRoot(result);
        setBranch(result.branch);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setRootError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId]);

  const refreshGit = useCallback(
    async (environmentId: string) => {
      try {
        const result = await rpc.call("explorer_git", { environmentId });
        setGitFiles(result.files);
        if (result.branch !== null) setBranch(result.branch);
      } catch {
        // A non-git workspace is ordinary; the tree just renders uncoloured.
        setGitFiles([]);
      }
    },
    [rpc],
  );

  useEffect(() => {
    if (root === null || !root.isGitRepo) return;
    void refreshGit(root.environmentId);
  }, [root, refreshGit]);

  const status = useMemo(() => buildStatusIndex(gitFiles), [gitFiles]);

  const onToggle = useCallback((path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const onOpenFile = useCallback(
    async (entry: Entry) => {
      if (root === null) return;
      setFileNotice(null);
      try {
        if (isImagePath(entry.relativePath)) {
          const preview = await rpc.call("explorer_preview", {
            hostId: root.hostId,
            rootPath: root.rootPath,
            path: entry.path,
          });
          if (preview.outcome === "too_large") {
            setFile(null);
            setFileNotice(
              `${entry.name} is ${formatBytes(preview.sizeBytes)} — too large to preview here.`,
            );
            return;
          }
          setFile({
            kind: "image",
            path: entry.path,
            relativePath: entry.relativePath,
            name: entry.name,
            url: preview.url,
          });
          return;
        }
        const result = await rpc.call("explorer_read", {
          hostId: root.hostId,
          rootPath: root.rootPath,
          path: entry.path,
        });
        if (result.outcome === "too_large") {
          setFile(null);
          setFileNotice(
            `${entry.name} is ${formatBytes(result.sizeBytes)} — too large to open here.`,
          );
          return;
        }
        if (result.outcome === "binary") {
          setFile(null);
          setFileNotice(
            `${entry.name} is a binary file (${formatBytes(result.sizeBytes)}).`,
          );
          return;
        }
        setFile({
          kind: "text",
          path: entry.path,
          relativePath: entry.relativePath,
          name: entry.name,
          content: result.content,
          sha256: result.sha256,
        });
      } catch (cause: unknown) {
        setFileNotice(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [rpc, root],
  );

  const onSaved = useCallback(
    (sha256: string, content: string) => {
      setFile((current) =>
        current === null || current.kind !== "text"
          ? current
          : { ...current, sha256, content },
      );
      if (root !== null && root.isGitRepo) void refreshGit(root.environmentId);
    },
    [root, refreshGit],
  );

  const onRefresh = useCallback(() => {
    cacheRef.current.clear();
    setExpanded(new Set());
    if (root !== null && root.isGitRepo) void refreshGit(root.environmentId);
  }, [root, refreshGit]);

  const clampSidebarWidth = useCallback((width: number) => {
    const layoutWidth = layoutRef.current?.getBoundingClientRect().width;
    const maximum =
      layoutWidth === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(
            MIN_SIDEBAR_WIDTH,
            layoutWidth - MIN_CONTENT_WIDTH - RESIZER_WIDTH,
          );
    return Math.min(Math.max(width, MIN_SIDEBAR_WIDTH), maximum);
  }, []);

  useEffect(() => {
    const layout = layoutRef.current;
    if (layout === null) return;
    const clampToLayout = () => {
      setSidebarWidth((current) => clampSidebarWidth(current));
    };
    clampToLayout();
    const observer = new ResizeObserver(clampToLayout);
    observer.observe(layout);
    return () => observer.disconnect();
  }, [clampSidebarWidth]);

  const storeSidebarWidth = useCallback((width: number) => {
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(Math.round(width)));
    } catch {
      // Persistence is a convenience; resizing still works without storage.
    }
  }, []);

  const onResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      resizeRef.current = { startX: event.clientX, startWidth: sidebarWidth };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    [sidebarWidth],
  );

  const onResizePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const start = resizeRef.current;
      if (start === null) return;
      setSidebarWidth(
        clampSidebarWidth(start.startWidth + event.clientX - start.startX),
      );
    },
    [clampSidebarWidth],
  );

  const finishResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (resizeRef.current === null) return;
      resizeRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      setSidebarWidth((current) => {
        const width = clampSidebarWidth(current);
        storeSidebarWidth(width);
        return width;
      });
    },
    [clampSidebarWidth, storeSidebarWidth],
  );

  const onResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const direction = event.key === "ArrowLeft" ? -1 : 1;
      const step = event.shiftKey ? 40 : 10;
      setSidebarWidth((current) => {
        const width = clampSidebarWidth(current + direction * step);
        storeSidebarWidth(width);
        return width;
      });
    },
    [clampSidebarWidth, storeSidebarWidth],
  );

  if (rootError !== null) {
    return <div className="pe-empty">{rootError}</div>;
  }
  if (root === null) {
    return <div className="pe-empty">Loading workspace…</div>;
  }

  return (
    <div className="pe-layout" ref={layoutRef}>
      <div className="pe-sidebar" style={{ width: sidebarWidth }}>
        <div className="pe-sidebar-header">
          <span className="pe-branch" title={root.rootPath}>
            {branch ?? root.rootPath.split("/").pop()}
          </span>
          <button
            type="button"
            className="pe-icon-button"
            onClick={onRefresh}
            title="Refresh"
          >
            <svg viewBox="0 0 16 16" width="12" height="12">
              <path
                d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3h-3"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
        <div className="pe-tree">
          <TreeLevel
            rpc={rpc}
            root={root}
            path={root.rootPath}
            depth={0}
            expanded={expanded}
            onToggle={onToggle}
            cache={cacheRef.current}
            status={status}
            activePath={file?.path ?? null}
            onOpenFile={(entry) => void onOpenFile(entry)}
          />
        </div>
      </div>
      <div
        className="pe-resizer"
        role="separator"
        aria-label="Resize file explorer"
        aria-orientation="vertical"
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuenow={Math.round(sidebarWidth)}
        tabIndex={0}
        title="Drag to resize · Double-click to reset"
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onKeyDown={onResizeKeyDown}
        onDoubleClick={() => {
          const width = clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
          setSidebarWidth(width);
          storeSidebarWidth(width);
        }}
      />
      <div className="pe-content">
        {file !== null ? (
          file.kind === "image" ? (
            <ImagePreview file={file} onClose={() => setFile(null)} />
          ) : (
            <Editor
              rpc={rpc}
              root={root}
              file={file}
              onSaved={onSaved}
              onClose={() => setFile(null)}
            />
          )
        ) : (
          <div className="pe-empty">
            {fileNotice ?? "Select a file to view or edit."}
          </div>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "project-explorer",
    title: "Project Explorer",
    icon: "FolderTree",
    // "flush" hands the tab its full area: this surface owns its own
    // scrolling in two independent panes.
    layout: "flush",
    component: ({ threadId }) => <ProjectExplorerPanel threadId={threadId} />,
    run: ({ openPanel }) => {
      openPanel({ title: "Project Explorer" });
    },
  });
});
