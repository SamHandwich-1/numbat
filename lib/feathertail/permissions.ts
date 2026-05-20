// lib/feathertail/permissions.ts — every field backed by an installed-.d.ts quote.
// See docs/sdk-audit-2026-05-16.md for the JSDoc and signatures.
//
// SHAPE FROZEN BY §0a-bis DECISION (Option B adapted — tool allowlist, no Bash,
// permissionMode: 'dontAsk'). DO NOT EDIT WITHOUT A NEW DECISIONS-LOG ENTRY.

import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";

export type PermissionConfig = {
  tools: string[];
  allowedTools: string[];
  disallowedTools: string[];
  permissionMode: PermissionMode;
};

export function getPermissionConfig(): PermissionConfig {
  return {
    // sdk.d.ts:1258–1267 — restricts the available tool surface to these six.
    // The model literally cannot emit Bash/WebFetch/WebSearch because they
    // don't exist in its toolset.
    tools: ["Read", "Edit", "Write", "MultiEdit", "Grep", "Glob"],

    // sdk.d.ts:1205–1211 — pre-approves these tools so they execute without
    // a permission prompt. Every tool reachable via `tools` above is also
    // in this list, so no prompt path exists for any reachable tool.
    allowedTools: ["Read", "Edit", "Write", "MultiEdit", "Grep", "Glob"],

    // sdk.d.ts:1226–1231 — trump-card denylist. "Cannot be used, even if they
    // would otherwise be allowed." Redundant against `tools` for the static
    // config but defence-in-depth against any settings-layer drift that
    // re-introduces Bash et al. at runtime.
    disallowedTools: ["Bash", "WebFetch", "WebSearch"],

    // sdk.d.ts:1521–1529 + 1862–1865 — 'dontAsk' = "Don't prompt for
    // permissions, deny if not pre-approved." Combined with `allowedTools`
    // above, the six file tools execute and anything else is silently
    // denied. No prompt path can hang the detached worker.
    permissionMode: "dontAsk",

    // NOT set:
    // - allowDangerouslySkipPermissions (would defeat the whole config).
    // - canUseTool callback (not needed; the static config is sufficient).
  };
}
