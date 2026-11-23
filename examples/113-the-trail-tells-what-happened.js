/**
 * A thread's trail tells each message's story from steps written with it, so a restart keeps it: whom it was posted to,
 * the director's wait and its pick with confidence, candidates and what it read, a run started and how it ended, and
 * a last step that says when nothing started.
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import {
	answered,
	api,
	check,
	configDir,
	done,
	kill,
	newest,
	say,
	scriptedRunner,
	server,
	text,
	until,
} from './lib.js'

writeFileSync(path.join(configDir, 'ade.json'), JSON.stringify({ director: { burst: 0.1 } }))
const modules = { MODULES: '+bots,-auto-title,-memory' }
let srv = await server(modules)
await scriptedRunner('laptop', async (request) => {
	const system = text(request.messages.find((m) => m.role === 'system') ?? { content: '' })
	if (system.startsWith('You choose who answers'))
		return say(JSON.stringify({ choice: 'nobody', confidence: 0.31, reason: 'nothing asked' }))
	if (text(request.messages.at(-1)).includes('break')) throw new Error('broken on purpose')
	return say(`${newest(text(request.messages.at(-1)))} heard`)
})
await api('POST', '/api/bots', { name: 'Jeroen', to: 'echo/echo@laptop' })
await api('POST', '/api/bots', { name: 'Kira', to: 'echo/echo@laptop' })
const { id } = (await api('POST', '/api/threads', { title: 'what happened' })).json
const post = async (body, to) =>
	(await api('POST', `/api/threads/${id}/entries`, { body, ...(to ? { to } : {}) })).json
const story = async (entry) => (await api('GET', `/api/threads/${id}/trail?entry=${entry}`)).json
const kinds = (steps) => steps.map((step) => step.kind).join(' → ')

const hello = await post('hello', ['Jeroen', 'Kira'])
await answered(id, 2)
const greeted = await until(async () => {
	const steps = await story(hello.entry)
	return steps.filter((step) => step.kind === 'answered').length === 2 && steps
})
check(
	kinds(greeted) === 'posted → started → answered → started → answered' &&
		greeted[0].to.join() === 'Jeroen,Kira',
	'a message asked by name: posted to whom, then each run started and answered',
	JSON.stringify(greeted),
)

const quiet = await post('anyone around?')
const picked = await story(quiet.entry)
const pick = picked.find((step) => step.kind === 'picked')?.chose
check(
	kinds(picked) === 'posted → waited → picked → nobody' &&
		picked[0].direct === true &&
		picked[1].ms >= 100 &&
		pick?.choice === 'nobody' &&
		pick.confidence === 0.31 &&
		pick.candidates.toSorted().join() === 'Jeroen,Kira' &&
		pick.read.includes(hello.entry) &&
		picked.at(-1).text === 'asked nobody, nothing started',
	"the director's wait and pick, with its confidence, candidates and what it read, and nothing started",
	JSON.stringify(picked),
)

const broken = await post('break, please', ['Jeroen'])
const failed = await until(async () => {
	const steps = await story(broken.entry)
	return steps.at(-1)?.kind === 'failed' && steps
})
check(
	kinds(failed) === 'posted → started → failed' && /broken on purpose/.test(failed.at(-1).reason),
	"a run that fails ends its message's story with why",
	JSON.stringify(failed),
)

await api('POST', `/api/threads/${id}/title`, { title: 'what happened then' })
await api('POST', `/api/threads/${id}/archive`, { archived: true })
await api('POST', `/api/threads/${id}/archive`, { archived: false })
await api('POST', '/api/bots', { name: 'Jeroen', instructions: 'Answer in one word.' })
const whole = (await api('GET', `/api/threads/${id}/trail`)).json
const changes = whole.filter((step) => step.entry === undefined)
check(
	changes[0].kind === 'created' &&
		changes[0].title === 'what happened' &&
		changes
			.filter((step) => step.kind === 'joined')
			.map((step) => step.agent)
			.toSorted()
			.join() === 'Jeroen,Kira' &&
		kinds(changes.slice(-3)) === 'renamed → archived → unarchived' &&
		changes.at(-3).from === 'what happened' &&
		changes.at(-3).to === 'what happened then',
	'what changed about the thread is a step too: created, each agent joining, renamed, archived and back',
	JSON.stringify(changes),
)
const jeroen = (await api('GET', '/api/bots')).json.find((bot) => bot.name === 'Jeroen')
const home = (await api('GET', `/api/threads/${jeroen.home}/trail`)).json
check(
	kinds(home.filter((step) => step.kind.startsWith('bot-'))) === 'bot-created → bot-changed' &&
		home.at(-1).instructions === 'Answer in one word.',
	"a bot's home keeps what became of the bot: made, then its instructions rewritten, with what they say now",
	JSON.stringify(home),
)

const before = (await api('GET', `/api/threads/${id}/trail`)).json
await kill(srv, 'SIGKILL')
srv = await server(modules)
const after = (await api('GET', `/api/threads/${id}/trail`)).json
check(
	after.length === before.length && JSON.stringify(after) === JSON.stringify(before),
	'a restart keeps the whole trail',
	JSON.stringify({ before: before.length, after: after.length }),
)
done()
