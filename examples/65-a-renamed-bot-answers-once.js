/**
 * A bot is its home thread and its name a label: renamed, it keeps its agent and history in every thread it's in, and
 * answers once, under its new name, a message that asked it by the old one, even while the director was picking it,
 * and a task that asks it there still does.
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import {
	answered,
	answers,
	api,
	check,
	configDir,
	conversationOf,
	done,
	newest,
	routed,
	say,
	scriptedRunner,
	server,
	text,
	until,
	view,
} from './lib.js'

writeFileSync(path.join(configDir, 'ade.json'), JSON.stringify({ director: { burst: 0.3 } }))
await server({ MODULES: '+bots,+schedule,-auto-title,-memory' })
let renaming
await scriptedRunner('laptop', async (request) => {
	const system = request.messages
		.filter((m) => m.role === 'system')
		.map(text)
		.join('\n')
	if (system.startsWith('You choose who answers')) {
		// The chooser sees her as wren; she's renamed before its pick lands
		if (newest(text(request.messages.at(-1))).includes('wren, mid-pick'))
			await (renaming = api('POST', '/api/bots', { name: 'wren', rename: 'robin' }))
		return say(JSON.stringify({ choice: 'wren', confidence: 0.9, reason: 'scripted' }))
	}
	// The name she has now, from her section as it last changed
	const names = [...JSON.stringify(request.messages).matchAll(/You are the bot (\w+)/g)]
	return say(names.at(-1)?.[1] ?? 'agent here')
})
await api('POST', '/api/bots', { name: 'wren', to: 'echo/echo@laptop' })
const { id } = (await api('POST', '/api/threads', { title: 'a group' })).json
await api('POST', `/api/threads/${id}/entries`, {
	body: 'hello both',
	to: ['echo/echo@laptop', 'wren'],
})
let thread = await answered(id, 2)
const before = thread.agents.find((agent) => agent.name === 'wren')
const herFirst = thread.entries.find((entry) => entry.data.author === 'wren')

const asked = await api('POST', `/api/threads/${id}/entries`, { body: 'wren, mid-pick' })
const message = await routed(id, asked.json.entry)
await renaming
thread = await answered(id, 3)
const replies = thread.entries.filter((entry) => entry.data.re?.includes(asked.json.entry))
const robin = thread.agents.filter((agent) => agent.to?.name)
const handed = (await conversationOf(thread, 'robin')).entries
	.filter((entry) => entry.kind === 'ade.delivery')
	.flatMap((entry) => entry.data.held)
check(
	message?.to?.join() === 'robin' &&
		replies.length === 1 &&
		replies[0].data.author === 'robin' &&
		replies[0].data.body === 'robin' &&
		robin.length === 1 &&
		robin[0].name === 'robin' &&
		robin[0].conversation === before.conversation &&
		handed.includes(asked.json.entry) &&
		!handed.includes(herFirst.id),
	'a bot renamed while the director picks her answers once, as robin, in the conversation she had, and never reads her own answer from before',
	JSON.stringify([message, replies, thread.agents, handed]),
)
check(
	thread.entries.find((entry) => entry.id === herFirst.id)?.data.author === 'wren' &&
		(await api('POST', `/api/threads/${id}/entries`, { body: 'hi', to: 'wren' })).status === 400,
	'what she wrote before keeps the name she had, which asks no one now',
)

// A task that asks her there still finds her
const task = await api('POST', '/api/schedule', {
	instructions: 'robin, the morning brief',
	thread: id,
	recipients: ['robin'],
	at: Date.now() + 3_600_000,
})
await api('POST', '/api/bots', { name: 'robin', rename: 'finch' })
const listed = await until(async () =>
	(await api('GET', '/api/schedule')).json.find((one) => one.id === task.json.id),
)
await api('POST', '/api/schedule', { run: task.json.id })
thread = (await answered(id, 4)) ?? (await view(id))
const brief = thread.entries.find((entry) => entry.data.body === 'robin, the morning brief')
check(
	listed?.recipients?.join() === 'finch' &&
		brief?.data.to?.join() === 'finch' &&
		answers(thread).at(-1)?.data.body === 'finch',
	'a task set to ask her by one name asks her after she takes another',
	JSON.stringify([task.json, listed, brief, answers(thread).at(-1)]),
)
done()
