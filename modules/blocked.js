/**
 * Agents can leave a question for a person; the thread waits on them until a person next writes, while the agent goes
 * on with its own work. A newer question replaces the older one. Off by default; MODULES=+blocked turns it on.
 */
import { obj, str } from '@earendil-works/pi-schema'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { writtenTo } from '../util.js'

export const on = false

export function server(core) {
	const askPerson = defineTool({
		name: 'ask_person',
		description:
			'Leave the person a decision only they can make. Returns at once; their reply arrives later as a message. A newer question replaces your open one.',
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
	return {
		extension: defineExtension({
			name: 'ade.blocked',
			tools: [askPerson],
			sections: [
				{
					key: 'blocked',
					tag: false,
					render: () =>
						"Use ask_person for any decision only the person can make, not only when you're stuck. Write it for someone coming in cold. Never ask what the code or this conversation already answers, and don't ask it again in your answer.",
				},
			],
		}),
		/** The thread's open question: its newest `ask_person` message, unless a person has written since */
		openQuestion: async (id, row) => {
			const latest = await core.latestMessage(
				id,
				(entry) => entry.data.waitingOnPerson || core.person(row, entry),
			)
			return latest?.data.waitingOnPerson === true ? latest : undefined
		},
	}
}
