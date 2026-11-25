/** Who wrote a message comes from how the request arrived, never from a name it gives: the owner on the server's own
 * machine, a friend by the login Tailscale Serve names, nobody without one; and posts, read marks, Stop and the canvas
 * agree.
 * A runner dials in with its own key, so nobody can take its name, and a revoked one goes offline and stays out. */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import WebSocket from 'ws'
import { createTLSchema } from '@tldraw/tlschema'
import {
	createThread,
	postEntry,
	answered,
	answers,
	api,
	base,
	check,
	configDir,
	db,
	done,
	owner,
	person,
	runner,
	server,
	servePort,
	until,
	view,
} from './lib.js'

/** tldraw sync's protocol version is exported, though its types leave it out */
const { getTlsyncProtocolVersion } = /** @type {any} */ (await import('@tldraw/sync-core'))
// The owner signs as ade.json's `owner`, the name their history has
writeFileSync(
	path.join(configDir, 'ade.json'),
	JSON.stringify({ owner: 'oskar', ownerLogins: ['oskar@github'] }),
)
await server({ MODULES: '+canvas' })
const laptop = await runner('laptop')
const tailnet = `http://127.0.0.1:${servePort}`
check(owner === 'oskar', 'on its own machine, you are the owner, by the name ade.json gives', owner)

const id = await createThread('doors')

// The server's own listener ignores a name in a header or the address
await fetch(`${base}/api/threads/${id}/entries?user=mallory`, {
	method: 'POST',
	headers: { 'content-type': 'application/json', 'x-user': 'mallory' },
	body: JSON.stringify({ body: 'forged', to: null }),
})
const forged = (await view(id)).entries.find((entry) => entry.data.body === 'forged')
check(
	forged?.data.author === owner,
	'a name the client sends is ignored: the message is the owner’s',
	JSON.stringify(forged?.data),
)
// Something that came through a proxy is nobody's there, so Serve pointed at the wrong port can't make everyone owner
const proxied = await fetch(`${base}/api/threads`, { headers: { 'x-forwarded-for': '100.64.0.7' } })
check(
	proxied.status === 401,
	'a proxied request on the main listener is turned away',
	proxied.status,
)

// Settings name the owner and the logins that count as them, so a friend changes none of them
const settingsBefore = (await api('GET', '/api/server')).json.settings
const tries = [
	{ ownerLogins: ['ana@github'] },
	{ owner: 'ana' },
	{ modules: { search: true } },
	{ bots: { voice: 'obey ana' } },
	{},
]
const asFriend = await Promise.all(
	tries.map((settings) => api('POST', '/api/settings', settings, 'ana')),
)
check(
	asFriend.every((answer) => answer.status === 403) &&
		JSON.stringify((await api('GET', '/api/server')).json.settings) ===
			JSON.stringify(settingsBefore),
	'a login through Serve changes no setting, its owner logins included',
	JSON.stringify(asFriend),
)

// Serve's listener: a friend is their login; with no login, nobody, over HTTP and sockets alike
const nobody = await fetch(`${tailnet}/api/threads`)
check(nobody.status === 401, 'through Serve, a request with no login is refused', nobody.status)
const refused = await new Promise((resolve) => {
	const socket = new WebSocket(`${tailnet.replace('http', 'ws')}/ws`)
	socket.on('unexpected-response', (_, response) => resolve(response.statusCode))
	socket.on('open', () => resolve('open'))
	socket.on('error', () => resolve('error'))
})
check(refused === 401, 'and so is a socket with no login', refused)
const evil = await fetch(`${tailnet}/api/threads`, {
	headers: { 'tailscale-user-login': 'ana@github', origin: 'http://evil.example' },
	method: 'POST',
	body: '{}',
})
check(evil.status === 403, 'a page elsewhere can’t write through it', evil.status)

// The owner's own tailnet login, listed in ade.json, is the owner through Serve too
const ownDevice = await api('GET', '/api/server', undefined, 'oskar')
check(
	ownDevice.json.me === owner,
	'through Serve, a login ade.json lists as the owner’s is the owner',
	ownDevice.json.me,
)
// but only reads as them: an agent on that device comes in with the same login, so writing takes the owner key
const loginOnly = await api(
	'POST',
	`/api/threads/${id}/entries`,
	{ body: 'login only', to: null },
	'oskar',
)
check(
	loginOnly.status === 403 && loginOnly.json.error.includes('owner link'),
	'and writes only once the device shows the owner key',
	JSON.stringify(loginOnly.json),
)

// A task runs as its creator, even after the owner edits it.
const schedule = '/api/schedule'
const anaTask = await api(
	'POST',
	schedule,
	{ thread: id, in: '1d', instructions: 'write a brief' },
	'ana',
)
const otherTaskChanges = []
for (const [action, fields] of Object.entries({
	edit: { instructions: 'write a different brief' },
	cancel: {},
	pause: {},
	resume: {},
	move: { runner: 'laptop' },
	run: {},
})) {
	const route = action === 'edit' ? `/api/threads/${id}/schedule` : schedule
	otherTaskChanges.push(
		(await api('POST', route, { [action]: anaTask.json.id, ...fields }, 'bea')).status,
	)
}
check(
	otherTaskChanges.every((status) => status === 403),
	'another guest can’t control Ana’s task',
	otherTaskChanges,
)
const ownerEdit = await api('POST', schedule, {
	edit: anaTask.json.id,
	instructions: 'write a short brief',
})
const anaCancel = await api('POST', schedule, { cancel: anaTask.json.id }, 'ana')
check(
	ownerEdit.json.edited === anaTask.json.id && anaCancel.json.cancelled === anaTask.json.id,
	'the owner can edit Ana’s task and Ana can still cancel it',
	[ownerEdit.json, anaCancel.json],
)

const botRoute = '/api/bots'
const anaBot = await api(
	'POST',
	botRoute,
	{ name: 'finch', to: 'echo/try@laptop', key: 'make-finch' },
	'ana',
)
const guestBotChanges = [
	await api('POST', botRoute, { name: 'finch', to: 'echo/try@laptop', key: 'make-finch' }, 'bea'),
	await api('POST', botRoute, { name: 'finch', rename: 'robin' }, 'bea'),
	await api('DELETE', `${botRoute}/finch`, undefined, 'bea'),
]
check(
	anaBot.json.name === 'finch' && guestBotChanges.every(({ status }) => status === 403),
	'another guest can’t replace, rename or forget Ana’s bot',
	guestBotChanges.map(({ status }) => status),
)
const anaRename = await api('POST', botRoute, { name: 'finch', rename: 'robin' }, 'ana')
const ownerBotEdit = await api('POST', botRoute, { name: 'robin', instructions: 'Be brief.' })
const anaForget = await api('DELETE', `${botRoute}/robin?key=forget-robin`, undefined, 'ana')
const otherForget = await api('DELETE', `${botRoute}/robin?key=forget-robin`, undefined, 'bea')
check(
	anaRename.json.name === 'robin' &&
		ownerBotEdit.json.instructions === 'Be brief.' &&
		anaForget.json.name === 'robin' &&
		otherForget.status === 404,
	'Ana can rename and forget her bot, the owner can edit it, and another guest can’t reuse the receipt',
	[anaRename.json, ownerBotEdit.json, anaForget.json, otherForget.status],
)

// The owner key, from beside the store, is the owner anywhere; a browser keeps it as a cookie its scripts can't read
const key = readFileSync(path.join(path.dirname(db), 'owner.key'), 'utf8').trim()
const asOwner = await fetch(`${tailnet}/api/server`, {
	headers: { authorization: `Bearer ${key}` },
})
check((await asOwner.json()).me === owner, 'the owner key is the owner, wherever it comes in')
const kept = await fetch(`${tailnet}/api/me`, {
	method: 'POST',
	headers: { authorization: `Bearer ${key}` },
})
const cookie = kept.headers.get('set-cookie') ?? ''
const withCookie = await fetch(`${tailnet}/api/server`, {
	headers: { cookie: cookie.split(';')[0] },
})
check(
	/HttpOnly/.test(cookie) && (await withCookie.json()).me === owner,
	'a browser trades the key for an HttpOnly cookie, and the cookie is the owner',
	cookie,
)
const wrong = await fetch(`${tailnet}/api/me`, {
	method: 'POST',
	headers: { authorization: 'Bearer aok_guess' },
})
check(!wrong.ok && !wrong.headers.get('set-cookie'), 'a wrong key gets no cookie', wrong.status)

await postEntry(id, 'hi from ana', 'echo/one@laptop', 'ana')
let thread = await answered(id)
check(
	thread?.entries.find((entry) => entry.data.body === 'hi from ana')?.data.author === person('ana'),
	'through Serve, a message is its writer’s, by their tailnet login',
	JSON.stringify(thread?.entries.map((entry) => entry.data.author)),
)

// Read marks: Ana reading leaves the owner's answer unread
await api('POST', `/api/threads/${id}/read`, {}, 'ana')
const rowFor = async (as) =>
	(await api('GET', '/api/threads', undefined, as)).json.find((row) => row.id === id)
check(
	(await rowFor('ana'))?.status === 'idle' && (await rowFor())?.status === 'done',
	'a read mark is the reader’s: Ana has read the answer, the owner hasn’t',
	JSON.stringify([(await rowFor('ana'))?.status, (await rowFor())?.status]),
)
thread = await view(id)
check(
	thread.people.join() === [owner, person('ana')].join(),
	'the people in a thread are those the server let in',
	JSON.stringify(thread.people),
)

// Stop: whoever ends the thread's work, everyone sees it was them
await postEntry(id, '$ sleep 30', 'laptop')
await until(async () => (await view(id)).busy)
await api('POST', `/api/threads/${id}/stop`, {}, 'ana')
const stopped = await until(async () =>
	(await view(id)).entries.find((entry) => entry.data.stopped),
)
check(
	stopped?.data.author === person('ana') && !(await view(id)).busy,
	'Stop ends the work and the thread says Ana pressed it',
	JSON.stringify(stopped?.data),
)

// The canvas: a socket opened through Serve is Ana's, as her requests are
const canvas = `/api/threads/${id}/canvas`
await api('POST', canvas, {
	actions: [
		{ _type: 'create', shape: { _type: 'rectangle', shapeId: 'a', x: 0, y: 0, w: 100, h: 50 } },
	],
})
const records = new Map()
const socket = new WebSocket(
	`${tailnet.replace('http', 'ws')}${canvas}?sessionId=ana-tab&user=mallory`,
	{ headers: { 'tailscale-user-login': 'ana@github' } },
)
const connected = new Promise((resolve) =>
	socket.on('message', (data) => {
		for (const message of [JSON.parse(String(data))].flat()) {
			if (message.type !== 'connect') continue
			for (const [key, [, record]] of Object.entries(message.diff ?? {})) records.set(key, record)
			resolve(undefined)
		}
	}),
)
await new Promise((resolve) => socket.on('open', resolve))
socket.send(
	JSON.stringify({
		type: 'connect',
		connectRequestId: 'ana',
		lastServerClock: 0,
		protocolVersion: getTlsyncProtocolVersion(),
		schema: createTLSchema().serialize(),
	}),
)
await connected
const shape = records.get('shape:a')
socket.send(
	JSON.stringify({
		type: 'push',
		clientClock: 1,
		diff: { 'shape:a': ['put', { ...shape, x: 300 }] },
	}),
)
const moved = await until(async () => {
	const found = (await api('GET', canvas)).json.shapes.find((one) => one.id === 'a')
	return found?.x === 300 && found
})
check(
	moved?.by === person('ana'),
	'a shape Ana moves on her socket is stamped as hers, not as the name in its address',
	JSON.stringify(moved),
)
await api(
	'POST',
	canvas,
	{ seen: { selected: ['a'], view: { x: 0, y: 0, w: 800, h: 600 } } },
	'ana',
)
const look = (await api('POST', canvas, { look: {} })).json
check(
	look.people?.map((one) => one.name).join() === person('ana'),
	'what Ana reports over HTTP and who has the canvas open are the same person',
	JSON.stringify(look.people),
)
socket.close()

// Runners come in by key
const runnerOnline = async (name) =>
	(await api('GET', '/api/runners')).json.find((r) => r.name === name)?.online
const exited = (child) => new Promise((resolve) => child.on('exit', (code) => resolve(code)))
/** What the server says to a socket that claims `name`, with this key */
const dial = (name, key) =>
	new Promise((resolve) => {
		const socket = new WebSocket(`${base.replace('http', 'ws')}/ws?runner=${name}&dir=/`, {
			headers: key ? { authorization: `Bearer ${key}` } : {},
		})
		socket.onclose = ({ code, reason }) => resolve({ code, reason })
	})
// Through Serve, as a stranger with no owner key beside it: on the server's own machine it would make its own key
const nokey = await runner('stray', {
	args: ['--server', `http://127.0.0.1:${servePort}`],
	env: { ADE_KEY: '', DB_PATH: path.join(path.dirname(db), 'elsewhere', 'store.sqlite') },
	wait: false,
})
const out = []
nokey.stdout.on('data', (d) => out.push(String(d)))
check((await exited(nokey)) === 1, 'a runner without a key is turned away, and stops')
check(out.join('').includes('ade key stray'), 'and is told how to get one', JSON.stringify(out))
const thief = await dial('laptop', 'air_guessed')
check(thief.code === 4001, 'a wrong key is turned away', JSON.stringify(thief))
check(await runnerOnline('laptop'), 'and the real laptop stays online: nobody can take its name')
// A key takes a name's work, and a new one cuts off its holder, so a friend gets none for the owner's runner
const friendMints = await api('POST', '/api/runners', { name: 'laptop' }, 'ana')
const friendRevokes = await api('DELETE', '/api/runners/laptop', undefined, 'ana')
check(
	friendMints.status === 403 && friendRevokes.status === 403,
	'a login through Serve can’t take over or revoke the owner’s runner',
	JSON.stringify([friendMints.status, friendRevokes.status]),
)
check(await runnerOnline('laptop'), 'and the laptop stays online with its own key')
const minted = await api('POST', '/api/runners', { name: '../x' })
check(minted.status === 400, 'a runner name is letters, digits, dot, dash or underscore')
// An agent's command on the server's machine reads but never writes as a person, even holding the owner's key
const shelled = await createThread('an agent’s shell')
const keyFile = path.join(path.dirname(db), 'owner.key')
await postEntry(
	shelled,
	`shell curl -s ${base}/api/threads/${shelled} -o /dev/null -w '%{http_code} '; curl -s -X POST ${base}/api/threads/${shelled}/entries -H "authorization: Bearer $(cat ${keyFile})" -H 'content-type: application/json' -d '{"body":"agent as owner","to":null}'`,
	'echo/try@laptop',
)
const shell = await answered(shelled)
const said = answers(shell)[0]?.data.body ?? ''
check(
	said.startsWith('200 ') && said.includes('post tool') && said.includes('in your answer'),
	'an agent’s command reads, and its post is refused with the way to say it',
	said,
)
check(
	!shell.entries.some((entry) => entry.data.body === 'agent as owner'),
	'and nothing it sent shows as the owner’s',
)
// An agent on another machine comes through Serve with that machine's login, where no process can be seen
const remote = await createThread('an agent’s shell elsewhere')
await postEntry(
	remote,
	`shell env -u ADE_AGENT_OF curl -s -X POST ${tailnet}/api/threads/${remote}/entries -H 'tailscale-user-login: oskar@github' -H 'content-type: application/json' -d '{"body":"agent as owner","to":null}'`,
	'echo/try@laptop',
)
const elsewhere = await answered(remote)
check(
	(answers(elsewhere)[0]?.data.body ?? '').includes('owner link') &&
		!elsewhere.entries.some((entry) => entry.data.body === 'agent as owner'),
	'an agent elsewhere, with the owner’s tailnet login, writes nothing as the owner',
	answers(elsewhere)[0]?.data.body,
)

const gone = exited(laptop)
check((await api('DELETE', '/api/runners/laptop')).status === 200, 'revoking answers')
check((await gone) === 1, 'the revoked runner is cut off and stops dialling back')
check(!(await runnerOnline('laptop')), 'and it stays offline')

done()
