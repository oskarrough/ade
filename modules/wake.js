/**
 * Agents can wake themselves later: `wake` posts their note back to them after a while, once or every so often, or
 * once another thread's work ends. Off by default; MODULES=+wake turns it on.
 *
 * Each wake is an `ade.wake` task owned by its thread in the background: a stored sleep, so it survives a restart and
 * the thread's Stop, and holds no process. When it's due it posts the note to the agent that set it, as that agent
 * (`wake` on the message), then sleeps again with `every` or ends. One that came due while the server was down fires
 * once on start; a recurring one skips the slots it missed. The thread shows its pending wakes above the composer
 * (serve), where × cancels one; archiving the thread cancels them all.
 *
 * A wake `after` thread N sleeps on a signal instead of a time. Whenever the thread lists change, and once on start,
 * settle signals each such wake whose thread has no work left (no agent answering or waiting for its runner, no `$ cmd`,
 * no director pick); one set while N is already idle fires at once.
 */
import { num, obj, opt, str } from '@earendil-works/pi-schema'
import { defineExtension, defineSignal, defineTask, defineTool } from '@earendil-works/pi-durable'
import { background, finished, writtenTo } from '../util.js'

export const on = false

const UNITS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
/** The shortest repeat, so a routine can't fill a thread */
const EVERY = 60_000

/** `90s`, `5m`, `1h30m`, `2d` → milliseconds */
export function duration(text, name) {
	const parts = String(text)
		.replace(/\s+/g, '')
		.match(/^(?:\d+[smhd])+$/)
	if (!parts) throw new Error(`${name} is a duration like 90s, 5m, 1h30m or 2d`)
	let ms = 0
	for (const [, count, unit] of String(text).matchAll(/(\d+)\s*([smhd])/g))
		ms += Number(count) * UNITS[unit]
	if (!ms) throw new Error(`${name} must be longer than nothing`)
	return ms
}

/** The thread a wake waits on has no work left */
const Ended = defineSignal({ name: 'ade.thread-ended', version: 1, schema: obj({}) })

export function server(core) {
	/** Wakes in one thread or all, `sleeping` or not yet (`pending`); those already cancelled are gone */
	const sleeping = async (threadId, status = 'sleeping') =>
		(
			await core.tasks({
				...(threadId === undefined ? {} : { conversationId: threadId }),
				kind: Wake.definition.name,
				status,
			})
		).filter((record) => !record.abortRequested)

	/** The thread's pending wakes, timed ones soonest first, then those waiting on a thread: `{id, at?, after?, every?, note, agent}` */
	async function pending(threadId) {
		return (await sleeping(threadId))
			.map(({ id, input, state }) => ({
				id,
				...(input.after === undefined
					? { at: /** @type {any} */ (state).until }
					: { after: input.after }),
				...(input.every ? { every: input.every } : {}),
				note: input.note,
				agent: input.author,
			}))
			.sort((left, right) => (left.at ?? Infinity) - (right.at ?? Infinity))
	}

	/** Wakes each wake whose thread has no work left; a signal it already has comes back `duplicate`, which is fine */
	async function settle() {
		// A wake just set may not sleep yet; Pi keeps a signal that comes first
		const waiting = [...(await sleeping()), ...(await sleeping(undefined, 'pending'))].filter(
			(record) => record.input.after !== undefined,
		)
		if (!waiting.length) return
		const working = new Set((await core.work()).map((job) => job.thread))
		for (const record of waiting)
			if (!working.has(record.input.after)) await core.signal(record.id, Ended, 'ended', {})
	}
	const settling = () => settle().catch((error) => console.error(error))

	/**
	 * Cancels one of the thread's wakes, and says what came of it: `{cancelled}`, or `{fired}` for a one-off that went off
	 * first, `{ended}` for one that ended otherwise
	 */
	async function cancel(threadId, id) {
		const record = await core.task(id)
		if (record?.kind !== Wake.definition.name || record.conversationId !== threadId)
			throw Object.assign(new Error(`No wake ${id} in thread ${threadId}`), { status: 404 })
		if ((await core.abortTask(id)) === 'marked') await core.waitForTask(id)
		const outcome = /** @type {any} */ ((await core.task(id))?.state)?.outcome
		if (outcome?.status === 'aborted') return { cancelled: id }
		return outcome?.result?.fired ? { fired: id } : { ended: id }
	}

	/**
	 * Sleeps until `at`, then posts the note to the agent that set it (its conversation, which a bot's rename keeps), as
	 * that agent; with `every`, sleeps until the next slot of its first rhythm, skipping those missed. An agent no longer
	 * in the thread, or an archived thread, ends it quietly.
	 */
	const Wake = defineTask({
		name: 'ade.wake',
		version: 1,
		initial: () => ({ phase: 'sleep' }),
		phases: {
			sleep: ({ input }, rt, ctx) =>
				input.after === undefined
					? rt.sleepUntil(input.at, { phase: 'fire' }, ctx)
					: rt.commit(
							() => ({
								status: 'sleeping',
								signals: [Ended.key('ended')],
								checkpoint: { phase: 'fire' },
							}),
							ctx,
						),
			fire: ({ id, conversationId: threadId, input, state }, rt, ctx) =>
				rt.commit(async (tx) => {
					const row = await core.threadIn(tx, threadId)
					const key = Object.keys(row.agents).find(
						(key) => row.agents[key].conversation === input.conversation,
					)
					const to = !row.hidden && key && (await core.agentOf(input.conversation, key, tx))
					if (!to) return finished()
					await core.post(
						tx,
						threadId,
						{ author: writtenTo(to), body: input.note, wake: id, to: [to] },
						{ member: true },
					)
					if (!input.every) return finished('completed', { fired: true })
					const slot = /** @type {any} */ (state).checkpoint.at ?? input.at
					const next = slot + Math.max(1, Math.ceil((rt.now() - slot) / input.every)) * input.every
					return { status: 'sleeping', until: next, checkpoint: { phase: 'fire', at: next } }
				}, ctx),
		},
		abort: (_task, rt, ctx) => rt.commit(() => finished('aborted'), ctx),
	})

	const wake = defineTool({
		name: 'wake',
		description:
			'Come back to this thread later: your note arrives here as a message to you after `in`, and again every `every` if you give it, or once thread `after` has finished its work. Returns at once. Or cancel a wake by its id.',
		parameters: obj({
			in: opt(str({ description: 'How long until the first wake: 90s, 5m, 1h30m, 2d' })),
			every: opt(str({ description: 'Wake again this often, at least 1m; `in` defaults to it' })),
			after: opt(
				num({
					description:
						"Another thread's id: wake once its work ends (now, if it's idle), instead of at a time",
				}),
			),
			note: opt(
				str({ description: "What to do when you wake, written so you'll know without context" }),
			),
			cancel: opt(num({ description: "A pending wake's id, to cancel it instead" })),
		}),
		replay: 'safe',
		execute: async (input, api) => {
			const args =
				/** @type {{ in?: string, every?: string, after?: number, note?: string, cancel?: number }} */ (
					input
				)
			const at = await core.home(api.conversationId)
			if (!at) throw new Error('Only an agent in a thread can set a wake')
			if (args.cancel !== undefined) {
				const ended = await cancel(at.thread, args.cancel)
				const said = ended.cancelled
					? 'Cancelled'
					: ended.fired
						? 'Too late: it already went off,'
						: 'It had already ended,'
				return { output: [{ type: 'text', text: `${said} wake ${args.cancel}.` }] }
			}
			const note = args.note?.trim()
			if (!note) throw new Error('note is required')
			let when
			if (args.after !== undefined) {
				if (args.in !== undefined || args.every !== undefined)
					throw new Error('after wakes once, at no time: leave in and every out')
				if (args.after === at.thread) throw new Error('after is another thread')
				if (!(await core.thread(args.after))) throw new Error(`No thread ${args.after}`)
				when = { after: args.after }
			} else {
				const every = args.every === undefined ? undefined : duration(args.every, 'every')
				if (every !== undefined && every < EVERY) throw new Error('every is at least 1m')
				if (args.in === undefined && every === undefined)
					throw new Error('give in, every or both, or after')
				const wait = args.in === undefined ? every : duration(args.in, 'in')
				when = { at: Date.now() + wait, ...(every ? { every } : {}) }
			}
			const id = await core.once(`wake ${api.taskId}`, 'wake', (tx) =>
				tx.createTask(
					Wake,
					{ conversation: api.conversationId, author: at.name, note, ...when },
					background(at.thread),
				),
			)
			if (when.after !== undefined) settling()
			const others = (await pending(at.thread)).filter((one) => one.id !== id)
			return {
				output: [
					{
						type: 'text',
						text: [
							`Set wake ${id}. Your note comes back here as a message; end your turn.`,
							...(others.length
								? [
										'Other wakes pending here:',
										...others.map(
											(one) =>
												`- ${one.id} ${one.after === undefined ? `at ${new Date(one.at).toISOString()}${one.every ? ', repeating' : ''}` : `after thread ${one.after}`}: ${one.note}`,
										),
									]
								: []),
						].join('\n'),
					},
				],
			}
		},
	})

	/** GET: the thread's pending wakes; POST `{cancel}`: cancels one */
	async function serve(threadId, _query, body) {
		if (threadId === undefined) throw new Error('Wakes live in a thread')
		await core.conversation(threadId)
		if (body === undefined) return pending(threadId)
		if (!Number.isInteger(body.cancel)) throw new Error('cancel is the wake id')
		return cancel(threadId, body.cancel)
	}

	/**
	 * Archiving a thread ends its wakes: a wake due meanwhile finds the thread hidden in its own commit and posts nothing,
	 * and once the archive is stored every wake still live is aborted
	 */
	async function archiving(tx, threadId) {
		core.afterCommit(tx, () =>
			core
				.tasks({ conversationId: threadId, kind: Wake.definition.name })
				.then((wakes) =>
					Promise.all(
						wakes
							.filter((one) => one.state.status !== 'terminal')
							.map((one) => core.abortTask(one.id)),
					),
				)
				.catch((error) => console.error(error)),
		)
	}

	return {
		serve,
		archiving,
		start: settling,
		changed: (lists) => lists.includes('threads') && settling(),
		extension: defineExtension({
			name: 'ade.wake',
			tools: [wake],
			tasks: [Wake],
			sections: [
				{
					key: 'wake',
					tag: false,
					render: () =>
						'To check back later (CI, a deploy, a daily routine), use wake instead of waiting; a message with the wake mark is your own note coming back.',
				},
			],
		}),
	}
}
