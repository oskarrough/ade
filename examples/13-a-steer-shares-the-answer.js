/** A steer joins the answer being written, and another thread's post steers like a person's Enter; a stop withdraws the follow-ups queued behind it, and the next input carries them; a message waiting behind a run that fails still gets its answer; a waiting message its author takes back never reaches the agent, and once read it can't be */
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import {
	executing,
	createThread,
	postEntry,
	answered,
	answers,
	api,
	brief,
	call,
	check,
	conversationOf,
	done,
	owner,
	quiet,
	say,
	scriptedRunner,
	server,
	text,
	until,
	view,
} from './lib.js'

await server()
const bot = await scriptedRunner('bot', (request) =>
	request.messages.some((m) => m.role === 'toolResult')
		? say('answered both')
		: call('bash', { command: 'sleep 0.5' }),
)
const to = { runner: 'bot', model: 'echo/echo' }
const id = await createThread('steer')
const first = (await api('POST', `/api/threads/${id}/entries`, { body: 'first', to, steer: true }))
	.json.entry
check(Boolean(await executing()), 'the first input is inside its tool call')
const second = (
	await api('POST', `/api/threads/${id}/entries`, { body: 'second', to, steer: true })
).json.entry
const v = (await answered(id)) ?? (await view(id))
const inputs = (await conversationOf(v, 'echo/echo@bot')).entries
	.filter((e) => e.kind === 'ade.delivery')
	.map((e) => text(e.model[0]))
check(inputs.includes('second'), 'Pi placed the steer', JSON.stringify(inputs))
check(answers(v).length === 1, 'both inputs share one answer')
check(
	JSON.stringify(answers(v)[0]?.data.re) === JSON.stringify([first, second]),
	'the answer says it answers both',
	JSON.stringify(answers(v)[0]?.data.re),
)
const idle = (
	await api('POST', `/api/threads/${id}/entries`, { body: 'idle again', to, steer: true })
).json.entry
const restarted = await answered(id, 2)
check(
	restarted &&
		answers(restarted).length === 2 &&
		JSON.stringify(answers(restarted)[1]?.data.re) === JSON.stringify([idle]),
	'a steer sent while idle starts its own run',
	JSON.stringify(restarted?.entries.map((entry) => entry.data)),
)
bot.close()

/** Another thread's agent posts mid-run: its message joins the answer being written, as a person's Enter does */
const dee = await scriptedRunner('dee', (request) => {
	const last = request.messages.findLast((m) => m.role !== 'system')
	const t = text(last)
	if (last.role === 'toolResult') return say(t.startsWith('Posted') ? '' : 'dee answered both')
	if (t.includes('tell thread'))
		return call('post', { thread: Number(t.match(/thread (\d+)/)[1]), body: 'news' })
	if (t.includes('work')) return call('bash', { command: 'sleep 0.5' })
	return say('dee heard')
})
const toDee = { runner: 'dee', model: 'echo/echo' }
const busy = await createThread('busy')
const teller = await createThread('teller')
const work = (await postEntry(busy, 'work', toDee)).json.entry
check(Boolean(await executing()), 'the busy agent is inside its tool call')
await postEntry(teller, `tell thread ${busy}`, toDee)
const news = await until(
	async () => (await view(busy)).entries.find((e) => e.data.from === teller),
	8000,
	10,
)
const told = await answered(busy)
await quiet()
check(
	Boolean(news) &&
		answers(told).length === 1 &&
		JSON.stringify(answers(told)[0].data.re) === JSON.stringify([work]),
	"another thread's post joined the answer being written",
	JSON.stringify(told?.entries.map((entry) => entry.data)),
)
check(
	!(await view(teller)).entries.some((entry) => entry.data.from === busy),
	"and since busy isn't teller's child, the answer stays in busy",
	brief(await view(teller)),
)
dee.close()

const cy = await scriptedRunner('cy', (request) => {
	const t = text(request.messages.findLast((m) => m.role === 'user'))
	if (t.includes('again')) return say('cy heard it all')
	if (request.messages.at(-1).role === 'user' && t.includes('work'))
		return call('bash', { command: 'sleep 0.5' })
	return say(`cy thinks ${'hmm '.repeat(300)}`)
})
const toCy = { runner: 'cy', model: 'echo/echo' }
const gap = await createThread('gap')
const cyInputs = async () =>
	(await conversationOf(await view(gap), 'echo/echo@cy')).entries
		?.filter((e) => e.kind === 'ade.delivery')
		.map((e) => text(e.model[0])) ?? []
await postEntry(gap, 'work', toCy)
await until(
	async () =>
		(await conversationOf(await view(gap), 'echo/echo@cy')).entries?.some(
			(e) => e.kind === 'pi.assistant',
		),
	8000,
	20,
)
await postEntry(gap, 'and a follow-up', toCy)
await api('POST', `/api/threads/${gap}/entries`, { body: 'steer now', to: toCy, steer: true })
const steered = await until(
	async () => (await cyInputs()).some((t) => t.includes('steer now')),
	8000,
	20,
)
await api('POST', `/api/threads/${gap}/stop`, {})
const before = await cyInputs()
check(
	Boolean(steered) && !before.some((t) => t.includes('follow-up')),
	'the steer was placed, the follow-up withdrawn',
	JSON.stringify(before),
)
await postEntry(gap, 'again', toCy)
await answered(gap, 1)
const last = (await cyInputs()).at(-1)
check(
	last === `and a follow-up\n\n<message from="${owner}">\nstopped\n</message>\n\nagain`,
	'the next input carries the withdrawn follow-up, and who stopped it',
	JSON.stringify(last),
)

cy.close()

/** A message that waits behind a run that fails still gets its answer */
const eve = await scriptedRunner('eve', (request) =>
	request.messages.some((m) => m.role === 'user' && JSON.stringify(m.content).includes('second'))
		? say('answered second')
		: request.messages.some((m) => m.role === 'toolResult')
			? fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'the model broke' })
			: call('bash', { command: 'sleep 0.5' }),
)
const toEve = { runner: 'eve', model: 'echo/echo' }
const failing = await createThread('failed run')
await postEntry(failing, 'first', toEve)
check(Boolean(await executing('eve')), 'the first input is inside its tool call')
await postEntry(failing, 'second', toEve)
const failed =
	(await until(async () => {
		const v = await view(failing)
		return v.entries.some((e) => e.data.answer) && v.status !== 'working' ? v : null
	})) ?? (await view(failing))
const posts = failed.entries.filter((e) => e.data.author === 'echo@eve').map((e) => e.data.body)
check(
	posts.some((b) => b.startsWith('gave no answer')),
	'the failed run says so',
	JSON.stringify(posts),
)
check(
	posts.includes('answered second'),
	'the queued message gets its own answer',
	JSON.stringify(posts),
)
check(failed.status !== 'working', 'the agent is not left working', failed.status)
eve.close()

/** A message waiting behind a run, taken back by its author, never reaches the agent and leaves the thread */
const fay = await scriptedRunner('fay', (request) =>
	request.messages.at(-1).role === 'user' && text(request.messages.at(-1)).includes('work')
		? call('bash', { command: 'sleep 0.5' })
		: say('fay answered'),
)
const toFay = { runner: 'fay', model: 'echo/echo' }
const taking = await createThread('take back')
await postEntry(taking, 'work', toFay)
check(Boolean(await executing('fay')), 'the agent is inside its tool call')
const regret = (await postEntry(taking, 'regret', toFay)).json.entry
const kept = (await postEntry(taking, 'kept', toFay)).json.entry
const notMine = await api('POST', `/api/threads/${taking}/withdraw`, { entry: regret }, 'bo')
check(notMine.status >= 400, "someone else can't take it back", JSON.stringify(notMine.json))
const back = await api('POST', `/api/threads/${taking}/withdraw`, { entry: regret })
check(
	back.json.withdrawn === regret,
	'its author takes it back while it waits',
	JSON.stringify(back.json),
)
const after = (await answered(taking, 2)) ?? (await view(taking))
const fayInputs = (await conversationOf(after, 'echo/echo@fay')).entries
	.filter((e) => e.kind === 'ade.delivery')
	.map((e) => text(e.model[0]))
check(
	!fayInputs.some((t) => t.includes('regret')) && fayInputs.some((t) => t.includes('kept')),
	'the agent never reads it, and reads what came after',
	JSON.stringify(fayInputs),
)
check(
	!after.entries.some((e) => e.id === regret || e.data.body === 'regret'),
	'the thread no longer shows it',
	brief(after),
)
const late = await api('POST', `/api/threads/${taking}/withdraw`, { entry: kept })
check(late.status >= 400, 'once read, it stays', JSON.stringify(late.json))
fay.close()
done()
