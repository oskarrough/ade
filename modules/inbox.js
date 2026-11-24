/**
 * Agents can leave a question for a person; the thread waits on them until a person next writes, while the agent
 * goes on with its own work. A newer question replaces the older one. Every open question also lists in one inbox,
 * answered from there. On by default; MODULES=-inbox turns it off.
 *
 * `GET /api/inbox` answers what needs you, most pressing first. Open questions, newest first:
 * `{thread, kind: 'question', question, asker}`, `question` being the thread's `ask_person` message as the thread holds
 * it and `asker` the conversation of the agent that asked, whom an answer goes to. A question stays until someone other
 * than the agent that asked writes in its thread - a person, or another agent answering on their behalf; the asking
 * agent's own later turns don't count. Everyone sees it; the trail says who closed it. Then, for you alone and only in threads you
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

	/**
	 * What a thread holds for `reader`, if anything; an archived one holds nothing. Its open question, unless it was
	 * dismissed. Else, as the sidebar's dots say it and only where they wrote: its last run failed (`error`) or its
	 * answer they haven't read (`done`), with the message behind it, which leaves once they read the thread.
	 */
	async function itemOf(thread, reader, work) {
		const row = await core.thread(thread)
		if (!row || row.hidden) return undefined
		const question = await openQuestion(thread, row)
		if (question) {
			if (question.id === row.dismissed) return undefined
			/** The conversation of the agent that asked, whom an answer from the inbox goes to */
			const asker = row.agents[keyOf(question.data.author)]?.conversation ?? null
			const askerTo = asker ? await core.agentOf(asker, keyOf(question.data.author)) : null
			return { thread, kind: 'question', question, asker, askerTo }
		}
		const jobs = work.filter((job) => job.thread === thread)
		if (!reader || !['done', 'error'].includes(await core.statusOf(thread, jobs, reader)))
			return undefined
		// As the status reads it: a `$ cmd` someone stopped is neither an answer nor a failure
		const message = await core.latestMessage(
			thread,
			({ data }) =>
				Boolean(data.answer || data.error || data.shell) && data.shell?.error !== 'stopped',
		)
		const failed = Boolean(message?.data.error || message?.data.shell?.error)
		// Your own `$ cmd` that ran fine is nothing to read
		if (!failed && !message?.data.answer) return undefined
		return { thread, kind: failed ? 'failed' : 'answered', message }
	}
	const KINDS = ['question', 'failed', 'answered']
	const time = (item) => (item.question ?? item.message).data.createdAt ?? ''

	/** Every thread's, most pressing first: questions, failed runs, then answers, each newest first */
	const list = async (reader) => {
		const work = await core.work()
		const items = await Promise.all(core.threadIds().map((thread) => itemOf(thread, reader, work)))
		return KINDS.flatMap((kind) =>
			items.filter((item) => item?.kind === kind).sort((a, b) => (time(a) < time(b) ? 1 : -1)),
		)
	}
	core.feed.define('inbox', {
		perViewer: true,
		keyOf: (item) => `${item.kind} ${item.thread}`,
		all: list,
		/** A touched thread's item under its kind, and nothing under the others */
		rows: async (threads, reader) => {
			const work = await core.work()
			const items = await Promise.all(threads.map((thread) => itemOf(thread, reader, work)))
			return threads.flatMap((thread, index) =>
				KINDS.map((kind) => [
					`${kind} ${thread}`,
					items[index]?.kind === kind ? items[index] : null,
				]),
			)
		},
		match: core.threadMatch,
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

	/**
	 * The thread's open question: its newest `ask_person` message, unless someone other than the agent that asked has
	 * written since - a person, or another agent answering for them; the asking agent's own later turns don't count.
	 * With `tx`, read in that commit; with `before`, as it stood before that message. Read back from the thread's end
	 * only until two have written: whoever asked before them, one of the two has answered.
	 */
	async function openQuestion(id, _row, tx, before = Infinity) {
		const since = new Set()
		const found = await core.latestMessage(
			id,
			({ id, data }) => {
				if (id >= before) return false
				if (data.waitingOnPerson === true) return true
				if (!data.stopped) since.add(data.author)
				return since.size > 1
			},
			undefined,
			tx,
		)
		if (found?.data.waitingOnPerson !== true) return undefined
		since.delete(found.data.author)
		return since.size ? undefined : found
	}
	/** Each thread whose newest question is open, as `openQuestion` finds it, from the read model's tables: no one but
	 * its asker wrote after it, but to stop */
	const openQuestions = (all) =>
		all(
			`select asked.thread_id as id from ade_messages asked
			where asked.kind = 'question'
				and asked.id = (select max(id) from ade_messages where thread_id = asked.thread_id and kind = 'question')
				and not exists (select 1 from ade_messages later where later.thread_id = asked.thread_id and later.id > asked.id
					and later.kind != 'stopped' and later.author != asked.author)`,
		).map((row) => row.id)

	/**
	 * When someone other than the asker closes a question, the trail says who. Reading the thread's other entries
	 * can't happen in the same commit as this one's write, so it's done after, in a commit of its own.
	 */
	function posted(tx, threadId, entry) {
		if (entry.data.waitingOnPerson || entry.data.stopped) return
		core.afterCommit(tx, () =>
			core
				.commit((fresh) => noteClosed(fresh, threadId, entry))
				.catch((error) => console.error(`inbox: thread ${threadId}: ${error.message}`)),
		)
	}

	async function noteClosed(tx, threadId, entry) {
		const question = await openQuestion(threadId, undefined, tx, entry.id)
		if (question && question.data.author !== entry.data.author)
			await core.trailed(tx, threadId, question.id, 'question-answered', { by: entry.data.author })
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
		openQuestions,
		posted,
	}
}
