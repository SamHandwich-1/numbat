// Smoke test for Option C: confirm that
// `node --import tsx/esm <this-file>` resolves TypeScript path aliases
// (`@/...`) defined in tsconfig.json's `paths`.
//
// If this script exits 0 with "ok" on stdout, the bare tsx loader hook
// resolves `@/lib/...` the same way the tsx CLI does — Option C is
// confirmed for the worker spawn. If it exits non-zero with a
// "Cannot find package '@/...'" or similar, C dies and we need a
// different approach (tsconfig-paths loader, etc.).

import { WorktreeDiff } from "@/lib/types/jsonb";

// Touch the import so it can't be tree-shaken / elided.
if (typeof WorktreeDiff.parse !== "function") {
  console.error("smoke: WorktreeDiff.parse not a function — alias resolved but shape wrong");
  process.exit(1);
}
console.log("ok");
