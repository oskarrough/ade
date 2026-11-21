/** MODULES=+blocked,+inbox: the questions agents ask wait in one inbox until you answer or dismiss them */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import WebSocket from 'ws'
import {
	answered,
	base,
	api,
	call,
	check,
	done,
	say,
	scriptedRunner,
	server,
	text,
	until,
	repo,
} from './lib.js'

await server({ MODULES: '+blocked,+inbox,+bots' })
await scriptedRunner('laptop', (request) => {
	const last = request.messages.findLast((m) => m.role !== 'system')
	if (last.role === 'toolResult') return say('asked')
	const asked = text(last).match(/ask: ([^\n]*)\s*$/)?.[1]
	return asked ? call('ask_person', { body: asked }) : say(`got: ${text(last)}`)
})
const thread = async (title) => (await api('POST', '/api/threads', { title })).json.id
const post = (id, body) =>
	api('POST', `/api/threads/${id}/entries`, { body, to: 'echo/echo@laptop' })
const inbox = async () => (await api('GET', '/api/inbox')).json
const asks = (items) =>
	items.map((item) => `${item.thread}: ${item.question.data.body}`).join(' | ')

const db = await thread('db')
const ship = await thread('ship')
await post(db, 'ask: SQLite or Postgres?')
await until(async () => (await inbox()).length === 1)
await post(ship, 'ask: ship it today?')
let items = await until(async () => ((list) => list.length === 2 && list)(await inbox()))
check(
	asks(items) === `${ship}: ship it today? | ${db}: SQLite or Postgres?` &&
		items.every((item) => item.question.data.waitingOnPerson),
	'each question waits in the inbox, the newest first',
	JSON.stringify(items),
)

await post(db, 'SQLite.')
await answered(db, 2)
items = await inbox()
check(
	asks(items) === `${ship}: ship it today?`,
	'answering in its thread takes a question out, and the agent carries on',
	JSON.stringify(items),
)

const dismissed = await api('POST', `/api/threads/${ship}/inbox`, {
	dismiss: items[0].question.id,
})
items = await inbox()
const row = (await api('GET', '/api/threads')).json.find((one) => one.id === ship)
check(
	dismissed.status === 201 && items.length === 0 && row.status === 'blocked',
	'dismissing hides the question without answering it',
	JSON.stringify([dismissed.json, items, row.status]),
)

await post(ship, 'ask: tomorrow, then?')
items = await until(async () => ((list) => list.length === 1 && list)(await inbox()))
check(
	asks(items) === `${ship}: tomorrow, then?`,
	"the thread's next question shows again",
	JSON.stringify(items),
)

// An answer from the inbox goes to the agent that asked: the item names its conversation
await api('POST', '/api/bots', { name: 'ada', to: 'echo/echo@laptop' })
const room = await thread('room')
await api('POST', `/api/threads/${room}/entries`, { body: 'ask: tabs or spaces?', to: 'ada' })
items = await until(async () =>
	((list) => list.some((item) => item.thread === room) && list)(await inbox()),
)
const ada = (await api('GET', `/api/threads/${room}`)).json.agents.find((one) => one.name === 'ada')
check(
	items.find((item) => item.thread === room)?.asker === ada?.conversation,
	'a question names the conversation of the agent that asked it, whom an answer goes to',
	JSON.stringify([items, ada]),
)
await api('POST', `/api/threads/${room}/entries`, { body: 'tabs', to: 'ada' })
await answered(room, 2)

// A late dismissal of an older question leaves the newer one alone
const late = await thread('late')
await post(late, 'ask: A?')
const first = await until(async () => (await inbox()).find((item) => item.thread === late))
await post(late, 'ask: B?')
await until(async () =>
	(await inbox()).some((item) => item.thread === late && item.question.data.body === 'B?'),
)
const stale = await api('POST', `/api/threads/${late}/inbox`, { dismiss: first.question.id })
check(
	stale.json.dismissed === null &&
		(await inbox()).some((item) => item.thread === late && item.question.data.body === 'B?'),
	'dismissing a question that is no longer open hides nothing',
	JSON.stringify([stale.json, await inbox()]),
)
await post(late, 'fine')
await answered(late, 3)

// A fork that inherits a question is in the inbox, and answering it there tells every page's socket
const heard = []
const socket = new WebSocket(`${base.replace('http', 'ws')}/ws`)
socket.onmessage = ({ data }) => heard.push(JSON.parse(String(data)))
await new Promise((resolve) => (socket.onopen = resolve))
const source = await thread('source')
await post(source, 'ask: fork me?')
const asked = await until(async () => (await inbox()).find((item) => item.thread === source))
const { json: fork } = await api('POST', `/api/threads/${source}/fork`, { at: asked.question.id })
const forked = await until(async () => (await inbox()).some((item) => item.thread === fork.id))
await until(async () => heard.some((message) => message.changed?.includes('inbox')), 3000)
heard.length = 0
await api('POST', `/api/threads/${fork.id}/entries`, { body: 'no' })
const told = await until(async () => heard.some((message) => message.changed?.includes('inbox')))
check(
	Boolean(forked && told) && !(await inbox()).some((item) => item.thread === fork.id),
	"answering a fork's inherited question takes it out, and the socket names the inbox",
	JSON.stringify([fork, heard, await inbox()]),
)
socket.close()

// A question open doesn't hide a command still running: `wait` waits for it
const slow = await thread('slow')
await post(slow, '$ sleep 3; echo slept')
await post(slow, 'ask: meanwhile?')
await until(async () => (await api('GET', `/api/threads/${slow}`)).json.status === 'blocked')
const waited = await promisify(execFile)(
	process.execPath,
	['cli.js', '--server', base, 'wait', String(slow)],
	{ cwd: repo },
)
const view = (await api('GET', `/api/threads/${slow}`)).json
check(
	!view.busy && view.entries.some((entry) => entry.data.shell?.stdout?.includes('slept')),
	'with a question open, wait returns once the command ends',
	`${waited.stdout} ${JSON.stringify(view.entries.at(-1)?.data)}`,
)
done()
