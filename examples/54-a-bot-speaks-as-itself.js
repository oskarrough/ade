/** A bot that posts from one thread into another she's in speaks there as itself, and its message is marked as an agent's, as its answers
 * are: it never counts as a person, and agents read it as an agent's */
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
	view,
} from './lib.js'

await server({ MODULES: '+bots' })
// She joins a room by being asked there, then speaks into it from another
const other = (await api('POST', '/api/threads', { title: 'other room' })).json.id
await scriptedRunner('laptop', (request) => {
	const last = request.messages.findLast((message) => message.role !== 'system')
	if (last.role === 'toolResult') return say(`tool: ${text(last)}`)
	if (text(last).includes('speak up'))
		return call('post', { thread: other, body: 'hello, other room', to: 'nobody' })
	return say('ok')
})
await api('POST', '/api/bots', { name: 'ada', to: 'echo/echo@laptop' })
await api('POST', `/api/threads/${other}/entries`, { body: 'hi', to: 'ada' })
await answered(other)
const room = (await api('POST', '/api/threads', { title: 'room' })).json.id
await api('POST', `/api/threads/${room}/entries`, { body: 'speak up', to: 'ada' })
await answered(room)
const said = (
	await until(async () =>
		(await view(other)).entries.find((entry) => entry.data.body === 'hello, other room'),
	)
)?.data
check(
	said?.author === 'ada' && said.posted === true,
	"a bot's post in a thread it's in is marked as hers",
	JSON.stringify(said),
)
const thread = await view(other)
check(
	!thread.people.includes('ada'),
	'and she is not one of its people',
	JSON.stringify(thread.people),
)

done()
