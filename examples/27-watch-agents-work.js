/** A browser with a thread open hears its messages, its newest page first, earlier pages when it asks, then each as it lands, and what each agent is doing as it changes, all on the one feed */
import {
	fauxAssistantMessage,
	fauxThinking,
	fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import {
	api,
	createThread,
	postEntry,
	answered,
	base,
	conversationOf,
	check,
	done,
	kill,
	say,
	scriptedRunner,
	server,
	until,
	view,
	text,
} from './lib.js'

let srv = await server()
const long = `done ${'and more '.repeat(60)}`
const bot = await scriptedRunner(
	'bot',
	(request) =>
		request.messages.some((m) => m.role === 'toolResult')
			? say(long)
			: fauxAssistantMessage(
					[
						fauxThinking('first the folder'),
						fauxToolCall('bash', { command: 'sleep 0.5; echo slept' }),
					],
					{ stopReason: 'toolUse' },
				),
	{ tokensPerSecond: 200 },
)
const id = await createThread('live')

/** Every frame the socket hears for the thread: `thread/<id>` for messages, `agents/<id>` for its agents' rows, in order */
function watch(thread) {
	const heard = []
	const frames = []
	const socket = new WebSocket(`${base.replace('http', 'ws')}/ws`)
	socket.onmessage = ({ data }) => {
		const m = JSON.parse(data)
		if (m.view === `thread/${thread}`) frames.push(m)
		else if (m.view?.startsWith(`agents/${thread}`))
			heard.push(...(m.put ?? []).map((item) => ({ view: m.view, ...item.row })))
	}
	socket.onopen = () => {
		socket.send(JSON.stringify({ sub: `thread/${thread}` }))
		socket.send(JSON.stringify({ sub: `agents/${thread}` }))
	}
	return {
		heard,
		frames,
		/** Agents' turns as far back as message `from`, all of them from 0 */
		earlier: (from) => socket.send(JSON.stringify({ sub: `agents/${thread}?from=${from}` })),
		close: () => socket.close(),
	}
}
// Live work is keyed by the agent's conversation, which stays as it switches model or runner
const lives = (heard) => heard.filter((row) => row.live).map((row) => row.live)
const entriesIn = (heard) => heard.filter((row) => 'id' in row)
const feedEntries = (frames) =>
	frames.flatMap((frame) =>
		(frame.put ?? []).filter((item) => typeof item.key === 'number').map((item) => item.row),
	)
const said = (frames) => feedEntries(frames).map((entry) => entry.data.body)
const metaOf = (frame) => frame?.put?.find((item) => item.key === 'thread')?.row

const first = watch(id)
await until(async () => first.frames.length)
const initMeta = metaOf(first.frames[0])
check(
	Boolean(first.frames[0]?.reset) &&
		feedEntries(first.frames).length === 0 &&
		initMeta?.earlier === false &&
		initMeta?.people?.length === 0 &&
		initMeta?.agents?.length === 0,
	'a new thread says first that it has no messages, none before them, no people and no agents',
	JSON.stringify(first.frames[0]),
)
const {
	json: { entry },
} = await postEntry(id, 'work', { runner: 'bot', model: 'echo/echo' })
check(
	Boolean(await until(async () => lives(first.heard).length, 8000, 20)),
	'an agent the thread asks is followed from then on',
)

/** Joining mid-run, the first word shows the running tool call and what it runs */
const running = (live) =>
	live.run && live.tools.some((t) => t.name === 'bash' && t.status === 'running')
await until(async () => lives(first.heard).some(running), 8000, 20)
const late = watch(id)
const joined = await until(async () => lives(late.heard)[0], 8000, 20)
check(
	running(joined) && joined.tools[0].args?.command?.includes('sleep'),
	'joining mid-run, the agent is running its tool call, with its arguments',
	JSON.stringify(joined)?.slice(0, 300),
)
late.close()

const v = await answered(id)
check(v?.entries.at(-1)?.data.body === long, 'the answer lands in the thread')
check(
	JSON.stringify(await until(async () => said(first.frames).length === 2 && said(first.frames))) ===
		JSON.stringify(['work', long]),
	'and the feed sent each message once, as it landed',
	JSON.stringify(said(first.frames).map((b) => b.slice(0, 20))),
)
const heard = lives(first.heard)
const lengths = [...new Set(heard.map((l) => text(l.message).length).filter(Boolean))]
check(
	lengths.length > 1 && lengths.every((n, i) => !i || n > lengths[i - 1]),
	'its reply grows in several updates before the answer lands',
	JSON.stringify(lengths),
)
check(
	await until(async () => {
		const last = lives(first.heard).at(-1)
		return !last.run && !last.message
	}),
	'and once it answered, the agent is idle',
	JSON.stringify(lives(first.heard).at(-1))?.slice(0, 200),
)

// Conversation entries arrive once, with thinking and tool output before the run ends.
const streamed = []
let working = false
for (const row of first.heard) {
	if (row.live) working = row.live.run
	if ('id' in row) streamed.push({ entry: row, working })
}
check(
	streamed.some(
		({ entry, working }) =>
			working && entry.model?.[0]?.content?.some((block) => block.type === 'thinking'),
	),
	'its thinking arrives while it still works',
)
check(
	streamed.some(
		({ entry, working }) =>
			working &&
			entry.model?.[0]?.role === 'toolResult' &&
			/slept/.test(JSON.stringify(entry.model)),
	),
	"the tool's output arrives before the turn ends",
)
check(
	new Set(streamed.map(({ entry }) => entry.id)).size === streamed.length,
	'each conversation entry comes once',
)
const delivery = streamed.find(({ entry }) => entry.kind === 'ade.delivery')?.entry
check(
	delivery &&
		heard
			.filter((live) => live.run)
			.every((live) => live.delivery?.id === delivery.id && live.delivery.held.includes(entry)),
	'every working update names its delivery and the messages it held',
)
check(
	heard.filter((live) => !live.run).every((live) => live.delivery === undefined),
	'an idle agent names no delivery',
)

const from = first.heard.length
await postEntry(id, 'again')
await answered(id, 2)
await until(async () => {
	const last = lives(first.heard.slice(from)).at(-1)
	return last && !last.run
})
const next = (await conversationOf(await view(id), 'echo/echo@bot')).entries.findLast(
	(entry) => entry.kind === 'ade.delivery',
)
const nextLives = lives(first.heard.slice(from)).filter((live) => live.run)
check(
	next.id > delivery.id &&
		nextLives.length > 0 &&
		nextLives.every((live) => live.delivery?.id === next.id),
	'the next turn names its own delivery',
)

/** A burst bigger than Pi's window still arrives whole, in order, each message once */
const burst = Array.from({ length: 250 }, (_, i) => `note ${i}`)
await Promise.all(burst.map((body) => postEntry(id, body, null)))
const notes = await until(async () => {
	const got = said(first.frames).filter((b) => b.startsWith('note '))
	return got.length >= burst.length && got
})
check(
	notes?.length === burst.length && new Set(notes).size === burst.length,
	'a burst of 250 messages arrives whole, each once',
	`${notes?.length ?? said(first.frames).length}`,
)
first.close()

await kill(srv, 'SIGKILL')
srv = await server()
const restarted = watch(id)
const now = await until(async () => lives(restarted.heard)[0], 8000, 20)
await until(async () => restarted.frames.length)
// A long thread opens on its newest page; each earlier one comes via ?before= and earlier agent turns on demand
const openedMeta = metaOf(restarted.frames[0])
const openedEntries = feedEntries(restarted.frames)
check(
	openedMeta?.earlier === true &&
		openedEntries.length === 15 &&
		openedEntries.every((entry) => entry.data.body.startsWith('note ')),
	'after a restart, subscribing again starts with the newest page and says there are messages before it',
	`${openedEntries.length} ${openedMeta?.earlier}`,
)
const pages = [openedEntries]
for (let more = true; more;) {
	const oldest = pages[0][0].id
	const page = (await api('GET', `/api/threads/${id}?before=${oldest}&last=50`)).json
	const from = page.entries[0]?.id ?? 0
	restarted.earlier(from)
	await until(async () => restarted.heard.some((row) => row.view === `agents/${id}?from=${from}`))
	pages.unshift(page.entries)
	more = Boolean(page.earlier)
}
const paged = pages.flat().map((entry) => entry.data.body)
check(
	JSON.stringify(paged.slice(0, 4)) === JSON.stringify(['work', long, 'again', long]) &&
		JSON.stringify(paged.slice(4).sort()) === JSON.stringify([...burst].sort()) &&
		pages.length > 2,
	'asked for earlier pages, it brings the rest, each message once, until none is left',
	`${pages.length} pages, ${paged.length} messages`,
)
const turns = new Map(entriesIn(restarted.heard).map((entry) => [entry.key, entry]))
check(
	[...turns.values()].filter((entry) => entry.kind === 'ade.delivery').length === 2,
	"the agent's turns for the earlier messages arrive as the view reaches back to them",
)
const allBefore = (await api('GET', `/api/threads/${id}?before=${openedEntries[0].id}`)).json
check(
	JSON.stringify([...allBefore.entries, ...openedEntries].map((entry) => entry.data.body)) ===
		JSON.stringify(paged),
	'asked for all earlier messages, the rest comes at once',
	`${allBefore.entries.length}`,
)
const plain = (await api('GET', `/api/threads/${id}`)).json
const whole = (await api('GET', `/api/threads/${id}?all`)).json
check(
	plain.earlier === true &&
		JSON.stringify(plain.entries.map((entry) => entry.data.body)) ===
			JSON.stringify(paged.slice(-50)) &&
		JSON.stringify(whole.entries.map((entry) => entry.data.body)) === JSON.stringify(paged),
	'read plainly, a long thread answers its newest 50 messages and says there are earlier ones; ?all answers every one',
	`${plain.entries.length} ${plain.earlier}, ${whole.entries.length}`,
)
check(
	now && !now.run && !now.tools.length,
	'after a restart, subscribing again says the agent is idle',
)
restarted.close()
bot.close()
done()
