/** A browser's socket names the lists that changed, so it fetches only those again: an agent's work moves threads and runners, never bots, and a thread names the list it's in */
import WebSocket from 'ws'
import {
	createThread,
	postEntry,
	answered,
	api,
	base,
	check,
	done,
	kill,
	runner,
	server,
	sleep,
	until,
} from './lib.js'

await server({ MODULES: '+bots' })
const laptop = await runner('laptop')

const heard = []
const socket = new WebSocket(`${base.replace('http', 'ws')}/ws`)
socket.onmessage = ({ data }) => heard.push(JSON.parse(String(data)))
await new Promise((resolve) => (socket.onopen = resolve))
const named = (list) => heard.some((message) => message.changed?.includes(list))

const id = await createThread('lists')
await postEntry(id, 'hi', 'echo/one@laptop')
await answered(id)
await sleep(300)
check(
	named('threads') && named('runners'),
	'asking an agent names the thread list and the runner list',
	JSON.stringify(heard),
)
check(
	heard.every((message) => message.changed?.length) && !named('bots'),
	'every list message names what changed, and an agent at work leaves the bot list alone',
	JSON.stringify(heard),
)
heard.length = 0
await postEntry(id, 'again', 'echo/one@laptop')
await answered(id, 2)
await sleep(300)
check(
	named('threads') && !named('archived') && !named('inbox'),
	'an open thread at work names neither the archived list nor the inbox, which it cannot change',
	JSON.stringify(heard),
)

heard.length = 0
await api('POST', `/api/threads/${id}/archive`, { archived: true })
check(
	Boolean(await until(async () => named('threads') && named('archived'))),
	'archiving a thread names both thread lists',
	JSON.stringify(heard),
)
await sleep(300)
heard.length = 0
await postEntry(id, 'still here', null)
check(
	Boolean(await until(async () => named('archived'))) && !named('threads'),
	'a message in an archived thread names the archived list, not the open one',
	JSON.stringify(heard),
)
await api('POST', `/api/threads/${id}/archive`, { archived: false })
await sleep(300)

heard.length = 0
await api('POST', `/api/threads/${id}/read`, {}, 'ida')
check(
	Boolean(await until(async () => named('threads'))) && !named('runners'),
	'someone reading a thread names the thread list, so each reader fetches their own unread',
	JSON.stringify(heard),
)

heard.length = 0
await api('POST', '/api/bots', {
	name: 'bot1',
	to: 'echo/one@laptop',
	instructions: 'You are bot1.',
})
check(Boolean(await until(async () => named('bots'))), 'a new bot names the bot list')

heard.length = 0
await kill(laptop)
check(
	Boolean(await until(async () => named('runners') && named('threads'))),
	'a runner going offline names the runner list and the thread list, whose agents it blocks',
	JSON.stringify(heard),
)

// A run waiting on the offline laptop: its start and its end are each their own change
heard.length = 0
await postEntry(id, 'are you there?', 'echo/one@laptop')
check(
	Boolean(await until(async () => named('threads') && named('runners'))),
	'a run starting names the thread list and the runner list',
	JSON.stringify(heard),
)
await until(async () => (await api('GET', `/api/threads/${id}`)).json.status === 'blocked')
await sleep(300)
heard.length = 0
await api('POST', `/api/threads/${id}/stop`, {})
check(
	Boolean(await until(async () => named('threads') && named('runners'))),
	'a run ending, here stopped while it waits for its runner, names them again',
	JSON.stringify(heard),
)

socket.close()
done()
