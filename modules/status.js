/**
 * Shows on a runner's terminal what its agents are doing, in the Program Status Protocol (OSC 7501):
 * https://www.superlogical.com/rex/docs/build/program-status.
 */

export const on = true

/**
 * Each runner hears the threads a commit touched, as its owner's list has them: `{id, title, agents, status}` for one
 * its agents work in, answered or failed, `{id}` for one that's none of those now; and all of them once it's online.
 * One telling at a time, so an older one never lands after a newer one.
 */
export function server({ runners, known, threadIds, threadRows, threadMatch }) {
	let changed = new Set()
	let telling
	async function tell() {
		while (changed.size) {
			const ids = [...changed]
			changed = new Set()
			const all = await known()
			for (const name of Object.keys(all).filter(runners.isOnline)) {
				const threads = (await threadRows(ids, all[name].owner)).map(([id, thread]) => {
					const agents = thread?.agents
						.filter((agent) => agent.to?.runner === name)
						.map((agent) => agent.name)
						.join(' ')
					return agents && ['working', 'done', 'error'].includes(thread.status)
						? { id, title: thread.title, agents, status: thread.status }
						: { id }
				})
				runners.tell(name, { op: 'status', threads })
			}
		}
	}
	function touched(ids) {
		for (const id of ids) changed.add(id)
		telling ??= tell()
			.catch((error) => console.error(error))
			.finally(() => (telling = undefined))
	}
	return {
		committed({ changes }) {
			const hits = changes.map(threadMatch)
			touched(hits.includes(true) ? threadIds() : hits.flatMap((hit) => hit || []))
		},
		runner: (_name, online) => online && touched(threadIds()),
	}
}

// oxlint-disable-next-line no-control-regex -- strip terminal control characters
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/g
/** Free text as the spec has it: one line of UTF-8, at most `max` bytes, in base64 */
function text(value, max) {
	let cut = ''
	for (const character of value.replace(CONTROL_CHARACTERS, ' ').trim())
		if (Buffer.byteLength(cut + character) <= max) cut += character
		else break
	return Buffer.from(cut).toString('base64')
}
/** One report; it replaces its record whole, so every key it should keep is in it */
const report = (pairs) =>
	`\u001b]7501;${Object.entries(pairs)
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => `${key}=${value}`)
		.join(':')}\u001b\\`

export function runner({ name, server }) {
	if (!process.stdout.isTTY && process.env.STATUS !== '1') return {}
	let shown = new Map()
	/** The threads the server told of and hasn't taken back, by id */
	const heard = new Map()
	function show(root, threads = []) {
		const next = new Map([
			['', report({ state: root.state, app: 'ade', msg: text(root.msg, 2048) })],
		])
		for (const thread of threads)
			next.set(
				String(thread.id),
				report({
					state: thread.status,
					id: thread.id,
					title: text(`#${thread.id} ${thread.title}`, 192),
					msg: text(thread.agents, 2048),
				}),
			)
		for (const id of shown.keys())
			if (!next.has(id)) process.stdout.write(report({ state: 'clear', id }))
		for (const [id, sequence] of next)
			if (shown.get(id) !== sequence) process.stdout.write(sequence)
		shown = next
	}
	return {
		told({ threads }) {
			for (const thread of threads)
				if (thread.status) heard.set(thread.id, thread)
				else heard.delete(thread.id)
			const working = [...heard.values()].filter((thread) => thread.status === 'working').length
			show(
				{
					state: working ? 'working' : 'idle',
					msg: `${name}: ${working ? `${working} working` : 'online'}`,
				},
				[...heard.values()],
			)
		},
		disconnected: () => {
			heard.clear()
			show({ state: 'error', msg: `${name}: offline, retrying ${server}` })
		},
	}
}
