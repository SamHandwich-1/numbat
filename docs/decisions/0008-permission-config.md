> File: docs/decisions/0008-permission-config.md

## Agent SDK permission config — frozen at `tools` + `allowedTools` + `disallowedTools` + `permissionMode: 'dontAsk'`

> **Date:** 21 May 2026.
> **Type:** security / API-contract decision.
> **Subject:** The shape of `lib/feathertail/permissions.ts` — the per-session permission config passed to every `@anthropic-ai/claude-agent-sdk` `query()` call. Records the §0a-bis material drift catch on `allowedTools` semantics, the four-field adapted-Option-B config that resulted, the per-field `.d.ts` evidence backing each field, and the explicit choice of `permissionMode: 'dontAsk'` over `'acceptEdits'`.

---

### 1 · The catch

The Slice 4 plan ([`docs/sdk-audit-2026-05-16.md`](../sdk-audit-2026-05-16.md) checkpoint (f)) called for restricting the model's tool surface to six file tools (`Read`, `Edit`, `Write`, `MultiEdit`, `Grep`, `Glob`) by passing them as `allowedTools` to `query()`. The plan assumed `allowedTools` was the surface-restriction allowlist.

The installed `@anthropic-ai/claude-agent-sdk@0.3.143` `.d.ts` says otherwise. The JSDoc on `allowedTools` (sdk.d.ts:1204–1211) is unambiguous:

> List of tool names that are auto-allowed without prompting for permission. These tools will execute automatically without asking the user for approval.
> **To restrict which tools are available, use the `tools` option instead.**

`allowedTools` is the **auto-approval** list — it skips the permission prompt for the named tools. The actual surface-restriction mechanism is the separate `tools` field. Two fields with similar names, very different semantics. The plan's name-based inference was wrong, and the failure mode of that wrongness would have been a worker shipping with `Bash` reachable from the model's menu (because the default tool set is "all of Claude Code's built-ins" and `allowedTools` doesn't subtract from that set — it only pre-approves a subset).

The §0a-bis pre-flight gate caught this. Exit condition (iii) of the gate — *"allowlist mechanism EXISTS but in a materially different form than the plan assumed (e.g. a per-call `canUseTool` callback instead of a static `allowedTools` array, or different tool-name strings, or a `permissions.allow` shape that differs in structure) → STOP and report. Operator confirms the adapted approach before proceeding"* — fired exactly as designed, and the slice paused for an explicit operator approval of the adapted four-field config before any code was written against the wrong shape. The full per-checkpoint audit, with `.d.ts` line numbers and JSDoc citations, is in [`docs/sdk-audit-2026-05-16.md`](../sdk-audit-2026-05-16.md).

---

### 2 · The verification round — verbatim `.d.ts` for each field

Each of the four fields in the final permission config is quoted from the installed `.d.ts` below, followed by a one-sentence operator-readable gloss. The point of this section is to keep the field semantics auditable from inside this doc — future readers should not have to re-derive intent from the SDK source.

#### `tools` (sdk.d.ts:1258–1267)

```typescript
/**
 * Specify the base set of available built-in tools.
 * - `string[]` - Array of specific tool names (e.g., `['Bash', 'Read', 'Edit']`)
 * - `[]` (empty array) - Disable all built-in tools
 * - `{ type: 'preset'; preset: 'claude_code' }` - Use all default Claude Code tools
 */
tools?: string[] | {
    type: 'preset';
    preset: 'claude_code';
};
```

**Gloss.** This is the **surface-restriction** allowlist. The model cannot emit a tool that isn't in this array — those tools literally don't exist on its menu. We pass the six file tools; `Bash`, `WebFetch`, `WebSearch`, and any other Claude Code default are not on the model's menu at all.

#### `allowedTools` (sdk.d.ts:1204–1211)

```typescript
/**
 * List of tool names that are auto-allowed without prompting for permission.
 * These tools will execute automatically without asking the user for approval.
 * To restrict which tools are available, use the `tools` option instead.
 *
 * Note: passing `'Skill'` here is deprecated — use the `skills` option instead.
 */
allowedTools?: string[];
```

**Gloss.** This is the **auto-approval** list — tools listed here skip the permission prompt entirely and execute immediately. Independent of which tools are *available* (controlled by `tools` above). We pass the same six file tools, so every tool the model can emit is also pre-approved — there is no prompt path for any reachable tool.

#### `disallowedTools` (sdk.d.ts:1226–1231)

```typescript
/**
 * List of tool names that are disallowed. These tools will be removed
 * from the model's context and cannot be used, even if they would
 * otherwise be allowed.
 */
disallowedTools?: string[];
```

**Gloss.** This is the **trump-card denylist** — *"cannot be used, even if they would otherwise be allowed."* The "even if otherwise allowed" clause is what makes it load-bearing: if any settings layer (managed / flag / local / project / user) re-introduces a denylisted tool at runtime, `disallowedTools` overrides. We pass `Bash`, `WebFetch`, `WebSearch` here — defence-in-depth against settings-layer drift that could re-add them.

#### `permissionMode` (field at sdk.d.ts:1521–1529, type at sdk.d.ts:1862–1865)

Field declaration JSDoc (sdk.d.ts:1521–1529):

```typescript
/**
 * Permission mode for the session.
 * - `'default'` - Standard permission behavior, prompts for dangerous operations
 * - `'acceptEdits'` - Auto-accept file edit operations
 * - `'bypassPermissions'` - Bypass all permission checks (requires `allowDangerouslySkipPermissions`)
 * - `'plan'` - Planning mode, no execution of tools
 * - `'dontAsk'` - Don't prompt for permissions, deny if not pre-approved
 */
permissionMode?: PermissionMode;
```

Type declaration JSDoc (sdk.d.ts:1862–1865) — adds documentation for `'auto'` which the field declaration omits:

```typescript
/**
 * Permission mode for controlling how tool executions are handled.
 * 'default' - Standard behavior, prompts for dangerous operations.
 * 'acceptEdits' - Auto-accept file edit operations.
 * 'bypassPermissions' - Bypass all permission checks (requires allowDangerouslySkipPermissions).
 * 'plan' - Planning mode, no actual tool execution.
 * 'dontAsk' - Don't prompt for permissions, deny if not pre-approved.
 * 'auto' - Use a model classifier to approve/deny permission prompts.
 */
export declare type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';
```

**Gloss.** This is the **prompt policy** — what happens when a tool the model wants to use isn't pre-approved in `allowedTools`. We pass `'dontAsk'`, whose contract is *"deny if not pre-approved"* — no prompt path exists, so a detached worker (which has no stdin to answer a prompt) can never hang waiting for one. Section §4 covers why this specifically and not `'acceptEdits'`.

---

### 3 · The adopted shape

The current `lib/feathertail/permissions.ts`, verbatim:

```typescript
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
```

Four independent layers, all pointing at the same outcome — *reachable tools execute without prompting; everything else is silently denied*. Each layer carries its own `.d.ts` citation in the file as inline comment so the rationale is visible at the point of use.

The file's header comment block declares the shape frozen: *"SHAPE FROZEN BY §0a-bis DECISION (Option B adapted — tool allowlist, no Bash, permissionMode: 'dontAsk'). DO NOT EDIT WITHOUT A NEW DECISIONS-LOG ENTRY."* Any future change — adding a tool, changing the prompt policy, swapping in `canUseTool`, anything — requires a successor entry in this log that supersedes 0008. The point of the freeze is not that the config is perfect forever; it's that drift on this surface is the highest-impact silent failure mode in the codebase (it's what would have made the worker arbitrary-shell-capable), so changes need to be deliberate rather than incremental.

---

### 4 · `permissionMode: 'dontAsk'` over `'acceptEdits'`

This is the subtle one. Both modes are technically viable for the current config: with `tools` and `allowedTools` already aligned to the same six entries, every reachable tool is pre-approved by name, so the prompt-policy mode is only load-bearing against drift (a tool added to `tools` but forgotten in `allowedTools`, a settings layer re-introducing a tool at runtime). Either `'dontAsk'` or `'acceptEdits'` would behave correctly in steady state. The choice of `'dontAsk'` is about which mode's *contract* covers the failure modes we care about.

The `'dontAsk'` JSDoc says: *"Don't prompt for permissions, deny if not pre-approved."* That sentence covers every tool the model can emit — pre-approved tools execute, non-pre-approved tools are silently denied. Read-only, edit, anything: the contract is explicit and uniform.

The `'acceptEdits'` JSDoc says: *"Auto-accept file edit operations."* That sentence covers edit operations explicitly. It is **silent** on read-only operations (`Read`, `Grep`, `Glob`) and on anything that might leak in from a settings layer. To pick `'acceptEdits'` and trust it for `Read`/`Grep`/`Glob`, one has to infer that the default policy for unmentioned cases is no-prompt-because-they're-not-dangerous — a name-based inference about what the SDK implementer "must have meant" by silence.

That inferential move is the exact shape of the move that produced the original `allowedTools` mistake. The plan inferred from the field name `allowedTools` that the field was a surface allowlist; the JSDoc said otherwise. Here, picking `'acceptEdits'` would mean inferring from the modename and the absence-of-mention that read-only tools also won't prompt. Maybe they don't — but the contract doesn't say so, and the inferential gap is identical in shape to the one §0a was built to catch.

`'dontAsk'` is the §0a-bis-aware choice: prefer the option whose contract **explicitly covers** the cases we care about, not the option whose contract is silent on them. That's the rule worth preserving from this decision — it generalises beyond permission modes to every API surface where two modes look interchangeable in practice. **Pick the mode whose contract names your case; don't pick the mode whose contract leaves your case unstated and assume the default applies.**

---

### 6 · Calibration takeaway

The §0a-bis `allowedTools`-vs-`tools` catch and the `'dontAsk'`-over-`'acceptEdits'` choice are the same inferential failure mode at two different scales — a field name and a mode name, both inviting an inference about behaviour that the contract itself doesn't make. The rule generalises beyond permission modes to every API surface where two options look interchangeable: **pick the option whose contract explicitly names your case; don't pick the option whose contract is silent on your case and assume the default applies**. This is the third operationalised pattern from Slice 4, alongside *"read fresh DB state in catch blocks, not error strings"* (from the kill-race-invariant section of 0006) and *"at least one live manual run before close-out, after typecheck/lint/test pass"* (from 0006's productive-failure note). The three together describe a posture: trust contracts over inferences, trust observed state over thrown errors, trust live runs over green test suites.

---

### 7 · Cross-references

- [`docs/decisions/0006-slice-4-close-out.md`](0006-slice-4-close-out.md) — Slice 4 close-out, including the live trace where the §23 kill-race invariant fired in production (the security posture this config establishes is what makes the kill path's failure mode bounded — even if a kill races a tool call, the tool call can't reach `Bash`).
- [`docs/sdk-audit-2026-05-16.md`](../sdk-audit-2026-05-16.md) — full §0a checkpoint audit against `@anthropic-ai/claude-agent-sdk@0.3.143`. Section "Backing .d.ts evidence for the adapted config" carries the same field-by-field quotations as §2 above; section "Per-value analysis against our requirement" carries the per-`PermissionMode`-value table that backs §4's `'dontAsk'`-vs-`'acceptEdits'` choice.
- §0a-bis exit (iii) — the operator-gate procedure that caught the `allowedTools` material drift. Defined in the Slice 4 plan; the procedural pattern (type-audit gate upstream of code) is the load-bearing process artefact from this slice, recorded as a calibration takeaway in 0006.
- `lib/feathertail/permissions.ts` — the live config. The file's header comment block points back to this entry; any future change must add a successor entry to this log.
