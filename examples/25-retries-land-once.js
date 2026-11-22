/** Retries never double */
import {
	answered,
	answers,
	api,
	check,
	done,
	kill,
	owner,
	quiet,
	runner,
	server,
	until,
	view,
} from './lib.js'

let srv = await server()
await runner('laptop')
const to = { runner: 'laptop', model: 'echo/echo' }
const threads = async () => (await api('GET', '/api/threads')).json

const made = await api('POST', '/api/threads', { title: 'once', key: 'make-1' })
const again = await api('POST', '/api/threads', { title: 'once', key: 'make-1' })
check(
	made.status === 201 && again.json.id === made.json.id && (await threads()).length === 1,
	'a retried thread is the same thread',
	JSON.stringify([made, again]),
)
const id = made.json.id

const withoutSeq = ({ seq: _, ...rest }) => rest

const said = await api('POST', `/api/threads/${id}/entries`, {
	body: 'hello',
	to,
	key: 'say-1',
})
const resent = await api('POST', `/api/threads/${id}/entries`, {
	body: 'hello',
	to,
	key: 'say-1',
})
check(
	JSON.stringify(withoutSeq(resent.json)) === JSON.stringify(withoutSeq(said.json)),
	'a retried message, by its own key, returns the first result',
	JSON.stringify([said.json, resent.json]),
)
await answered(id)

await kill(srv, 'SIGKILL')
srv = await server()
const later = await api('POST', `/api/threads/${id}/entries`, {
	body: 'hello',
	to,
	key: 'say-1',
})
const remade = await api('POST', '/api/threads', { title: 'once', key: 'make-1' })
check(
	JSON.stringify(withoutSeq(later.json)) === JSON.stringify(withoutSeq(said.json)) &&
		remade.json.id === id,
	'a retry after a restart still finds its receipt',
	JSON.stringify([later.json, remade.json]),
)

const ran = await api('POST', `/api/threads/${id}/entries`, {
	body: '$ echo hi',
	key: 'run-1',
})
await api('POST', `/api/threads/${id}/entries`, { body: '$ echo hi', key: 'run-1' })
await until(async () => (await view(id)).entries.some((e) => e.data.shell))
await quiet()
const v = await view(id)
check(
	ran.status === 201 &&
		v.entries.filter((e) => e.data.author === owner && e.data.body === 'hello').length === 1,
	'one message',
)
check(answers(v).length === 1, 'one answer', JSON.stringify(answers(v).length))
check(v.entries.filter((e) => e.data.shell).length === 1, 'one command run')
check((await threads()).length === 1, 'one thread')

const other = await api('POST', '/api/threads', { title: 'other', key: 'other-1' })
const otherId = other.json.id
const here = await api('POST', `/api/threads/${id}/entries`, { body: 'hi there', key: 'shared' })
const elsewhere = await api('POST', `/api/threads/${otherId}/entries`, {
	body: 'hi here',
	key: 'shared',
})
check(
	here.status === 201 && elsewhere.status === 201 && here.json.entry !== elsewhere.json.entry,
	'a key is scoped to its thread: the same key in another thread is a different message',
	JSON.stringify([here.json, elsewhere.json]),
)

// A thread-creation key and a message key never share a receipt, even if one is crafted to look like the other's
const crafted = await api('POST', '/api/threads', { title: 'crafted', key: `post ${id}/collide` })
const collided = await api('POST', `/api/threads/${id}/entries`, {
	body: 'not a thread',
	key: 'collide',
})
check(
	crafted.status === 201 && collided.status === 201 && typeof collided.json.entry === 'number',
	"a message key never reads a thread-creation key's receipt, whatever text it shares",
	JSON.stringify([crafted.json, collided.json]),
)

done()
