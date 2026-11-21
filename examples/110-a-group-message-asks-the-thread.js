/** A mention asks a bot once, and one not in the thread yet joins as if picked from the @ list; the next group message
 * asks the director, including the thread's own agent. Failed picks never stick to the last bot. */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import {
	answered,
	api,
	check,
	configDir,
	done,
	say,
	newest,
	scriptedRunner,
	server,
	text,
	view,
} from './lib.js'

writeFileSync(
	path.join(configDir, 'ade.json'),
	JSON.stringify({ director: { timeout: 0.5, burst: 0.1 } }),
)
await server({ MODULES: '+bots,-auto-title,-memory' })
let choosing = 0
await scriptedRunner('laptop', async (request) => {
	const system = text(request.messages.find((m) => m.role === 'system') ?? { content: '' })
	if (system.startsWith('You choose who answers')) {
		choosing++
		const message = newest(text(request.messages.at(-1)))
		if (message.includes('timeout')) return new Promise(() => {})
		if (message.includes('error')) throw new Error('chooser unavailable')
		if (message.includes('unknown'))
			return say(JSON.stringify({ choice: 'Stranger', confidence: 0.9, reason: 'both can answer' }))
		return say(
			JSON.stringify({
				choice: 'agent',
				confidence: 0.9,
				reason: 'the question is for the thread agent',
			}),
		)
	}
	return say(system.includes('You are Jeroen in thread') ? 'Jeroen here' : 'agent here')
})
const post = (id, body, to) =>
	api('POST', `/api/threads/${id}/entries`, { body, ...(to === undefined ? {} : { to }) })
const message = async (id, body) =>
	(await view(id)).entries.findLast((entry) => entry.data.body === body)?.data
await api('POST', '/api/bots', { name: 'Jeroen', to: 'echo/echo@laptop' })
await api('POST', '/api/bots', { name: 'Ada', to: 'echo/echo@laptop' })
check(
	(await api('GET', '/api/server')).json.settings.director.picks === true,
	'group picks are on without a configured chooser',
)
const { id } = (await api('POST', '/api/threads', { title: 'group routing' })).json
await post(id, 'hello', 'echo/echo@laptop')
await answered(id)
await post(id, 'join us', 'Jeroen')
await answered(id, 2)
await post(id, '@Jeroen')
await answered(id, 3)
check(choosing === 0, 'an @mention makes no chooser call')
await post(id, 'terra are you still here?')
await answered(id, 4)
check(
	(await message(id, 'terra are you still here?'))?.to?.[0] === 'echo@laptop',
	'after @Jeroen, the next question reaches the thread agent',
)
check(
	choosing === 1 &&
		(await message(id, 'terra are you still here?'))?.picked ===
			'the question is for the thread agent',
	'one bot plus the agent is a group and the chooser selects its agent',
)
for (const failure of ['unknown', 'error', 'timeout']) {
	await post(id, '@Jeroen')
	await answered(id, 5 + ['unknown', 'error', 'timeout'].indexOf(failure) * 2)
	const body = `chooser ${failure}`
	await post(id, body)
	await answered(id, 6 + ['unknown', 'error', 'timeout'].indexOf(failure) * 2)
	const data = await message(id, body)
	check(
		data?.to?.[0] === 'echo@laptop' && data.picked?.startsWith('Pick failed:'),
		`${failure}: the agent answers and the message says the pick failed`,
		JSON.stringify(data),
	)
	if (failure === 'timeout')
		check(
			data?.picked === "Pick failed: the chooser timed out. The thread's agent answers.",
			'a timeout is identified as a timeout',
			JSON.stringify(data),
		)
}
// Typing a bot's name that isn't in the thread yet, without picking it from the list, invites it all the same
const picks = choosing
await post(id, '@Ada can you join?')
await answered(id, 11)
check(
	choosing === picks && (await message(id, '@Ada can you join?'))?.to?.join() === 'Ada',
	'a typed @mention of a bot not yet here asks it, with no pick',
	JSON.stringify(await message(id, '@Ada can you join?')),
)
check(
	(await view(id)).agents.some((agent) => agent.name === 'Ada'),
	'and she is in the thread from then on',
)
const bots = (await api('POST', '/api/threads', { title: 'bots only' })).json.id
await post(bots, 'hello', ['Jeroen', 'Ada'])
await answered(bots, 2)
await post(bots, 'chooser unknown')
const failed = await message(bots, 'chooser unknown')
check(
	!failed?.to && failed?.picked?.startsWith('Pick failed:'),
	'a bot-only group reports a failed pick without asking the last bot',
	JSON.stringify(failed),
)
const solo = (await api('POST', '/api/threads', { title: 'solo' })).json.id
await post(solo, 'hello', 'Jeroen')
await answered(solo)
const before = choosing
await post(solo, 'again')
await answered(solo, 2)
check(
	choosing === before && (await message(solo, 'again'))?.to?.[0] === 'Jeroen',
	'solo chats still ask the sole participant without a chooser call',
)
done()
