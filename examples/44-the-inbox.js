/** MODULES=+blocked,+inbox: the questions agents ask wait in one inbox until you answer or dismiss them */
import {
	answered,
	api,
	call,
	check,
	done,
	say,
	scriptedRunner,
	server,
	text,
	until,
} from './lib.js'

await server({ MODULES: '+blocked,+inbox' })
await scriptedRunner('laptop', (request) => {
	const last = request.messages.findLast((m) => m.role !== 'system')
	if (last.role === 'toolResult') return say('asked')
	const asked = text(last).match(/ask: (.*)/)?.[1]
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
done()
