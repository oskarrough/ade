/**
 * Every thread, archived ones included, as files a person can read without ade installed: one Markdown file and one
 * JSON file each.
 */
import { byAgent } from '../util.js'

export const on = false

function fileName(id, title) {
	const slug = String(title)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
	return slug ? `${id}-${slug}` : String(id)
}

const foldLine = (text) => text.replace(/\s+/g, ' ').trim()

function foldShell(shell) {
	const code = shell.code === null ? shell.error || 'stopped' : `exit ${shell.code}`
	const said = foldLine([shell.stdout, shell.stderr].filter(Boolean).join(' '))
	return said ? `${code} — ${said}` : code
}

function toMarkdown(title, people, entries) {
	const lines = [`# ${title}`, '', `People: ${people.join(', ') || 'none'}`]
	for (const { data: message } of entries) {
		lines.push('', `**${message.author}** · ${message.createdAt ?? ''}`, '', message.body)
		if (message.shell) lines.push('', foldShell(message.shell))
	}
	return `${lines.join('\n')}\n`
}

export function server(core) {
	async function serve(threadId) {
		if (threadId !== undefined) throw new Error('Export has nothing per thread')
		const rows = [
			...(await core.threadList(core.owner, false)),
			...(await core.threadList(core.owner, true)),
		]
		const files = {}
		for (const row of rows) {
			const entries = await core.shapeMessages(row.id, await core.messages(row.id), core.owner)
			const { reads } = await core.thread(row.id)
			const wrote = entries
				.filter((entry) => !byAgent(entry.data))
				.map((entry) => entry.data.author)
			const people = [...new Set([...wrote, ...Object.keys(reads)])]
			const base = fileName(row.id, row.title)
			files[`${base}.json`] = `${JSON.stringify(entries, null, 2)}\n`
			files[`${base}.md`] = toMarkdown(row.title, people, entries)
		}
		return { files }
	}

	return { serve }
}
