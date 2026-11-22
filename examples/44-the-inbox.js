/** MODULES=+inbox: what needs you waits in one inbox: questions agents ask, then failed runs and unread answers where you wrote */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import WebSocket from 'ws'
import {
	createThread,
	postEntry,
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
	view,
} from './lib.js'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'

await server({ MODULES: '+inbox,+bots' })
await scriptedRunner('laptop', (request) => {
	const last = request.messages.findLast((m) => m.role !== 'system')
	if (last.role === 'toolResult') return say('asked')
	if (/fail please\s*$/.test(text(last)))
		return fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'boom' })
	const asked = text(last).match(/ask: ([^\n]*)\s*$/)?.[1]
	return asked ? call('ask_person', { body: asked }) : say(`got: ${text(last)}`)
})
const post = (id, body) => postEntry(id, body, 'echo/echo@laptop')
/** Questions only: what this example checks first */
const inbox = async () =>
	(await api('GET', '/api/inbox')).json.filter((item) => item.kind === 'question')
const asks = (items) =>
	items.map((item) => `${item.thread}: ${item.question.data.body}`).join(' | ')

const db = await createThread('db')
const ship = await createThread('ship')
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
await api('POST', '/api/bots', { name: 'bot1', to: 'echo/echo@laptop' })
const room = await createThread('room')
await postEntry(room, 'ask: tabs or spaces?', 'bot1')
items = await until(async () =>
	((list) => list.some((item) => item.thread === room) && list)(await inbox()),
)
const bot1 = (await api('GET', `/api/threads/${room}`)).json.agents.find(
	(one) => one.name === 'bot1',
)
check(
	items.find((item) => item.thread === room)?.asker === bot1?.conversation,
	'a question names the conversation of the agent that asked it, whom an answer goes to',
	JSON.stringify([items, bot1]),
)
await postEntry(room, 'tabs', 'bot1')
await answered(room, 2)

// A late dismissal of an older question leaves the newer one alone
const late = await createThread('late')
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
const source = await createThread('source')
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
const slow = await createThread('slow')
await post(slow, '$ sleep 3; echo slept')
await post(slow, 'ask: meanwhile?')
await until(async () => (await api('GET', `/api/threads/${slow}`)).json.status === 'blocked')
const waited = await promisify(execFile)(
	process.execPath,
	['cli.js', '--server', base, 'wait', String(slow)],
	{ cwd: repo },
)
const slowView = (await api('GET', `/api/threads/${slow}`)).json
check(
	!slowView.busy && slowView.entries.some((entry) => entry.data.shell?.stdout?.includes('slept')),
	'with a question open, wait returns once the command ends',
	`${waited.stdout} ${JSON.stringify(slowView.entries.at(-1)?.data)}`,
)

// After the questions, what else needs you: a failed run, then an answer you haven't read, only where you wrote
const everything = async () => (await api('GET', '/api/inbox')).json
const kinds = (items, ids) =>
	items
		.filter((item) => ids.includes(item.thread))
		.map((item) => `${item.kind} ${item.thread}`)
		.join(' | ')
const answeredHere = await createThread('answered')
const failedHere = await createThread('failed')
const askedHere = await createThread('asked')
await post(answeredHere, 'hello')
await answered(answeredHere)
await post(failedHere, 'fail please')
await until(async () => (await view(failedHere)).status === 'error')
await post(askedHere, 'ask: one more?')
const ids = [answeredHere, failedHere, askedHere]
const want = `question ${askedHere} | failed ${failedHere} | answered ${answeredHere}`
let all = await until(async () => ((list) => kinds(list, ids) === want && list)(await everything()))
check(
	Boolean(all),
	'the inbox lists questions first, then a failed run, then an unread answer',
	JSON.stringify(kinds(await everything(), ids)),
)
const friendThread = await createThread('agents among themselves')
await postEntry(friendThread, 'hi', 'echo/echo@laptop', 'ida')
await answered(friendThread)
check(
	!(await everything()).some((item) => item.thread === friendThread),
	"a thread you never wrote in isn't yours to read",
	JSON.stringify(await everything()),
)
const heardRead = []
const readSocket = new WebSocket(`${base.replace('http', 'ws')}/ws`)
readSocket.onmessage = ({ data }) => heardRead.push(JSON.parse(String(data)))
await new Promise((resolve) => (readSocket.onopen = resolve))
await api('POST', `/api/threads/${answeredHere}/read`, {})
await api('POST', `/api/threads/${failedHere}/read`, {})
all = await until(async () =>
	((list) => kinds(list, ids) === `question ${askedHere}` && list)(await everything()),
)
await until(async () => heardRead.some((message) => message.changed?.includes('inbox')))
check(
	Boolean(all) && heardRead.some((message) => message.changed?.includes('inbox')),
	'reading a thread clears its failure or answer, and the socket names the inbox',
	JSON.stringify([kinds(await everything(), ids), heardRead]),
)
readSocket.close()

// A `$ cmd` you stopped is no failure: the answer under it still waits, as the sidebar's dot says
const stopped = await createThread('stopped')
await post(stopped, 'hello')
await answered(stopped)
await post(stopped, '$ sleep 20')
await until(async () => (await view(stopped)).busy)
await api('POST', `/api/threads/${stopped}/stop`, {})
await until(async () => !(await view(stopped)).busy)
const stoppedRow = (await everything()).find((item) => item.thread === stopped)
check(
	stoppedRow?.kind === 'answered' && (await view(stopped)).status === 'done',
	'a stopped command leaves the unread answer in the inbox, not a failure',
	JSON.stringify([stoppedRow, (await view(stopped)).status]),
)

// Work starting on a failed thread takes it out at once, and the socket names the inbox as it starts
const retried = await createThread('retried')
await post(retried, 'fail please')
await until(async () => (await everything()).some((item) => item.thread === retried))
const heardStart = []
const startSocket = new WebSocket(`${base.replace('http', 'ws')}/ws`)
startSocket.onmessage = ({ data }) => heardStart.push(JSON.parse(String(data)))
await new Promise((resolve) => (startSocket.onopen = resolve))
await api('POST', `/api/threads/${retried}/entries`, { body: '$ sleep 3', to: 'echo/echo@laptop' })
await until(async () => (await view(retried)).busy)
const toldStart = await until(async () =>
	heardStart.some((message) => message.changed?.includes('inbox')),
)
const stillBusy = (await view(retried)).busy
check(
	Boolean(toldStart) && stillBusy && !(await everything()).some((item) => item.thread === retried),
	'a failed thread that starts work again leaves the inbox, and the socket says so while it runs',
	JSON.stringify([heardStart, stillBusy]),
)
startSocket.close()
done()
