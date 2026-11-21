/**
 * Every thread, archived ones included, written to a folder as files a person can read without ade installed: one
 * Markdown file and one JSON file each. Off by default; MODULES=+export turns it on.
 *
 * `GET /api/export?dir=<path>` writes them on the server's own machine and answers `{dir, written}`, the resolved
 * folder and how many threads it wrote. `node cli.js export <dir>` resolves `<dir>` against the shell's own folder
 * and calls it; cli and server share a machine the way ade runs, so this is the same write, not a download.
 *
 * Each thread's JSON file holds its entries exactly as `GET /api/threads/:id` returns them. Its Markdown file is for
 * a person: the title, who wrote in it, then every message as "**author** · time" with the body; a `$ cmd` message's
 * shell result folds into one line instead of its full stdout and stderr.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
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

	/** Writes every thread into `dir`, archived ones included: `{dir, written}` */
	async function exportAll(dir) {
		if (!dir || typeof dir !== 'string') throw new Error('dir is required')
		const full = path.resolve(dir)
		await mkdir(full, { recursive: true })
		const rows = [
			...(await core.threadList(core.owner, false)),
			...(await core.threadList(core.owner, true)),
		]
		for (const row of rows) {
			const entries = await core.messages(row.id)
			const people = await peopleOf(row.id, entries)
			const base = path.join(full, fileName(row.id, row.title))
			await writeFile(`${base}.json`, `${JSON.stringify(entries, null, 2)}\n`)
			await writeFile(`${base}.md`, toMarkdown(row.title, people, entries))
		}
		return { dir: full, written: rows.length }
	}

	async function serve(threadId, query, body) {
		if (threadId !== undefined) throw new Error('Export has nothing per thread')
		return exportAll(body?.dir ?? query?.get('dir'))
	}

	return { serve }
}
