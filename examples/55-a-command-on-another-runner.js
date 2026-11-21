/** An agent runs commands on two runners in one turn, its conversation staying on its own; a runner that drops
 * mid-command reports that the command may have run */
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import {
	answered,
	api,
	check,
	dir,
	done,
	kill,
	runner,
	say,
	scriptedRunner,
	server,
	text,
	until,
} from './lib.js'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'

await server()
const elsewhere = path.join(dir, '..', 'elsewhere')
mkdirSync(elsewhere, { recursive: true })
const started = path.join(elsewhere, 'started')
const both = (command, elsewhere = command) =>
	fauxAssistantMessage(
		[
			fauxToolCall('bash', { command }),
			fauxToolCall('bash', { command: elsewhere, runner: 'there' }),
		],
		{ stopReason: 'toolUse' },
	)
await scriptedRunner('here', (request) => {
	const last = request.messages.at(-1)
	if (last.role === 'toolResult')
		return say(
			request.messages
				.slice(request.messages.findLastIndex((message) => message.role === 'user'))
				.filter((message) => message.role === 'toolResult')
				.map((message) => `${message.isError ? 'error ' : ''}${text(message).trim()}`)
				.join('\n'),
		)
	return text(last).includes('hang') ? both('true', 'touch started; sleep 30') : both('pwd')
})
const there = await runner('there', { dir: elsewhere })

const id = (await api('POST', '/api/threads', { title: 'hands' })).json.id
await api('POST', `/api/threads/${id}/entries`, { body: 'where are you', to: 'echo/echo@here' })
const answer = (thread, count) =>
	thread?.entries.filter((entry) => entry.data.answer)[count - 1]?.data.body ?? ''
const first = answer(await answered(id), 1)
check(
	first.split('\n').includes(dir) && first.split('\n').includes(elsewhere),
	'one turn runs a command on its own runner and on another, each in its folder',
	first,
)

await api('POST', `/api/threads/${id}/entries`, { body: 'hang', to: 'echo/echo@here' })
await until(async () => existsSync(started))
await kill(there, 'SIGKILL')
const second = answer(await answered(id, 2), 2)
check(
	/may have (partially )?run/.test(second),
	'a runner that drops mid-command says the command may have run',
	second,
)

done()
