/**
 * Usage and cost: the tokens each thread's agents spent and what they'd cost at list price, per thread and for the
 * whole house. Off by default; MODULES=+usage turns it on.
 *
 * Agents' turns are read from what Pi keeps: each holds its model, its tokens (fresh input, output, cache reads and
 * writes) and their cost as pi prices the model. Compaction summaries are what Pi's own ledger of each conversation's
 * spend (`pi.usage`) holds beyond its turns, dated by the compactions it wrote. Calls modules make for themselves
 * (titles, memory lines and merges, the director's picks, recaps) go through util's `complete`, which hands what each
 * spent to `spent`; that is kept on the thread's `ade.usage` doc, an hour's calls of one purpose and model together.
 * With the module off, nothing is kept.
 *
 * The cost is the list price, which a subscription login (Claude Code, ChatGPT) never bills, so it's `billed` only
 * where a runner offers the provider on an API key (its `metered` providers, less its `free` models) or the provider
 * reported the cost itself (OpenRouter). Tokens are the honest number either way.
 *
 * `GET /api/usage?since=&until=&zone=` answers the house's `{total, models, days, threads, by, threadCount}`: days
 * start at the asker's midnight, `zone` being what its clock adds to UTC in milliseconds; `by` is who or what spent it,
 * each bot across its threads, `agent` the threads' own agents, then `titles`, `memory`, `director`, `recap` and
 * `compaction`. `GET /api/threads/:id/usage` answers the thread's `{total, models}`, a model row for each agent there,
 * or `purpose` for the rest; `since` and `until` are epoch milliseconds. Each count
 * is `{calls, input, output, cacheRead, cacheWrite, cost, billed}`, cost and billed in dollars. The turns are read
 * once, on the first request, then kept as Pi stores each new one.
 */
import { DatabaseSync } from 'node:sqlite'
import { defineDoc, UsageDoc } from '@earendil-works/pi-durable'
import { AGENT } from '../util.js'

export const on = false

const ASSISTANT = 'pi.assistant'
/** Threads the house view lists, most expensive first */
const THREADS = 30

const COMPACTION = 'compaction'
const HOUR = 3_600_000

/** A thread's module calls, an hour's calls of one purpose and model in each bucket */
const Spent = defineDoc({
	kind: 'ade.usage',
	version: 1,
	scope: 'conversation',
	history: 'latest',
	fork: 'initial',
	checkpointWhen: () => true,
	initial: () => ({ buckets: {} }),
})

const SUMS = `sum(calls) as calls, sum(input) as input, sum(output) as output, sum(cache_read) as cacheRead,
	sum(cache_write) as cacheWrite, sum(cost) as cost, sum(cost * from_provider) as reported`

export function server(core) {
	const db = new DatabaseSync(':memory:')
	// `purpose` is empty for an agent's turn, else what spent it: a module's purpose, or compaction
	db.exec(`
		create table spend (
			id integer primary key, entry integer unique, conversation integer, at integer, purpose text not null,
			provider text, model text, calls integer, input real, output real, cache_read real, cache_write real,
			cost real, from_provider integer
		);
		create index spend_by_conversation on spend (conversation, at);
	`)
	const insert = db.prepare(`
		insert or ignore into spend
			(entry, conversation, at, purpose, provider, model, calls, input, output, cache_read, cache_write, cost, from_provider)
		values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`)
	/** One row: an entry's turn (`entry` its id), or a module's or compaction's (none) */
	const put = (entry, conversation, at, purpose, provider, model, calls, usage) =>
		insert.run(
			entry,
			conversation,
			at,
			purpose,
			provider ?? '',
			model ?? '',
			calls,
			usage.input ?? 0,
			usage.output ?? 0,
			usage.cacheRead ?? 0,
			usage.cacheWrite ?? 0,
			typeof usage.cost === 'number' ? usage.cost : (usage.cost?.total ?? 0),
			usage.reported ?? (usage.cost?.totalFromProvider ? 1 : 0),
		)

	/** One stored entry: an agent's model answer becomes a turn, once */
	function entryStored(entry) {
		if (entry.kind !== ASSISTANT) return
		for (const message of entry.model ?? [])
			if (message.role === 'assistant' && message.usage)
				put(
					entry.id,
					entry.conversationId,
					message.timestamp ?? 0,
					'',
					message.provider,
					message.model,
					1,
					message.usage,
				)
	}

	/** A thread's module calls, as its doc has them now, in place of what was known of them */
	const forget = db.prepare(
		`delete from spend where conversation = ? and entry is null and purpose != '${COMPACTION}'`,
	)
	function calls(thread, buckets) {
		forget.run(thread)
		for (const bucket of Object.values(buckets ?? {}))
			put(null, thread, bucket.at, bucket.purpose, bucket.provider, bucket.model, bucket.calls, {
				...bucket,
				reported: bucket.reported ? 1 : 0,
			})
	}

	/** What a module's own model call spent, added to its thread's hour */
	async function spent(thread, purpose, reply) {
		if (thread === undefined || !purpose) return
		const at = Math.floor(Date.now() / HOUR) * HOUR
		const { usage } = reply
		const key = `${at}|${purpose}|${reply.provider}/${reply.model}`
		const buckets = await core.commit(async (tx) => {
			const doc = await tx.doc(Spent, thread)
			doc.buckets[key] ??= {
				at,
				purpose,
				provider: reply.provider,
				model: reply.model,
				calls: 0,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				reported: false,
			}
			const bucket = doc.buckets[key]
			bucket.calls += 1
			bucket.input += usage.input ?? 0
			bucket.output += usage.output ?? 0
			bucket.cacheRead += usage.cacheRead ?? 0
			bucket.cacheWrite += usage.cacheWrite ?? 0
			bucket.cost += usage.cost?.total ?? 0
			bucket.reported ||= Boolean(usage.cost?.totalFromProvider)
			return JSON.parse(JSON.stringify(doc.buckets))
		})
		if (done) calls(thread, buckets)
	}

	const kept = db.prepare(`
		select sum(input) as input, sum(output) as output, sum(cache_read) as cacheRead,
			sum(cache_write) as cacheWrite, sum(cost) as cost
		from spend where conversation = ? and provider = ? and model = ? and (purpose = '' or purpose = '${COMPACTION}')
	`)
	/**
	 * Compaction: what a conversation's ledger holds beyond the turns and compactions already known, per model, spread
	 * over `times`, when its compactions were written
	 */
	function settle(conversation, ledger, times) {
		for (const [name, usage] of Object.entries(ledger?.models ?? {})) {
			const slash = name.indexOf('/')
			const [provider, model] = [name.slice(0, slash), name.slice(slash + 1)]
			const known = /** @type {any} */ (kept.get(conversation, provider, model)) ?? {}
			const beyond = {
				input: (usage.input ?? 0) - (known.input ?? 0),
				output: (usage.output ?? 0) - (known.output ?? 0),
				cacheRead: (usage.cacheRead ?? 0) - (known.cacheRead ?? 0),
				cacheWrite: (usage.cacheWrite ?? 0) - (known.cacheWrite ?? 0),
				cost: (usage.cost?.total ?? 0) - (known.cost ?? 0),
			}
			// A ledger younger than its turns holds less than they do; only what's beyond them is compaction's
			if (
				!(beyond.cost > 1e-9 || beyond.output > 0) ||
				Object.values(beyond).some((value) => value < -1e-6)
			)
				continue
			const share = Object.fromEntries(
				Object.entries(beyond).map(([key, value]) => [key, value / times.length]),
			)
			for (const at of times)
				put(null, conversation, at, COMPACTION, provider, model, 1, {
					...share,
					reported: usage.cost?.totalFromProvider ? 1 : 0,
				})
		}
	}

	/** A conversation's ledger changed: once the build is done, what it adds beyond the commit's turns is a compaction */
	function documentStored(change) {
		if (!done || change.record.kind !== UsageDoc.definition.kind) return
		const { conversationId, value } = change
		// After the commit's entries, which the same publication hands over in any order
		queueMicrotask(() => settle(conversationId, value, [Date.now()]))
	}

	/** Every turn, module call and compaction so far, read on the first request; what's stored meanwhile goes in as it comes */
	let ready
	let done = false
	async function build() {
		for (const { id, owner } of await core.conversations()) {
			const found = await core.entries(id)
			const [ledger, spentHere] = await Promise.all([
				core.snapshot(UsageDoc, id),
				owner ? undefined : core.snapshot(Spent, id),
			])
			db.exec('begin')
			try {
				// A fork reads its parent's entries too; only its own were spent here
				const own = found.filter((entry) => entry.conversationId === id)
				for (const entry of own) entryStored(entry)
				const compactions = own.filter((entry) => entry.kind === 'pi.compaction')
				const last = own.findLast((entry) => entry.kind === ASSISTANT)?.model?.[0]?.timestamp ?? 0
				settle(
					id,
					ledger,
					compactions.length
						? compactions.map((entry) => entry.model?.[0]?.timestamp ?? last)
						: [last],
				)
				if (spentHere) calls(id, spentHere.buckets)
				db.exec('commit')
			} catch (error) {
				db.exec('rollback')
				throw error
			}
		}
		done = true
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
		select provider, model, ${SUMS} from spend where at >= :since and at < :until
		group by provider, model order by sum(cost) desc
	`)
	const byConversation = db.prepare(`
		select conversation, purpose, provider, model, ${SUMS} from spend where at >= :since and at < :until
		group by conversation, purpose, provider, model
	`)
	const byDay = db.prepare(`
		select cast((at + :zone) / ${DAY} as integer) as day, provider, model, ${SUMS} from spend
		where at >= :since and at < :until group by day, provider, model
	`)
	const ofConversation = db.prepare(`
		select purpose, provider, model, ${SUMS} from spend
		where conversation = :conversation and at >= :since and at < :until
		group by purpose, provider, model order by sum(cost) desc
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
		/** Who spent it: a module's purpose or compaction, else a bot by name, else the thread's own agent */
		const whose = (row) => {
			if (row.purpose) return row.purpose
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
			by: grouped(rows, whose).map(([by, sums]) => ({ by, ...sums })),
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
				agent: row.purpose || (names.get(one.id) ?? AGENT),
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

	return { entryStored, documentStored, spent, serve }
}
