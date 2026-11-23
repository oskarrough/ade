/**
 * Agents can leave a question for a person; the thread waits on them until a person next writes, while the agent
 * goes on with its own work. A newer question replaces the older one. Every open question also lists in one inbox,
 * answered from there. On by default; MODULES=-inbox turns it off.
 *
 * `GET /api/inbox` answers what needs you, most pressing first. Open questions, newest first:
 * `{thread, kind: 'question', question, asker}`, `question` being the thread's `ask_person` message as the thread holds
 * it and `asker` the conversation of the agent that asked, whom an answer goes to. A question stays until a person writes
 * in its thread, the same rule that keeps the thread blocked; everyone sees it. Then, for you alone and only in threads you
 * wrote in, the ones the sidebar dots as failed or unread, newest first: `{thread, kind: 'failed' | 'answered', message}`,
 * the message behind it. Those leave once you read the thread (`POST /api/threads/:id/read`), which is also how to
 * dismiss one. `POST /api/threads/:id/inbox {dismiss: <message id>}` hides that question without
 * answering, if it's still the open one (else it answers `{dismissed: null}`); the thread's next question shows again. The dismissal is kept on the thread, so every device agrees.
 */
import { obj, str } from '@earendil-works/pi-schema'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { keyOf, writtenTo } from '../util.js'

export const on = true

export function server(core) {
	const askPerson = defineTool({
		name: 'ask_person',
		description:
			'Leave the person a decision only they can make. Returns at once; their reply arrives later as a message.',
		parameters: obj({
			body: str({
				description:
					'The question first, then one to three plain sentences on what it affects and what you know, then the options if there are any, with the one you recommend',
			}),
		}),
		replay: 'safe',
		execute: async ({ body }, api) => {
			if (!body.trim()) throw new Error('body is required')
			const { thread, name } = await core.home(api.conversationId)
			const author = writtenTo(await core.agentOf(api.conversationId, name))
			return core.once(`ask_person ${api.taskId}`, 'ask_person', async (tx) => {
				await core.post(
					tx,
					thread,
					{ author, body: body.trim(), waitingOnPerson: true },
					{ member: true },
				)
				return {
					output: [
						{
							type: 'text',
							text: 'Asked. Go on with whatever does not depend on the answer, or end your turn; their reply arrives as a message.',
						},
					],
				}
			})
		},
	})

	/** Each thread's open question, unless it was dismissed; archived threads have none */
	async function questions() {
		const found = await Promise.all(
			(await core.threadIds()).map(async (thread) => {
				const row = await core.thread(thread)
				if (row.hidden) return undefined
				const question = await openQuestion(thread, row)
				if (!question || question.id === row.dismissed) return undefined
				/** The conversation of the agent that asked, whom an answer from the inbox goes to */
				const asker = row.agents[keyOf(question.data.author)]?.conversation ?? null
				const askerTo = asker ? await core.agentOf(asker, keyOf(question.data.author)) : null
				return { thread, kind: 'question', question, asker, askerTo }
			}),
		)
		return found.filter(Boolean).sort(newest)
	}

	/**
	 * What else needs `reader`, as the sidebar's dots say it: a thread whose last run failed (`error`) or whose answer
	 * they haven't read (`done`), but only where they wrote; a thread agents keep among themselves never comes. Each
	 * carries the message behind it, and leaves once they read the thread.
	 */
	async function unread(reader) {
		if (!reader) return []
		const found = await Promise.all(
			(await core.threadList(reader)).map(async (row) => {
				if (!['done', 'error'].includes(row.status)) return undefined
				if (!(await core.concerns(row.id, reader))) return undefined
				// As the status reads it: a `$ cmd` someone stopped is neither an answer nor a failure
				const message = await core.latestMessage(
					row.id,
					({ data }) =>
						Boolean(data.answer || data.error || data.shell) && data.shell?.error !== 'stopped',
				)
				if (!message) return undefined
				const failed = Boolean(message.data.error || message.data.shell?.error)
				// Your own `$ cmd` that ran fine is nothing to read
				if (!failed && !message.data.answer) return undefined
				return { thread: row.id, kind: failed ? 'failed' : 'answered', message }
			}),
		)
		const items = found.filter(Boolean).sort(newest)
		return [
			...items.filter((item) => item.kind === 'failed'),
			...items.filter((item) => item.kind === 'answered'),
		]
	}
	const newest = (a, b) => (time(a) < time(b) ? 1 : -1)
	const time = (item) => (item.question ?? item.message).data.createdAt ?? ''

	const list = async (reader) => {
		const asked = await questions()
		const waiting = new Set(asked.map((item) => item.thread))
		return [...asked, ...(await unread(reader)).filter((item) => !waiting.has(item.thread))]
	}
	core.feed.define('inbox', {
		perViewer: true,
		keyOf: (item) => `${item.kind} ${item.thread}`,
		all: list,
		match: (change) => {
			if (change.type === 'entry') return change.value.kind === 'ade.message'
			if (change.type === 'document') return change.record.kind === 'ade.thread'
			if (change.type === 'task') return core.isWork(change.value.kind)
			if (change.type === 'conversation') return !change.value.owner
			return false
		},
	})

	async function serve(threadId, _query, body, reader) {
		if (threadId === undefined) {
			if (body !== undefined) throw new Error('Dismiss a question in its thread')
			return list(reader)
		}
		if (!Number.isInteger(body?.dismiss)) throw new Error('dismiss is the question message id')
		await core.conversation(threadId)
		// Only the question still open: a late dismissal of an older one must not hide a newer one
		return core.once(
			core.scopedKey(`dismiss ${threadId}`, body.key),
			`dismiss ${threadId}`,
			async (tx) => {
				const row = await core.threadIn(tx, threadId)
				if ((await openQuestion(threadId, row, tx))?.id !== body.dismiss) return { dismissed: null }
				row.dismissed = body.dismiss
				return { dismissed: body.dismiss }
			},
		)
	}

	/** The thread's open question: its newest `ask_person` message, unless a person has written since; with `tx`, read in that commit */
	async function openQuestion(id, row, tx) {
		const latest = await core.latestMessage(
			id,
			(entry) => entry.data.waitingOnPerson || core.person(row, entry),
			undefined,
			tx,
		)
		return latest?.data.waitingOnPerson === true ? latest : undefined
	}

	return {
		extension: defineExtension({
			name: 'ade.inbox',
			tools: [askPerson],
			sections: [
				{
					key: 'inbox',
					tag: false,
					render: () =>
						"Use ask_person for any decision only the person can make, not only when you're stuck. Write it for someone coming in cold. Never ask what the code or this conversation already answers, and don't ask it again in your answer.",
				},
			],
		}),
		serve,
		openQuestion,
	}
}
