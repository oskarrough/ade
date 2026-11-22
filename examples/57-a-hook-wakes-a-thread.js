/**
 * MODULES=+wake,+hooks: a wake `on` an outside event comes back on each POST to its hook that carries its own secret,
 * once per event even when it's sent again after a restart; a wrong secret or the owner's key is refused, and a
 * cancelled hook answers nothing
 */
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
	answered,
	api,
	base,
	call,
	check,
	db,
	done,
	kill,
	say,
	scriptedRunner,
	server,
	text,
	until,
	view,
} from './lib.js'

const env = { MODULES: '+wake,+hooks' }
let srv = await server(env)
await scriptedRunner('laptop', (request) => {
	const last = request.messages.findLast((m) => m.role !== 'system')
	if (last.role === 'toolResult') return say(text(last))
	const on = text(last).match(/^wake on (\S+) (.*)/)
	return on ? call('wake', { on: on[1], note: on[2] }) : say(`got: ${text(last)}`)
})
const {
	json: { id },
} = await api('POST', '/api/threads', { title: 'deploys' })
const hookFor = async (body) => {
	await api('POST', `/api/threads/${id}/entries`, { body, to: 'echo/echo@laptop' })
	const set = (
		await answered(id, (await view(id)).entries.filter((e) => e.data.answer).length + 1)
	).entries.findLast((entry) => entry.data.answer).data.body
	return { wake: Number(set.match(/\/hooks\/(\d+)/)[1]), secret: set.match(/awh_[\w-]+/)[0] }
}
const send = async (wake, body, headers) => {
	const response = await fetch(`${base}/hooks/${wake}`, { method: 'POST', headers, body })
	return { status: response.status, json: await response.json() }
}
const woken = async () => (await view(id)).entries.filter((entry) => entry.data.wake)

const hook = await hookFor('wake on hook check the deploy')
check(
	(await api('GET', `/api/threads/${id}/wake`)).json[0]?.on === 'hook',
	'the wake waits in the thread, on its hook',
)
const bearer = { Authorization: `Bearer ${hook.secret}` }
const first = await send(hook.wake, 'deploy 41 finished', bearer)
const posted = await until(async () => (await woken()).length && (await woken()))
check(
	first.json.woke === hook.wake && posted[0].data.body === 'check the deploy\n\ndeploy 41 finished',
	'a POST with its secret wakes the thread with the note and what came',
	JSON.stringify({ first, posted }),
)

await kill(srv, 'SIGKILL')
srv = await server(env)
const repeat = await send(hook.wake, 'deploy 41 finished', bearer)
const next = await send(hook.wake, 'deploy 42 finished', bearer)
await until(async () => (await woken()).length === 2)
check(
	repeat.json.repeat === hook.wake &&
		next.json.woke === hook.wake &&
		(await woken()).map((entry) => entry.data.body.split('\n\n')[1]).join() ===
			'deploy 41 finished,deploy 42 finished',
	'after a restart, the same event again posts nothing, and a new one wakes it again',
	JSON.stringify({ repeat, next }),
)

const ownerKey = readFileSync(path.join(path.dirname(db), 'owner.key'), 'utf8').trim()
const wrong = await send(hook.wake, 'deploy 43', { Authorization: 'Bearer awh_guess' })
const owners = await send(hook.wake, 'deploy 43', { Authorization: `Bearer ${ownerKey}` })
const none = await send(hook.wake, 'deploy 43')
check(
	[wrong, owners, none].every((answer) => answer.status === 403),
	"a wrong secret, the owner's key, or none is refused",
	JSON.stringify([wrong, owners, none]),
)

// GitHub signs the body with the secret and names each delivery
const push = await hookFor('wake on push review what landed')
const github = (event, delivery, body, secret = push.secret) =>
	send(push.wake, body, {
		'X-GitHub-Event': event,
		'X-GitHub-Delivery': delivery,
		'X-Hub-Signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
	})
const payload = JSON.stringify({
	ref: 'refs/heads/main',
	repository: { full_name: 'oskarrough/ade' },
	pusher: { name: 'oskar' },
	head_commit: { message: 'Hooks wake threads' },
})
const ping = await github('ping', 'd0', '{"zen":"hi"}')
const pushed = await github('push', 'd1', payload)
const forged = await github('push', 'd2', payload, 'awh_guess')
await until(async () => (await woken()).length === 3)
const redelivered = await github('push', 'd1', payload)
check(
	ping.json.ignored === 'ping' &&
		pushed.json.woke === push.wake &&
		forged.status === 403 &&
		(await woken()).at(-1).data.body ===
			'review what landed\n\nGitHub: oskar pushed to oskarrough/ade main: Hooks wake threads',
	"a GitHub push signed with the wake's secret wakes it; a ping is ignored, a forged one refused",
	JSON.stringify({ ping, pushed, forged }),
)
check(
	redelivered.json.repeat === push.wake && (await woken()).length === 3,
	'a redelivered push posts once',
	JSON.stringify(redelivered),
)

await api('POST', `/api/threads/${id}/wake`, { cancel: hook.wake })
const gone = await send(hook.wake, 'deploy 44', bearer)
check(gone.status === 404, 'a cancelled hook answers nothing', JSON.stringify(gone))

await kill(srv)
done()
