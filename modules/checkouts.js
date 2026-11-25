/**
 * Lets a thread work in its own checkout of its folder's repo instead of the main one: a jj workspace, or a git worktree
 * on a branch of its own, made on its runner before its agent first runs, and removed when the thread is archived if
 * nothing in it is uncommitted. Each lives in `$XDG_DATA_HOME/ade/checkouts/<repo>/<thread>-<title>` on the runner.
 */
import path from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { defineDoc, defineExtension, defineTask } from '@earendil-works/pi-durable'
import { remoteEnv } from '../remote.js'
import { AGENT, background, finished } from '../util.js'

/**
 * Which repo a folder is in, the nearest where one is nested in another: its kind, the checkout it's in, that repo's
 * main checkout, and where checkouts go
 */
const DETECT = String.raw`
jjtop=$(jj root 2>/dev/null)
gittop=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -n "$jjtop" ] && [ ${'$'}{#jjtop} -ge ${'$'}{#gittop} ]; then
	top=$jjtop; echo jj; echo "$top"
	if [ -f "$top/.jj/repo" ]; then (cd "$top/.jj" && cd "$(cat repo)/../.." && pwd); else echo "$top"; fi
elif [ -n "$gittop" ]; then
	top=$gittop
	echo git; echo "$top"
	dirname "$(git rev-parse --path-format=absolute --git-common-dir)"
else
	echo none; echo; echo
fi
echo "${'$'}{XDG_DATA_HOME:-$HOME/.local/share}"
`

/** Makes the checkout at $DEST unless it's there, again at $REV once it was removed, and prints where it started */
const MAKE = {
	jj: String.raw`set -e
if [ ! -d "$DEST" ]; then
	mkdir -p "$(dirname "$DEST")"
	jj workspace add --name "$NAME" ${'$'}{REV:+-r "$REV"} "$DEST" >&2
fi
cd "$DEST"
jj log --no-graph -r @- -n 1 -T 'commit_id.short(12) ++ " " ++ description.first_line()'`,
	git: String.raw`set -e
if [ ! -d "$DEST" ]; then
	mkdir -p "$(dirname "$DEST")"
	if git show-ref --verify -q "refs/heads/$BRANCH"; then git worktree add "$DEST" "$BRANCH" >&2
	else git worktree add -b "$BRANCH" "$DEST" HEAD >&2; fi
fi
git -C "$DEST" log -1 --format='%h %s' HEAD`,
}

/** Removes the checkout at $DEST if nothing in it is uncommitted: `removed <tip>`, `dirty <files>` or `gone` */
const REMOVE = {
	jj: String.raw`set -e
cd "$DEST" 2>/dev/null || { echo gone; exit 0; }
changed=$(jj diff -r @ --summary)
if [ -n "$changed" ]; then echo "dirty $(printf '%s\n' "$changed" | wc -l)"; exit 0; fi
tip=$(jj log --no-graph -r @- -n 1 -T 'commit_id.short(12)')
jj workspace forget "$NAME" 2>/dev/null
cd / && rm -rf "$DEST"
echo "removed $tip"`,
	git: String.raw`set -e
cd "$DEST" 2>/dev/null || { echo gone; exit 0; }
changed=$(git status --porcelain)
if [ -n "$changed" ]; then echo "dirty $(printf '%s\n' "$changed" | wc -l)"; exit 0; fi
tip=$(git rev-parse --short HEAD)
cd "$MAIN" && git worktree remove "$DEST"
echo "removed $tip"`,
}

/** A title as a folder name: lowercase words joined by dashes, at most 40 characters */
const slug = (title) =>
	title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.slice(0, 40)
		.replace(/^-+|-+$/g, '')

export function server(core) {
	/**
	 * A thread's own checkout: `state` is '' for none, then `planned`, `made`, `removing`, and `removed` or `kept`.
	 * `cwd` is where its agent works, `path` plus the folder's place in the repo; `parent` the revision it started from.
	 */
	const Checkout = defineDoc({
		kind: 'ade.checkout',
		version: 1,
		scope: 'conversation',
		history: 'latest',
		fork: 'initial',
		checkpointWhen: () => true,
		initial: () => ({
			state: '',
			kind: '',
			runner: '',
			main: '',
			path: '',
			cwd: '',
			name: '',
			branch: '',
			parent: '',
			tip: '',
			note: '',
		}),
	})

	/** Runs `script` in `cwd` on `runner` with `env`: its stdout's lines, or an error with what it printed */
	async function run(runner, cwd, script, env, signal) {
		let out = ''
		let err = ''
		const result = await remoteEnv(core.runners, runner, cwd).exec(
			['bash', '-c', script],
			{
				env,
				inheritEnv: true,
				onOutput: (text, _context, info) =>
					info.stream === 'stderr' ? (err += text) : (out += text),
			},
			{ ...BACKGROUND_CONTEXT, abortSignal: signal },
		)
		if (result.ok !== true) throw new Error(result.error.message)
		if (result.value.exitCode)
			throw new Error(err.trim().split('\n').slice(-3).join(' ') || `exit ${result.value.exitCode}`)
		return out.split('\n')
	}

	/** The repo `dir` on `runner` is in, or undefined outside one */
	async function repoOf(runner, dir, signal) {
		const [kind, top, main, data] = await run(runner, dir, DETECT, {}, signal)
		return kind === 'none' ? undefined : { kind, top, main, data }
	}

	/**
	 * Before a thread with its own checkout is made: checks its agent's folder is in a repo, and answers what puts the
	 * agent in a checkout named after the thread, in the commit that makes it: `(tx, id, title) => to`.
	 */
	async function ownCheckout(to, signal) {
		const runner = (await core.known())[to.runner]
		if (!core.runners.isOnline(to.runner))
			throw new Error(`${to.runner} is offline; a thread's own checkout is made there as it starts`)
		const folder = core.folder(runner, to)
		const repo = await repoOf(to.runner, folder, signal)
		if (!repo)
			throw new Error(`${folder} is in no jj or git repo, so it has no checkouts of its own`)
		return async (tx, id, title) => {
			const name = [id, slug(title)].filter(Boolean).join('-')
			const at = path.join(repo.data, 'ade', 'checkouts', path.basename(repo.main), name)
			const cwd = path.join(at, path.relative(repo.top, folder))
			Object.assign(await tx.doc(Checkout, id), {
				state: 'planned',
				kind: repo.kind,
				runner: to.runner,
				main: repo.main,
				path: at,
				cwd,
				name,
				branch: repo.kind === 'git' ? `ade/${name}` : '',
			})
			return { ...to, dir: cwd }
		}
	}

	/** Before the thread's agent runs: its checkout, made if it's planned, or made again if archiving removed it */
	async function prepare(threadId, agent, signal) {
		const doc = await core.snapshot(Checkout, threadId)
		if (!['planned', 'removed'].includes(doc?.state)) return
		const row = await core.thread(threadId)
		if (row.agents[AGENT]?.conversation !== agent) return
		const to = await core.agentOf(agent, AGENT)
		if (to?.runner !== doc.runner || core.folder((await core.known())[to.runner], to) !== doc.cwd)
			return
		const again = doc.state === 'removed'
		const [parent] = await run(
			doc.runner,
			doc.main,
			MAKE[doc.kind],
			{ DEST: doc.path, NAME: doc.name, BRANCH: doc.branch, REV: again ? doc.tip : '' },
			signal,
		)
		await core.commit(async (tx) => {
			const now = await tx.doc(Checkout, threadId)
			if (now.state !== doc.state) return
			now.state = 'made'
			now.note = ''
			if (!again) now.parent = parent
			await core.trailed(tx, threadId, undefined, 'checkout-made', {
				path: doc.path,
				...(again ? { tip: doc.tip } : { parent }),
			})
		})
	}

	/** Removes an archived thread's checkout if it's clean, and keeps it, saying why, if it isn't */
	const Remove = defineTask({
		name: 'ade.checkout-remove',
		version: 1,
		initial: () => ({ phase: 'remove' }),
		phases: {
			async remove({ conversationId: threadId }, rt, ctx) {
				const doc = await core.snapshot(Checkout, threadId)
				let said
				try {
					;[said] = await run(
						doc.runner,
						doc.main,
						REMOVE[doc.kind],
						{ DEST: doc.path, NAME: doc.name, MAIN: doc.main },
						rt.signal,
					)
				} catch (error) {
					if (rt.signal.aborted) throw error
					said = `failed ${error.message}`
				}
				const [outcome, ...rest] = said.split(' ')
				const detail = rest.join(' ')
				await rt.commit(async (tx) => {
					const now = await tx.doc(Checkout, threadId)
					if (outcome === 'removed' || outcome === 'gone') {
						Object.assign(now, { state: 'removed', note: '', ...(detail ? { tip: detail } : {}) })
						await core.trailed(tx, threadId, undefined, 'checkout-removed', {
							path: doc.path,
							...(doc.branch ? { branch: doc.branch } : { tip: detail }),
						})
					} else {
						const why =
							outcome === 'dirty'
								? `${detail} ${detail === '1' ? 'file has' : 'files have'} uncommitted changes`
								: `couldn't remove it: ${detail}`
						Object.assign(now, { state: 'kept', note: why })
						await core.trailed(tx, threadId, undefined, 'checkout-kept', { path: doc.path, why })
					}
					return finished()
				}, ctx)
			},
		},
		abort: (task, rt, ctx) => rt.commit(() => finished('aborted'), ctx),
	})

	core.feed.define('checkout/', {
		keyOf: () => 'checkout',
		all: async (_viewer, param) => {
			const id = Number(param)
			await core.conversation(id)
			const doc = await core.snapshot(Checkout, id)
			return doc?.state ? [{ key: 'checkout', ...doc }] : []
		},
		match: (change, param) =>
			change.type === 'document' &&
			change.record.kind === Checkout.definition.kind &&
			change.conversationId === Number(param),
	})

	/** GET /api/checkouts?runner=&dir= says whether a folder is in a repo, so the picker offers a checkout of its own */
	async function serve(threadId, query, body, by) {
		if (threadId !== undefined) {
			await core.conversation(threadId)
			const doc = await core.snapshot(Checkout, threadId)
			return doc?.state ? doc : null
		}
		if (body !== undefined)
			throw new Error('GET /api/checkouts?runner=&dir= says which repo a folder is in')
		const name = query.get('runner')
		const runner = name && (await core.known())[name]
		if (!runner) throw new Error(`No runner named ${name}`)
		core.reach([{ runner: name }], by, await core.known())
		if (!core.runners.isOnline(name)) return { kind: null }
		const repo = await repoOf(name, core.folder(runner, { dir: query.get('dir') ?? '' }))
		return { kind: repo?.kind ?? null }
	}

	return {
		serve,
		ownCheckout,
		prepare,
		async archiving(tx, id) {
			const doc = await tx.doc(Checkout, id)
			if (doc.state === 'made' || doc.state === 'kept') {
				doc.state = 'removing'
				await tx.createTask(Remove, {}, background(id))
			}
		},
		extension: defineExtension({ name: 'ade.checkouts', tasks: [Remove] }),
	}
}
