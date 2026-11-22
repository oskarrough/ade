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

again.socket.close()
done()
