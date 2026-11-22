/**
 * Outside events wake threads: a GitHub push or failed CI run, or any service's POST, reaches a wake set `on` one at
 * POST /hooks/<wake id>. Off by default, and needs wake: MODULES=+wake,+hooks.
 *
 * The server takes hooks on a listener of its own, the only part meant for the internet: no page, no socket, no owner
 * key or login there. Each wake has its own secret, kept apart from the wake in a Hook doc, never in a transcript: the
 * agent learns only the hook's id, and the owner reads or rotates the secret (serve). A plain service sends it as a
 * bearer; a GitHub wake takes only a body GitHub signed with it (X-Hub-Signature-256), and reads the event from that
 * body's shape, not from the unsigned headers.
 *
 * Each delivery is reserved once, in one commit: a receipt of its own, `hook {wake}/{digest}` (the signed body's, or a
 * plain call's Idempotency-Key or body), and a Hooked signal to the wake on the next key it sleeps on, `event-N`. A
 * repeat finds the receipt and wakes nothing. A wake takes at most EVENTS in its life and RATE a minute.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { obj, str } from '@earendil-works/pi-schema'
import { defineDoc, defineSignal } from '@earendil-works/pi-durable'

export const on = false

/** What a wake can be `on`, as the strip says it */
export const EVENTS = {
	push: 'each GitHub push',
	ci: 'each failed GitHub CI run',
	hook: 'each call to its hook',
}
/** An outside event for a wake: where it came from, and what it says, which the agent reads as data */
export const Hooked = defineSignal({
	name: 'ade.hooked',
	version: 1,
	schema: obj({ from: str(), said: str() }),
})
/** A hook wake's secret and how many events it has taken, the wake's own doc */
const Hook = defineDoc({
	kind: 'ade.hook',
	version: 1,
	scope: 'task',
	checkpointWhen: () => true,
	initial: () => ({ secret: '', events: 0 }),
})

/** How many events a wake takes in its life; each one stays in its task record */
const LIFETIME = 500
/** How many a wake takes a minute */
const RATE = 30
/** How much of an event a message carries */
const SAID = 2000

const newSecret = () => `awh_${randomBytes(24).toString('base64url')}`
/** Gives a new wake its secret, inside the commit that makes it */
export async function issue(tx, wakeId) {
	;(await tx.doc(Hook, wakeId)).secret = newSecret()
}

const sha256 = (text) => createHash('sha256').update(text).digest()
const same = (given, secret) => timingSafeEqual(sha256(given), sha256(secret))
const fail = (status, message) => Object.assign(new Error(message), { status })

/** What a signed GitHub body says, by its own shape: `{from, said}`, `{ignored}`, or undefined when it isn't GitHub's */
function github(on, payload) {
	if (!payload || typeof payload !== 'object') return undefined
	if (typeof payload.zen === 'string' && payload.hook_id !== undefined) return { ignored: 'ping' }
	const repo = String(payload.repository?.full_name ?? 'a repository')
	if (
		typeof payload.ref === 'string' &&
		typeof payload.after === 'string' &&
		Array.isArray(payload.commits) &&
		payload.pusher
	) {
		if (on !== 'push') return { ignored: 'push' }
		const branch = payload.ref.replace(/^refs\/(heads|tags)\//, '')
		const head = String(payload.head_commit?.message ?? '').split('\n')[0]
		return {
			from: 'GitHub push',
			said: [
				`${payload.pusher.name ?? 'someone'} pushed to ${repo} ${branch}`,
				head && `head commit: ${head}`,
				payload.compare,
			]
				.filter(Boolean)
				.join('\n'),
		}
	}
	const run = payload.workflow_run ?? payload.check_suite
	if (run && typeof run === 'object' && typeof payload.action === 'string') {
		if (
			on !== 'ci' ||
			payload.action !== 'completed' ||
			!['failure', 'timed_out'].includes(run.conclusion)
		)
			return { ignored: 'ci' }
		return {
			from: 'GitHub CI',
			said: [
				`${run.name ?? run.app?.name ?? 'a run'} ${run.conclusion === 'failure' ? 'failed' : 'timed out'} on ${repo} ${run.head_branch ?? ''}`.trim(),
				run.html_url,
			]
				.filter(Boolean)
				.join('\n'),
		}
	}
	return undefined
}

export function server(core) {
	if (!core.modulesOn.includes('wake')) throw new Error('hooks needs wake: MODULES=+wake,+hooks')
	const hookOf = (wakeId) =>
		core.commit(async (tx) => JSON.parse(JSON.stringify(await tx.doc(Hook, wakeId))))
	/** Each wake's accepted events in the last minute */
	const recent = new Map()

	/** A live wake on events, or a 404 that says nothing more */
	async function live(wakeId, threadId = undefined) {
		const record = await core.task(wakeId)
		if (
			record?.kind !== 'ade.wake' ||
			record.input.on === undefined ||
			record.state.status === 'terminal' ||
			record.abortRequested ||
			(threadId !== undefined && record.conversationId !== threadId)
		)
			throw fail(404, 'No hook here')
		return record
	}

	/**
	 * One event for wake `id`: `{woke}`, `{repeat}` for one it took already, `{ignored}` for one it doesn't wait for.
	 * Everything it can check from the headers it checks before reading the body.
	 */
	async function webhook(id, { headers, body }) {
		const record = await live(id)
		const hook = await hookOf(id)
		if (!hook.secret) throw fail(404, 'No hook here')
		const gitHub = record.input.on !== 'hook'
		const signature = headers['x-hub-signature-256']
		const bearer = /^Bearer (.+)$/.exec(headers.authorization ?? '')?.[1]
		if (gitHub ? typeof signature !== 'string' : !bearer || !same(bearer, hook.secret))
			throw fail(403, "That is not this hook's secret")
		if (hook.events >= LIFETIME)
			throw fail(429, `This hook took its ${LIFETIME} events; set a new wake`)
		const minute = (recent.get(id) ?? []).filter((at) => at > Date.now() - 60_000)
		if (minute.length >= RATE) throw fail(429, `At most ${RATE} events a minute; try again`)

		const raw = await body()
		let event
		if (gitHub) {
			const expected = `sha256=${createHmac('sha256', hook.secret).update(raw).digest('hex')}`
			if (!same(String(signature), expected)) throw fail(403, "That is not this hook's secret")
			let payload
			try {
				payload = JSON.parse(raw.toString('utf8'))
			} catch {
				throw fail(400, 'A GitHub webhook here sends JSON')
			}
			event = github(record.input.on, payload)
			if (!event) throw fail(400, 'Not an event GitHub sends')
			if (event.ignored) return { ignored: event.ignored }
		} else event = { from: 'hook', said: raw.toString('utf8').trim() || '(an empty call)' }
		const idempotency = !gitHub && headers['idempotency-key']
		const digest = sha256(idempotency ? `key ${idempotency}` : raw).toString('hex')
		const receipt = `hook ${id}/${digest}`
		if (await core.receipt(receipt, 'hook')) return { repeat: id }

		minute.push(Date.now())
		recent.set(id, minute)
		return core.once(receipt, 'hook', async (tx) => {
			const doc = await tx.doc(Hook, id)
			if (doc.events >= LIFETIME)
				throw fail(429, `This hook took its ${LIFETIME} events; set a new wake`)
			const sent = await tx.signal(id, Hooked, `event-${doc.events}`, {
				from: event.from,
				said: event.said.slice(0, SAID),
			})
			if (sent !== 'delivered') throw fail(404, 'No hook here')
			doc.events += 1
			return { woke: id }
		})
	}

	/**
	 * The owner only. GET `?wake=N`: where wake N's hook is and its secret; POST `{rotate: N}`: a new secret, the old one
	 * refused from then on. A wake from before secrets were kept here gets its first one when asked.
	 */
	async function serve(threadId, query, body, user) {
		if (user !== core.owner) throw fail(403, "Only the owner reads a hook's secret")
		if (threadId === undefined) throw new Error('Hooks live in a thread')
		const wakeId = Number(body === undefined ? query.get('wake') : body.rotate)
		if (!Number.isInteger(wakeId))
			throw new Error(body === undefined ? 'wake is the wake id' : 'rotate is the wake id')
		const record = await live(wakeId, threadId)
		const secret = await core.commit(async (tx) => {
			const doc = await tx.doc(Hook, wakeId)
			if (body !== undefined || !doc.secret) doc.secret = newSecret()
			return doc.secret
		})
		return {
			wake: wakeId,
			on: record.input.on,
			path: `/hooks/${wakeId}`,
			secret,
			...(record.input.on === 'hook'
				? { send: `Authorization: Bearer ${secret}` }
				: {
						github: `a webhook with content type application/json, ${record.input.on === 'push' ? 'push events' : 'workflow runs'}, and this secret`,
					}),
		}
	}

	return { webhook, serve }
}
