import type {
  MockedDiff,
  MockedDiffFileStatus,
} from "@/lib/mock/agent-sdk-output";

// File-list view of the post-session diff. Server component. Slice 3
// renders the file list only (no hunk-level patch); Slice 4 may add a
// hunk toggle that reads from `MockedDiffFile.patch`.
//
// 375px concern: long paths must ellipsise rather than scroll. The
// row uses `min-w-0` + the path span uses `truncate`. Counts stay
// `whitespace-nowrap` to keep the right column legible.

const MARKER: Record<MockedDiffFileStatus, string> = {
  added: "+",
  modified: "M",
  deleted: "−",
};

const MARKER_COLOR: Record<MockedDiffFileStatus, string> = {
  added: "var(--color-mint)",
  modified: "var(--color-amber)",
  deleted: "var(--color-coral)",
};

export function DiffPreview({ diff }: { diff: MockedDiff }) {
  const { files, totals } = diff;
  return (
    <section className="overflow-hidden rounded-md border border-border bg-card">
      <header className="flex items-center justify-between border-b border-border px-4 py-2 text-xs text-muted-foreground">
        <span>
          {totals.files_changed} file
          {totals.files_changed === 1 ? "" : "s"} changed
        </span>
        <span className="font-mono">
          <span style={{ color: "var(--color-mint)" }}>+{totals.additions}</span>{" "}
          <span style={{ color: "var(--color-coral)" }}>−{totals.deletions}</span>
        </span>
      </header>
      <ul className="divide-y divide-border">
        {files.map((file) => (
          <li
            key={file.path}
            className="flex min-w-0 items-center gap-3 px-3 py-2"
          >
            <span
              aria-label={`${file.status}:`}
              className="w-3 shrink-0 text-center font-mono text-xs"
              style={{ color: MARKER_COLOR[file.status] }}
            >
              {MARKER[file.status]}
            </span>
            <span className="truncate font-mono text-sm">{file.path}</span>
            <span className="ml-auto whitespace-nowrap font-mono text-xs text-muted-foreground">
              <span style={{ color: "var(--color-mint)" }}>+{file.additions}</span>{" "}
              <span style={{ color: "var(--color-coral)" }}>−{file.deletions}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
