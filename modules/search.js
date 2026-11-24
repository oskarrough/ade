/**
 * Search across every thread's messages, archived ones included, to find where something was said. Off by default;
 * MODULES=+search turns it on.
 *
 * `GET /api/search?q=<words>` answers up to 50 matches, best first: `[{thread, title, archived, message, author,
 * createdAt, snippet}]`, `message` being the entry id and `snippet` the words around the match, each matched word
 * between `\u0001` and `\u0002`. Every word must match, the last one as a prefix; "quoted words" match as a phrase. Agents get
 * the same results as text through the `search` tool. The index is the read model's (read.js): SQLite's full-text search
 * over `ade_messages`, kept with the tables, so a start builds nothing. While the tables are being made, a search waits
 * for them; if they can't be, it answers 503.
 */
import { num, obj, opt, str } from '@earendil-works/pi-schema'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'

export const on = false

const LIMIT = 50

/** What someone typed as an FTS5 query: each word or "phrase" quoted, so nothing in it reads as syntax; the last
 * word, still being typed, matches as a prefix */
function matchOf(text) {
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
	const FIND = `
		select found.rowid as message, ade_messages.thread_id as thread, ade_threads.title, ade_threads.archived,
			ade_messages.author, ade_messages.at, found.snippet
		from (
			select rowid, rank, snippet(ade_messages_fts, 0, char(1), char(2), '…', 24) as snippet
			from ade_messages_fts where ade_messages_fts match ? order by rank limit ?
		) as found
		join ade_messages on ade_messages.id = found.rowid
		join ade_threads on ade_threads.id = ade_messages.thread_id
		order by found.rank`

	/** The best matches for what someone typed, from the read model's index */
	async function search(text, limit = LIMIT) {
		const match = matchOf(String(text ?? ''))
		if (!match) return []
		const rows = await core.recent((all) => all(FIND, match, limit))
		if (!rows)
			throw Object.assign(new Error('Search is down with the read tables'), { status: 503 })
		return rows.map((row) => ({
			thread: row.thread,
			title: row.title,
			archived: Boolean(row.archived),
			message: row.message,
			author: row.author,
			createdAt: row.at ?? '',
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
		serve,
	}
}
