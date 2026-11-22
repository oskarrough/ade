/** A bot that posts from one thread into another she's in speaks there as itself, and its message is marked as an agent's, as its answers
 * are: it never counts as a person, and agents read it as an agent's */
import {
	createThread,
	postEntry,
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
const other = await createThread('other room')
await scriptedRunner('laptop', (request) => {
	const last = request.messages.findLast((message) => message.role !== 'system')
	if (last.role === 'toolResult') return say(`tool: ${text(last)}`)
	if (text(last).includes('speak up'))
		return call('post', { thread: other, body: 'hello, other room', to: 'nobody' })
	return say('ok')
})
await api('POST', '/api/bots', { name: 'bot1', to: 'echo/echo@laptop' })
await postEntry(other, 'hi', 'bot1')
await answered(other)
const room = await createThread('room')
await postEntry(room, 'speak up', 'bot1')
await answered(room)
const said = (
	await until(async () =>
		(await view(other)).entries.find((entry) => entry.data.body === 'hello, other room'),
	)
)?.data
check(
	said?.author === 'bot1' && said.posted === true,
	"a bot's post in a thread it's in is marked as hers",
	JSON.stringify(said),
)
const thread = await view(other)
check(
	!thread.people.includes('bot1'),
	'and she is not one of its people',
	JSON.stringify(thread.people),
)

done()
