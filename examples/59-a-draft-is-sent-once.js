/** What you're writing lives on the server, per thread and person: it follows you to another device, Send turns it into
 * the message once, and nothing brings it back after: not a reload, a late save or a resend. A fork keeps your pick.
 * A thread you haven't started has one too, and sending it makes the thread and its message in one step. */
import WebSocket from 'ws'
import {
	answered,
	api,
	base,
	check,
	createThread,
	done,
	owner,
	runner,
	server,
	until,
	view,
} from './lib.js'

await server()
await runner('laptop')
const to = { runner: 'laptop', model: 'echo/echo' }
const pick = { agent: to, bots: [] }
const id = await createThread('drafts')
const draftOf = async (thread, as) =>
	(await api('GET', `/api/threads/${thread}/draft`, undefined, as)).json.draft

// Another device of yours, watching the thread
const heard = []
const socket = new WebSocket(`${base.replace('http', 'ws')}/ws`)
socket.on('message', (data) => heard.push(JSON.parse(data.toString())))
await new Promise((resolve) => socket.once('open', resolve))
socket.send(JSON.stringify({ watch: id }))
await until(async () => heard.some((message) => message.thread === id && message.entries))

const saved = await api('POST', `/api/threads/${id}/draft`, {
	key: 'draft-1',
	text: 'hello th',
	pick,
	page: 'laptop',
})
await api('POST', `/api/threads/${id}/draft`, {
	key: 'draft-1',
	text: 'hello there',
	page: 'laptop',
})
check(
	saved.status === 201 &&
		JSON.stringify(await draftOf(id)) ===
			JSON.stringify({ key: 'draft-1', text: 'hello there', images: [], pick }),
	'a draft saves as you type, its fields one at a time, and reads back whole',
	JSON.stringify([saved, await draftOf(id)]),
)
await until(async () => heard.some((message) => message.draft?.text === 'hello there'))
check(
	heard.find((message) => message.draft?.text === 'hello there')?.page === 'laptop',
	'your other device watching the thread hears it, with the page that saved it',
)
check(
	(await draftOf(id, 'ana')) === null,
	"a draft is one person's: someone else in the thread has none",
	JSON.stringify(await draftOf(id, 'ana')),
)
await api('POST', `/api/threads/${id}/draft`, { key: 'ana-1', text: 'hi from ana' }, 'ana')
check(
	(await draftOf(id)).text === 'hello there' && (await draftOf(id, 'ana')).text === 'hi from ana',
	'and theirs leaves yours alone',
)

// Send: the draft becomes the message in the same commit, under the draft's key
const sent = await api('POST', `/api/threads/${id}/entries`, {
	body: 'hello there',
	to,
	key: 'draft-1',
})
check(
	sent.status === 201 && (await draftOf(id)) === null,
	'sending under its key empties the draft',
	JSON.stringify([sent, await draftOf(id)]),
)
await until(async () => heard.some((message) => message.sent === 'draft-1'))
check(true, 'your other device hears it was sent, by its key')

// A save that was on its way when Send went, or a page reloading after an aborted Send, can't bring it back
const late = await api('POST', `/api/threads/${id}/draft`, { key: 'draft-1', text: 'hello there' })
check(
	late.json.sent === true && (await draftOf(id)) === null,
	'a late save under the sent key changes nothing and says it was sent',
	JSON.stringify([late.json, await draftOf(id)]),
)
const again = await api('POST', `/api/threads/${id}/entries`, {
	body: 'hello there',
	to,
	key: 'draft-1',
})
await answered(id)
check(
	again.json.entry === sent.json.entry &&
		(await view(id)).entries.filter((entry) => entry.data.author === owner).length === 1,
	'pressing Send again with it lands nothing new',
	JSON.stringify([sent.json, again.json]),
)

// A fork keeps what you picked to ask next
const other = { runner: 'laptop', model: 'echo/other' }
await api('POST', `/api/threads/${id}/draft`, { key: 'draft-2', pick: { agent: other, bots: [] } })
const fork = (await api('POST', `/api/threads/${id}/fork`, { at: sent.json.entry })).json.id
check(
	JSON.stringify((await draftOf(fork))?.pick) === JSON.stringify({ agent: other, bots: [] }),
	'a fork copies your pick',
	JSON.stringify(await draftOf(fork)),
)

// A thread not started yet has a draft too, one per person, which every page of theirs hears
const next = await api('POST', '/api/draft', {
	key: 'new-1',
	text: 'start something',
	pick,
	page: 'laptop',
})
await until(async () =>
	heard.some((message) => message.thread === 'new' && message.draft?.text === 'start something'),
)
check(
	next.status === 201 && (await api('GET', '/api/draft')).json.draft.text === 'start something',
	'the draft for a new thread saves and reads back, and your other pages hear it',
	JSON.stringify(next),
)
// Sending it makes the thread and its first message in one step, under the draft's key: no thread is ever left without it
const threadCount = async () => (await api('GET', '/api/threads')).json.length
const before = await threadCount()
const started = await api('POST', '/api/threads', {
	title: 'started',
	key: 'new-1',
	body: 'start something',
	to,
})
const made = started.json.id
check(
	started.status === 201 &&
		(await view(made)).entries
			.filter((entry) => entry.data.author === owner)
			.map((entry) => entry.data.body)
			.join() === 'start something' &&
		(await draftOf(made)) === null &&
		JSON.stringify((await api('GET', '/api/draft')).json.draft) ===
			JSON.stringify({ key: '', text: '', images: [], pick }),
	'a new thread and its first message land together; the new-thread draft keeps only its pick',
	JSON.stringify([started.json, await draftOf(made), (await api('GET', '/api/draft')).json]),
)
await until(async () =>
	heard.some((message) => message.thread === 'new' && message.sent === 'new-1'),
)
const stale = await api('POST', '/api/draft', { key: 'new-1', text: 'start something' })
check(
	stale.json.sent === true && (await api('GET', '/api/draft')).json.draft.text === '',
	'a late save under that key brings nothing back to the new-thread box',
	JSON.stringify(stale.json),
)
const retried = await api('POST', '/api/threads', {
	title: 'started',
	key: 'new-1',
	body: 'start something',
	to,
})
await answered(made)
check(
	retried.json.id === made &&
		retried.json.entry === started.json.entry &&
		(await threadCount()) === before + 1 &&
		(await view(made)).entries.filter((entry) => entry.data.author === owner).length === 1,
	'sending it again makes no second thread and no second message',
	JSON.stringify([started.json, retried.json]),
)

socket.close()
done()
