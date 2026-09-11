/**
 * dsh-workspace-merge test harness — no framework, no network, no real session.
 *
 * A stub Cordis context records the registered tools so each one can be called
 * directly, and every read/write happens in a fresh temp DSH_HOME with two
 * throwaway project roots. Run with `npm test` (or `node test/run-test.mjs`).
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

let passed = 0
const failures = []

/** Run one named check; a throw is recorded instead of aborting the suite. */
function check(label, fn) {
	try {
		fn()
		passed += 1
		console.log(`  ok   ${label}`)
	} catch (error) {
		failures.push(`${label}: ${error.message}`)
		console.log(`  FAIL ${label}\n         ${error.message}`)
	}
}

/** Run one async check. */
async function checkAsync(label, fn) {
	try {
		await fn()
		passed += 1
		console.log(`  ok   ${label}`)
	} catch (error) {
		failures.push(`${label}: ${error.message}`)
		console.log(`  FAIL ${label}\n         ${error.message}`)
	}
}

/**
 * The Cordis rule that bit this bundle at boot: a service NOT declared in
 * `inject` is not a readable property — `ctx.systemPrompt` THROWS instead of
 * returning undefined. A row that touches it anyway dies whole, taking every
 * tool it registered with it, and the failure is silent unless the loader is
 * asked for it. This stub reproduces the guard, so a regression to a bare
 * property read fails the suite here rather than in a user's session.
 */
const INJECT_GUARD = {
	get systemPrompt() {
		throw new Error('cannot get property "systemPrompt" without inject')
	},
}

/** A stub Cordis context exposing exactly the seams the bundle touches. */
function makeCtx(services = {}) {
	const tools = new Map()
	const sections = new Map()
	// Faithful to the real service: `section()` rejects a non-finite order, and
	// `getSectionOrder()` only knows the harness's own centrally allocated
	// placement names — anything else comes back undefined. A plugin that invents
	// a placement name, or forgets a fallback, fails here.
	const systemPrompt = {
		getSectionOrder(name) {
			return { TOOLS_SDK: 5000, DEPLOYMENT_PERSONA_PREFIX: 0 }[name]
		},
		section(section) {
			if (!Number.isFinite(section.order)) {
				throw new TypeError(`prompt section "${section.name}" order must be a finite number`)
			}
			sections.set(section.name, section)
			return () => sections.delete(section.name)
		},
	}
	const ctx = Object.create(INJECT_GUARD)
	Object.assign(ctx, {
		tools: {
			register(definition) {
				tools.set(definition.name, definition)
				return () => tools.delete(definition.name)
			},
		},
		inject(names, callback) {
			if (names.includes('tools')) callback(ctx)
			return () => undefined
		},
		effect(fn) {
			const disposer = fn()
			return typeof disposer === 'function' ? disposer : () => undefined
		},
		get(serviceName) {
			if (serviceName === 'systemPrompt') return systemPrompt
			return services[serviceName]
		},
		waterfall(_name, _target, _exec, next) {
			return Promise.resolve(next())
		},
	})
	return { ctx, tools, sections }
}

/** A ToolRunContext lookalike: the session cwd plus the escalation ingredients. */
function makeExec(cwd) {
	return { callId: 'call-1', signal: undefined, agent: { session: { cwd } } }
}

// The registry home can sit in tmpdir; the PROJECT roots deliberately do not.
// `writableRoots` for workspace-write always includes /tmp and os.tmpdir(), so a
// root placed there could never be denied and the sandbox cases below would test
// nothing.
const home = mkdtempSync(join(tmpdir(), 'wsm-home-'))
const roots = mkdtempSync(join(homedir(), '.dsh-wsm-test-'))
const pc = join(roots, 'pc')
const mobile = join(roots, 'mobile')
const COMPONENT = 'src/components/AmountInput.vue'

try {
	process.env.DSH_HOME = home
	for (const root of [pc, mobile]) {
		mkdirSync(join(root, 'src/components'), { recursive: true })
		writeFileSync(join(root, COMPONENT), '<template>\n  <el-input v-model="amount" />\n</template>\n', 'utf8')
	}
	const storePath = join(home, 'workspace-groups.json')
	const { ctx, tools, sections } = makeCtx()
	apply(ctx, { storePath })

	const call = (toolName, args, exec) => {
		const definition = tools.get(toolName)
		assert.ok(definition !== undefined, `tool ${toolName} is not registered`)
		return definition.execute(args, exec ?? makeExec(pc))
	}

	console.log('\n# registration')
	check('eight ws_* tools are registered', () => {
		const names = [...tools.keys()].sort()
		assert.deepEqual(names, [
			'ws_diff', 'ws_edit', 'ws_group_remove', 'ws_group_set',
			'ws_groups', 'ws_ls', 'ws_read', 'ws_write',
		])
	})
	check('the stub reproduces the cordis inject guard', () => {
		// Guards the guard: if this ever stops throwing, the systemPrompt
		// regression it exists to catch would go unnoticed again.
		assert.throws(() => makeCtx().ctx.systemPrompt, /without inject/)
	})
	check('an unconfigured install adds an EMPTY prompt section', () => {
		const section = sections.get('WORKSPACE_MERGE_GROUPS')
		assert.ok(section !== undefined, 'section was not registered')
		assert.equal(section.text(), '', 'empty registry must render an empty section')
	})

	console.log('\n# registry')
	await checkAsync('ws_group_set stores a normalized group', async () => {
		const result = await call('ws_group_set', {
			group: 'demo',
			description: 'PC + mobile',
			roots: [{ id: 'pc', path: pc }, { id: 'mobile', path: mobile }],
		})
		assert.equal(result.group, 'demo')
		assert.match(result.summary, /Group "demo" saved with 2 root\(s\)/)
		const stored = JSON.parse(readFileSync(storePath, 'utf8'))
		assert.equal(stored.version, 1)
		assert.deepEqual(stored.groups.demo.roots.map((r) => r.id), ['pc', 'mobile'])
	})

	await checkAsync('ws_group_set rejects a group with no roots', async () => {
		await assert.rejects(() => call('ws_group_set', { group: 'empty', roots: [] }), /at least one root/)
	})

	await checkAsync('the prompt section becomes non-empty once a group exists', async () => {
		const section = sections.get('WORKSPACE_MERGE_GROUPS')
		const text = section.text()
		assert.match(text, /Workspace groups \(multi-root editing\)/)
		assert.match(text, /demo: pc=/)
		assert.match(text, /ws_edit/)
	})

	await checkAsync('ws_groups reports the active group from the session cwd', async () => {
		const result = await call('ws_groups', {})
		assert.equal(result.active, 'demo')
		assert.equal(result.groups.length, 1)
		assert.match(result.summary, /\[pc\]/)
	})

	await checkAsync('a single group is the fallback for an unrelated cwd', async () => {
		// With exactly one group defined there is nothing to disambiguate, so it
		// is used even when the session directory is somewhere else entirely.
		const result = await call('ws_groups', {}, makeExec(roots))
		assert.equal(result.active, 'demo')
	})

	console.log('\n# inspect')
	await checkAsync('ws_read returns every copy', async () => {
		const result = await call('ws_read', { path: COMPONENT })
		assert.deepEqual(result.results.map((r) => r.status), ['read', 'read'])
		assert.match(result.summary, /\[pc\]/)
		assert.match(result.summary, /\[mobile\]/)
	})

	await checkAsync('ws_diff reports identical copies', async () => {
		const result = await call('ws_diff', { path: COMPONENT })
		const statuses = result.results.map((r) => r.status)
		assert.ok(statuses.includes('baseline') && statuses.includes('identical'))
		assert.match(result.summary, /identical to \[pc\]/)
	})

	await checkAsync('ws_diff reports a real difference and a missing copy', async () => {
		writeFileSync(join(mobile, COMPONENT), '<template>\n  <el-input v-model="amount" size="large" />\n</template>\n', 'utf8')
		const result = await call('ws_diff', { path: COMPONENT })
		const mobileResult = result.results.find((r) => r.root === 'mobile')
		assert.equal(mobileResult.status, 'differs')
		assert.match(result.summary, /^\+ /m)
		assert.match(result.summary, /^- /m)
		const missing = await call('ws_diff', { path: 'src/nope.vue' })
		assert.deepEqual(missing.results.map((r) => r.status), ['missing', 'missing'])
		// restore the pair for the mutation tests
		writeFileSync(join(mobile, COMPONENT), readFileSync(join(pc, COMPONENT), 'utf8'), 'utf8')
	})

	await checkAsync('ws_ls finds the same component under every root', async () => {
		const result = await call('ws_ls', { path: 'src', depth: 3, contains: 'AmountInput' })
		for (const entry of result.results) {
			assert.equal(entry.status, 'listed')
			assert.match(entry.detail, /AmountInput\.vue/)
		}
	})

	console.log('\n# mutation')
	await checkAsync('ws_edit dry_run changes nothing', async () => {
		const result = await call('ws_edit', {
			path: COMPONENT,
			old_string: 'v-model="amount"',
			new_string: 'v-model="amountText"',
			dry_run: true,
		})
		assert.deepEqual(result.results.map((r) => r.status), ['would-change', 'would-change'])
		assert.match(readFileSync(join(mobile, COMPONENT), 'utf8'), /v-model="amount"/)
	})

	await checkAsync('ws_edit applies the same replacement to every root', async () => {
		const result = await call('ws_edit', {
			path: COMPONENT,
			old_string: 'v-model="amount"',
			new_string: 'v-model="amountText"',
		})
		assert.deepEqual(result.results.map((r) => r.status), ['changed', 'changed'])
		assert.match(result.summary, /changed=2/)
		for (const root of [pc, mobile]) {
			assert.match(readFileSync(join(root, COMPONENT), 'utf8'), /v-model="amountText"/)
		}
	})

	await checkAsync('a second ws_edit finds nothing left to change', async () => {
		const result = await call('ws_edit', {
			path: COMPONENT,
			old_string: 'v-model="amount"',
			new_string: 'v-model="amountText"',
		})
		assert.deepEqual(result.results.map((r) => r.status), ['not-found', 'not-found'])
	})

	await checkAsync('an ambiguous match is refused per root', async () => {
		const result = await call('ws_edit', { path: COMPONENT, old_string: 'n', new_string: 'N' })
		assert.deepEqual(result.results.map((r) => r.status), ['ambiguous', 'ambiguous'])
	})

	await checkAsync('replace_all resolves an ambiguous match', async () => {
		const result = await call('ws_edit', {
			path: COMPONENT,
			old_string: 'amount',
			new_string: 'amountText',
			replace_all: true,
		})
		assert.deepEqual(result.results.map((r) => r.status), ['changed', 'changed'])
	})

	await checkAsync('ws_edit rejects identical old/new strings up front', async () => {
		await assert.rejects(
			() => call('ws_edit', { path: COMPONENT, old_string: 'a', new_string: 'a' }),
			/identical/,
		)
	})

	await checkAsync('ws_write creates the same new file in every root', async () => {
		const result = await call('ws_write', { path: 'src/shared/const.ts', content: 'export const RETIRE = 1\n' })
		assert.deepEqual(result.results.map((r) => r.status), ['created', 'created'])
		for (const root of [pc, mobile]) {
			assert.equal(readFileSync(join(root, 'src/shared/const.ts'), 'utf8'), 'export const RETIRE = 1\n')
		}
	})

	await checkAsync('ws_write reports unchanged when content already matches', async () => {
		const result = await call('ws_write', { path: 'src/shared/const.ts', content: 'export const RETIRE = 1\n' })
		assert.deepEqual(result.results.map((r) => r.status), ['unchanged', 'unchanged'])
	})

	await checkAsync('roots narrows a call to one project', async () => {
		const result = await call('ws_write', {
			path: 'src/shared/const.ts',
			content: 'export const RETIRE = 2\n',
			roots: ['pc'],
		})
		assert.deepEqual(result.results.map((r) => r.status), ['written'])
		assert.equal(readFileSync(join(mobile, 'src/shared/const.ts'), 'utf8'), 'export const RETIRE = 1\n')
	})

	await checkAsync('an unknown root id is refused', async () => {
		await assert.rejects(
			() => call('ws_write', { path: 'x', content: 'y', roots: ['ios'] }),
			/unknown root id/,
		)
	})

	await checkAsync('a path escaping the root is refused', async () => {
		const result = await call('ws_write', { path: '../../etc/escape.txt', content: 'x' })
		assert.deepEqual(result.results.map((r) => r.status), ['invalid', 'invalid'])
		assert.match(result.results[0].detail, /escapes root/)
	})

	console.log('\n# sandbox policy')
	await checkAsync('workspace-write denies a target outside the workspace root', async () => {
		const denied = makeCtx({ sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: pc }) } })
		apply(denied.ctx, { storePath })
		const result = await denied.tools.get('ws_write').execute(
			{ path: 'src/denied.txt', content: 'x' },
			makeExec(pc),
		)
		assert.deepEqual(result.results.map((r) => r.status), ['created', 'denied'])
		assert.match(result.results[1].detail, /\[sandbox: file access denied under workspace-write mode\]/)
		assert.match(result.results[1].detail, /\[sandbox: escalation available — retry this exact operation once with sandbox_permissions/)
		assert.equal(existsSync(join(mobile, 'src/denied.txt')), false, 'the denied target must not be written')
	})

	await checkAsync('danger-full-access writes every root', async () => {
		const open = makeCtx({ sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: pc }) } })
		apply(open.ctx, { storePath })
		const result = await open.tools.get('ws_write').execute(
			{ path: 'src/open.txt', content: 'x' },
			makeExec(pc),
		)
		assert.deepEqual(result.results.map((r) => r.status), ['created', 'created'])
	})

	await checkAsync('the group registry obeys the policy too', async () => {
		const registryOutside = makeCtx({
			sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: pc }) },
		})
		apply(registryOutside.ctx, { storePath: join(roots, 'outside-registry.json') })
		await assert.rejects(
			() => registryOutside.tools.get('ws_group_set').execute(
				{ group: 'x', roots: [{ id: 'pc', path: pc }] },
				makeExec(pc),
			),
			/\[sandbox: file access denied under workspace-write mode\]/,
		)
		assert.equal(existsSync(join(roots, 'outside-registry.json')), false)
	})

	await checkAsync('read-only denies both roots', async () => {
		const frozen = makeCtx({ sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) } })
		apply(frozen.ctx, { storePath })
		const result = await frozen.tools.get('ws_write').execute(
			{ path: 'src/frozen.txt', content: 'x' },
			makeExec(pc),
		)
		assert.deepEqual(result.results.map((r) => r.status), ['denied', 'denied'])
	})

	console.log('\n# selection errors')
	await checkAsync('an unknown group name lists the defined ones', async () => {
		await assert.rejects(() => call('ws_groups', {}) && call('ws_ls', { group: 'nope' }), /unknown workspace group "nope"; defined: demo/)
	})

	await checkAsync('an empty registry explains how to create one', async () => {
		const empty = makeCtx()
		apply(empty.ctx, { storePath: join(home, 'nested/empty.json') })
		const result = await empty.tools.get('ws_groups').execute({}, makeExec(pc))
		assert.match(result.summary, /No workspace groups defined/)
		assert.match(result.summary, /ws_group_set/)
		await assert.rejects(() => empty.tools.get('ws_ls').execute({}, makeExec(pc)), /no workspace groups are defined/)
	})

	await checkAsync('two groups with no cwd match demand an explicit name', async () => {
		await call('ws_group_set', { group: 'second', roots: [{ id: 'other', path: roots }] })
		const listed = await call('ws_groups', {}, makeExec('/'))
		assert.equal(listed.active, undefined)
		assert.match(listed.summary, /matches no group/)
		await assert.rejects(() => call('ws_ls', {}, makeExec('/')), /matches no group and 2 groups exist/)
		const named = await call('ws_ls', { group: 'second', depth: 1 }, makeExec('/'))
		assert.deepEqual(named.results.map((r) => r.root), ['other'])
	})

	await checkAsync('ws_group_remove deletes only the registry entry', async () => {
		const removed = await call('ws_group_remove', { group: 'second' })
		assert.equal(removed.removed, true)
		assert.equal(readFileSync(join(pc, COMPONENT), 'utf8').length > 0, true)
		const again = await call('ws_group_remove', { group: 'second' })
		assert.equal(again.removed, false)
	})
} finally {
	rmSync(home, { recursive: true, force: true })
	rmSync(roots, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
	console.log('\nFailures:')
	for (const failure of failures) console.log(`- ${failure}`)
	process.exitCode = 1
}
