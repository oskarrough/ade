/** Writes each agent's conversation as a pi session file on its runner, in the folder's own sessions directory, so `pi --resume` there lists it and carries on, and starts a thread from a pi session there.
 */
import { existsSync } from 'node:fs'
import { appendFile, mkdir, open as openFile, readdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
	convertToLlm,
	CURRENT_SESSION_VERSION,
	getAgentDir,
	migrateSessionEntries,
	parseSessionEntries,
	SessionManager,
	SettingsManager,
} from '@earendil-works/pi-coding-agent'
import {
	AssistantEntry,
	CompactionEntry,
	ProviderDoc,
	ToolResultEntry,
} from '@earendil-works/pi-durable'

export const on = false

export async function server(core) {
	// Server-only files, which a runner doesn't have
	const { AGENT, writtenTo } = await import('../util.js')
	const { defaultTitle } = await import('../apps/client/title.js')
	/** The thread's first entry says which pi session it came from; its messages are the other kind, so nothing else reads it */
	const SOURCE = 'ade.pi-session'
	// The thread contract's two kinds of entry, as server.js writes them
	const MESSAGE = 'ade.message'
	const DELIVERY = 'ade.delivery'
	const followed = new Map()
	const touched = new Set()
	/** Pi has no place for a reset, and a system message would put ade's tools where pi's own belong */
	const sendable = (entry) => entry.kind !== 'pi.system' && entry.kind !== 'pi.reset' && entry.model

	/** What the person typed, where ade handed the agent a tag naming them (once a second person has written) or a note before it: pi sees the one, and an import brings back the one */
	function typed(entry, said) {
		if (entry.kind !== DELIVERY) return entry
		const [only, ...more] = entry.data.held
		const data = said.get(only)
		if (more.length || !data || data.answer || data.error || data.from) return entry
		const [message] = entry.model
		const content =
			typeof message.content === 'string'
				? data.body
				: [{ ...message.content[0], text: data.body }, ...message.content.slice(1)]
		return { ...entry, model: [{ ...message, content }] }
	}

	async function push(conversation, state, title) {
		const to = await core.agentOf(conversation)
		const runner = to && (await core.known())[to.runner]
		if (!runner) return
		const cwd = path.resolve(runner.dir, to.dir ?? '.')
		const where = `${to.runner} ${cwd}`
		// The conversation's own session identity, a UUID that pi uses the same way; a fork has a fresh one
		state.session ??= await core.commit(
			async (tx) => (await tx.doc(ProviderDoc, conversation)).sessionId,
		)
		const { session } = state
		const send = (entries) =>
			core.runners.call(to.runner, { op: 'pi-session', session, cwd, entries, title }, {})
		let sent = false
		// A new runner or folder starts from what its own file holds
		if (state.where !== where) {
			state.where = where
			const reply = await send([])
			if (!reply) throw new Error(`${to.runner} doesn't write pi sessions; update it`)
			state.last = reply.last
			sent = true
		}
		let cursor
		do {
			const page = await core.commit((tx) =>
				tx.scanEntries(
					{ conversationId: conversation, minEntryId: state.last + 1, order: 'ascending' },
					100,
					cursor,
				),
			)
			const entries = page.items.filter(sendable)
			// Only the messages these deliveries handed over, read back from the thread's end to the first
			const held = entries.flatMap((entry) => (entry.kind === DELIVERY ? entry.data.held : []))
			const said = new Map(
				held.length
					? (await core.messages(state.thread, { after: Math.min(...held) - 1 })).map((entry) => [
							entry.id,
							entry.data,
						])
					: [],
			)
			if (entries.length) {
				state.last = (
					await send(
						entries.map((entry) => {
							const { id, kind, model, head } = typed(entry, said)
							return { id, kind, model, head }
						}),
					)
				).last
				sent = true
			}
			if (page.items.length) state.seen = page.items.at(-1).id
			cursor = page.next
		} while (cursor)
		if (!sent && state.titled !== title) await send([])
		state.titled = title
	}

	/** One push at a time per conversation; a change meanwhile means one more after it */
	async function sync(conversation, state) {
		if (state.running) return void (state.again = true)
		state.running = true
		try {
			do {
				state.again = false
				const to = await core.agentOf(conversation)
				if (!to) continue
				let newest
				const title = (await core.thread(state.thread)).title
				try {
					newest = await core.commit((tx) => tx.latestEntryId(conversation))
					if ((newest === undefined || newest <= state.seen) && title === state.titled) continue
					await core.runners.online(to.runner)
					await push(conversation, state, title)
					state.failed = undefined
				} catch (error) {
					state.where = undefined
					// A runner that dropped comes back to the same push
					if (!core.runners.isOnline(to.runner)) state.again = true
					else {
						// Anything else waits for the next change, and is said once
						if (state.failed !== error.message)
							console.error(`pi-sessions: conversation ${conversation}: ${error.message}`)
						state.failed = error.message
						state.seen = Math.max(state.seen, newest ?? 0)
						state.titled = title
					}
				}
			} while (state.again)
		} finally {
			state.running = false
		}
	}

	async function follow(threadId) {
		const row = await core.thread(threadId)
		if (!row) return
		for (const { conversation } of Object.values(row.agents))
			if (!followed.has(conversation))
				followed.set(conversation, { thread: threadId, seen: 0, last: 0 })
	}

	async function folderOf({ runner: name = undefined, dir = undefined }, by) {
		const known = await core.known()
		const runner = name && known[name]
		if (!runner) throw new Error(`No runner named ${name}`)
		core.reach([{ runner: name }], by, known)
		if (!core.runners.isOnline(name)) throw new Error(`${name} is offline`)
		return { name, cwd: path.resolve(runner.dir, dir || '.') }
	}

	async function bring({ runner, dir, session, title }, by) {
		const { name, cwd } = await folderOf({ runner, dir }, by)
		const listed = await core.runners.call(name, { op: 'pi-session-list', cwd }, {})
		const found = listed?.find((info) => info.path === session || info.id === session)
		if (!found) throw new Error(`${name} has no pi session ${session} for ${cwd}`)
		const read = await core.runners.call(name, { op: 'pi-session-read', cwd, file: found.path }, {})
		const first = read.items
			.flatMap(({ messages }) => messages)
			.find((message) => message.role === 'user')
		if (!first) throw new Error('That session has no messages to bring')
		const asked = { runner: name, dir: cwd }
		const to = await core
			.address({
				...asked,
				model: read.model && `${read.model.provider}/${read.model.modelId}`,
				thinkingLevel: read.thinkingLevel,
			})
			.catch(() => core.address(asked))
		const label = writtenTo(to)
		const heading = title?.trim() || read.name || defaultTitle(textOf(first.content))
		const thread = await core.commit(async (tx) => {
			const threadId = await core.startThread(tx, heading, null, null)
			await tx.appendEntry(threadId, {
				kind: SOURCE,
				data: {
					runner: name,
					file: found.path,
					session: found.id,
					name: read.name ?? found.firstMessage.split('\n')[0].slice(0, 100),
				},
			})
			const agent = await core.newAgent(tx, threadId, { after: 0 })
			await core.setUp(tx, agent.conversation, threadId, to)
			for (const { type, messages } of read.items)
				for (const message of messages) {
					if (type === 'compaction') {
						// Pi's summary comes first and what it kept follows, so nothing before it is held back
						await tx.appendEntry(CompactionEntry, agent.conversation, {
							model: [message],
							data: { reason: 'manual' },
							head: 'self',
						})
					} else if (message.role === 'user') {
						const images = Array.isArray(message.content)
							? message.content.filter((part) => part.type === 'image')
							: []
						// Written as ade writes a message to its agent, though nothing is to be delivered: the agent has read it
						const sent = await tx.appendEntry(threadId, {
							kind: MESSAGE,
							data: {
								author: by,
								body: textOf(message.content),
								createdAt: new Date(message.timestamp).toISOString(),
								to: [label],
								...(images.length ? { images } : {}),
							},
						})
						// It has read the session's messages; its answers it never reads back
						agent.after = sent.id
						await tx.appendEntry(agent.conversation, {
							kind: DELIVERY,
							data: { held: [sent.id] },
							model: [message],
						})
					} else if (message.role === 'assistant') {
						const placed = await tx.appendEntry(AssistantEntry, agent.conversation, {
							model: [message],
						})
						const said = textOf(message.content)
						if (said.trim() && !message.content.some((part) => part.type === 'toolCall'))
							await core.post(tx, threadId, {
								author: label,
								body: said,
								createdAt: new Date(message.timestamp).toISOString(),
								answer: { conversation: agent.conversation, entry: placed.id },
							})
					} else if (message.role === 'toolResult') {
						await tx.appendEntry(ToolResultEntry, agent.conversation, {
							model: [message],
							data: { diagnostics: [] },
						})
					}
				}
			;(await core.threadIn(tx, threadId)).agents[AGENT] = agent
			return threadId
		})
		return { id: thread }
	}

	async function serve(threadId, query, body, by) {
		if (threadId !== undefined) {
			if (body !== undefined)
				throw new Error('POST /api/pi-sessions {runner, session} starts a thread from a pi session')
			const [first] = (
				await core.commit((tx) =>
					tx.scanEntries({ conversationId: threadId, order: 'ascending' }, 1),
				)
			).items
			return { from: first?.kind === SOURCE ? first.data : null }
		}
		if (body !== undefined) return bring(body, by)
		const { name, cwd } = await folderOf(Object.fromEntries(query), by)
		return core.runners.call(name, { op: 'pi-session-list', cwd }, {})
	}

	let syncing
	const scheduleSync = () => {
		syncing ??= setTimeout(() => {
			syncing = undefined
			const threads = [...touched]
			touched.clear()
			for (const threadId of threads) void follow(threadId).catch((error) => console.error(error))
			for (const [conversation, state] of followed)
				void sync(conversation, state).catch((error) => console.error(error))
		}, 100)
	}
	return {
		serve,
		posted: (tx, threadId) => {
			touched.add(threadId)
			scheduleSync()
		},
		entryStored: () => scheduleSync(),
	}
}

// ── The runner's half: a pi session file, appended to ─────────────────────

/** Each pi entry's id says which of the conversation's entries it came from: `i` for a message, `m` and `t` for the model and thinking it implied, `s` for a title.
 * Pi's own ids are hex, so what someone adds in pi never looks like ours. */
const ours = (letter, entry) => `${letter}${entry.toString(16).padStart(7, '0')}`
const isOurs = (id) => /^[imts][0-9a-f]{7}/.test(id)
const entryOf = (id) => (/^i[0-9a-f]{7}/.test(id) ? Number.parseInt(id.slice(1, 8), 16) : undefined)

const SUMMARY_PREFIX =
	'The conversation history before this point was compacted into the following summary:\n\n<summary>\n'
const SUMMARY_SUFFIX = '\n</summary>'

function sessionDir(cwd) {
	const asked =
		process.env.PI_CODING_AGENT_SESSION_DIR || SettingsManager.create(cwd).getSessionDir()
	if (asked) return path.resolve(cwd, asked.replace(/^~(?=$|[/\\])/, os.homedir()))
	const safe = `--${path
		.resolve(cwd)
		.replace(/^[/\\]/, '')
		.replace(/[/\\:]/g, '-')}--`
	return path.join(getAgentDir(), 'sessions', safe)
}

const opened = new Map()

async function open(dir, id) {
	const found =
		existsSync(dir) && (await readdir(dir)).find((file) => file.endsWith(`_${id}.jsonl`))
	const state = { file: found && path.join(dir, found), leaf: null, last: 0, kept: [], tail: true }
	if (!found) return state
	const text = await readFile(state.file, 'utf8')
	state.tail = text.endsWith('\n')
	for (const entry of parseSessionEntries(text)) {
		// What pi added is a branch of its own; ade carries on from its last entry
		if (entry.type === 'session' || !isOurs(entry.id)) continue
		state.leaf = entry.id
		if (entry.type === 'session_info') state.title = entry.name
		if (entry.type === 'model_change') state.model = `${entry.provider}/${entry.modelId}`
		if (entry.type === 'thinking_level_change') state.thinking = entry.thinkingLevel
		const from = entryOf(entry.id)
		if (from !== undefined) {
			state.kept.push(from)
			state.last = Math.max(state.last, from)
		}
	}
	return state
}

const textOf = (content, between = '') =>
	typeof content === 'string'
		? content
		: (content ?? [])
				.filter((part) => part.type === 'text')
				.map((part) => part.text)
				.join(between)

const iso = (time) => new Date(time ?? Date.now()).toISOString()

/**
 * Appends what the conversation's `entries` add to its session file, and answers with the newest entry the file now has.
 * Entries it already has are skipped, so a repeat, or a catch-up after a break, changes nothing.
 * Which entries pi has no place for is decided here: the system messages never come, since pi would take their tools for its own.
 */
export async function writePiSession({ session, cwd, entries, title }) {
	const dir = sessionDir(cwd)
	const key = `${dir}\n${session}`
	const state = opened.get(key) ?? (await open(dir, session))
	opened.set(key, state)
	const lines = []
	const add = (entry) => {
		const line = { ...entry, parentId: state.leaf }
		state.leaf = entry.id
		lines.push(line)
	}
	const fresh = entries.filter((entry) => entry.id > state.last)
	for (const [index, entry] of fresh.entries()) {
		const [message] = entry.model ?? []
		if (!message) continue
		if (entry.kind === 'pi.compaction') {
			const summary = message.content?.[0]?.text ?? message.content ?? ''
			const kept = state.kept.find((from) => from >= entry.head)
			add({
				type: 'compaction',
				id: ours('i', entry.id),
				timestamp: iso(message.timestamp),
				summary: summary.replace(SUMMARY_PREFIX, '').replace(SUMMARY_SUFFIX, ''),
				firstKeptEntryId: kept === undefined ? ours('i', entry.id) : ours('i', kept),
				tokensBefore: 0,
			})
			state.kept.push(entry.id)
			state.last = entry.id
			continue
		}
		if (!['user', 'assistant', 'toolResult'].includes(message.role)) continue
		// Pi starts a session with its model and thinking; here they are known once an assistant has answered, so look ahead
		const answer = state.model
			? message.role === 'assistant' && message
			: [message, ...fresh.slice(index + 1).flatMap((later) => later.model ?? [])].find(
					(candidate) => candidate.role === 'assistant',
				)
		if (answer) {
			const model = `${answer.provider}/${answer.model}`
			const timestamp = iso(answer.timestamp)
			if (model !== state.model) {
				state.model = model
				add({
					type: 'model_change',
					id: ours('m', entry.id),
					timestamp,
					provider: answer.provider,
					modelId: answer.model,
				})
			}
			if (answer.thinkingLevel && answer.thinkingLevel !== state.thinking) {
				state.thinking = answer.thinkingLevel
				add({
					type: 'thinking_level_change',
					id: ours('t', entry.id),
					timestamp,
					thinkingLevel: answer.thinkingLevel,
				})
			}
		}
		add({ type: 'message', id: ours('i', entry.id), timestamp: iso(message.timestamp), message })
		state.kept.push(entry.id)
		state.last = entry.id
	}
	// The thread's title is the session's name; it needs a conversation in the file first
	if (title && title !== state.title && (state.file || lines.length)) {
		state.title = title
		add({
			type: 'session_info',
			id: ours('s', Date.now() % 0x10000000),
			timestamp: iso(),
			name: title,
		})
	}
	if (!lines.length) return { last: state.last }
	if (!state.file) {
		const first = new Date(lines[0].timestamp).toISOString()
		state.file = path.join(dir, `${first.replace(/[:.]/g, '-')}_${session}.jsonl`)
		await mkdir(dir, { recursive: true })
		lines.unshift({
			type: 'session',
			version: CURRENT_SESSION_VERSION,
			id: session,
			timestamp: first,
			cwd,
		})
		state.tail = true
	}
	try {
		await appendFile(
			state.file,
			(state.tail ? '' : '\n') + lines.map((line) => `${JSON.stringify(line)}\n`).join(''),
		)
	} catch (error) {
		// What was only worked out above isn't in the file: forget it, and read the file again next time
		opened.delete(key)
		throw error
	}
	state.tail = true
	return { last: state.last }
}

export async function listPiSessions({ cwd }) {
	const dir = sessionDir(cwd)
	if (!existsSync(dir)) return []
	const sessions = await SessionManager.list(cwd, dir)
	return Promise.all(
		sessions.map(async ({ path, id, name, firstMessage, modified, messageCount }) => ({
			path,
			id,
			...(name ? { name } : {}),
			firstMessage,
			lastMessage: await lastWords(path),
			modified,
			messageCount,
		})),
	)
}

/** The last thing said in a session file, read from its tail, so a long session isn't read twice */
async function lastWords(file) {
	const handle = await openFile(file, 'r')
	try {
		const { size } = await handle.stat()
		const length = Math.min(size, 256 * 1024)
		const tail = Buffer.alloc(length)
		await handle.read(tail, 0, length, size - length)
		// The first line may be cut in half; it fails to parse and is skipped
		for (const line of tail.toString('utf8').split('\n').reverse()) {
			let message
			try {
				message = JSON.parse(line).message
			} catch {
				continue
			}
			if (!['user', 'assistant'].includes(message?.role)) continue
			const text = textOf(message.content, ' ').trim()
			if (text) return text
		}
		return ''
	} finally {
		await handle.close()
	}
}

export async function readPiSession({ cwd, file }) {
	const dir = sessionDir(cwd)
	const full = path.resolve(file)
	if (path.dirname(full) !== dir || !full.endsWith('.jsonl'))
		throw new Error(`${file} isn't one of ${cwd}'s pi sessions`)
	const entries = parseSessionEntries(await readFile(full, 'utf8'))
	migrateSessionEntries(entries)
	const session = SessionManager.inMemory(cwd, undefined, entries)
	if (path.resolve(session.getHeader()?.cwd ?? '') !== path.resolve(cwd))
		throw new Error(`${file} was started in another folder`)
	// What pi hands its model, as pi builds it: edits applied, a compaction as its summary, a command or a note as a user message
	const { model, thinkingLevel, entries: projected } = session.buildSessionProjection()
	return {
		name: session.getSessionName(),
		model,
		// A session that never chose a level leaves the thread's default
		...(session.getBranch().some((entry) => entry.type === 'thinking_level_change')
			? { thinkingLevel }
			: {}),
		items: projected
			.map(({ sourceEntry, messages }) => ({
				type: sourceEntry.type,
				messages: convertToLlm(messages),
			}))
			.filter(({ messages }) => messages.length),
	}
}
