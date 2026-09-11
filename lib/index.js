/**
 * dsh-workspace-merge — one session, several project roots.
 *
 * A DSH session is rooted at exactly one working directory: the session cwd is
 * the sandbox boundary, the workspace registry keys off it, and every file tool
 * resolves relative paths against it. That is the right default, but it makes a
 * genuinely common layout awkward — PC and mobile clients of the same product,
 * an iOS and a HarmonyOS app that must stay in step, a shared library and its
 * consumers. They live in sibling directories, and "change the same file in both
 * places" degenerates into absolute paths and repeated calls.
 *
 * This bundle adds a named *workspace group*: an ordered set of local roots
 * (`~/.dsh/workspace-groups.json`). Eight `ws_*` tools then let one session read,
 * diff, and edit the SAME relative path across every root of a group, reporting
 * a per-root outcome instead of a single opaque failure.
 *
 * Writes are not a sandbox bypass. Every mutation resolves the session's
 * `sandboxPolicy`, and a target outside the standing writable roots is refused
 * with the official denial marker unless the caller escalates through the
 * official `sandbox_permissions` + `justification` path — exactly the contract
 * the built-in `write` and `edit` tools honour.
 *
 * @module dsh-workspace-merge
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
	approveEscalation,
	canonicalPath,
	escalationHintMarker,
	sandboxDenialMarker,
	validateEscalationArgs,
	writableRoots,
} from '@deepseek-ai/dsh-sandbox'

export const name = 'dsh-workspace-merge'

// Module top level: proves the row's module was actually imported.
debugMarker('module: evaluated')

/** Section order name for the conditional workspace-group prompt. */
const GROUP_SECTION = 'WORKSPACE_MERGE_GROUPS'

/** How deep `ws_ls` walks by default, and the hard cap. */
const DEFAULT_LS_DEPTH = 2
const MAX_LS_DEPTH = 6
/** Diff input cap: beyond this, line alignment is skipped for a cheap summary. */
const MAX_DIFF_LINES = 4000

// #region store

/** Resolve $DSH_HOME the way the harness does. */
export function resolveDshHome() {
	const fromEnv = process.env.DSH_HOME
	if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
	return join(homedir(), '.dsh')
}

/** The registry file holding every named group. */
export function defaultStorePath() {
	return join(resolveDshHome(), 'workspace-groups.json')
}

/** Expand `~` and make a root absolute; canonicalize when it exists. */
function normalizeRootPath(input) {
	let p = String(input ?? '').trim()
	if (p.startsWith('~')) p = join(homedir(), p.slice(1))
	if (!isAbsolute(p)) p = resolve(p)
	return existsSync(p) ? canonicalPath(p) : p
}

/** True when `child` is `parent` itself or lives beneath it. */
function containsPath(parent, child) {
	if (parent === child) return true
	const withSep = parent.endsWith(sep) ? parent : parent + sep
	return child.startsWith(withSep)
}

/** Normalize one stored group; returns undefined for an unusable entry. */
function normalizeGroup(raw) {
	if (raw === null || typeof raw !== 'object') return undefined
	const rawRoots = Array.isArray(raw.roots) ? raw.roots : []
	const roots = []
	for (const entry of rawRoots) {
		if (entry === null || typeof entry !== 'object') continue
		const path = normalizeRootPath(entry.path)
		if (path.length === 0) continue
		const id = typeof entry.id === 'string' && entry.id.length > 0
			? entry.id
			: `root${roots.length + 1}`
		if (roots.some((r) => r.path === path)) continue
		roots.push({
			id,
			path,
			...(typeof entry.label === 'string' ? { label: entry.label } : {}),
		})
	}
	if (roots.length === 0) return undefined
	return {
		...(typeof raw.description === 'string' ? { description: raw.description } : {}),
		roots,
	}
}

/**
 * The group registry: a JSON file of named root sets.
 *
 * Reads tolerate a missing or corrupt file (an empty registry) and writes are
 * atomic-enough for a single-process tool: the file is rewritten whole under a
 * temporary name and renamed into place.
 */
export class GroupStore {
	/**
	 * @param config - optional `{ storePath }` override for tests or a custom home.
	 */
	constructor(config = {}) {
		this.path = typeof config.storePath === 'string' && config.storePath.length > 0
			? config.storePath
			: defaultStorePath()
	}

	/** Every group, keyed by name, normalized on the way out. */
	read() {
		let parsed
		try {
			parsed = JSON.parse(readFileSync(this.path, 'utf8'))
		} catch {
			return {}
		}
		const rawGroups = parsed !== null && typeof parsed === 'object' && parsed.groups !== null
			&& typeof parsed.groups === 'object'
			? parsed.groups
			: {}
		const out = {}
		for (const [groupName, raw] of Object.entries(rawGroups)) {
			const group = normalizeGroup(raw)
			if (group !== undefined) out[groupName] = group
		}
		return out
	}

	/** Persist the whole registry. */
	write(groups) {
		mkdirSync(dirname(this.path), { recursive: true })
		const next = { version: 1, groups }
		writeFileSync(this.path, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
	}

	/** Create or replace one group; returns the stored, normalized group. */
	set(groupName, roots, description) {
		if (typeof groupName !== 'string' || groupName.trim().length === 0) {
			throw new Error('ws_group_set: `group` must be a non-empty name')
		}
		const name = groupName.trim()
		const group = normalizeGroup({ roots, ...(description !== undefined ? { description } : {}) })
		if (group === undefined) {
			throw new Error('ws_group_set: at least one root with a non-empty `path` is required')
		}
		const groups = this.read()
		groups[name] = group
		this.write(groups)
		return group
	}

	/** Remove one group; returns false when it did not exist. */
	remove(groupName) {
		const groups = this.read()
		if (!Object.prototype.hasOwnProperty.call(groups, groupName)) return false
		delete groups[groupName]
		this.write(groups)
		return true
	}

	/**
	 * Choose the group a call works on.
	 *
	 * An explicit name wins. Otherwise the session cwd is matched against every
	 * group's roots — a group that literally contains the session directory is
	 * almost always what the caller means, and the longest matching root breaks
	 * a tie between nested roots. With no match, a single group is unambiguous
	 * and any other number requires an explicit name.
	 *
	 * @param groupName - explicit group name, if the caller passed one.
	 * @param sessionCwd - the session working directory (the sandbox boundary).
	 */
	pick(groupName, sessionCwd) {
		const groups = this.read()
		const names = Object.keys(groups)
		if (names.length === 0) {
			throw new Error(`no workspace groups are defined (registry: ${this.path}); create one with ws_group_set`)
		}
		if (typeof groupName === 'string' && groupName.trim().length > 0) {
			const wanted = groupName.trim()
			if (!Object.prototype.hasOwnProperty.call(groups, wanted)) {
				throw new Error(`unknown workspace group "${wanted}"; defined: ${names.join(', ')}`)
			}
			return { name: wanted, group: groups[wanted] }
		}
		if (typeof sessionCwd === 'string' && sessionCwd.length > 0) {
			const cwd = canonicalPath(sessionCwd)
			let best
			let bestLength = -1
			for (const candidate of names) {
				for (const root of groups[candidate].roots) {
					if (!containsPath(root.path, cwd)) continue
					if (root.path.length > bestLength) {
						best = candidate
						bestLength = root.path.length
					}
				}
			}
			if (best !== undefined) return { name: best, group: groups[best] }
		}
		if (names.length === 1) return { name: names[0], group: groups[names[0]] }
		throw new Error(
			`the session directory matches no group and ${names.length} groups exist; pass \`group\` (defined: ${names.join(', ')})`,
		)
	}

	/**
	 * Reduce a group to the roots one call touches.
	 * @param group - a normalized group.
	 * @param rootIds - optional explicit subset of root ids.
	 */
	static selectRoots(group, rootIds) {
		if (!Array.isArray(rootIds) || rootIds.length === 0) return group.roots
		const wanted = new Set(rootIds.map((id) => String(id)))
		const selected = group.roots.filter((root) => wanted.has(root.id))
		const missing = [...wanted].filter((id) => !group.roots.some((root) => root.id === id))
		if (missing.length > 0) {
			throw new Error(`unknown root id(s): ${missing.join(', ')}; this group has: ${group.roots.map((r) => r.id).join(', ')}`)
		}
		return selected
	}
}

// #endregion store

// #region sandbox

/** The standing policy for this call, or undefined when nothing confines. */
function policyFor(ctx, exec) {
	const service = ctx.get('sandboxPolicy')
	if (service === undefined || typeof service.resolve !== 'function') return undefined
	try {
		return exec !== undefined && exec.agent !== undefined
			? service.resolve({ session: exec.agent.session })
			: service.resolve()
	} catch {
		return undefined
	}
}

/** Whether one absolute path may be written under `policy`. */
function writeAllowed(policy, absolutePath) {
	if (policy === undefined) return { allowed: true }
	if (policy.mode === 'danger-full-access') return { allowed: true }
	if (policy.mode === 'read-only') return { allowed: false }
	const target = canonicalPath(absolutePath)
	// A file that does not exist yet cannot be canonicalized; walk up to the
	// nearest existing ancestor and re-anchor the missing tail under its real
	// path, so a symlinked parent cannot smuggle the write out of the roots.
	let probe = target
	while (!existsSync(probe)) {
		const parent = dirname(probe)
		if (parent === probe) break
		probe = parent
	}
	let checked = target
	if (probe !== target) {
		const realProbe = canonicalPath(probe)
		checked = realProbe === probe ? target : join(realProbe, relative(probe, target))
	}
	return { allowed: writableRoots(policy).some((root) => containsPath(root, checked)) }
}

/**
 * Resolve the effective policy for a mutating call.
 *
 * With no `sandbox_permissions` this is the standing policy — no prompt, no
 * change. A requested escalation is judged by the official helper (a
 * non-widening request never prompts) and must be granted before anything runs;
 * a rejection or an unanswerable ask throws, exactly like the built-in tools.
 *
 * @returns the policy to enforce for this call.
 */
async function effectivePolicy(ctx, args, exec, toolName) {
	const standing = policyFor(ctx, exec)
	validateEscalationArgs(args.sandbox_permissions, args.justification)
	if (args.sandbox_permissions === undefined) return standing
	const outcome = await approveEscalation({
		requestedMode: args.sandbox_permissions,
		justification: args.justification,
		effectiveMode: standing === undefined ? 'workspace-write' : standing.mode,
		subject: 'operation',
	}, {
		approver: ctx.get('approval'),
		agent: exec === undefined ? undefined : exec.agent,
		callId: exec === undefined ? undefined : exec.callId,
		toolName,
		signal: exec === undefined ? undefined : exec.signal,
	})
	const granted = typeof outcome === 'string'
		? outcome
		: outcome !== null && typeof outcome === 'object'
			? outcome.mode ?? outcome.granted ?? outcome.effectiveMode
			: undefined
	return {
		mode: typeof granted === 'string' ? granted : args.sandbox_permissions,
		workspaceRoot: standing === undefined ? undefined : standing.workspaceRoot,
	}
}

/** The refusal text for one target, using the official markers. */
function denialText(policy, absolutePath) {
	const mode = policy === undefined ? 'workspace-write' : policy.mode
	return `${sandboxDenialMarker(mode)}\n${escalationHintMarker('operation')}\n`
		+ `Target: ${absolutePath}`
}

/**
 * Refuse a registry mutation the standing policy would not allow.
 *
 * The group registry is a real file write, so it obeys the same policy as a
 * project write rather than quietly stepping around a read-only session.
 *
 * @throws the official denial text when the registry file is out of reach.
 */
async function assertRegistryWritable(ctx, args, exec, toolName, registryPath) {
	const policy = await effectivePolicy(ctx, args, exec, toolName)
	if (writeAllowed(policy, registryPath).allowed) return
	throw new Error(denialText(policy, registryPath))
}

// #endregion sandbox

// #region filesystem

/** Read a UTF-8 file, or undefined when it does not exist. */
function readMaybe(absolutePath) {
	try {
		return readFileSync(absolutePath, 'utf8')
	} catch {
		return undefined
	}
}

/** Create parent directories and write UTF-8 content (node:fs path). */
function writePlain(absolutePath, content) {
	mkdirSync(dirname(absolutePath), { recursive: true })
	writeFileSync(absolutePath, content, 'utf8')
}

/**
 * Write one file, preferring the harness filesystem service.
 *
 * Delegating to `ctx.fs` keeps the harness's own file-observation bookkeeping in
 * step (so a later built-in `edit` does not see a stale version) and lets other
 * plugins veto through the `fs/write-intent` waterfall. When that service is not
 * mounted — or rejects the call for a shape this plugin cannot satisfy — the
 * plain node:fs path is used; the sandbox decision has already been made either
 * way, so the fallback is not a policy bypass.
 */
async function writeText(ctx, absolutePath, content, policy, exec) {
	const service = ctx.get('fs')
	if (service !== undefined && typeof service.resolve === 'function' && typeof service.writeText === 'function') {
		try {
			const target = await service.resolve(absolutePath)
			const signal = exec === undefined ? undefined : exec.signal
			// Register the observation the harness's fs-observation policy demands:
			// an unobserved existing file gets a `createIfAbsent` intent, which
			// refuses to clobber content the session never saw (FS_NOT_OBSERVED).
			// Recording the pre-write version through the official event turns that
			// into `replaceIfVersion` and keeps later built-in reads and edits in
			// step with what this tool actually did.
			if (typeof service.stat === 'function' && typeof ctx.emit === 'function' && existsSync(absolutePath)) {
				const info = await service.stat(target, signal)
				if (info !== undefined && info.version !== undefined) {
					ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
				}
			}
			const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)
			const outcome = await service.writeText(target, content, intent, signal, policy)
			if (typeof ctx.emit === 'function') {
				ctx.emit('fs/observed', target, {
					kind: 'present',
					version: outcome === undefined ? undefined : outcome.version,
				}, exec)
			}
			return { via: 'fs' }
		} catch (error) {
			// Reported, never swallowed: a silent fallback would hide exactly the
			// integration problem a caller needs to see.
			const reason = error instanceof Error ? error.message : String(error)
			debugMarker(`writeText: fs service failed for ${absolutePath} — ${describeError(error)}`)
			writePlain(absolutePath, content)
			return { via: `node:fs (fs service failed: ${reason})` }
		}
	}
	writePlain(absolutePath, content)
	return { via: 'node:fs' }
}

/** A bounded recursive listing of relative file paths under one root. */
function listRelative(rootPath, subPath, depth, pattern) {
	const out = []
	const start = subPath.length > 0 ? join(rootPath, subPath) : rootPath
	const walk = (dir, level) => {
		let entries
		try {
			entries = readdirSync(dir, { withFileTypes: true })
		} catch {
			return
		}
		for (const entry of entries) {
			if (entry.name === '.git' || entry.name === 'node_modules') continue
			const full = join(dir, entry.name)
			const rel = relative(rootPath, full)
			if (entry.isDirectory()) {
				if (level < depth) walk(full, level + 1)
				continue
			}
			if (pattern !== undefined && !rel.includes(pattern)) continue
			out.push(rel)
		}
	}
	walk(start, 0)
	return out.sort()
}

/** Join a caller-supplied relative path onto a root, refusing escapes. */
function resolveWithinRoot(rootPath, relativePath) {
	const clean = String(relativePath ?? '').replace(/^[/\\]+/, '')
	const full = resolve(rootPath, clean)
	if (!containsPath(rootPath, full) && full !== rootPath) {
		throw new Error(`path "${relativePath}" escapes root ${rootPath}`)
	}
	return full
}

// #endregion filesystem

// #region diff

/** Longest-common-subsequence line alignment, capped for large inputs. */
function lineDiff(before, after) {
	const a = before.split('\n')
	const b = after.split('\n')
	if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return undefined
	const n = a.length
	const m = b.length
	let prev = new Int32Array(m + 1)
	let curr = new Int32Array(m + 1)
	const table = []
	for (let i = n - 1; i >= 0; i -= 1) {
		curr = new Int32Array(m + 1)
		for (let j = m - 1; j >= 0; j -= 1) {
			curr[j] = a[i] === b[j] ? prev[j + 1] + 1 : Math.max(prev[j], curr[j + 1])
		}
		table[i] = curr
		prev = curr
	}
	const lines = []
	let i = 0
	let j = 0
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			lines.push(`  ${a[i]}`)
			i += 1
			j += 1
		} else if (table[i + 1] !== undefined && table[i + 1][j] >= table[i][j + 1]) {
			lines.push(`- ${a[i]}`)
			i += 1
		} else {
			lines.push(`+ ${b[j]}`)
			j += 1
		}
	}
	while (i < n) {
		lines.push(`- ${a[i]}`)
		i += 1
	}
	while (j < m) {
		lines.push(`+ ${b[j]}`)
		j += 1
	}
	return lines
}

// #endregion diff

// #region tools

/** Shared `group` / `roots` parameter specs. */
const GROUP_PARAM = {
	type: 'string',
	description: 'Workspace group name. Omit to use the group whose roots contain the session directory (or the only group, when exactly one is defined).',
}
const ROOTS_PARAM = {
	type: 'array',
	description: 'Optional subset of root ids to act on, e.g. ["pc"]. Defaults to every root in the group.',
	items: { type: 'string' },
}
const ESCALATION_PARAMS = {
	sandbox_permissions: {
		type: 'string',
		enum: ['workspace-write', 'danger-full-access'],
		description: 'The narrowest wider sandbox mode this call needs, only when a target falls outside the standing writable roots. Requires justification. Omit for a normal call.',
	},
	justification: {
		type: 'string',
		description: 'One sentence for the user explaining why this exact call needs the wider access. Required with sandbox_permissions.',
	},
}

/**
 * The session directory, used to pick the default group.
 *
 * The session carries its own working directory — the immutable sandbox
 * boundary. When it is not readable, the standing policy's workspace root is the
 * same boundary and is used instead.
 */
function sessionCwdOf(ctx, exec) {
	const fromSession = exec?.agent?.session?.cwd
	if (typeof fromSession === 'string' && fromSession.length > 0) return fromSession
	const policy = policyFor(ctx, exec)
	return typeof policy?.workspaceRoot === 'string' ? policy.workspaceRoot : undefined
}

/**
 * Build the per-call context the tools share: the selected group, its roots, and
 * the session directory used for group selection.
 */
function callContext(store, ctx, args, exec) {
	const picked = store.pick(args.group, sessionCwdOf(ctx, exec))
	return { ...picked, roots: GroupStore.selectRoots(picked.group, args.roots) }
}

/** A text rendering for the standard `{summary, results[]}` tool result. */
const RESULTS_RENDER = (_args, value) => [{ type: 'text', text: value.summary }]

/** The standard result output schema shared by the file-scoped tools. */
const RESULTS_OUTPUT = {
	schema: {
		type: 'object',
		additionalProperties: false,
		properties: {
			summary: { type: 'string', required: true },
			group: { type: 'string', required: true },
			results: {
				type: 'array',
				required: true,
				items: {
					type: 'object',
					additionalProperties: false,
					properties: {
						root: { type: 'string', required: true },
						path: { type: 'string', required: true },
						status: { type: 'string', required: true },
						detail: { type: 'string' },
					},
				},
			},
		},
	},
	render: RESULTS_RENDER,
}

/**
 * Register the eight `ws_*` tools, the conditional prompt section, and the
 * group-membership context on the tools-injected context.
 */
function registerTools(ctx, store) {
	ctx.tools.register(defineTool({
		name: 'ws_groups',
		description: 'List every workspace group (name, description, roots) and show which group this session resolves to. Root ids appear here; pass one to `roots` in the other ws_* tools to narrow a call to a single project.',
		parameters: {},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					summary: { type: 'string', required: true },
					active: { type: 'string' },
					groups: {
						type: 'array',
						required: true,
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								name: { type: 'string', required: true },
								description: { type: 'string' },
								roots: {
									type: 'array',
									required: true,
									items: {
										type: 'object',
										additionalProperties: false,
										properties: {
											id: { type: 'string', required: true },
											path: { type: 'string', required: true },
										},
									},
								},
							},
						},
					},
				},
			},
			render: RESULTS_RENDER,
		},
		async execute(_args, exec) {
			const groups = store.read()
			const names = Object.keys(groups).sort()
			const sessionCwd = sessionCwdOf(ctx, exec)
			let active
			try {
				active = store.pick(undefined, sessionCwd).name
			} catch {
				active = undefined
			}
			const lines = names.length === 0
				? [`No workspace groups defined. Registry: ${store.path}`, 'Create one with ws_group_set, e.g. {group:"ecam", roots:[{id:"pc",path:"~/proj/pc"},{id:"mobile",path:"~/proj/mobile"}]}.']
				: [
					`${names.length} workspace group(s). Registry: ${store.path}`,
					`Session directory: ${typeof sessionCwd === 'string' ? sessionCwd : '(unknown)'}${active === undefined ? ' — matches no group, pass `group` explicitly' : ` — active group: ${active}`}`,
					'',
					...names.flatMap((groupName) => {
						const group = groups[groupName]
						const head = `• ${groupName}${groupName === active ? ' (active)' : ''}${group.description === undefined ? '' : ` — ${group.description}`}`
						return [head, ...group.roots.map((root) => `    [${root.id}] ${root.path}${existsSync(root.path) ? '' : '  (missing)'}`)]
					}),
				]
			return {
				summary: lines.join('\n'),
				...(active === undefined ? {} : { active }),
				groups: names.map((groupName) => ({
					name: groupName,
					...(groups[groupName].description === undefined ? {} : { description: groups[groupName].description }),
					roots: groups[groupName].roots.map((root) => ({ id: root.id, path: root.path })),
				})),
			}
		},
	}))

	ctx.tools.register(defineTool({
		name: 'ws_group_set',
		description: 'Create or replace a workspace group: a name plus the local project roots it merges. `id` is the short label used by every other ws_* tool (`pc`, `mobile`, `ios`, `harmony`); `path` may be absolute or start with `~`.',
		parameters: {
			group: {
				type: 'string',
				required: true,
				description: 'Group name, e.g. "ecam" or "jsb-mobile".',
			},
			roots: {
				type: 'array',
				required: true,
				description: 'The roots to merge, in order.',
				items: {
					type: 'object',
					additionalProperties: false,
					properties: {
						id: { type: 'string', required: true, description: 'Short root id, e.g. "pc".' },
						path: { type: 'string', required: true, description: 'Absolute project root, or a ~-prefixed path.' },
						label: { type: 'string', description: 'Optional human label.' },
					},
				},
			},
			description: { type: 'string', description: 'Optional one-line description shown by ws_groups.' },
			...ESCALATION_PARAMS,
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					summary: { type: 'string', required: true },
					group: { type: 'string', required: true },
				},
			},
			render: RESULTS_RENDER,
		},
		async execute(args, exec) {
			// The registry is a real file mutation too, so it honours the same
			// policy as a project write instead of quietly stepping around a
			// read-only session.
			await assertRegistryWritable(ctx, args, exec, 'ws_group_set', store.path)
			const group = store.set(args.group, args.roots, args.description)
			const missing = group.roots.filter((root) => !existsSync(root.path))
			return {
				group: args.group,
				summary: [
					`Group "${args.group}" saved with ${group.roots.length} root(s):`,
					...group.roots.map((root) => `  [${root.id}] ${root.path}`),
					...(missing.length === 0
						? []
						: ['', `Warning — ${missing.length} root path(s) do not exist yet: ${missing.map((r) => r.path).join(', ')}`]),
				].join('\n'),
			}
		},
	}))

	ctx.tools.register(defineTool({
		name: 'ws_group_remove',
		description: 'Delete a workspace group from the registry. Project files are never touched.',
		parameters: {
			group: { type: 'string', required: true, description: 'Group name to delete.' },
			...ESCALATION_PARAMS,
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					summary: { type: 'string', required: true },
					removed: { type: 'boolean', required: true },
				},
			},
			render: RESULTS_RENDER,
		},
		async execute(args, exec) {
			await assertRegistryWritable(ctx, args, exec, 'ws_group_remove', store.path)
			const removed = store.remove(args.group)
			return {
				removed,
				summary: removed
					? `Removed workspace group "${args.group}". Remaining: ${Object.keys(store.read()).join(', ') || '(none)'}`
					: `No group named "${args.group}". Defined: ${Object.keys(store.read()).join(', ') || '(none)'}`,
			}
		},
	}))

	ctx.tools.register(defineTool({
		name: 'ws_ls',
		description: 'List files at one relative directory across every root of a group, so the same component can be located in all projects at once. Skips .git and node_modules.',
		parameters: {
			group: GROUP_PARAM,
			roots: ROOTS_PARAM,
			path: { type: 'string', description: 'Relative directory inside each root. Defaults to the root itself.' },
			depth: { type: 'integer', description: `Recursion depth, 1-${MAX_LS_DEPTH}. Default ${DEFAULT_LS_DEPTH}.` },
			contains: { type: 'string', description: 'Optional substring filter on the relative path.' },
		},
		output: RESULTS_OUTPUT,
		async execute(args, exec) {
			const selected = callContext(store, ctx, args, exec)
			const depth = Math.min(Math.max(1, typeof args.depth === 'number' ? args.depth : DEFAULT_LS_DEPTH), MAX_LS_DEPTH)
			const sub = typeof args.path === 'string' ? args.path : ''
			const results = []
			for (const root of selected.roots) {
				if (!existsSync(root.path)) {
					results.push({ root: root.id, path: sub, status: 'missing-root', detail: root.path })
					continue
				}
				const files = listRelative(root.path, sub, depth, args.contains)
				results.push({
					root: root.id,
					path: sub.length > 0 ? sub : '.',
					status: files.length === 0 ? 'empty' : 'listed',
					detail: files.length === 0 ? '(nothing found)' : files.slice(0, 200).join('\n'),
				})
			}
			const counts = results.map((r) => `${r.root}=${r.status === 'listed' ? r.detail.split('\n').length : 0}`)
			return {
				group: selected.name,
				results,
				summary: `ws_ls ${sub.length > 0 ? sub : '.'} in group "${selected.name}" (${counts.join(', ')})\n\n${results.map((r) => `[${r.root}] ${r.path} — ${r.status}\n${r.detail ?? ''}`).join('\n\n')}`,
			}
		},
	}))

	ctx.tools.register(defineTool({
		name: 'ws_read',
		description: 'Read the same relative path from every root of a group and return each copy. The fastest way to see whether two projects have already drifted.',
		parameters: {
			group: GROUP_PARAM,
			roots: ROOTS_PARAM,
			path: { type: 'string', required: true, description: 'Relative file path inside each root.' },
		},
		output: RESULTS_OUTPUT,
		async execute(args, exec) {
			const selected = callContext(store, ctx, args, exec)
			const results = []
			const bodies = []
			for (const root of selected.roots) {
				let full
				try {
					full = resolveWithinRoot(root.path, args.path)
				} catch (error) {
					results.push({ root: root.id, path: args.path, status: 'invalid', detail: error.message })
					continue
				}
				if (!existsSync(full)) {
					results.push({ root: root.id, path: args.path, status: 'missing', detail: full })
					continue
				}
				let text
				try {
					text = readFileSync(full, 'utf8')
				} catch (error) {
					results.push({ root: root.id, path: args.path, status: 'unreadable', detail: error.message })
					continue
				}
				const lines = text.split('\n').length
				results.push({ root: root.id, path: args.path, status: 'read', detail: `${lines} line(s)` })
				bodies.push(`----- [${root.id}] ${full} (${lines} lines) -----\n${text}`)
			}
			return {
				group: selected.name,
				results,
				summary: `ws_read ${args.path} in group "${selected.name}" — ${results.map((r) => `${r.root}:${r.status}`).join(', ')}\n\n${bodies.join('\n\n')}`,
			}
		},
	}))

	ctx.tools.register(defineTool({
		name: 'ws_diff',
		description: 'Compare the same relative path across the roots of a group and print a line diff (the first root is the baseline). Use it before ws_edit to see how far the copies have already diverged.',
		parameters: {
			group: GROUP_PARAM,
			roots: ROOTS_PARAM,
			path: { type: 'string', required: true, description: 'Relative file path inside each root.' },
		},
		output: RESULTS_OUTPUT,
		async execute(args, exec) {
			const selected = callContext(store, ctx, args, exec)
			const loaded = []
			const results = []
			for (const root of selected.roots) {
				let full
				try {
					full = resolveWithinRoot(root.path, args.path)
				} catch (error) {
					results.push({ root: root.id, path: args.path, status: 'invalid', detail: error.message })
					continue
				}
				const text = readMaybe(full)
				if (text === undefined) {
					results.push({ root: root.id, path: args.path, status: 'missing', detail: full })
					continue
				}
				loaded.push({ root, text })
			}
			if (loaded.length === 0) {
				return { group: selected.name, results, summary: `ws_diff ${args.path}: no readable copy in group "${selected.name}".` }
			}
			const base = loaded[0]
			const sections = [`baseline: [${base.root.id}] (${base.text.split('\n').length} lines)`]
			for (let i = 1; i < loaded.length; i += 1) {
				const other = loaded[i]
				if (other.text === base.text) {
					results.push({ root: other.root.id, path: args.path, status: 'identical', detail: `matches [${base.root.id}]` })
					sections.push(`\n[${other.root.id}] identical to [${base.root.id}]`)
					continue
				}
				const diff = lineDiff(base.text, other.text)
				results.push({
					root: other.root.id,
					path: args.path,
					status: 'differs',
					detail: diff === undefined ? 'too large to align' : `${diff.filter((l) => l.startsWith('-') || l.startsWith('+')).length} differing line(s)`,
				})
				sections.push(`\n[${other.root.id}] vs [${base.root.id}]:\n${diff === undefined ? '(files too large for a line diff; compare hashes/line counts)' : diff.join('\n')}`)
			}
			results.unshift({ root: base.root.id, path: args.path, status: 'baseline', detail: `${base.text.split('\n').length} lines` })
			return {
				group: selected.name,
				results,
				summary: `ws_diff ${args.path} in group "${selected.name}"\n${sections.join('\n')}`,
			}
		},
	}))

	ctx.tools.register(defineTool({
		name: 'ws_edit',
		description: 'Apply ONE literal string replacement to the same relative path in every root of a group (or the selected subset), with a per-root outcome. Same matching rule as the built-in edit: old_string must occur exactly once unless replace_all is set. Supports dry-run, and writes outside the standing writable roots need sandbox_permissions + justification.',
		parameters: {
			group: GROUP_PARAM,
			roots: ROOTS_PARAM,
			path: { type: 'string', required: true, description: 'Relative file path inside each root.' },
			old_string: { type: 'string', required: true, description: 'Exact text to replace.' },
			new_string: { type: 'string', required: true, description: 'Replacement text.' },
			replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match.' },
			dry_run: { type: 'boolean', description: 'Report what would change without writing anything.' },
			...ESCALATION_PARAMS,
		},
		output: RESULTS_OUTPUT,
		async execute(args, exec) {
			if (args.old_string === args.new_string) {
				throw new Error('ws_edit: old_string and new_string are identical')
			}
			const selected = callContext(store, ctx, args, exec)
			const dryRun = args.dry_run === true
			const policy = dryRun ? undefined : await effectivePolicy(ctx, args, exec, 'ws_edit')
			const results = []
			for (const root of selected.roots) {
				let full
				try {
					full = resolveWithinRoot(root.path, args.path)
				} catch (error) {
					results.push({ root: root.id, path: args.path, status: 'invalid', detail: error.message })
					continue
				}
				const before = readMaybe(full)
				if (before === undefined) {
					results.push({ root: root.id, path: args.path, status: 'missing', detail: full })
					continue
				}
				const occurrences = before.split(args.old_string).length - 1
				if (occurrences === 0) {
					results.push({ root: root.id, path: args.path, status: 'not-found', detail: 'old_string does not occur' })
					continue
				}
				if (occurrences > 1 && args.replace_all !== true) {
					results.push({ root: root.id, path: args.path, status: 'ambiguous', detail: `old_string occurs ${occurrences} times; pass replace_all or a longer unique string` })
					continue
				}
				const after = args.replace_all === true
					? before.split(args.old_string).join(args.new_string)
					: before.replace(args.old_string, args.new_string)
				if (after === before) {
					results.push({ root: root.id, path: args.path, status: 'unchanged', detail: 'replacement produced identical content' })
					continue
				}
				if (dryRun) {
					results.push({ root: root.id, path: args.path, status: 'would-change', detail: `${occurrences} occurrence(s)` })
					continue
				}
				const guard = writeAllowed(policy, full)
				if (!guard.allowed) {
					results.push({ root: root.id, path: args.path, status: 'denied', detail: denialText(policy, full) })
					continue
				}
				const written = await writeText(ctx, full, after, policy, exec)
				results.push({ root: root.id, path: args.path, status: 'changed', detail: `${occurrences} replacement(s) via ${written.via}` })
			}
			const tally = results.reduce((acc, r) => {
				acc[r.status] = (acc[r.status] ?? 0) + 1
				return acc
			}, {})
			const summary = `ws_edit ${args.path} in group "${selected.name}"${dryRun ? ' (dry run)' : ''}: `
				+ Object.entries(tally).map(([status, count]) => `${status}=${count}`).join(' ')
				+ '\n\n'
				+ results.map((r) => `[${r.root}] ${r.status}${r.detail === undefined ? '' : ` — ${r.detail}`}`).join('\n')
			return { group: selected.name, results, summary }
		},
	}))

	ctx.tools.register(defineTool({
		name: 'ws_write',
		description: 'Write the SAME full content to one relative path in every root of a group (or the selected subset) — for a new shared file, or to force two copies back in sync. Supports dry-run; writes outside the standing writable roots need sandbox_permissions + justification.',
		parameters: {
			group: GROUP_PARAM,
			roots: ROOTS_PARAM,
			path: { type: 'string', required: true, description: 'Relative file path inside each root.' },
			content: { type: 'string', required: true, description: 'The complete file content.' },
			dry_run: { type: 'boolean', description: 'Report what would change without writing anything.' },
			...ESCALATION_PARAMS,
		},
		output: RESULTS_OUTPUT,
		async execute(args, exec) {
			const selected = callContext(store, ctx, args, exec)
			const dryRun = args.dry_run === true
			const policy = dryRun ? undefined : await effectivePolicy(ctx, args, exec, 'ws_write')
			const results = []
			for (const root of selected.roots) {
				let full
				try {
					full = resolveWithinRoot(root.path, args.path)
				} catch (error) {
					results.push({ root: root.id, path: args.path, status: 'invalid', detail: error.message })
					continue
				}
				const before = readMaybe(full)
				if (before === args.content) {
					results.push({ root: root.id, path: args.path, status: 'unchanged', detail: 'content already identical' })
					continue
				}
				if (dryRun) {
					results.push({
						root: root.id,
						path: args.path,
						status: before === undefined ? 'would-create' : 'would-change',
						detail: before === undefined ? full : `${before.split('\n').length} → ${args.content.split('\n').length} line(s)`,
					})
					continue
				}
				const guard = writeAllowed(policy, full)
				if (!guard.allowed) {
					results.push({ root: root.id, path: args.path, status: 'denied', detail: denialText(policy, full) })
					continue
				}
				const written = await writeText(ctx, full, args.content, policy, exec)
				results.push({
					root: root.id,
					path: args.path,
					status: before === undefined ? 'created' : 'written',
					detail: written.via,
				})
			}
			const tally = results.reduce((acc, r) => {
				acc[r.status] = (acc[r.status] ?? 0) + 1
				return acc
			}, {})
			const summary = `ws_write ${args.path} in group "${selected.name}"${dryRun ? ' (dry run)' : ''}: `
				+ Object.entries(tally).map(([status, count]) => `${status}=${count}`).join(' ')
				+ '\n\n'
				+ results.map((r) => `[${r.root}] ${r.status}${r.detail === undefined ? '' : ` — ${r.detail}`}`).join('\n')
			return { group: selected.name, results, summary }
		},
	}))

	// The prompt section stays EMPTY until a group exists, so an install that is
	// never configured adds no tokens to any prompt.
	//
	// `systemPrompt` is an OPTIONAL dependency and must be read with ctx.get():
	// cordis makes a bare `ctx.systemPrompt` access THROW (rather than return
	// undefined) unless the service is declared in `inject`, and that throw takes
	// the whole row — every tool registered above included — down with it.
	const systemPrompt = ctx.get('systemPrompt')
	if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') return
	if (typeof ctx.effect !== 'function') return
	// Section placement is CENTRALLY allocated: getSectionOrder() only knows the
	// names in the harness's own order table and returns undefined for anything
	// else — and a section whose order is not a finite number throws. TOOLS_SDK is
	// that table's slot for tools contributed through the tools SDK, which is
	// exactly what an out-of-tree bundle is; the literal is a defensive fallback
	// for a deployment that drops the placement.
	const placement = systemPrompt.getSectionOrder('TOOLS_SDK')
	const sectionOrder = Number.isFinite(placement) ? placement : 5000
	const promptSection = () => ctx.effect(() => systemPrompt.section({
		name: GROUP_SECTION,
		order: sectionOrder,
		text: () => {
			let groups
			try {
				groups = store.read()
			} catch {
				return ''
			}
			const names = Object.keys(groups).sort()
			if (names.length === 0) return ''
			const lines = names.map((groupName) => {
				const roots = groups[groupName].roots.map((root) => `${root.id}=${root.path}`).join(', ')
				return `- ${groupName}: ${roots}`
			})
			return [
				'## Workspace groups (multi-root editing)',
				'',
				'This session can treat several local project roots as one workspace. A group is a named root set; the same relative path is read, diffed, and edited across all of its roots by one call.',
				'',
				...lines,
				'',
				'Tools: `ws_groups` (list groups and the active one), `ws_group_set` / `ws_group_remove` (registry), `ws_ls` / `ws_read` / `ws_diff` (inspect the same path in every root), `ws_edit` / `ws_write` (apply one change to every root, with a per-root outcome). `ws_edit` and `ws_write` take `dry_run` to preview. Root ids select a subset through `roots`.',
				'',
				'Use a group whenever a change must land in more than one of these projects in the same step — a shared component, a synced fix, a matching config — instead of repeating one absolute-path edit per project and risking that they drift apart. A write whose target falls outside the standing writable roots is refused and must be retried with `sandbox_permissions` + `justification`.',
			].join('\n')
		},
	}))
	promptSection()
}

// #endregion tools

/**
 * Cordis plugin entry.
 *
 * @param ctx - the Cordis context of the bundle row.
 * @param config - optional row configuration: `storePath` overrides the registry
 *   file location (useful for tests and for a non-default $DSH_HOME).
 */
export function apply(ctx, config = {}) {
	debugMarker('apply: enter')
	try {
		const store = new GroupStore(config ?? {})
		ctx.inject(['tools'], (toolsCtx) => {
			debugMarker('inject: tools service available')
			try {
				registerTools(toolsCtx, store)
				debugMarker('inject: registerTools ok')
			} catch (error) {
				debugMarker(`inject: registerTools FAILED — ${describeError(error)}`)
				throw error
			}
		})
		debugMarker('apply: exit')
	} catch (error) {
		debugMarker(`apply: THREW — ${describeError(error)}`)
		throw error
	}
}

/**
 * Optional startup diagnostics.
 *
 * A plugin row that mounts but contributes nothing is hard to diagnose from the
 * outside, so `WSM_DEBUG=1` records each startup phase to
 * `<tmpdir>/dsh-workspace-merge-debug.log`. Off by default, and it can never
 * break a boot: every failure inside this function is swallowed.
 *
 * @param phase - the phase label, including any error text.
 */
function debugMarker(phase) {
	if (process.env.WSM_DEBUG !== '1') return
	const line = `${new Date().toISOString()} pid=${process.pid} ${phase}\n`
	try {
		process.stderr.write(`[dsh-workspace-merge] ${phase}\n`)
	} catch {
		// diagnostics must never affect the plugin
	}
	try {
		appendFileSync(join(tmpdir(), 'dsh-workspace-merge-debug.log'), line, 'utf8')
	} catch {
		// diagnostics must never affect the plugin
	}
}

/** A stack when there is one, else the stringified value. */
function describeError(error) {
	if (error instanceof Error) return `${error.name}: ${error.message}\n${error.stack ?? ''}`
	return String(error)
}
