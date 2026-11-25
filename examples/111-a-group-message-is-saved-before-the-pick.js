/** A group message is in the thread before the director picks; its pick comes after, on that message. A newer message cancels a running pick and one pick covers both, as does an @mention. */
import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import {
	answered,
	api,
	base,
	check,
	configDir,
	done,
	kill,
	routed,
	say,
	newest,
	repo,
	runner,
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
let releaseNobody
await scriptedRunner('laptop', async (request) => {
	const system = text(request.messages.find((m) => m.role === 'system') ?? { content: '' })
	if (system.startsWith('You choose who answers')) {
		const ask = text(request.messages.at(-1))
		const body = newest(ask)
		const saved = (await view(id)).entries.find((entry) => entry.data.body === body)
		picks.push({ body, ask, saved })
		if (body === 'hold this one') return new Promise((resolve) => (release = resolve))
		if (body === 'nothing for anyone') return new Promise((resolve) => (releaseNobody = resolve))
		return say(JSON.stringify({ choice: 'Jeroen', confidence: 0.9, reason: 'he knows' }))
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
const secondRouted = await routed(id, second.json.entry)
const byBody = async (body) => (await view(id)).entries.find((entry) => entry.data.body === body)
check(
	picks.length === 2 && picks[1].ask.includes('hold this one'),
	'a newer message cancels the running pick and its pick reads the older one',
	JSON.stringify(picks.map((pick) => pick.body)),
)
check(
	second.json.direct === true && !second.json.to.length && secondRouted?.to?.[0] === 'Jeroen',
	'the post answers before the pick, which then shows on its message',
	JSON.stringify({ posted: second.json, routed: secondRouted }),
)
const older = await byBody('hold this one')
check(
	!held.json.to?.length && !older?.data.to && !older?.data.picked,
	'the older message asks no one and says nothing; the newer pick covers it',
	JSON.stringify(older),
)
await answered(id, 3)
release?.(say(JSON.stringify({ choice: 'Jeroen', confidence: 0.9, reason: 'too late' })))

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

// `ade post` says the director asked nobody and returns, though someone else wrote while it picked, to a runner that's offline
const desk = await runner('desk')
const elsewhere = (await api('POST', '/api/threads', { title: 'elsewhere' })).json.id
await api('POST', `/api/threads/${elsewhere}/entries`, { body: 'hi', to: ['echo/echo@desk'] })
await answered(elsewhere)
await kill(desk)
await until(
	async () => !(await api('GET', '/api/runners')).json.find((r) => r.name === 'desk').online,
)
const posting = promisify(execFile)(
	process.execPath,
	['bin.js', '--server', base, 'post', '--thread', String(id), 'nothing for anyone'],
	{ cwd: repo, timeout: 30000 },
)
await until(async () => releaseNobody)
const offline = await api(
	'POST',
	`/api/threads/${id}/entries`,
	{ body: 'meanwhile, between us', to: ['echo/echo@desk'] },
	'ben',
)
releaseNobody(say(JSON.stringify({ choice: 'nobody', confidence: 0.9, reason: 'just a remark' })))
const { stderr } = await posting.catch((error) => error)
check(
	offline.status === 201 && stderr.includes('The director asked nobody: just a remark'),
	'ade post says the director asked nobody and returns, even while another message waits on an offline runner',
	JSON.stringify({ offline: offline.json, stderr }),
)
done()
