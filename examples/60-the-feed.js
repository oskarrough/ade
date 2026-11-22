/** A view's feed sends one versioned stream: never an older state after a newer one, deltas on reconnect, and writes land once with the seq they reached */
import WebSocket from 'ws'
import { api, base, check, done, kill, runner, server, until } from './lib.js'

await server({ MODULES: '+bots' })

const open = () =>
	new Promise((resolve, reject) => {
		const socket = new WebSocket(`${base.replace('http', 'ws')}/ws`)
		const frames = []
		socket.onmessage = ({ data }) => frames.push(JSON.parse(String(data)))
		socket.onopen = () => resolve({ socket, frames })
		socket.onerror = reject
	})

const { socket, frames } = await open()
socket.send(JSON.stringify({ sub: 'runners' }))
const boot = await until(async () => frames.find((frame) => frame.view === 'runners'))
check(
	Boolean(boot?.reset) &&
		typeof boot.seq === 'number' &&
		Array.isArray(boot.put) &&
		Array.isArray(boot.del),
	'subscribing to runners bootstraps with reset, seq, put and del',
	JSON.stringify(boot),
)

// Minting a runner key returns seq, lands once per key, and pushes the new row on the feed
const minted = await api('POST', '/api/runners', { name: 'laptop', key: 'mint-laptop' })
const retriedMint = await api('POST', '/api/runners', { name: 'laptop', key: 'mint-laptop' })
check(
	minted.status === 201 &&
		typeof minted.json.seq === 'number' &&
		retriedMint.json.key === minted.json.key,
	'minting a runner returns seq and a retry with the same key returns the first key',
	JSON.stringify([minted.json, retriedMint.json]),
)
const added = await until(async () =>
	frames.find(
		(frame) =>
			frame.view === 'runners' &&
			!frame.reset &&
			frame.put?.some((item) => item.key === 'laptop' && item.row.online === false),
	),
)
check(
	Boolean(added) && added.seq >= minted.json.seq,
	'the feed puts the minted runner at or past the write seq',
	JSON.stringify([minted.json, added]),
)

// Runner coming online and going offline (touch, not a Pi commit) still advance seq
const laptop = await runner('laptop')
const online = await until(async () =>
	frames.find(
		(frame) =>
			frame.view === 'runners' &&
			frame.seq > added.seq &&
			frame.put?.some((item) => item.key === 'laptop' && item.row.online === true),
	),
)
check(
	Boolean(online),
	'connecting a runner puts online: true with a higher seq',
	JSON.stringify(online),
)

// Reconnect with `after` receives only what changed while disconnected
const lastSeq = online.seq
socket.close()

await kill(laptop)
await api('POST', '/api/runners', { name: 'desktop', key: 'mint-desktop' })
const again = await open()
again.socket.send(JSON.stringify({ sub: 'runners', after: lastSeq }))
const delta = await until(async () => again.frames.find((frame) => frame.view === 'runners'))
check(
	Boolean(delta) &&
		!delta.reset &&
		delta.seq > lastSeq &&
		delta.put?.some((item) => item.key === 'desktop') &&
		delta.put?.some((item) => item.key === 'laptop' && item.row.online === false),
	'reconnecting with after receives a delta of only what changed since then',
	JSON.stringify(delta),
)

// Revoking a runner lands once per key, returns seq, and deletes the row from the feed
const revoked = await api('DELETE', '/api/runners/desktop?key=revoke-desktop')
const retriedRevoke = await api('DELETE', '/api/runners/desktop?key=revoke-desktop')
check(
	revoked.status === 200 &&
		typeof revoked.json.seq === 'number' &&
		retriedRevoke.status === 200 &&
		retriedRevoke.json.revoked === 'desktop',
	'revoking a runner returns seq and retrying with the same key succeeds idempotently',
	JSON.stringify([revoked.json, retriedRevoke.json]),
)
const deleted = await until(async () =>
	again.frames.find(
		(frame) =>
			frame.view === 'runners' && frame.seq >= revoked.json.seq && frame.del?.includes('desktop'),
	),
)
check(
	Boolean(deleted),
	'revoking a runner sends del on the feed at or past the write seq',
	JSON.stringify([revoked.json, deleted]),
)

// A sync request after an idempotent no-op still advances the view to the write's seq
again.socket.send(JSON.stringify({ sync: 'runners', seq: retriedRevoke.json.seq }))
const synced = await until(async () =>
	again.frames.find((frame) => frame.view === 'runners' && frame.seq >= retriedRevoke.json.seq),
)
check(Boolean(synced), 'sync catches a view up even after a no-op write', JSON.stringify(synced))

// Seq never goes backwards on a view's feed
const seqs = frames.filter((frame) => frame.view === 'runners').map((frame) => frame.seq)
check(
	seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]),
	'a view never sends an older seq after a newer one',
	JSON.stringify(seqs),
)

// Bots on the feed: server sends color, defaultColor, working and status; forgetting lands once and deletes
await runner('laptop')
again.socket.send(JSON.stringify({ sub: 'bots' }))
const botsBoot = await until(async () => again.frames.find((frame) => frame.view === 'bots'))
check(
	Boolean(botsBoot?.reset),
	'subscribing to bots bootstraps with reset',
	JSON.stringify(botsBoot),
)
const madeBot = await api('POST', '/api/bots', {
	name: 'ada',
	to: 'echo/one@laptop',
	instructions: 'You are ada.',
	key: 'make-ada',
})
const botPut = await until(async () =>
	again.frames.find(
		(frame) =>
			frame.view === 'bots' &&
			!frame.reset &&
			frame.seq >= madeBot.json.seq &&
			frame.put?.some((item) => item.key === 'ada'),
	),
)
const ada = botPut?.put.find((item) => item.key === 'ada')?.row
check(
	Boolean(ada) &&
		typeof ada.color === 'number' &&
		ada.defaultColor === ada.color &&
		ada.customColor === false &&
		ada.working === 0 &&
		ada.status === 'idle',
	'a bot arrives on the feed with server-computed color, working and status',
	JSON.stringify(ada),
)
const forgot = await api('DELETE', '/api/bots/ada?key=forget-ada')
const forgotAgain = await api('DELETE', '/api/bots/ada?key=forget-ada')
const botDel = await until(async () =>
	again.frames.find(
		(frame) => frame.view === 'bots' && frame.seq >= forgot.json.seq && frame.del?.includes('ada'),
	),
)
check(
	forgot.status === 200 && forgotAgain.status === 200 && Boolean(botDel),
	'forgetting a bot lands once per key and deletes it on the feed',
	JSON.stringify([forgot.json, forgotAgain.json, botDel]),
)

// Threads and archived on the feed: per-row updates, server-computed family & unread, archive & rename with key
again.socket.send(JSON.stringify({ sub: 'threads' }))
again.socket.send(JSON.stringify({ sub: 'archived' }))
await until(
	async () =>
		again.frames.some((frame) => frame.view === 'threads' && frame.reset) &&
		again.frames.some((frame) => frame.view === 'archived' && frame.reset),
)
const parent = (await api('POST', '/api/threads', { title: 'parent' })).json
const child = (await api('POST', '/api/threads', { title: 'child', parent: parent.id })).json
const childPut = await until(async () =>
	again.frames.find(
		(frame) =>
			frame.view === 'threads' &&
			!frame.reset &&
			frame.seq >= child.seq &&
			frame.put?.some((item) => item.key === parent.id && item.row.family?.length === 2),
	),
)
const parentRow = childPut?.put.find((item) => item.key === parent.id)?.row
check(
	Boolean(parentRow) &&
		parentRow.family.map((member) => `${member.id}:${member.depth}`).join(',') ===
			`${parent.id}:0,${child.id}:1` &&
		parentRow.unread === false,
	'threads arrive on the feed with server-computed family and unread',
	JSON.stringify(parentRow),
)
// Renaming updates only that row, idempotently per key
const renamed = await api('POST', `/api/threads/${child.id}/title`, {
	title: 'renamed child',
	key: 'ren-1',
})
const renamedAgain = await api('POST', `/api/threads/${child.id}/title`, {
	title: 'renamed child',
	key: 'ren-1',
})
const renamePut = await until(async () =>
	again.frames.find(
		(frame) =>
			frame.view === 'threads' &&
			frame.seq >= renamed.json.seq &&
			frame.put?.some((item) => item.key === child.id && item.row.title === 'renamed child'),
	),
)
check(
	renamed.status === 201 &&
		renamedAgain.status === 201 &&
		Boolean(renamePut) &&
		renamePut.put.length === 1,
	'renaming a thread updates only that row on the feed',
	JSON.stringify([renamed.json, renamePut]),
)
// Archiving deletes from threads (and updates parent family) and puts on archived
const archived = await api('POST', `/api/threads/${child.id}/archive`, {
	archived: true,
	key: 'arch-1',
})
const archDel = await until(async () =>
	again.frames.find(
		(frame) =>
			frame.view === 'threads' &&
			frame.seq >= archived.json.seq &&
			frame.del?.includes(child.id) &&
			frame.put?.some((item) => item.key === parent.id && item.row.family?.length === 1),
	),
)
const archPut = await until(async () =>
	again.frames.find(
		(frame) =>
			frame.view === 'archived' &&
			frame.seq >= archived.json.seq &&
			frame.put?.some((item) => item.key === child.id && item.row.archived === true),
	),
)
check(
	Boolean(archDel && archPut),
	'archiving deletes from threads, updates the parent family, and puts on archived',
	JSON.stringify([archDel, archPut]),
)

again.socket.close()
done()
