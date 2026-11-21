/** A browser's socket names the lists that changed, so it fetches only those again: an agent's work moves threads and runners, never bots */
import WebSocket from 'ws'
import { answered, api, base, check, done, kill, runner, server, sleep, until } from './lib.js'

await server({ MODULES: '+bots' })
const laptop = await runner('laptop')

const heard = []
const socket = new WebSocket(`${base.replace('http', 'ws')}/ws`)
socket.onmessage = ({ data }) => heard.push(JSON.parse(String(data)))
await new Promise((resolve) => (socket.onopen = resolve))
const named = (list) => heard.some((message) => message.changed?.includes(list))

const {
	json: { id },
} = await api('POST', '/api/threads', { title: 'lists' })
await api('POST', `/api/threads/${id}/entries`, { body: 'hi', to: 'echo/one@laptop' })
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
await api('POST', `/api/threads/${id}/read`, {}, 'ida')
check(
	Boolean(await until(async () => named('threads'))) && !named('runners'),
	'someone reading a thread names the thread list, so each reader fetches their own unread',
	JSON.stringify(heard),
)

heard.length = 0
await api('POST', '/api/bots', { name: 'ada', to: 'echo/one@laptop', instructions: 'You are ada.' })
check(Boolean(await until(async () => named('bots'))), 'a new bot names the bot list')

heard.length = 0
await kill(laptop)
check(
	Boolean(await until(async () => named('runners') && named('threads'))),
	'a runner going offline names the runner list and the thread list, whose agents it blocks',
	JSON.stringify(heard),
)

socket.close()
done()
