/** MODULES=+wake: an agent's wake comes back to it after a restart, survives Stop, and × cancels one */
import {
	answered,
	api,
	call,
	check,
	done,
	kill,
	say,
	scriptedRunner,
	server,
	text,
	until,
	view,
} from './lib.js'

const env = { MODULES: '+wake' }
let srv = await server(env)
await scriptedRunner('laptop', (request) => {
	const last = request.messages.findLast((m) => m.role !== 'system')
	if (last.role === 'toolResult') return say(last.isError ? `failed: ${text(last)}` : 'set')
	const asked = text(last).match(/^wake (\S+) (.*)/)
	return asked ? call('wake', { in: asked[1], note: asked[2] }) : say(`got: ${text(last)}`)
})
const {
	json: { id },
} = await api('POST', '/api/threads', { title: 'ci' })
const post = (body) => api('POST', `/api/threads/${id}/entries`, { body, to: 'echo/echo@laptop' })
const wakes = async () => (await api('GET', `/api/threads/${id}/wake`)).json

await post('wake 1h tidy the branch')
await answered(id)
await post('wake 5s check CI on #412')
await answered(id, 2)
let pending = await wakes()
check(
	pending.length === 2 && pending[0].note === 'check CI on #412' && pending[0].at > Date.now(),
	'both wakes wait in the thread, the soonest first',
	JSON.stringify(pending),
)

await api('POST', `/api/threads/${id}/stop`, {})
check((await wakes()).length === 2, "Stop leaves the thread's wakes alone")

await kill(srv, 'SIGKILL')
const restarted = Date.now()
srv = await server(env)
const woke = await until(async () => {
	const thread = await view(id)
	const fired = thread.entries.find((entry) => entry.data.wake)
	const reply = fired && thread.entries.find((entry) => entry.id > fired.id && entry.data.answer)
	return reply && { fired, reply }
}, 15000)
check(
	woke?.fired.data.body === 'check CI on #412' &&
		Date.parse(woke.fired.data.createdAt) > restarted &&
		woke.reply.data.body.includes('wake') &&
		woke.reply.data.body.includes('check CI on #412'),
	'after a restart the wake posts its note back to the agent, which answers it',
	JSON.stringify(woke),
)

pending = await wakes()
check(
	pending.length === 1 && pending[0].note === 'tidy the branch',
	'a wake that fired is gone',
	JSON.stringify(pending),
)
await api('POST', `/api/threads/${id}/wake`, { cancel: pending[0].id })
check((await wakes()).length === 0, '× cancels the other', JSON.stringify(await wakes()))

done()
