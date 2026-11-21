/** Two people in one thread: each gets their own pick, a pick holds while someone types, and one agent with two people asks the director before it answers; a paused thread answers only @mentions. */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import {
	answered,
	api,
	check,
	configDir,
	done,
	newest,
	say,
	scriptedRunner,
	server,
	sleep,
	text,
	until,
	view,
} from './lib.js'

writeFileSync(path.join(configDir, 'ade.json'), JSON.stringify({ director: { burst: 0.3 } }))
await server({ MODULES: '+bots,-auto-title,-memory' })
/** Each pick's newest message, as the chooser read it */
const picked = []
await scriptedRunner('laptop', async (request) => {
	const system = text(request.messages.find((m) => m.role === 'system') ?? { content: '' })
	if (system.startsWith('You choose who answers')) {
		const body = newest(text(request.messages.at(-1)))
		picked.push(body)
		const choice = body.includes('lunch') ? 'nobody' : body.includes('you all') ? 'all' : 'Jeroen'
		return say(JSON.stringify({ choice, confidence: 0.9, reason: 'scripted' }))
	}
	return say(system.includes('You are Jeroen in thread') ? 'Jeroen here' : 'agent here')
})
await api('POST', '/api/bots', { name: 'Jeroen', to: 'echo/echo@laptop' })
const post = (id, body, as, to) =>
	api('POST', `/api/threads/${id}/entries`, { body, ...(to === undefined ? {} : { to }) }, as)
const typing = (id, on, as) => api('POST', `/api/threads/${id}/typing`, { typing: on }, as)
const message = async (id, body) =>
	(await view(id)).entries.find((entry) => entry.data.body === body)?.data

const { id } = (await api('POST', '/api/threads', { title: 'two people' })).json
await post(id, 'hello', undefined, ['echo/echo@laptop', 'Jeroen'])
await answered(id, 2)

// Someone else's message never takes over yours
const mine = post(id, 'what does Jeroen think?')
await until(async () => message(id, 'what does Jeroen think?'))
await post(id, 'and what about tests?', 'dee')
await mine
check(
	picked.includes('what does Jeroen think?') && picked.includes('and what about tests?'),
	'each person’s message gets its own pick',
	JSON.stringify(picked),
)
check(
	(await message(id, 'what does Jeroen think?'))?.to?.[0] === 'Jeroen' &&
		(await message(id, 'and what about tests?'))?.to?.[0] === 'Jeroen',
	'neither question is dropped',
)
await answered(id, 4)

// While someone types, the pick waits; when they stop, it goes on
const said = await typing(id, true, 'dee')
check(said.status === 201, 'a person can say they’re typing', JSON.stringify(said))
const held = post(id, 'is this ready?')
await sleep(1500)
check(
	!picked.includes('is this ready?'),
	'while someone types, the pick waits',
	JSON.stringify(picked),
)
const mention = await post(id, '@Jeroen quick one', 'ann')
check(mention.json.to?.[0] === 'Jeroen', 'an @mention skips the wait')
await typing(id, false, 'dee')
await held
check(picked.includes('is this ready?'), 'once they stop typing, the pick goes on')

// One agent with two people writing: the director decides whether it's for the agent
const pair = (await api('POST', '/api/threads', { title: 'one agent' })).json.id
await post(pair, 'hi', undefined, 'echo/echo@laptop')
await answered(pair)
const before = picked.length
await post(pair, 'oskar, lunch at one?', 'dee')
await sleep(500)
check(
	picked.length === before + 1 && !(await message(pair, 'oskar, lunch at one?'))?.to,
	'one agent and two people: a message for the other person gets no answer',
	JSON.stringify(await message(pair, 'oskar, lunch at one?')),
)

// A message to everyone gets every agent's answer, one after another
const all = await post(id, 'what do you all think?')
check(
	all.json.to?.length === 2 && all.json.to.includes('Jeroen'),
	'asking everyone picks every agent, each in turn',
	JSON.stringify(all.json),
)
await answered(id, 8)

// Paused, only @mentions and named recipients get an answer; resuming replays nothing
await api('POST', `/api/threads/${id}/pause`, { paused: true })
const quiet = picked.length
await post(id, 'anyone there?')
const mentioned = await post(id, '@Jeroen you there?')
check(
	picked.length === quiet &&
		!(await message(id, 'anyone there?'))?.to &&
		mentioned.json.to?.[0] === 'Jeroen',
	'paused: a message naming no one gets no pick, an @mention still answers',
)
await api('POST', `/api/threads/${id}/pause`, { paused: false })
await post(id, 'back again?')
check(
	picked.length === quiet + 1 && picked.at(-1) === 'back again?',
	'resumed: the next message gets a pick, and nothing from the pause is picked again',
	JSON.stringify(picked.slice(quiet)),
)
done()
