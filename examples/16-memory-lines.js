/** With memory, a short message is its own line at once; a long one waits until someone needs it, and opening the
 * memory view writes the waiting message lines, sixteen per call, through a SIGKILL, without merging any */
// MEMORY_MODEL is set because these threads never ask an agent, so without it their lines would wait for one.
import {
	postEntry,
	createThread,
	api,
	check,
	done,
	kill,
	linesOf,
	owner,
	say,
	scriptedRunner,
	server,
	text,
	until,
} from './lib.js'

const env = { MODULES: '+memory', MEMORY_MODEL: 'echo/echo@bot' }
const requests = []
let n = 0
/** A line of `size` bytes in its source's words, as a real writer's would be: its first real word, repeated */
const line = (size, source) => {
	const head = `L${++n} `
	return (
		head +
		`${source.match(/[\p{L}\p{N}]{4,}/u)?.[0] ?? 'line'} `.repeat(size).slice(0, size - head.length)
	)
}
const route = (request) => {
	const first = text(request.messages.find((m) => m.role === 'user'))
	if (!first.includes('<input>')) return say('ok')
	const all = request.messages.map((m) => text(m)).join('\n')
	const input = first.slice(first.lastIndexOf('<input>'))
	requests.push({ first, all, input })
	const source = input.slice('<input>\n'.length, input.lastIndexOf('\n</input>'))
	const size = (text) =>
		text.includes('STUBBORN') || (text.includes('TOOLONG') && !first.includes('Redo only'))
			? 700
			: 300
	if (first.includes('without numbering'))
		return say(
			source.includes('MISSING') && !first.includes('Redo only') ? '' : line(size(source), source),
		)
	return say(
		'Here are the lines:\n' +
			[...source.matchAll(/^(\d+)\| (.*)$/gm)]
				.filter((item) => !item[2].includes('MISSING') || first.includes('Redo only'))
				.map((item) => `${item[1]}| ${line(size(item[2]), item[2])}`)
				.join('\n') +
			'\nThat is all.',
	)
}
const long = (tag) => `${tag} ${'word '.repeat(400)}`.slice(0, 2000)
const has = (lines, l, i) => lines.some((x) => x.l === l && x.i === i)
const post = (id, body) => postEntry(id, body, null)
const open = (id) => api('GET', `/api/threads/${id}/memory`)
const thread = async (title) => {
	const id = await createThread(title)
	await api('POST', `/api/threads/${id}/memory`, { on: true })
	return id
}

let srv = await server(env)
await scriptedRunner('bot', route)

// Recorded memory can arrive before the rest of a thread's messages.
const late = await createThread('before memory starts')
await post(late, 'recorded')
await api('POST', `/api/threads/${late}/memory`, {
	lines: [{ id: 0, n: 1, text: 'recorded' }],
})
await api('POST', `/api/threads/${late}/memory`, { on: false })
await post(late, long('missed one'))
await post(late, long('missed two'))
await post(late, 'missed short')
// Importing turns memory on, but does not write the missing messages.
await api('POST', `/api/threads/${late}/memory`, { lines: [] })
const pending = (await api('GET', `/api/threads/${late}/memory?budget=65536`)).json.lines
check(
	pending.length === 2 && pending[1].id === 1 && pending[1].n === 3,
	'consecutive unwritten messages are one span',
	JSON.stringify(pending),
)
const opened = (await api('GET', `/api/threads/${late}/memory?zoom=1,2`)).json
check(
	opened.message?.includes('missed one') && opened.message?.includes('missed two'),
	'opening an unwritten span gives its messages',
)
await api('POST', `/api/threads/${late}/memory`, { on: true })
check(
	Boolean(await until(async () => has(await linesOf(late), 0, 3))) &&
		!has(await linesOf(late), 0, 1) &&
		requests.length === 0,
	'switching memory on writes the short messages it missed, and calls no model',
)

const a = await thread('quiet')
await post(a, 'hi')
await post(a, long('long one'))
await post(a, long('long two'))
await post(a, 'bye')
await until(async () => has(await linesOf(a), 0, 3))
const quiet = await linesOf(a)
check(
	quiet.length === 2 && quiet[0].text === `${owner}: hi` && requests.length === 0,
	'a short message is its own line; long ones wait, and no model is called',
	JSON.stringify(quiet),
)

const b = await thread('view')
await post(b, long('first'))
await post(b, long('second'))
await post(b, long('TOOLONG'))
await post(b, 'short')
await api('GET', `/api/threads/${b}/memory?zoom=0,1`)
await api('GET', `/api/threads/${b}/memory?zoom=0,2`)
await api('GET', `/api/threads/${b}/memory?budget=100`)
await until(async () => has(await linesOf(b), 0, 3))
check(
	requests.length === 0 && (await linesOf(b)).length === 1,
	'zooming and reading a budgeted cut write nothing',
)
const shown = (await open(b)).json.lines
check(
	shown.some((line) => line.text.includes('not summarized yet')),
	'opening the memory view answers at once, the waiting lines as placeholders',
	JSON.stringify(shown),
)
await until(async () => (await linesOf(b)).length === 4, 15000)
const bl = await linesOf(b)
check(
	bl.every((x) => x.l === 0) &&
		bl.filter((x) => x.i < 3).every((x) => x.size <= 512 && x.text.startsWith('L')),
	'the view writes each long message a line of at most 512 bytes, and merges nothing',
	JSON.stringify(bl.map((x) => [x.l, x.i, x.size])),
)
check(
	requests.length === 1 &&
		['first', 'second', 'TOOLONG'].every((tag) => requests[0].input.includes(tag)),
	'one call writes the waiting message lines',
	requests.length,
)
check(
	requests.every((r) => r.first.includes('-'.repeat(512))),
	'every line request holds the 512-dash ruler',
)
const trimmed = bl.find((x) => x.l === 0 && x.i === 2)
check(
	trimmed?.size <= 512 && trimmed?.text.endsWith('TOOLONG'),
	'an oversized line is trimmed at a word boundary, without another call',
)

const grouped = await thread('batch')
for (let i = 0; i < 18; i++)
	await post(
		grouped,
		long(
			i === 4 ? 'TOOLONG batch' : i === 5 ? 'STUBBORN' : i === 6 ? 'MISSING' : `batch item ${i}`,
		),
	)
const batchStart = requests.length
await open(grouped)
await until(async () => (await linesOf(grouped)).length === 18, 30000)
const batchRequests = requests.slice(batchStart)
const group = batchRequests.find((request) => request.input.includes('batch item 0'))
const retry = batchRequests.find((request) => request.first.includes('Redo only'))
check(
	group?.input.includes('batch item 15') && !group.input.includes('batch item 16'),
	'one call writes at most sixteen message lines',
)
check(
	!retry?.input.includes('TOOLONG batch') &&
		retry?.input.includes('MISSING') &&
		!retry.input.includes('batch item'),
	'only missing batch items are redone, as plain text',
)
check(
	(await linesOf(grouped)).every((line) => line.l === 0 && line.size <= 512),
	'even a stubborn batch item gets a capped line without losing its siblings',
)

await api('POST', `/api/threads/${late}/memory`, { on: false })
await post(late, 'missed before restart')
await api('POST', `/api/threads/${late}/memory`, { lines: [] })

// A withdrawn message leaves no trace in any line over it, in its thread or a fork made after, and a read opens the
// messages that are left; a fork made before still has the message, and keeps it
const w = await thread('withdrawn')
const said = []
for (const body of ['alpha', 'SECRET beta', 'gamma', 'delta'])
	said.push((await post(w, body)).json.entry)
await until(async () => has(await linesOf(w), 0, 3))
await api('POST', `/api/threads/${w}/memory`, {
	lines: [
		{ id: 0, n: 2, text: 'alpha SECRET beta' },
		{ id: 2, n: 2, text: 'gamma delta' },
		{ id: 0, n: 4, text: 'alpha SECRET beta gamma delta' },
	],
})
const kept = (await api('POST', `/api/threads/${w}/fork`, { at: said[3] })).json.id
await api('GET', `/api/threads/${kept}/memory?budget=10`)
await api('POST', `/api/threads/${w}/withdraw`, { entry: said[1] })
const after = (
	await api('POST', `/api/threads/${w}/fork`, { at: (await post(w, 'epsilon')).json.entry })
).json.id
const remembered = async (id) =>
	JSON.stringify(
		await Promise.all(
			['budget=10', 'budget=65536', 'zoom=0,4', 'zoom=0,2', 'zoom=1,1'].map(
				async (query) => (await api('GET', `/api/threads/${id}/memory?${query}`)).json,
			),
		),
	)
const forgets = async () =>
	!(await remembered(w)).includes('SECRET') && !(await remembered(after)).includes('SECRET')
check(
	(await forgets()) && (await remembered(w)).includes('gamma'),
	'a withdrawn message is gone from every line over it, in its thread and a fork made after',
	await remembered(w),
)
check(
	(await remembered(kept)).includes('SECRET'),
	'a fork made before the withdrawal keeps the message in its memory, as in its thread',
)

const c = await thread('restart')
const entries = []
for (let k = 0; k < 8; k++) entries.push((await post(c, long(`m${k}`))).json.entry)
await open(c)
await until(async () => requests.some((r) => r.input.includes('m0 ')), 15000)
await kill(srv, 'SIGKILL')
srv = await server(env)
check(await forgets(), 'after a restart, a withdrawn message is still gone from every line')
check(
	Boolean(await until(async () => has(await linesOf(late), 0, 4))),
	'server startup writes short messages without surviving line tasks',
)
const built = await until(async () => (await linesOf(c)).length >= 8, 30000)
const keys = (await linesOf(c)).map((x) => `${x.l}:${x.i}`)
check(
	Boolean(built) &&
		keys.length === 8 &&
		Array.from({ length: 8 }, (_, i) => `0:${i}`).every((k) => keys.includes(k)),
	'after a SIGKILL the view’s 8 lines arrive, each exactly once, and no merges',
	JSON.stringify(keys.sort()),
)

const at = entries[3]
const f = (await api('POST', `/api/threads/${c}/fork`, { at })).json.id
check(
	(await linesOf(f)).every((x) => x.id <= at),
	'a fork copies no lines',
)
const source = await linesOf(c)
const sourceLine = (l, i) => source.find((x) => x.l === l && x.i === i).text
const before = requests.length
for (let k = 4; k < 8; k++) await post(f, long(`fork${k}`))
await open(f)
const forkWant = ['0:4', '0:5', '0:6', '0:7']
await until(async () => {
	const own = (await linesOf(f)).filter((x) => x.id > at)
	return forkWant.every((k) => own.some((x) => `${x.l}:${x.i}` === k))
}, 30000)
const own = (await linesOf(f))
	.filter((x) => x.id > at)
	.map((x) => `${x.l}:${x.i}`)
	.sort()
const firstFork = requests.slice(before).find((r) => r.input.includes('fork4'))
check(
	[0, 1, 2, 3].every((i) => firstFork?.first.includes(`${i}+1|${sourceLine(0, i)}`)),
	"the fork's first line request reads the source's lines through",
)
check(
	JSON.stringify(own) === JSON.stringify(forkWant),
	'the fork writes only its own message lines',
	JSON.stringify(own),
)

// A line the source writes later, over messages the fork shares, shows in the fork's memory view too
const tightest = async () =>
	(await api('GET', `/api/threads/${f}/memory?room=0`)).json.cut.map((line) => line.text)
await tightest()
await api('POST', `/api/threads/${c}/memory`, {
	lines: [{ id: 0, n: 4, text: 'the first four, merged' }],
})
check(
	(await tightest()).includes('the first four, merged'),
	"a fork's memory view shows a line its source wrote after the fork was first read",
	JSON.stringify(await tightest()),
)

srv.kill()
done()
