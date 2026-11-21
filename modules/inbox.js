/**
 * One inbox for every question agents ask you with `ask_person`, answered from there. Off by default; it needs
 * `blocked`, whose questions it lists: MODULES=+blocked,+inbox turns both on.
 *
 * `GET /api/inbox` answers the open questions, newest first: `[{thread, question, asker}]`, `question` being the thread's
 * `ask_person` message as the thread holds it and `asker` the conversation of the agent that asked, whom an answer goes to. A question stays until a person writes in its thread, the same rule that
 * keeps the thread blocked. `POST /api/threads/:id/inbox {dismiss: <message id>}` hides that question without
 * answering, if it's still the open one (else it answers `{dismissed: null}`); the thread's next question shows again. The dismissal is kept on the thread, so every device agrees.
 */
import { keyOf } from '../util.js'

export const on = false

export function server(core) {
	/** Each thread's open question, unless it was dismissed; archived threads have none */
	async function questions() {
		const found = await Promise.all(
			(await core.threadIds()).map(async (thread) => {
				const row = await core.thread(thread)
				if (row.hidden) return undefined
				const question = await core.openQuestion(thread, row)
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
			if ((await core.openQuestion(threadId, row, tx))?.id !== body.dismiss) return null
			row.dismissed = body.dismiss
			return body.dismiss
		})
		return { dismissed }
	}

	return { serve }
}
