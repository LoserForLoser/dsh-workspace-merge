# dsh-workspace-merge

One DSH session, several project roots.

A DSH session is rooted at exactly one working directory — that directory is the
sandbox boundary, the workspace key, and the base for every relative path. That
default is right almost always, but it makes a very common layout awkward: the PC
and mobile clients of one product, an iOS and a HarmonyOS app that must stay in
step, a shared library and its consumers. They live in sibling directories, and
"change the same file in both places" degenerates into absolute paths and
repeated calls that quietly drift apart.

This bundle adds a named **workspace group** — an ordered set of local project
roots — and eight `ws_*` tools that treat one relative path across every root of
the group as a single operation, with a per-root outcome instead of one opaque
failure.

```
            one call: ws_edit src/components/AmountInput.vue
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
  [pc]  ecam-ui           [mobile] ecam-mobile     [shared] lib-ui
  changed · 1 replacement changed · 1 replacement  not-found
```

## Install

```bash
dsh plugin add dsh-workspace-merge
```

Or add it to a profile by hand: install the package under `$DSH_HOME/profiles/web`
and list `dsh-workspace-merge` in `dsh.profile.bundles`.

## Configure

A group is a name plus roots. `id` is the short label every other tool uses;
`path` may be absolute or `~`-prefixed.

```jsonc
// ws_group_set {group:"ecam", description:"PC + mobile", roots:[
//   {id:"pc",     path:"~/Desktop/JLXY/ecam-ui"},
//   {id:"mobile", path:"~/Desktop/JLXY/ecam-mobile-ui"}
// ]}
```

That writes `$DSH_HOME/workspace-groups.json`:

```json
{
  "version": 1,
  "groups": {
    "ecam": {
      "description": "PC + mobile",
      "roots": [
        { "id": "pc", "path": "/Users/you/Desktop/JLXY/ecam-ui" },
        { "id": "mobile", "path": "/Users/you/Desktop/JLXY/ecam-mobile-ui" }
      ]
    }
  }
}
```

The file is plain JSON — hand-edit it if you prefer.

**Group selection.** A call may pass `group` explicitly. Otherwise the group
whose root contains the session directory wins (the longest matching root breaks
a tie between nested roots); with no match, a single defined group is
unambiguous, and any other count requires an explicit name.

## Tools

| Tool | Purpose |
| --- | --- |
| `ws_groups` | List groups, their root ids, and the active group for this session. |
| `ws_group_set` / `ws_group_remove` | Maintain the registry (project files are never touched). |
| `ws_ls` | List one relative directory across every root — locate the same component everywhere at once. |
| `ws_read` | Read the same relative path from every root and return each copy. |
| `ws_diff` | Line-diff the copies (first root is the baseline) before editing anything. |
| `ws_edit` | Apply ONE literal replacement to every root, per-root outcome. |
| `ws_write` | Write the SAME full content to every root — new shared file, or force copies back in sync. |

`ws_edit` follows the built-in `edit` rule: `old_string` must occur exactly once
unless `replace_all` is set. `ws_edit` and `ws_write` accept `dry_run` to preview,
and `roots: ["pc"]` to narrow a call to one project. Per-root statuses are
explicit — `changed` / `unchanged` / `not-found` / `ambiguous` / `missing` /
`invalid` / `denied` — so a partial application is visible, never silent.

## Sandbox behaviour

Every mutation resolves the session's `sandboxPolicy` first, and this bundle does
not widen it:

* `danger-full-access` — writes resolve unfenced, as everywhere else.
* `workspace-write` — each target is canonicalized (a missing file is re-anchored
  under its nearest existing ancestor, so a symlinked parent cannot smuggle the
  write out) and must fall inside the policy's writable roots.
* `read-only` — all mutations are refused.

A target outside the standing roots is refused with the official
`[sandbox: file access denied under … mode]` marker plus the escalation hint, and
can be retried once with `sandbox_permissions` + `justification`, exactly like the
built-in `write` and `edit` tools. The group registry itself (`ws_group_set`,
`ws_group_remove`) obeys the same policy — a read-only session cannot quietly
reconfigure groups.

## Notes and limits

* **A group is not a monorepo.** It changes where the `ws_*` tools point; it does
  not change the session's working directory, so the built-in `read` / `edit` /
  `write` / `bash` still resolve against the session root only. Use a group when
  one change must land in several projects in the same step.
* Writes go through the harness filesystem service (`ctx.fs`): the pre-write
  version is registered with the official `fs/observed` event, so the
  fs-observation policy issues `replaceIfVersion` rather than refusing the write
  as `FS_NOT_OBSERVED`, and other plugins can veto through `fs/write-intent`.
  When that service is not mounted, the plain `node:fs` path is used *after* the
  same policy decision — and the result says so (`via: node:fs (fs service
  failed: …)`) instead of hiding it, so an integration problem is visible rather
  than silent.
* `ws_ls` skips `.git` and `node_modules`, and caps output at 200 paths per root.
* `ws_diff` aligns lines up to 4000 per side; larger files get a size summary
  instead of a diff.

## Test

```bash
npm test
```

31 assertions over a throwaway DSH home and two throwaway roots: registration,
registry CRUD, group selection, read/diff/list, dry-run, per-root mutation
statuses, path-escape refusal, root-id validation, and the sandbox cases
(`danger-full-access`, `workspace-write` deny, `read-only` deny, registry-write
policy). The test links the harness's own `@deepseek-ai/dsh-tools` and
`@deepseek-ai/dsh-sandbox` from the DevEco/DSH install (see `node_modules`), so
`npm test` expects a local DSH installation.

The stub context reproduces two cordis rules that cost this bundle a real boot
each, and fails loudly if a future edit breaks them again:

* a service not declared in `inject` is not a readable property —
  `ctx.systemPrompt` **throws** rather than returning undefined, which takes the
  whole row (and every tool registered before the throw) down with it, silently;
  optional services must be read with `ctx.get(name)`;
* section placement is centrally allocated — `getSectionOrder()` returns
  undefined for a name the harness does not know, and a section with a
  non-finite order throws. This bundle uses the `TOOLS_SDK` placement with a
  numeric fallback.

### Diagnostics

`WSM_DEBUG=1` records the plugin's startup phases (module evaluated → apply →
tools service available → registration result) to stderr and
`<tmpdir>/dsh-workspace-merge-debug.log`. Use it when a row is in the composed
profile but its tools never appear in a session.

## License

MIT © 宋朝阳
