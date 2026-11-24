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

/** A thread's Markdown file, a message at a time */
function* markdown(title, people, entries) {
	yield `# ${title}\n\nPeople: ${people.join(', ') || 'none'}`
	for (const { data: message } of entries) {
		yield `\n\n**${message.author}** · ${message.createdAt ?? ''}\n\n${message.body}`
		if (message.shell) yield `\n\n${foldShell(message.shell)}`
	}
	yield '\n'
}

/** A thread's JSON file, as `JSON.stringify(entries, null, 2)` writes it, an entry at a time */
function* json(entries) {
	if (!entries.length) return yield '[]\n'
	for (const [at, entry] of entries.entries())
		yield `${at ? ',' : '['}\n  ${JSON.stringify(entry, null, 2).replaceAll('\n', '\n  ')}`
	yield '\n]\n'
}

/** A file in `{files}`: its name, and its text as a JSON string a piece at a time */
function* file(name, pieces) {
	yield `${JSON.stringify(name)}:"`
	for (const piece of pieces) yield JSON.stringify(piece).slice(1, -1)
	yield '"'
}

export function server(core) {
	async function serve(threadId) {
		if (threadId !== undefined) throw new Error('Export has nothing per thread')
		return files()
	}
	/** `{files}` as JSON, sent a message at a time, so only one thread's messages are held at once */
	async function* files() {
		const rows = [
			...(await core.threadList(core.owner, false)),
			...(await core.threadList(core.owner, true)),
		]
		yield '{"files":{'
		for (const [at, row] of rows.entries()) {
			const entries = await core.shapeMessages(row.id, await core.messages(row.id), core.owner)
			const { reads } = await core.thread(row.id)
			const wrote = entries
				.filter((entry) => !byAgent(entry.data))
				.map((entry) => entry.data.author)
			const people = [...new Set([...wrote, ...Object.keys(reads)])]
			const base = fileName(row.id, row.title)
			if (at) yield ','
			yield* file(`${base}.json`, json(entries))
			yield ','
			yield* file(`${base}.md`, markdown(row.title, people, entries))
		}
		yield '}}'
	}

	return { serve }
}
