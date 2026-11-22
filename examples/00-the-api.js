/** The README's walk through the API, request by request, so the README stays true */
import { answered, answers, api, base, check, done, owner, runner, server, until } from './lib.js'

await server()
await runner('laptop')

check(
	Boolean((await api('GET', '/api/server')).json.me),
	'the server says who it takes you for: on its own machine, its owner',
)

check(
	(await api('GET', '/api/threads/999')).status === 404,
	'a thread that does not exist is not found',
)

const {
	json: { id },
} = await api('POST', '/api/threads', { title: 'hello' })
check(id > 0, 'creating a thread gives its id')

const heard = []
const socket = new WebSocket(`${base.replace('http', 'ws')}/ws`)
socket.onmessage = ({ data }) => {
	const message = JSON.parse(data)
	if (message.view === `thread/${id}`) heard.push(message)
}
socket.onopen = () => socket.send(JSON.stringify({ sub: `thread/${id}` }))
await until(async () => heard.length)

await api('POST', `/api/threads/${id}/entries`, {
	body: 'what machine is this?',
	to: 'echo/one@laptop',
})
const first = await answered(id)
check(
	first?.people.join() === owner && answers(first)[0]?.data.author === 'one:off@laptop',
	'asking a model on a runner gets its answer, and the thread knows who is in it',
	JSON.stringify(first?.entries.map((entry) => entry.data)),
)
check(
	Boolean(
		await until(async () =>
			heard.some((frame) => frame.put?.some((item) => item.row.data?.answer)),
		),
	),
	'a subscribed feed hears the answer land',
)

const agent = first.agents[0].conversation
await api('POST', `/api/threads/${id}/entries`, { body: 'and now?', to: 'echo/two@laptop' })
const second = await answered(id, 2)
check(
	second?.agents.length === 1 &&
		second.agents[0].conversation === agent &&
		answers(second)[1]?.data.author === 'two:off@laptop',
	'another model is the same agent, switched in place',
	JSON.stringify(second?.agents),
)

const row = async (thread) =>
	(await api('GET', '/api/threads')).json.find((one) => one.id === thread)
const newest = second.entries.at(-1).id
check(
	(await row(id)).latest === newest,
	'a thread row says when it last moved, as the id of its newest message',
	JSON.stringify([(await row(id)).latest, newest]),
)

const at = first.entries[0].id
const fork = await api('POST', `/api/threads/${id}/fork`, { at })
const forked = (await api('GET', `/api/threads/${fork.json.id}`)).json
check(
	forked.entries.length === 1 && forked.entries[0].data.body === 'what machine is this?',
	'a fork starts a new thread from a message',
	JSON.stringify(forked.entries?.map((entry) => entry.data.body)),
)

check((await api('POST', `/api/threads/${id}/stop`, {})).status < 300, 'stop answers')

socket.close()
done()
