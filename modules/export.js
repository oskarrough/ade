/**
 * Every thread, archived ones included, as files a person can read without ade installed: one Markdown file and one
 * JSON file each. Off by default; MODULES=+export turns it on.
 *
 * `GET /api/export` answers `{files}`, a map of file name to its text; nothing is written on the server, so the
 * route is a plain read and reaches a server anywhere, not only its own machine. `node cli.js export <dir>` fetches
 * it and writes each file into `<dir>` itself.
 *
 * Each thread's JSON file holds its entries exactly as `GET /api/threads/:id` returns them. Its Markdown file is for
 * a person: the title, who wrote in it, then every message as "**author** · time" with the body; a `$ cmd` message's
 * shell result folds into one line instead of its full stdout and stderr.
 */
import { byAgent } from '../util.js'

export const on = false

/** A filesystem-safe name from a thread's id (unique on its own) and its title */
function fileName(id, title) {
	const slug = String(title)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
	return slug ? `${id}-${slug}` : String(id)
}

/** Whitespace and newlines collapsed to one line */
const foldLine = (text) => text.replace(/\s+/g, ' ').trim()

/** A `$ cmd` message's shell result, folded to one line: its exit and whatever it printed */
function foldShell(shell) {
	const code = shell.code === null ? shell.error || 'stopped' : `exit ${shell.code}`
	const said = foldLine([shell.stdout, shell.stderr].filter(Boolean).join(' '))
	return said ? `${code} — ${said}` : code
}

/** The thread as Markdown: its title, who wrote in it, then each message */
function toMarkdown(title, people, entries) {
	const lines = [`# ${title}`, '', `People: ${people.join(', ') || 'none'}`]
	for (const { data: message } of entries) {
		lines.push('', `**${message.author}** · ${message.createdAt ?? ''}`, '', message.body)
		if (message.shell) lines.push('', foldShell(message.shell))
	}
	return `${lines.join('\n')}\n`
}

export function server(core) {
	/** A thread's people: who wrote as themselves, and whoever has read it, same as the thread view's own list */
	async function peopleOf(id, entries) {
		const { reads } = await core.thread(id)
		const wrote = entries.filter((entry) => !byAgent(entry.data)).map((entry) => entry.data.author)
		return [...new Set([...wrote, ...Object.keys(reads)])]
	}

	/** Every thread's files, archived ones included: `{files: {<name>: content}}`, nothing written anywhere */
	async function exportAll() {
		const rows = [
			...(await core.threadList(core.owner, false)),
			...(await core.threadList(core.owner, true)),
		]
		const files = {}
		for (const row of rows) {
			const entries = await core.messages(row.id)
			const people = await peopleOf(row.id, entries)
			const base = fileName(row.id, row.title)
			files[`${base}.json`] = `${JSON.stringify(entries, null, 2)}\n`
			files[`${base}.md`] = toMarkdown(row.title, people, entries)
		}
		return { files }
	}

	async function serve(threadId) {
		if (threadId !== undefined) throw new Error('Export has nothing per thread')
		return exportAll()
	}

	return { serve }
}
