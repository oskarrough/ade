/**
 * Search across every thread's messages, archived ones included, to find where something was said. Off by default;
 * MODULES=+search turns it on.
 *
 * `GET /api/search?q=<words>` answers up to 50 matches, best first: `[{thread, title, archived, message, author,
 * createdAt, snippet}]`, `message` being the entry id and `snippet` the words around the match, each matched word
 * between `\u0001` and `\u0002`. Every word must match, the last one as a prefix; "quoted words" match as a phrase. Agents get
 * the same results as text through the `search` tool. The index is SQLite's full-text search, in memory: built from
 * every thread on start, in the background (about 0.4 s for 7,000 messages), and kept as Pi stores each entry after.
 */
import { DatabaseSync } from 'node:sqlite'
import { num, obj, opt, str } from '@earendil-works/pi-schema'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'

export const on = false

const MESSAGE = 'ade.message'
const WITHDRAWAL = 'ade.withdrawal'
const LIMIT = 50

/** What someone typed as an FTS5 query: each word or "phrase" quoted, so nothing in it reads as syntax; the last
 * word, still being typed, matches as a prefix */
export function matchOf(text) {
	const parts = [...text.matchAll(/"([^"]*)"?|[^\s"]+/g)]
		.map(([whole, phrase]) => ({
			words: (phrase ?? whole).match(/[\p{L}\p{N}_]+/gu) ?? [],
			phrase: phrase !== undefined,
		}))
		.filter((part) => part.words.length)
	if (!parts.length) return undefined
	const last = parts.at(-1)
	return parts
		.map((part) =>
			part === last && !part.phrase && !/\s$/.test(text)
				? `"${part.words.join(' ')}"*`
				: `"${part.words.join(' ')}"`,
		)
		.join(' ')
}

const ago = (createdAt) => {
	const minutes = Math.round((Date.now() - Date.parse(createdAt)) / 60000)
	if (!(minutes >= 1)) return 'now'
	if (minutes < 60) return `${minutes}m ago`
	if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h ago`
	return `${Math.round(minutes / 1440)}d ago`
}

export function server(core) {
	const db = new DatabaseSync(':memory:')
	db.exec(`
		create virtual table messages using fts5(
			body, author unindexed, thread unindexed, at unindexed,
			tokenize = 'porter unicode61 remove_diacritics 2'
		)
	`)
	const has = db.prepare('select 1 from messages where rowid = ?')
	const insert = db.prepare(
		'insert into messages (rowid, body, author, thread, at) values (?, ?, ?, ?, ?)',
	)
	const remove = db.prepare('delete from messages where rowid = ?')
	const find = db.prepare(`
		select rowid as message, thread, author, at,
			snippet(messages, 0, char(1), char(2), '…', 24) as snippet
		from messages where messages match :match order by rank limit :limit
	`)

	/** Messages taken back; one the start's read of its thread brings after its withdrawal was stored stays out */
	const withdrawn = new Set()
	/** One stored entry into the index: a message once, under the thread that wrote it (a fork reads its parent's too),
	 * and out again when withdrawn */
	function entryStored(entry) {
		if (entry.kind === MESSAGE) {
			const { body, author, createdAt } = entry.data
			if (!body?.trim() || withdrawn.has(entry.id) || has.get(entry.id)) return
			insert.run(entry.id, body, author ?? '', entry.conversationId, createdAt ?? '')
		} else if (entry.kind === WITHDRAWAL) {
			withdrawn.add(entry.data.message)
			remove.run(entry.data.message)
		}
	}

	/** Every thread's messages, read on start while entries stored meanwhile go in as they come; a search waits for it */
	let ready
	async function build() {
		// Oldest first, so a fork's parent is read before the fork that reads its messages too
		for (const thread of (await core.threadIds()).reverse()) {
			const found = await core.entries(thread)
			db.exec('begin')
			try {
				for (const entry of found) entryStored(entry)
				db.exec('commit')
			} catch (error) {
				db.exec('rollback')
				throw error
			}
		}
	}
	function start() {
		ready = build()
		ready.catch((error) => console.error('search: building the index failed:', error))
	}

	/** The best matches for what someone typed, newest titles and archived state as the threads have them now */
	async function search(text, limit = LIMIT) {
		const match = matchOf(String(text ?? ''))
		if (!match) return []
		await ready
		const rows = /** @type {any[]} */ (find.all({ match, limit }))
		const ids = [...new Set(rows.map((row) => row.thread))]
		const found = await Promise.all(ids.map((id) => core.thread(id)))
		const threads = new Map(ids.map((id, index) => [id, found[index]]))
		return rows.map((row) => ({
			thread: row.thread,
			title: threads.get(row.thread)?.title ?? '',
			archived: Boolean(threads.get(row.thread)?.hidden),
			message: row.message,
			author: row.author,
			createdAt: row.at,
			snippet: row.snippet,
		}))
	}

	async function serve(threadId, query, body) {
		if (threadId !== undefined || body !== undefined)
			throw new Error('Search is GET /api/search?q=<words>')
		return search(query.get('q'))
	}

	const searchTool = defineTool({
		name: 'search',
		description:
			'Search every thread\'s messages, archived ones included, for where something was said or decided. Every word must match; "quoted words" match as a phrase. Answers the best matches, each with its thread, message id, author, age and the words around the match in [brackets].',
		parameters: obj({
			query: str({ description: 'The words to find' }),
			limit: opt(num({ description: `How many matches, ${20} by default, at most ${LIMIT}` })),
		}),
		replay: 'safe',
		execute: async ({ query, limit }) => {
			const found = await search(query, Math.min(Math.max(1, limit ?? 20), LIMIT))
			const text = found.length
				? found
						.map(
							(row) =>
								`thread ${row.thread} "${row.title}"${row.archived ? ' (archived)' : ''} · message ${row.message} · ${row.author} · ${ago(row.createdAt)}\n  ${row.snippet.replace(/\s+/g, ' ').replaceAll('\u0001', '[').replaceAll('\u0002', ']')}`,
						)
						.join('\n')
				: 'Nothing matches.'
			return { output: [{ type: 'text', text }] }
		},
	})

	return {
		extension: defineExtension({ name: 'ade.search', tools: [searchTool] }),
		start,
		entryStored,
		serve,
	}
}
