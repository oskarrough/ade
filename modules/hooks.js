/**
 * Outside events wake threads: a GitHub push or failed CI run, or any service's POST, reaches a wake set `on` one at
 * POST /hooks/<wake id>. Off by default, and needs wake: MODULES=+wake,+hooks.
 *
 * The route is outside /api, so it takes no owner key or login: each wake has its own secret, which a plain service
 * sends as a bearer and GitHub signs the body with (X-Hub-Signature-256). An event that matches the wake becomes a
 * Hooked signal to it, on the next key it sleeps on; the wake posts it under a message key from the event's delivery
 * id (X-GitHub-Delivery, an Idempotency-Key header, or else the body itself), so a redelivered one posts once.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { Hooked } from './wake.js'

export const on = false

/** How much of an event a message carries */
const SAID = 2000
/** How many keys past the wake's own a burst of events may queue */
const AHEAD = 50

const sha256 = (text) => createHash('sha256').update(text).digest()
const same = (given, secret) => timingSafeEqual(sha256(given), sha256(secret))

/** What a GitHub event says, in one or two lines, or undefined when the wake ignores it */
function github(on, event, payload) {
	const repo = payload.repository?.full_name ?? 'a repository'
	if (on === 'push' && event === 'push') {
		const branch = String(payload.ref ?? '').replace(/^refs\/(heads|tags)\//, '')
		const head = String(payload.head_commit?.message ?? '').split('\n')[0]
		return `GitHub: ${payload.pusher?.name ?? 'someone'} pushed to ${repo} ${branch}${head ? `: ${head}` : ''}\n${payload.compare ?? ''}`.trim()
	}
	const run =
		event === 'workflow_run'
			? payload.workflow_run
			: event === 'check_suite'
				? payload.check_suite
				: undefined
	if (
		on === 'ci' &&
		run &&
		payload.action === 'completed' &&
		['failure', 'timed_out'].includes(run.conclusion)
	)
		return `GitHub: CI ${run.conclusion === 'failure' ? 'failed' : 'timed out'}: ${run.name ?? run.app?.name ?? 'a run'} on ${repo} ${run.head_branch ?? ''}\n${run.html_url ?? ''}`.trim()
	return undefined
}

export function server(core) {
	if (!core.modulesOn.includes('wake')) throw new Error('hooks needs wake: MODULES=+wake,+hooks')

	/** One event for wake `id`: `{woke}`, `{repeat}` for one already posted, `{ignored}` for one it doesn't wait for */
	async function webhook(id, { headers, body }) {
		const record = await core.task(id)
		const secret =
			record?.kind === 'ade.wake' && record.input.on !== undefined && record.input.secret
		if (!secret || record.state.status === 'terminal' || record.abortRequested)
			throw Object.assign(new Error('No hook here'), { status: 404 })
		const signature = headers['x-hub-signature-256']
		const bearer = /^Bearer (.+)$/.exec(headers.authorization ?? '')?.[1]
		const signed =
			typeof signature === 'string'
				? same(signature, `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`)
				: Boolean(bearer) && same(bearer, secret)
		if (!signed)
			throw Object.assign(new Error("That is not this hook's secret"), {
				status: 403,
			})

		const event = headers['x-github-event']
		const text = body.toString('utf8')
		let said
		if (record.input.on === 'hook') said = text.trim().slice(0, SAID) || '(an empty call)'
		else {
			if (typeof event !== 'string') return { ignored: 'not a GitHub event' }
			let payload
			try {
				payload = JSON.parse(text)
			} catch {
				throw new Error('A GitHub webhook here sends JSON')
			}
			said = github(record.input.on, event, payload)?.slice(0, SAID)
			if (!said) return { ignored: event }
		}
		const delivery =
			headers['x-github-delivery'] ?? headers['idempotency-key'] ?? sha256(body).toString('hex')
		const key = `hook ${id} ${sha256(String(delivery)).toString('hex').slice(0, 40)}`
		if (await core.keyUsed(record.conversationId, key)) return { repeat: id }
		// The wake sleeps on event-N; a key that already holds an event not yet posted takes the next
		const from = record.state.checkpoint?.n ?? 0
		for (let n = from; n < from + AHEAD; n++) {
			const result = await core.signal(id, Hooked, `event-${n}`, { key, said })
			if (result === 'delivered') return { woke: id }
			if (result !== 'duplicate') throw Object.assign(new Error('No hook here'), { status: 404 })
		}
		throw Object.assign(new Error('Too many events at once; try again'), {
			status: 429,
		})
	}

	return { webhook }
}
