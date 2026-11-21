/**
 * Agents can leave a question for a person; the thread waits on them until a person next writes, while the agent
 * goes on with its own work. A newer question replaces the older one. Every open question also lists in one inbox,
 * answered from there. Off by default; MODULES=+inbox turns it on.
 *
 * `GET /api/inbox` answers the open questions, newest first: `[{thread, question, asker}]`, `question` being the thread's
 * `ask_person` message as the thread holds it and `asker` the conversation of the agent that asked, whom an answer goes to. A question stays until a person writes in its thread, the same rule that
 * keeps the thread blocked. `POST /api/threads/:id/inbox {dismiss: <message id>}` hides that question without
 * answering, if it's still the open one (else it answers `{dismissed: null}`); the thread's next question shows again. The dismissal is kept on the thread, so every device agrees.
 */
import { obj, str } from '@earendil-works/pi-schema'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { keyOf, writtenTo } from '../util.js'

export const on = false

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
				return { thread, question, asker }
			}),
		)
		const time = ({ question }) => question.data.createdAt ?? ''
		return found.filter(Boolean).sort((a, b) => (time(a) < time(b) ? 1 : -1))
	}

	async function serve(threadId, _query, body) {
		if (threadId === undefined) {
			if (body !== undefined) throw new Error('Dismiss a question in its thread')
			return questions()
		}
		if (!Number.isInteger(body?.dismiss)) throw new Error('dismiss is the question message id')
		await core.conversation(threadId)
		// Only the question still open: a late dismissal of an older one must not hide a newer one
		const dismissed = await core.commit(async (tx) => {
			const row = await core.threadIn(tx, threadId)
			if ((await openQuestion(threadId, row, tx))?.id !== body.dismiss) return null
			row.dismissed = body.dismiss
			return body.dismiss
		})
		return { dismissed }
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
