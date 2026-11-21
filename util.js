/** Helpers the server and its modules share */
import { retryAssistantCall } from '@earendil-works/pi-ai'

/** A durable task's terminal result
 * @param {'completed' | 'aborted'} [status] */
export const finished = (status = 'completed', result = null) => ({
	status: /** @type {const} */ ('terminal'),
	outcome: { status, result },
})

/** A background task owned by its thread */
export const background = (threadId) => ({
	ownership: { kind: /** @type {const} */ ('conversation') },
	conversationId: threadId,
	background: true,
})

export async function collect(scan) {
	const items = []
	let cursor
	do {
		const page = await scan(cursor)
		items.push(...page.items)
		cursor = page.next
	} while (cursor)
	return items
}

/** The first item `find` matches in a paged `scan`, reading no further than it */
export async function firstIn(scan, find) {
	for (let cursor; ;) {
		const page = await scan(cursor)
		const found = page.items.find(find)
		if (found || !(cursor = page.next)) return found
	}
}

/** How a `to` is written, shown and typed alike: a bot's name, or the thread's agent as `model:thinking@runner`, the
 * model by its own name without its provider */
export const writtenTo = (to) =>
	to &&
	(to.name ??
		`${to.model.split('/').pop()}${to.thinkingLevel ? `:${to.thinkingLevel}` : ''}@${to.runner}`)
/** The thread's own agent's key among its agents; bots are keyed by name */
export const AGENT = 'agent'
/** Bot names have no `@`, so any name with one is the thread's agent, whatever model it had */
export const keyOf = (name) => (name.includes('@') ? AGENT : name)
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
/** `model:thinking@runner`, each part but the runner optional; `ada=model@runner` asks the bot ada as that */
export const agentTo = (name) => {
	const eq = name.indexOf('=')
	const agent = name.slice(eq + 1)
	const at = agent.lastIndexOf('@')
	let model = at < 0 ? '' : agent.slice(0, at),
		thinkingLevel
	const colon = model.lastIndexOf(':')
	if (colon >= 0 && THINKING_LEVELS.includes(model.slice(colon + 1)))
		[model, thinkingLevel] = [model.slice(0, colon), model.slice(colon + 1)]
	return {
		runner: agent.slice(at + 1),
		model,
		...(thinkingLevel ? { thinkingLevel } : {}),
		...(eq > 0 ? { name: name.slice(0, eq) } : {}),
	}
}
/** A small model for side work, like memory's lines or the director's picks: Haiku for Anthropic or Claude Code agents,
 * Luna otherwise, on `to`'s runner when that runner lists it; else `to` itself. `runners` is what each runner lists. */
export function smallModel(to, runners, thinkingLevel) {
	const provider = to.model.split('/')[0]
	const model =
		provider === 'anthropic' || provider === 'claude-code'
			? `${provider}/claude-haiku-5-5`
			: 'openai-codex/gpt-6-luna'
	return runners[to.runner]?.models?.[model] ? { runner: to.runner, model, thinkingLevel } : to
}
/** The director's numbers in ade.json, in seconds there, as whole milliseconds; out of range throws, so a typo never
 * makes a timer fire at once. Left out, each takes its default. */
export function directorTimes({ context = 20, timeout = 60, burst = 1.5 } = {}) {
	const within = (value, least, most, says) => {
		if (typeof value !== 'number' || !(value >= least && value <= most)) throw new Error(says)
		return value
	}
	if (!Number.isInteger(context))
		throw new Error('director.context is a whole number of messages, 1 to 200')
	return {
		context: within(context, 1, 200, 'director.context is a whole number of messages, 1 to 200'),
		timeoutMs: Math.round(
			within(timeout, 0.1, 600, 'director.timeout is 0.1 to 600 seconds') * 1000,
		),
		burstMs: Math.round(within(burst, 0, 60, 'director.burst is 0 to 60 seconds') * 1000),
	}
}
/** What a paused thread's message says instead of whom it asks */
export const PAUSED = 'Paused: only @mentions and named recipients get an answer.'
/** A person's name as one line of printable text, so no author can write a speaker line of their own */
export const speaker = (name) =>
	[
		...String(name ?? '')
			.normalize('NFKC')
			.replace(/[\p{Cc}\p{Cf}]/gu, ' ')
			.replace(/\s+/g, ' ')
			.trim(),
	]
		.slice(0, 40)
		.join('')
		.trim() || 'anon'

/** A person as the server names them: `~`, then their login with `@` written `+`, so no person reads as a bot (letters,
 * digits, dot, dash) or an agent (anything with `@`). Never shortened, so two logins never become one name. */
export const personName = (login) =>
	`~${String(login)
		.normalize('NFKC')
		.replace(/^~/, '')
		.replace(/[\p{Cc}\p{Cf}\s]/gu, '')
		.replaceAll('@', '+')}`

/** The owner's name as written in ade.json: one line, no `@`, which would make it an agent, and no leading `~`, which
 * marks a tailnet login; else it throws */
export function ownerName(name) {
	const clean = String(name ?? '')
		.normalize('NFKC')
		.replace(/[\p{Cc}\p{Cf}]/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim()
	if (!clean || clean.length > 40 || clean.includes('@') || clean.startsWith('~'))
		throw new Error("owner is the owner's name: 1 to 40 characters, no @, not starting with ~")
	return clean
}

export function field(value, name) {
	if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`)
	return value.trim()
}

/** Whether an agent wrote it, in this thread or from another */
export const byAgent = (message) =>
	Boolean(
		message.answer ||
		message.error ||
		message.from ||
		message.waitingOnPerson ||
		message.wake ||
		message.posted,
	)

/** A message's text, with what its shell command gave; a withdrawn one says only that */
export const written = (message) =>
	message.withdrawn
		? '(took back a message)'
		: `${message.body}${
				message.shell
					? `\n${[`exit ${message.shell.code ?? message.shell.error}`, message.shell.stdout, message.shell.stderr].filter(Boolean).join('\n')}`
					: ''
			}`

/** A message as an agent reads it: inside a tag that names who wrote it, or, a person's when `plain`, as typed */
export function said({ data: message }, plain = false) {
	if (plain && !byAgent(message)) return written(message)
	const from = String(message.author).replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`)
	const agent = byAgent(message)
		? ` agent${message.from ? ` thread="${message.from}"${message.re ? ' answering' : ''}` : ''}${message.wake ? ' wake' : ''}`
		: ''
	/** A body can't open or close a tag of this name, so nothing in it can pass for someone else's message */
	return `<message from="${from}"${agent}>\n${written(message).replace(/<(\/?message)/gi, '&lt;$1')}\n</message>`
}

/** Bot names a message @mentions, in mention order, ignoring case and trailing dots. */
export function mentioned(body, names) {
	const bots = new Map(names.map((name) => [name.toLowerCase(), name]))
	return [
		...new Set(
			[...body.matchAll(/@([\w.-]+)/g)]
				.map(([, name]) => bots.get(name.replace(/\.+$/, '').toLowerCase()))
				.filter(Boolean),
		),
	]
}

export async function complete(core, to, messages, signal, retry = undefined) {
	const model = core.models.getModel(`runner:${to.runner}`, to.model)
	const call = () =>
		core.models.completeSimple(
			model,
			{ messages },
			{
				signal,
				...(to.thinkingLevel && to.thinkingLevel !== 'off' ? { reasoning: to.thinkingLevel } : {}),
			},
		)
	const reply = await (retry ? retryAssistantCall(call, retry, signal) : call())
	if (reply.stopReason === 'error' || reply.stopReason === 'aborted')
		throw new Error(reply.errorMessage ?? reply.stopReason)
	return reply
}
