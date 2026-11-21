/** Who wrote a message comes from how the request arrived, never from a name it gives: the owner on the server's own
 * machine, a friend by the login Tailscale Serve names, nobody without one; and posts, read marks and the canvas agree */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import WebSocket from 'ws'
import { createTLSchema } from '@tldraw/tlschema'
import {
	answered,
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
await runner('laptop')
const tailnet = `http://127.0.0.1:${servePort}`
check(owner === 'oskar', 'on its own machine, you are the owner, by the name ade.json gives', owner)

const {
	json: { id },
} = await api('POST', '/api/threads', { title: 'doors' })

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

await api(
	'POST',
	`/api/threads/${id}/entries`,
	{ body: 'hi from ana', to: 'echo/one@laptop' },
	'ana',
)
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

done()
