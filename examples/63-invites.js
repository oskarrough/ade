/** With invites on, only keys get in: the owner's, and an invite's, which is its name until the owner takes it back.
 * A tailnet login or the server's own machine alone is nobody. A guest uses the owner's runners and adds their own,
 * which nobody else can take over or revoke but the owner. */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import WebSocket from 'ws'
import { api, base, check, configDir, db, done, owner, runner, server, until } from './lib.js'

writeFileSync(path.join(configDir, 'ade.json'), JSON.stringify({}))
await server()
await runner('laptop')
const ownerKey = readFileSync(path.join(path.dirname(db), 'owner.key'), 'utf8').trim()
/** A request with a key as a bearer, or a cookie */
const as = async (key, method, route, body = undefined, headers = {}) => {
	const res = await fetch(base + route, {
		method,
		headers: {
			'content-type': 'application/json',
			...(key && { authorization: `Bearer ${key}` }),
			...headers,
		},
		body: body && JSON.stringify(body),
	})
	return { status: res.status, json: await res.json(), cookie: res.headers.get('set-cookie') }
}

const sam = (await as(ownerKey, 'POST', '/api/invites', { name: 'sam' })).json
const ana = (await as(ownerKey, 'POST', '/api/invites', { name: 'ana' })).json
check(sam.link.endsWith(`#key=${sam.key}`) && sam.on === false, 'an invite is a key in a link', sam)
check(
	(await as(sam.key, 'GET', '/api/server')).json.me === owner,
	'while invites are off, an invite’s key opens nothing of its own: this machine is still the owner',
)

await as(ownerKey, 'POST', '/api/settings', { invites: true })
await until(
	async () => (await as(ownerKey, 'GET', '/api/server')).json.settings?.invites === true,
	15000,
)

check(
	(await api('GET', '/api/server')).status === 401,
	'with invites on, no key is refused, even from this machine',
)
check(
	(await api('GET', '/api/server', undefined, 'oskar')).status === 401,
	'and a tailnet login alone is nobody',
)
check((await as(ownerKey, 'GET', '/api/server')).json.me === owner, 'the owner key is the owner')

const kept = await as(sam.key, 'POST', '/api/me')
const cookie = String(kept.cookie).split(';')[0]
const asSam = await as(undefined, 'GET', '/api/server', undefined, { cookie })
check(asSam.json.me === 'sam', 'the link’s key becomes a cookie that is sam', asSam.json.me)

const settings = await as(sam.key, 'POST', '/api/settings', { invites: false })
check(settings.status === 403, 'a guest can’t change settings', settings.status)

// The owner's runner dials back after the restart
await until(
	async () =>
		(await as(ownerKey, 'GET', '/api/runners')).json.find((one) => one.name === 'laptop')?.online,
	15000,
)
const started = await as(sam.key, 'POST', '/api/threads', {
	title: 'sam’s',
	body: 'hello',
	to: 'echo/try@laptop',
})
const thread = await until(async () => {
	const seen = (await as(sam.key, 'GET', `/api/threads/${started.json.id}?all`)).json
	return seen.entries?.some((entry) => entry.data.answer) && seen
})
check(
	thread.entries[0].data.author === 'sam' && thread.entries.some((entry) => entry.data.answer),
	'sam’s message is sam’s, and the owner’s runner answers it',
)

const mine = await as(sam.key, 'POST', '/api/runners', { name: 'samlap' })
check(Boolean(mine.json.key), 'a guest adds a runner of their own', mine.status)
const listed = (await as(ownerKey, 'GET', '/api/runners')).json
check(listed.find((one) => one.name === 'samlap')?.by === 'sam', 'and it lists as theirs')
const anaTakes = await as(ana.key, 'POST', '/api/runners', { name: 'samlap' })
const ownerTakes = await as(ownerKey, 'POST', '/api/runners', { name: 'samlap' })
const samTakes = await as(sam.key, 'POST', '/api/runners', { name: 'laptop' })
check(
	[anaTakes.status, ownerTakes.status, samTakes.status].every((status) => status === 403),
	'nobody takes over another runner’s name, the owner included',
	[anaTakes.status, ownerTakes.status, samTakes.status],
)
const anaRevokes = await as(ana.key, 'DELETE', '/api/runners/samlap')
const samRevokesLaptop = await as(sam.key, 'DELETE', '/api/runners/laptop')
check(
	anaRevokes.status === 403 && samRevokesLaptop.status === 403,
	'a guest can’t revoke someone else’s runner',
	[anaRevokes.status, samRevokesLaptop.status],
)
check(
	(await as(ownerKey, 'DELETE', '/api/runners/samlap')).json.revoked === 'samlap',
	'the owner can revoke a guest’s runner',
)
const squatsSam = await as(ana.key, 'POST', '/api/runners', { name: 'samlap' })
check(squatsSam.status === 403, 'a revoked runner’s name stays its maker’s', squatsSam.status)

/** A socket opened with `key`: `closed` settles with its close code, or 'open' if it's still open after a while */
const socketWith = async (key, route = '/ws') => {
	const socket = new WebSocket(base.replace('http', 'ws') + route, {
		headers: { authorization: `Bearer ${key}` },
	})
	const closed = new Promise((resolve) => socket.on('close', (code) => resolve(code)))
	await new Promise((resolve, reject) => {
		socket.on('open', resolve)
		socket.on('error', reject)
	})
	return {
		closed: () =>
			Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve('open'), 3000))]),
	}
}
/** What the server says to a runner that dials in as `name` with `key`: its close code, or 'open' */
const dial = (name, key) =>
	new Promise((resolve) => {
		const socket = new WebSocket(`${base.replace('http', 'ws')}/ws?runner=${name}&dir=/`, {
			headers: { authorization: `Bearer ${key}` },
		})
		socket.on('close', (code) => resolve(code))
		setTimeout(() => (resolve('open'), socket.terminate()), 3000)
	})

const anaBefore = await socketWith(ana.key)
const anaAgain = (await as(ownerKey, 'POST', '/api/invites', { name: 'ana' })).json
check(
	(await anaBefore.closed()) !== 'open',
	'inviting someone again closes the sockets their old key opened',
)

const samSocket = await socketWith(sam.key)
const samlap2 = (await as(sam.key, 'POST', '/api/runners', { name: 'samlap2' })).json
const task = await as(sam.key, 'POST', '/api/schedule', {
	instructions: 'tick',
	thread: started.json.id,
	every: '1h',
})
check(Boolean(task.json.id), 'sam schedules a task', task.json)

await as(ownerKey, 'DELETE', '/api/invites/sam')
const after = await as(undefined, 'GET', '/api/server', undefined, { cookie })
check(after.status === 401, 'a revoked invite is out on the next request', after.status)
check((await samSocket.closed()) !== 'open', 'and their open sockets close')
check((await dial('samlap2', samlap2.key)) === 4001, 'and their runners’ keys open nothing')
check(
	Boolean(
		await until(async () =>
			(await as(ownerKey, 'GET', '/api/schedule')).json.every((one) => one.id !== task.json.id),
		),
	),
	'and their scheduled tasks end',
)
check(
	(await as(anaAgain.key, 'GET', '/api/server')).json.me === 'ana',
	'and other invites still work',
)

// Keys live in the store as SHA-256 only, a retried request's receipt included
const kim = (await as(ownerKey, 'POST', '/api/invites', { name: 'kim', key: 'invite-kim' })).json
const kimlap = (
	await as(ownerKey, 'POST', '/api/runners', { name: 'kimlap', key: 'runner-kimlap' })
).json
const store = new DatabaseSync(db, { readOnly: true })
const holding = (key) =>
	store.prepare('select count(*) as n from document_revisions where content like ?').get(`%${key}%`)
		.n
check(
	Boolean(kim.key && kimlap.key) && holding(kim.key) === 0 && holding(kimlap.key) === 0,
	'the store never holds an invite’s or a runner’s key',
	[holding(kim.key), holding(kimlap.key)],
)
store.close()

// The server's own runner, and any the owner made, stay the owner's when revoked
await as(ownerKey, 'DELETE', '/api/runners/laptop')
const squatsLaptop = await as(anaAgain.key, 'POST', '/api/runners', { name: 'laptop' })
check(squatsLaptop.status === 403, 'nobody takes a name the owner revoked', squatsLaptop.status)
check(
	Boolean((await as(ownerKey, 'POST', '/api/runners', { name: 'laptop' })).json.key),
	'and the owner can make it again',
)

// An invite whose name the owner later takes for their own is nobody, not the owner
writeFileSync(path.join(configDir, 'ade.json'), JSON.stringify({ invites: true, owner: 'kim' }))
await as(ownerKey, 'POST', '/api/restart')
await until(async () => (await as(ownerKey, 'GET', '/api/server')).json.me === 'kim', 15000)
const kimNow = await as(kim.key, 'GET', '/api/server')
check(kimNow.status === 401, 'an invite named as the owner is turned away', [
	kimNow.status,
	kimNow.json.me,
])

done()
