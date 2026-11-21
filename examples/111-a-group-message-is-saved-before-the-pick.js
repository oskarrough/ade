/** A group message is in the thread before the director picks; its pick comes after, on that message. A newer message cancels a running pick and one pick covers both, as does an @mention. */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import {
	answered,
	api,
	check,
	configDir,
	done,
	say,
	scriptedRunner,
	server,
	text,
	until,
	view,
} from './lib.js'

// A second of quiet: room for the @mention below to land before the pick starts
writeFileSync(path.join(configDir, 'ade.json'), JSON.stringify({ director: { burst: 1 } }))
await server({ MODULES: '+bots,-auto-title,-memory' })
const { id } = (await api('POST', '/api/threads', { title: 'saved first' })).json
/** What the thread held when each pick began, and what each pick read */
const picks = []
let release
await scriptedRunner('laptop', async (request) => {
	const system = text(request.messages.find((m) => m.role === 'system') ?? { content: '' })
	if (system.startsWith('You choose who answers')) {
		const ask = text(request.messages.at(-1))
		const body = ask.match(/New message: \[[^\]]+\] (.*)/)?.[1] ?? ''
		const saved = (await view(id)).entries.find((entry) => entry.data.body === body)
		picks.push({ body, ask, saved })
		if (body === 'hold this one') return new Promise((resolve) => (release = resolve))
		return say('Jeroen: he knows')
	}
	return say(system.includes('You are Jeroen in thread') ? 'Jeroen here' : 'agent here')
})
await api('POST', '/api/bots', { name: 'Jeroen', to: 'echo/echo@laptop' })
const post = (body, to) =>
	api('POST', `/api/threads/${id}/entries`, { body, ...(to === undefined ? {} : { to }) })
await post('hello', ['echo/echo@laptop', 'Jeroen'])
await answered(id, 2)

const first = post('hold this one')
await until(async () => picks.length === 1)
check(
	picks[0].saved && !picks[0].saved.data.to && !picks[0].saved.data.picked,
	'the message is in the thread while the director picks, asking no one yet',
	JSON.stringify(picks[0].saved),
)
const second = await post('and this too')
const held = await first
const byBody = async (body) => (await view(id)).entries.find((entry) => entry.data.body === body)
check(
	picks.length === 2 && picks[1].ask.includes('hold this one'),
	'a newer message cancels the running pick and its pick reads the older one',
	JSON.stringify(picks.map((pick) => pick.body)),
)
check(
	second.json.to?.[0] === 'Jeroen' && (await byBody('and this too'))?.data.to?.[0] === 'Jeroen',
	'the pick shows on its message, and the post answers with it',
	JSON.stringify(second.json),
)
const older = await byBody('hold this one')
check(
	!held.json.to?.length && !older?.data.to && !older?.data.picked,
	'the older message asks no one and says nothing; the newer pick covers it',
	JSON.stringify(older),
)
await answered(id, 3)
release?.(say('Jeroen: too late'))

const free = post('who knows?')
await until(async () => byBody('who knows?'))
const mention = await post('@Jeroen you first')
const waited = await free
check(
	!picks.some((pick) => pick.body === 'who knows?') &&
		!waited.json.to?.length &&
		mention.json.to?.[0] === 'Jeroen',
	'an @mention while a message waits for its pick takes it over: only the bot it asks answers',
	JSON.stringify({ picks: picks.map((pick) => pick.body), waited: waited.json }),
)
done()
