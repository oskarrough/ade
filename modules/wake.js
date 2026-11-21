/**
 * Agents can wake themselves later: `wake` posts their note back to them after a while, once or every so often.
 * Off by default; MODULES=+wake turns it on.
 *
 * Each wake is an `ade.wake` task owned by its thread in the background: a stored sleep, so it survives a restart and
 * the thread's Stop, and holds no process. When it's due it posts the note to the agent that set it, as that agent
 * (`wake` on the message), then sleeps again with `every` or ends. One that came due while the server was down fires
 * once on start; a recurring one skips the slots it missed. The thread shows its pending wakes above the composer
 * (serve), where × cancels one; archiving the thread cancels them all.
 */
import { num, obj, opt, str } from '@earendil-works/pi-schema'
import { defineExtension, defineTask, defineTool } from '@earendil-works/pi-durable'
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

export function server(core) {
	/** The thread's pending wakes, soonest first: `{id, at, every?, note, agent}` */
	async function pending(threadId) {
		const sleeping = await core.tasks({
			conversationId: threadId,
			kind: Wake.definition.name,
			status: 'sleeping',
		})
		return sleeping
			.filter((record) => !record.abortRequested)
			.map(({ id, input, state }) => ({
				id,
				at: /** @type {any} */ (state).until,
				...(input.every ? { every: input.every } : {}),
				note: input.note,
				agent: input.author,
			}))
			.sort((left, right) => left.at - right.at)
	}

	/** Cancels one of the thread's wakes; a wake already gone is fine */
	async function cancel(threadId, id) {
		const record = await core.task(id)
		if (record?.kind !== Wake.definition.name || record.conversationId !== threadId)
			throw Object.assign(new Error(`No wake ${id} in thread ${threadId}`), { status: 404 })
		if (record.state.status !== 'terminal') await core.abortTask(id)
		return { cancelled: id }
	}

	/**
	 * Sleeps until `at`, then posts the note to the agent that set it, as that agent; with `every`, sleeps again from
	 * when it fired. An agent no longer in the thread ends it quietly.
	 */
	const Wake = defineTask({
		name: 'ade.wake',
		version: 1,
		initial: () => ({ phase: 'sleep' }),
		phases: {
			sleep: ({ input }, rt, ctx) => rt.sleepUntil(input.at, { phase: 'fire' }, ctx),
			fire: ({ id, conversationId: threadId, input }, rt, ctx) =>
				rt.commit(async (tx) => {
					const recipient = (await core.threadIn(tx, threadId)).agents[input.key]
					const to = recipient && (await core.agentOf(recipient.conversation, input.key, tx))
					if (!to) return finished()
					await core.post(
						tx,
						threadId,
						{ author: writtenTo(to), body: input.note, wake: id, to: [to] },
						{ member: true },
					)
					return input.every
						? { status: 'sleeping', until: rt.now() + input.every, checkpoint: { phase: 'fire' } }
						: finished()
				}, ctx),
		},
		abort: (_task, rt, ctx) => rt.commit(() => finished('aborted'), ctx),
	})

	const wake = defineTool({
		name: 'wake',
		description:
			'Come back to this thread later: your note arrives here as a message to you after `in`, and again every `every` if you give it. Returns at once. Or cancel a wake by its id.',
		parameters: obj({
			in: opt(str({ description: 'How long until the first wake: 90s, 5m, 1h30m, 2d' })),
			every: opt(str({ description: 'Wake again this often, at least 1m; `in` defaults to it' })),
			note: opt(
				str({ description: "What to do when you wake, written so you'll know without context" }),
			),
			cancel: opt(num({ description: "A pending wake's id, to cancel it instead" })),
		}),
		replay: 'safe',
		execute: async (input, api) => {
			const args = /** @type {{ in?: string, every?: string, note?: string, cancel?: number }} */ (
				input
			)
			const at = await core.home(api.conversationId)
			if (!at) throw new Error('Only an agent in a thread can set a wake')
			if (args.cancel !== undefined) {
				await cancel(at.thread, args.cancel)
				return { output: [{ type: 'text', text: `Cancelled ${args.cancel}.` }] }
			}
			const note = args.note?.trim()
			if (!note) throw new Error('note is required')
			const every = args.every === undefined ? undefined : duration(args.every, 'every')
			if (every !== undefined && every < EVERY) throw new Error('every is at least 1m')
			if (args.in === undefined && every === undefined) throw new Error('give in, every or both')
			const after = args.in === undefined ? every : duration(args.in, 'in')
			const id = await core.once(`wake ${api.taskId}`, 'wake', (tx) =>
				tx.createTask(
					Wake,
					{
						key: at.key,
						author: at.name,
						note,
						at: Date.now() + after,
						...(every ? { every } : {}),
					},
					background(at.thread),
				),
			)
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
												`- ${one.id} at ${new Date(one.at).toISOString()}${one.every ? ', repeating' : ''}: ${one.note}`,
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

	/** Archiving a thread cancels its wakes, once the archive is stored */
	async function archiving(tx, threadId) {
		core.afterCommit(tx, () =>
			pending(threadId)
				.then((wakes) => Promise.all(wakes.map((one) => core.abortTask(one.id))))
				.catch((error) => console.error(error)),
		)
	}

	return {
		serve,
		archiving,
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
