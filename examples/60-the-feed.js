/** A view's feed sends one versioned stream: never an older state after a newer one, deltas on reconnect, and writes land once with the seq they reached */
import WebSocket from 'ws'
import { api, base, check, done, kill, runner, server, until } from './lib.js'

await server({ MODULES: '+bots,+schedule,+talk' })

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
		typeof boot.boot === 'string' &&
		boot.boot.length > 0 &&
		typeof boot.seq === 'number' &&
		Array.isArray(boot.put) &&
		Array.isArray(boot.del),
	'subscribing to runners bootstraps with reset, boot, seq, put and del',
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
again.socket.send(JSON.stringify({ sub: 'runners', after: lastSeq, boot: boot.boot }))
const delta = await until(async () => again.frames.find((frame) => frame.view === 'runners'))
check(
	Boolean(delta) &&
		!delta.reset &&
		delta.boot === boot.boot &&
		delta.seq > lastSeq &&
		delta.put?.some((item) => item.key === 'desktop') &&
		delta.put?.some((item) => item.key === 'laptop' && item.row.online === false),
	'reconnecting with after and matching boot receives a delta of only what changed since then',
	JSON.stringify(delta),
)
// A mismatched boot id (e.g. after a server restart) forces a full reset even when `after` is in range
const staleBoot = await open()
staleBoot.socket.send(JSON.stringify({ sub: 'runners', after: delta.seq, boot: 'old-boot' }))
const resetFrame = await until(async () =>
	staleBoot.frames.find((frame) => frame.view === 'runners'),
)
check(
	Boolean(resetFrame?.reset) && resetFrame.boot === boot.boot,
	'resubscribing with an old boot id forces a full reset',
	JSON.stringify(resetFrame),
)
staleBoot.socket.close()

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

// Thread/<id> feed: shaped messages per viewer, key echo, withdrawal del, cross-thread, scheduled run, stopped
const room = (await api('POST', '/api/threads', { title: 'room' })).json.id
again.socket.send(JSON.stringify({ sub: `thread/${room}` }))
await until(async () =>
	again.frames.some((frame) => frame.view === `thread/${room}` && frame.reset),
)
// Owner posts with a key; owner sees voice: 'mine', friend (via Serve) sees voice: 'said' with showName: true
const firstMsg = (
	await api('POST', `/api/threads/${room}/entries`, {
		body: 'hello room',
		to: null,
		key: 'msg-key-1',
	})
).json
const firstPut = await until(async () =>
	again.frames.find(
		(frame) =>
			frame.view === `thread/${room}` &&
			!frame.reset &&
			frame.seq >= firstMsg.seq &&
			frame.put?.some((item) => item.key === firstMsg.entry),
	),
)
const ownerRow = firstPut?.put.find((item) => item.key === firstMsg.entry)?.row
check(
	Boolean(ownerRow) &&
		ownerRow.voice === 'mine' &&
		ownerRow.showName === false &&
		ownerRow.data.key === 'msg-key-1' &&
		ownerRow.clamp === true,
	'thread/<id> feed puts a shaped message with voice mine and echoes its key',
	JSON.stringify(ownerRow),
)
// Friend posts twice in a row: owner sees showName true on the first, false on the second
await api('POST', `/api/threads/${room}/entries`, { body: 'from ida 1', to: null }, 'ida')
await api('POST', `/api/threads/${room}/entries`, { body: 'from ida 2', to: null }, 'ida')
const ownerView = (await api('GET', `/api/threads/${room}`)).json
const idaView = (await api('GET', `/api/threads/${room}`, undefined, 'ida')).json
const [o0, o1, o2] = ownerView.entries
const [i0, i1, i2] = idaView.entries
check(
	o0.voice === 'mine' &&
		o1.voice === 'said' &&
		o1.showName === true &&
		o1.speaker === '~ida+github' &&
		o2.voice === 'said' &&
		o2.showName === false &&
		i0.voice === 'said' &&
		i0.showName === true &&
		i1.voice === 'mine' &&
		i2.voice === 'mine',
	'messages arrive shaped per viewer with speaker, showName and voice',
	JSON.stringify({
		owner: [o0, o1, o2].map((e) => [e.voice, e.showName, e.speaker]),
		ida: [i0, i1, i2].map((e) => [e.voice, e.showName, e.speaker]),
	}),
)
// Scheduled task run arrives shaped as voice: 'run'
await api('POST', '/api/schedule', { thread: room, instructions: 'ping later', in: '1h' })
const scheduled = (await api('GET', `/api/threads/${room}/schedule`)).json[0]
await api('POST', `/api/threads/${room}/schedule`, { run: scheduled.id })
const runPut = await until(async () =>
	again.frames.find(
		(frame) =>
			frame.view === `thread/${room}` &&
			frame.put?.some(
				(item) => item.row.voice === 'run' && item.row.data?.scheduledTask === scheduled.id,
			),
	),
)
check(
	Boolean(runPut),
	'a scheduled task run arrives shaped with voice run on the feed',
	JSON.stringify(runPut),
)

// Withdrawing an unread message sends `del` for its entry id on the thread/<id> feed
const slowThread = (await api('POST', '/api/threads', { title: 'withdraw-feed' })).json.id
again.socket.send(JSON.stringify({ sub: `thread/${slowThread}` }))
await until(async () =>
	again.frames.some((frame) => frame.view === `thread/${slowThread}` && frame.reset),
)
// Ask an agent on an offline runner so the message stays queued and withdrawable
const offline = await api('POST', '/api/runners', { name: 'asleep' })
check(offline.status === 201, 'minted offline runner')
await api('POST', `/api/threads/${slowThread}/entries`, { body: 'hold on', to: 'echo/one@laptop' })
await until(async () => (await api('GET', `/api/threads/${slowThread}`)).json.entries.length >= 2)
await api('POST', `/api/threads/${slowThread}/entries`, { body: 'slow', to: 'echo/try@laptop' })
await until(async () => (await api('GET', `/api/threads/${slowThread}`)).json.busy)
const extra = (
	await api('POST', `/api/threads/${slowThread}/entries`, {
		body: 'take me back',
		to: 'echo/try@laptop',
	})
).json
const extraPut = await until(async () =>
	again.frames.find(
		(frame) =>
			frame.view === `thread/${slowThread}` && frame.put?.some((item) => item.key === extra.entry),
	),
)
const taken = await api('POST', `/api/threads/${slowThread}/withdraw`, { entry: extra.entry })
const extraDel = await until(async () =>
	again.frames.find(
		(frame) =>
			frame.view === `thread/${slowThread}` &&
			frame.seq >= taken.json.seq &&
			frame.del?.includes(extra.entry),
	),
)
check(
	Boolean(extraPut) && taken.status === 201 && Boolean(extraDel),
	'withdrawing a message deletes its entry id on the thread/<id> feed',
	JSON.stringify([taken.json, extraDel]),
)

again.socket.close()
done()
