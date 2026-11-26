/**
 * A bot is its home thread and its name a label: renamed, it keeps its agent and history in every thread it's in, and
 * answers once, under its new name, a message that asked it by the old one, even while the director was picking it,
 * and a task that asks it there still does, without skipping a run. A bot forgotten and made again under its name is
 * two bots: its name, by `to` or @mention, asks the new one. `to` can name a bot alone, by name or home.
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
/** Answers held back until the example lets them go, by the words their newest message ends with */
const gates = new Map()
const gate = (word) => {
	let open
	gates.set(word, new Promise((resolve) => (open = resolve)))
	return open
}
await scriptedRunner('laptop', async (request) => {
	const asked = text(request.messages.findLast((m) => m.role === 'user') ?? { content: '' })
	for (const [word, held] of gates) if (asked.trimEnd().endsWith(word)) await held
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

// A bot alone, by name or by home
const byName = await api('POST', `/api/threads/${id}/entries`, {
	body: 'by name',
	to: { name: 'finch' },
})
const byHome = await api('POST', `/api/threads/${id}/entries`, {
	body: 'by home',
	to: { home: before.to.home },
})
thread = await answered(id, 6)
check(
	byName.status === 201 &&
		byHome.status === 201 &&
		answers(thread)
			.slice(-2)
			.every((answer) => answer.data.author === 'finch'),
	'`to` names a bot by its name or its home alone, and it runs as it does',
	JSON.stringify([byName.json, byHome.json]),
)

// Renamed mid-run, with other work going on in its thread, a repeating task's next run still comes
const letAgentGo = gate('busy work')
await api('POST', `/api/threads/${id}/entries`, { body: 'busy work', to: 'echo/echo@laptop' })
await until(async () => (await view(id)).status === 'working')
const letBotGo = gate('the noon brief')
const repeating = await api('POST', '/api/schedule', {
	instructions: 'the noon brief',
	thread: id,
	recipients: ['finch'],
	every: '1m',
	in: '4s',
})
await api('POST', '/api/schedule', { run: repeating.json.id })
await until(async () =>
	(await view(id)).entries.some((entry) => entry.data.body === 'the noon brief'),
)
await api('POST', '/api/bots', { name: 'finch', rename: 'heron' })
letBotGo()
await until(async () => answers(await view(id)).some((answer) => answer.data.author === 'heron'))
const nextRun = await until(async () => {
	const task = (await api('GET', '/api/schedule')).json.find((one) => one.id === repeating.json.id)
	return task?.runs.length > 1 && task.runs.at(-1)
}, 15000)
letAgentGo()
check(
	nextRun && !nextRun.skipped,
	'a repeating task whose bot was renamed while it answered runs again on time, with other work still going in its thread',
	JSON.stringify(nextRun),
)
await api('POST', '/api/schedule', { cancel: repeating.json.id })
await until(async () => (await view(id)).status === 'idle')

// Forgotten and made again under the same name, the name asks the new bot, whichever way it's named
await api('DELETE', '/api/bots/heron')
await api('POST', '/api/bots', { name: 'heron', to: 'echo/echo@laptop' })
const herConversation = (await view(id)).agents.find(
	(agent) => agent.to?.home === before.to.home,
)?.conversation
const sofar = answers(await view(id)).length
await api('POST', `/api/threads/${id}/entries`, { body: 'heron by to', to: 'heron' })
await answered(id, sofar + 1)
await api('POST', `/api/threads/${id}/entries`, { body: '@heron by mention' })
thread = await answered(id, sofar + 2)
const replies2 = ['heron by to', '@heron by mention'].map((body) => {
	const asked2 = thread.entries.find((entry) => entry.data.body === body)
	return thread.entries.find((entry) => entry.data.re?.includes(asked2?.id))
})
check(
	replies2.every((reply) => reply?.data.answer) &&
		replies2[0].data.answer.conversation === replies2[1].data.answer.conversation &&
		replies2[0].data.answer.conversation !== herConversation,
	'a bot forgotten and made again under its name is another bot: `to` and @mention both ask the new one',
	JSON.stringify([replies2, herConversation]),
)
done()
