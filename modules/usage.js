/**
 * Usage and cost: the tokens each thread's agents spent and what they'd cost at list price, per thread and for the
 * whole house. Off by default; MODULES=+usage turns it on.
 *
 * Nothing new is stored: each agent turn Pi keeps already holds its model, its tokens (fresh input, output, cache
 * reads and writes) and their cost as pi prices the model. That cost is the list price, which a subscription login
 * (Claude Code, ChatGPT) never bills, so it's `billed` only where a runner offers the provider on an API key (its
 * `metered` providers, less its `free` models) or the provider reported the cost itself (OpenRouter). Tokens are the
 * honest number either way. Model calls modules make for themselves (titles, memory lines, the director, recaps)
 * and compaction summaries aren't stored as turns, so they aren't counted.
 *
 * `GET /api/usage?since=&until=&zone=` answers the house's `{total, models, days, threads, bots, threadCount}`: days
 * start at the asker's midnight, `zone` being what its clock adds to UTC in milliseconds; bots are each bot's turns across
 * every thread, and `agent` the threads' own agents. `GET /api/threads/:id/usage` answers the
 * thread's `{total, models}`, one model row per agent there; `since` and `until` are epoch milliseconds. Each count
 * is `{calls, input, output, cacheRead, cacheWrite, cost, billed}`, cost and billed in dollars. The turns are read
 * once, on the first request, then kept as Pi stores each new one.
 */
import { DatabaseSync } from 'node:sqlite'
import { AGENT } from '../util.js'

export const on = false

const ASSISTANT = 'pi.assistant'
/** Threads the house view lists, most expensive first */
const THREADS = 30

const SUMS = `count(*) as calls, sum(input) as input, sum(output) as output, sum(cache_read) as cacheRead,
	sum(cache_write) as cacheWrite, sum(cost) as cost, sum(cost * from_provider) as reported`

export function server(core) {
	const db = new DatabaseSync(':memory:')
	db.exec(`
		create table turns (
			entry integer primary key, conversation integer, at integer, provider text, model text,
			input integer, output integer, cache_read integer, cache_write integer, cost real, from_provider integer
		);
		create index turns_by_conversation on turns (conversation, at);
	`)
	const insert = db.prepare('insert or ignore into turns values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')

	/** One stored entry: an agent's model answer becomes a turn, once */
	function entryStored(entry) {
		if (entry.kind !== ASSISTANT) return
		for (const message of entry.model ?? []) {
			const usage = message.role === 'assistant' && message.usage
			if (!usage) continue
			insert.run(
				entry.id,
				entry.conversationId,
				message.timestamp ?? 0,
				message.provider ?? '',
				message.model ?? '',
				usage.input ?? 0,
				usage.output ?? 0,
				usage.cacheRead ?? 0,
				usage.cacheWrite ?? 0,
				usage.cost?.total ?? 0,
				usage.cost?.totalFromProvider ? 1 : 0,
			)
		}
	}

	/** Every turn stored so far, read on the first request; turns stored meanwhile go in as they come */
	let ready
	async function build() {
		for (const { id } of await core.conversations()) {
			const found = await core.entries(id)
			db.exec('begin')
			try {
				// A fork reads its parent's entries too; only its own were spent here
				for (const entry of found) if (entry.conversationId === id) entryStored(entry)
				db.exec('commit')
			} catch (error) {
				db.exec('rollback')
				throw error
			}
		}
	}
	const built = () => {
		ready ??= build().catch((error) => {
			ready = undefined
			throw error
		})
		return ready
	}

	/** Whether a model's cost is a bill: some runner offers its provider on an API key, and it isn't one of the free ones */
	async function meteredOf() {
		const runners = Object.values(await core.known())
		return (provider, model) =>
			runners.some(
				(runner) =>
					runner.metered?.includes(provider) && !runner.free?.includes(`${provider}/${model}`),
			)
	}

	const DAY = 86_400_000
	/** `since` and `until` in epoch milliseconds, and `zone`, what the asker's clock adds to UTC, which its days follow */
	const range = (query) => ({
		since: Number(query.get('since')) || 0,
		until: Number(query.get('until')) || Number.MAX_SAFE_INTEGER,
		zone: Number(query.get('zone')) || 0,
	})
	/** A row of sums as the API answers it: billed is the whole cost on a metered model, else what the provider reported */
	const counted = ({ reported, ...row }, metered) => ({
		...row,
		cost: row.cost ?? 0,
		billed: metered ? (row.cost ?? 0) : (reported ?? 0),
	})
	const add = (rows) =>
		rows.reduce(
			(total, row) => {
				for (const key of Object.keys(total)) total[key] += row[key] ?? 0
				return total
			},
			{ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, billed: 0 },
		)
	/** Rows summed by what `key` says each belongs to, most expensive first */
	const grouped = (rows, key) => {
		/** @type {Map<any, any[]>} */
		const groups = new Map()
		for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row])
		return [...groups]
			.map(([group, of]) => [group, add(of)])
			.sort((one, other) => other[1].cost - one[1].cost)
	}

	const byModel = db.prepare(`
		select provider, model, ${SUMS} from turns where at >= :since and at < :until
		group by provider, model order by sum(cost) desc
	`)
	const byConversation = db.prepare(`
		select conversation, provider, model, ${SUMS} from turns where at >= :since and at < :until
		group by conversation, provider, model
	`)
	const byDay = db.prepare(`
		select cast((at + :zone) / ${DAY} as integer) as day, provider, model, ${SUMS} from turns
		where at >= :since and at < :until group by day, provider, model
	`)
	const ofConversation = db.prepare(`
		select provider, model, ${SUMS} from turns
		where conversation = :conversation and at >= :since and at < :until
		group by provider, model order by sum(cost) desc
	`)

	/** The house: its total, each model, each day, the threads that cost most, and each bot across its threads */
	async function house(query) {
		await built()
		const between = range(query)
		const metered = await meteredOf()
		const priced = (/** @type {any} */ row) => counted(row, metered(row.provider, row.model))
		const { zone: _, ...within } = between
		const models = /** @type {any[]} */ (byModel.all(within)).map(priced)
		const days = grouped(/** @type {any[]} */ (byDay.all(between)).map(priced), (row) => row.day)
			.map(([day, sums]) => ({ day: day * DAY - between.zone, ...sums }))
			.sort((one, other) => one.day - other.day)
		const owners = new Map(
			(await core.conversations()).map((one) => [one.id, one.owner?.conversationId ?? one.id]),
		)
		const rows = /** @type {any[]} */ (byConversation.all(within)).map((row) => ({
			...priced(row),
			thread: owners.get(row.conversation) ?? row.conversation,
		}))
		const threadIds = [...new Set(rows.map((row) => row.thread))]
		const found = await Promise.all(threadIds.map((id) => core.thread(id)))
		const docs = new Map(threadIds.map((id, index) => [id, found[index]]))
		/** Whose a conversation is: a bot by name, else the thread's own agent */
		const whose = (row) => {
			const agents = Object.entries(docs.get(row.thread)?.agents ?? {})
			const key = agents.find(([, agent]) => agent.conversation === row.conversation)?.[0]
			return key && key !== AGENT ? key : AGENT
		}
		return {
			total: add(models),
			models,
			days,
			threads: grouped(rows, (row) => row.thread)
				.slice(0, THREADS)
				.map(([thread, sums]) => ({
					thread,
					...sums,
					title: docs.get(thread)?.title ?? '',
					archived: Boolean(docs.get(thread)?.hidden),
				})),
			bots: grouped(rows, whose).map(([bot, sums]) => ({ bot, ...sums })),
			threadCount: threadIds.length,
		}
	}

	async function thread(id, query) {
		const doc = await core.thread(id)
		if (!doc) throw Object.assign(new Error('Thread not found'), { status: 404 })
		await built()
		const between = range(query)
		const metered = await meteredOf()
		const names = new Map(
			Object.entries(doc.agents ?? {}).map(([key, { conversation }]) => [conversation, key]),
		)
		const owned = (await core.conversations()).filter(
			(one) => one.id === id || one.owner?.conversationId === id,
		)
		const { zone: _, ...within } = between
		const models = owned.flatMap((one) =>
			/** @type {any[]} */ (ofConversation.all({ conversation: one.id, ...within })).map((row) => ({
				agent: names.get(one.id) ?? AGENT,
				...counted(row, metered(row.provider, row.model)),
			})),
		)
		models.sort((one, other) => other.cost - one.cost)
		return { total: add(models), models }
	}

	async function serve(threadId, query, body) {
		if (body !== undefined) throw new Error('Usage is GET /api/usage or /api/threads/:id/usage')
		return threadId === undefined ? house(query) : thread(threadId, query)
	}

	return { entryStored, serve }
}
