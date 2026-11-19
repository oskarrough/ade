/** Automatic and manual compaction use the thread's memory, bounded even with a million-token window, and write only
 * the lines its cut shows; an agent past 70% of `memory.compactAt` gets its seen messages' lines ahead of time. */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import {
	answered,
	api,
	check,
	conversationOf,
	configDir,
	done,
	kill,
	linesOf,
	say,
	scriptedRunner,
	server,
	text,
	until,
} from './lib.js'

const COMPACT_AT = 40000,
	LONGS = 56
let srv = await server({ MODULES: '+memory' })
for (const [
	runner,
	contextWindow,
	count,
	half,
	lineSize,
] of /** @type {[string, number, number, number, number][]} */ ([
	['automatic', 40000, 310, 140, 300],
	['manual', 1000000, 330, 160, 492],
])) {
	const requests = []
	await scriptedRunner(
		runner,
		(request) => {
			requests.push(request.messages.map(text).join('\n'))
			const first = text(request.messages.find((message) => message.role === 'user'))
			if (!first.includes('<input>')) return say('ok')
			const input = first.slice(
				first.lastIndexOf('<input>') + '<input>\n'.length,
				first.lastIndexOf('\n</input>'),
			)
			const line = `L ${'x'.repeat(lineSize - 2)}`
			if (first.includes('without numbering')) return say(line)
			return say([...input.matchAll(/^(\d+)\| /gm)].map((item) => `${item[1]}| ${line}`).join('\n'))
		},
		{ model: { contextWindow } },
	)
	const agent = { runner, model: 'echo/echo' }
	const {
		json: { id },
	} = await api('POST', '/api/threads', { title: runner })
	await api('POST', `/api/threads/${id}/memory`, { on: true })
	const post = (body, to = null) => api('POST', `/api/threads/${id}/entries`, { body, to })
	let position = 0
	// Every ninth filler is long, so the cut needs written lines as well as merges
	const longFiller = (at) => at % 9 === 4
	const fill = async (end) => {
		for (; position < end; position++) {
			const head = `filler ${position} `
			await post(head + 'z'.repeat((longFiller(position) ? 2000 : 500) - head.length))
		}
	}
	await fill(half)
	await post('go A', agent)
	await answered(id, 1, 20000)
	await fill(count)
	const longs = Array.from({ length: count }, (_, at) => at).filter(longFiller).length
	await until(async () => (await linesOf(id)).length === count + 2 - longs, 60000, 500)
	check(
		(await linesOf(id)).every((line) => line.l === 0) &&
			!requests.some((request) => request.includes('<input>')),
		`${runner}: before a compaction, short messages are their own lines and no line is summarized`,
	)
	await post('go B', agent)
	const view = await answered(id, 2, 60000)
	check(
		view.agents[0].contextWindow === contextWindow,
		`${runner}: the thread reports its context window`,
	)
	const conversation = () => conversationOf(view, `echo/echo@${runner}`)
	if (runner === 'manual') {
		check(
			!(await conversation()).entries.some((entry) => entry.kind === 'pi.compaction'),
			'with room to spare, nothing is compacted',
		)
		const { status, json } = await api('POST', `/api/threads/${id}/compact`, {})
		check(
			status < 300 && json.compacted?.length === 1,
			'compacting by hand answers for the thread’s agent',
		)
	}
	const compaction = (await conversation()).entries.find((entry) => entry.kind === 'pi.compaction')
	const summary = text(compaction?.model?.[0] ?? {})
	check(
		summary.includes('<chat>'),
		`${runner}: the conversation is compacted with memory as its summary`,
	)
	const chat = summary.slice(summary.indexOf('<chat>\n') + 7, summary.indexOf('\n</chat>'))
	const heads = chat
		.split('\n')
		.map((line) => line.match(/^(\d+)\+(\d+)\|/))
		.filter(Boolean)
		.map((match) => [Number(match[1]), Number(match[2])])
	check(
		heads.length > 0 &&
			heads.every(
				([at, size], index) => at === (index ? heads[index - 1][0] + heads[index - 1][1] : 0),
			) &&
			heads.reduce((sum, [, size]) => sum + size, 0) === half + 1,
		`${runner}: memory covers the cut exactly, from position 0`,
		JSON.stringify(heads),
	)
	check(
		heads[0]?.[1] > 1 && heads.at(-1)?.[1] === 1,
		`${runner}: old lines are merged, recent messages stay whole`,
		JSON.stringify(heads),
	)
	check(
		Buffer.byteLength(chat) <= Math.min(contextWindow, 64 * 1024),
		`${runner}: memory fits its budget, capped at 64 KiB`,
		Buffer.byteLength(chat),
	)
	check(
		!summary.includes('not summarized yet'),
		`${runner}: the compaction waited for every line its cut shows`,
	)
	const T = half + 1
	const written = await linesOf(id)
	const start = (line) => line.i * 2 ** line.l,
		end = (line) => (line.i + 1) * 2 ** line.l
	check(
		written.some((line) => line.l > 0) &&
			written
				.filter((line) => line.l > 0)
				.every((line) => heads.some(([at, size]) => at <= start(line) && end(line) <= at + size)),
		`${runner}: the only merges written are those under the cut's lines`,
		JSON.stringify(written.filter((line) => line.l > 0).map((line) => `${line.l}:${line.i}`)),
	)
	const summarized = written.filter((line) => line.l === 0 && line.text.startsWith('L '))
	check(
		summarized.length > 0 && summarized.every((line) => line.i < T),
		`${runner}: long messages before the cut got lines, and none after it`,
		JSON.stringify(summarized.map((line) => line.i)),
	)
	check(
		!requests.some((request) => request.includes('context summarization assistant')),
		`${runner}: Pi's summariser never ran`,
	)
}

// Past 70% of compactAt, but short of it, the messages the agent has seen get their lines, and nothing is merged
await kill(srv)
writeFileSync(
	path.join(configDir, 'ade.json'),
	JSON.stringify({ memory: { compactAt: COMPACT_AT } }),
)
srv = await server({ MODULES: '+memory' })
const early = []
await scriptedRunner(
	'early',
	(request) => {
		const first = text(request.messages.find((message) => message.role === 'user'))
		if (!first.includes('<input>')) return say('ok')
		early.push(first)
		const line = `L ${'x'.repeat(298)}`
		if (first.includes('without numbering')) return say(line)
		const input = first.slice(first.lastIndexOf('<input>'))
		return say([...input.matchAll(/^(\d+)\| /gm)].map((item) => `${item[1]}| ${line}`).join('\n'))
	},
	{ model: { contextWindow: 1000000 } },
)
const {
	json: { id: busy },
} = await api('POST', '/api/threads', { title: 'early' })
await api('POST', `/api/threads/${busy}/memory`, { on: true })
for (let k = 0; k < LONGS; k++)
	await api('POST', `/api/threads/${busy}/entries`, {
		body: `early ${k} ${'q'.repeat(2000)}`,
		to: null,
	})
await api('POST', `/api/threads/${busy}/entries`, {
	body: 'go',
	to: { runner: 'early', model: 'echo/echo' },
})
const answer = await answered(busy, 1, 20000)
const agentEntries = (await conversationOf(answer, 'echo/echo@early')).entries
const used = agentEntries.flatMap((entry) => entry.model ?? []).findLast((message) => message.usage)
	?.usage.totalTokens
check(
	used >= 0.7 * COMPACT_AT && used < COMPACT_AT,
	'the agent’s context is past 70% of compactAt, short of it',
	used,
)
check(
	Boolean(await until(async () => (await linesOf(busy)).length === LONGS + 2, 30000)),
	'past 70% of compactAt, every message the agent has seen gets its line',
	JSON.stringify((await linesOf(busy)).map((line) => `${line.l}:${line.i}`)),
)
check(
	(await linesOf(busy)).every((line) => line.l === 0) &&
		!agentEntries.some((entry) => entry.kind === 'pi.compaction'),
	'before its compaction, nothing is merged',
)
done()
