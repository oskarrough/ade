/** Who wrote what */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
	createThread,
	postEntry,
	answered,
	answers,
	api,
	check,
	conversationOf,
	dir,
	done,
	owner,
	person,
	runner,
	server,
	text,
} from './lib.js'

await server()
await runner('laptop')

const id = await createThread('test')
const echo = { runner: 'laptop', model: 'echo/echo' }
const posted = await postEntry(id, 'hello', echo)
check(
	posted.status === 201 && posted.json.entry > 0,
	'posting returns its entry',
	JSON.stringify(posted.json),
)

const view = await answered(id)
const input = view?.entries.find((e) => e.id === posted.json.entry)
const answer = answers(view ?? { entries: [] })[0]
check(
	[input, answer].every(
		(entry) => Math.abs(Date.parse(entry?.data.createdAt) - Date.now()) < 60_000,
	),
	'each message says when it was written (createdAt)',
	JSON.stringify([input?.data.createdAt, answer?.data.createdAt]),
)
check(
	input?.data.author === owner && input.data.to?.join() === 'echo:off@laptop',
	'the message says who wrote it and whom it asks',
	JSON.stringify(input),
)
check(
	answer?.data.author === 'echo:off@laptop',
	'answer author is the agent',
	JSON.stringify(answer),
)
check(
	answer?.data.re?.[0] === input?.id,
	'the answer says which message it answers (re)',
	JSON.stringify(answer?.data.re),
)
const agent = view?.agents[0]
check(
	view?.agents.length === 1 && agent.name === 'echo:off@laptop' && agent.to?.model === 'echo/echo',
	'the thread records its agent',
	JSON.stringify(view?.agents),
)

const own = await conversationOf(view, 'echo/echo@laptop')
const user = own.entries?.find((e) => e.kind === 'ade.delivery')
check(
	text(user?.model[0]) === 'hello' && user.data.held.join() === String(input?.id),
	"in the agent's conversation the message is a delivery: the text as typed, naming what it held",
	JSON.stringify(user),
)
check(
	answer?.data.answer.conversation === agent?.conversation &&
		own.entries.some((e) => e.id === answer.data.answer.entry && e.kind === 'pi.assistant'),
	'the answer points at the entry it came from',
	JSON.stringify(answer?.data.answer),
)
check(
	!(await api('GET', '/api/threads')).json.some((t) => t.id === agent?.conversation),
	"the agent's conversation is no thread",
)

await postEntry(id, 'me too', undefined, 'ana')
const v2 = await answered(id, 2)
const ana = v2?.entries.find((e) => e.data.author === person('ana'))
check(
	ana?.data.to?.join() === 'echo:off@laptop',
	'no `to` asks whom the thread last asked',
	JSON.stringify(ana),
)
check(
	answers(v2 ?? { entries: [] })[1]?.data.body ===
		`echo@laptop heard: [Every message above without a tag is ${owner}'s.]\n\n<message from="${person('ana')}">\nme too\n</message>`,
	"the agent catches up on what's new, not its own answer",
	JSON.stringify(v2?.entries.at(-1)),
)

// Cy names the model as pi would let him, by its id with a thinking level, one that thinks
await postEntry(id, 'think hard', { runner: 'laptop', model: 'try:high' }, 'cy')
const v3 = await answered(id, 3)
const cy = v3?.entries.find((e) => e.data.author === person('cy'))
check(
	cy?.data.to?.join() === 'try:high@laptop' && v3.agents[0].to.thinkingLevel === 'high',
	"pi resolves a pattern to a model, and the thread's agent thinks as hard as it now asks",
	JSON.stringify([cy?.data.to, v3?.agents]),
)

const pi = path.join(dir, '..', 'pi')
mkdirSync(pi)
writeFileSync(
	path.join(pi, 'settings.json'),
	JSON.stringify({ defaultProvider: 'echo', defaultModel: 'echo/echo' }),
)
await runner('desk', { env: { PI_CODING_AGENT_DIR: pi } })
const desk = (await api('GET', '/api/runners')).json.find((r) => r.name === 'desk')
check(
	desk?.model === 'echo/echo',
	"a runner's default model is pi's, named once",
	JSON.stringify(desk?.model),
)
const id2 = await createThread('default')
await postEntry(id2, 'hi', { runner: 'desk' }, 'dee')
const v4 = await answered(id2)
check(
	answers(v4 ?? { entries: [] })[0]?.data.author === 'echo:off@desk',
	"no model asks the runner's default",
	JSON.stringify(v4?.entries.at(-1)),
)

/** A default model pi can't resolve is said so, not offered */
const odd = path.join(dir, '..', 'odd')
mkdirSync(odd)
writeFileSync(
	path.join(odd, 'settings.json'),
	JSON.stringify({ defaultProvider: 'nowhere', defaultModel: 'nowhere/x' }),
)
await runner('odd', { env: { PI_CODING_AGENT_DIR: odd } })
const lost = (await api('GET', '/api/runners')).json.find((r) => r.name === 'odd')
check(
	!lost?.model && /nowhere/.test(lost?.modelError),
	"a default model pi can't resolve is reported with why",
	JSON.stringify(lost),
)

done()
