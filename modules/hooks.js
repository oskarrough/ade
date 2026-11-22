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
 * Each delivery is reserved once, in one commit that checks the secret it came with is still the wake's: a receipt of
 * its own, `hook {wake}/{digest}` (the signed body's, or a plain call's Idempotency-Key or body), and a Hooked signal to
 * the wake on the next key it sleeps on, `event-N`. A repeat finds the receipt and wakes nothing. A wake takes at most
 * LIFETIME events and RATE a minute, charged only once its caller proved the secret; before that, a caller gets at most
 * PROBES tries a minute at GitHub hooks, counted by its own address, so strangers can't spend a hook's budget or lock
 * GitHub out.
 *
 * The agent gets typed facts, each kept to its own shape (a repo, a branch, commit ids, a pusher; a workflow's path or
 * id, its conclusion and URL; a plain call's event name and size), never free text, unless the owner turned `raw` on
 * for that hook. Each hook carries the GENERATION it was issued under, the Hooked signal's version; both routes refuse
 * an older one, which has to be set again.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { num, obj, opt, str } from '@earendil-works/pi-schema'
import { defineDoc, defineSignal } from '@earendil-works/pi-durable'

export const on = false

export const EVENTS = {
	push: 'each GitHub push',
	ci: 'each failed GitHub CI run',
	hook: 'each call to its hook',
}
/** What a hook's signal looks like now; a hook issued under another refuses every call and has to be set again */
const GENERATION = 3
/**
 * An outside event for a wake: where it came from, its typed facts, and its text only where the owner allowed it
 * (`raw`); the agent reads all of it as data
 */
export const Hooked = defineSignal({
	name: 'ade.hooked',
	version: GENERATION,
	schema: obj({
		from: str(),
		facts: obj({
			repo: opt(str()),
			branch: opt(str()),
			before: opt(str()),
			after: opt(str()),
			pusher: opt(str()),
			commits: opt(num()),
			workflow: opt(str()),
			workflow_id: opt(num()),
			conclusion: opt(str()),
			url: opt(str()),
			event: opt(str()),
			bytes: opt(num()),
		}),
		said: opt(str()),
	}),
})
/** A hook wake's secret, the generation it was issued under, how many events it took, and whether the owner lets its
 * sender's text through; the wake's own doc */
const Hook = defineDoc({
	kind: 'ade.hook',
	version: 1,
	scope: 'task',
	checkpointWhen: () => true,
	initial: () => ({ secret: '', generation: 0, events: 0, raw: false }),
})

/** How many events a wake takes in its life; each one stays in its task record */
const LIFETIME = 500
/** How many a wake takes a minute, from callers that proved its secret */
const RATE = 30
/** How many tries a GitHub hook takes a minute before its signature is checked */
const PROBES = 120
/** How much of an event a message carries */
const SAID = 2000

const newSecret = () => `awh_${randomBytes(24).toString('base64url')}`
/** Gives a new wake its secret, inside the commit that makes it */
export async function issue(tx, wakeId) {
	const doc = await tx.doc(Hook, wakeId)
	doc.secret = newSecret()
	doc.generation = GENERATION
}
/** A hook issued under another generation, or none */
const stale = (doc) => !doc.secret || doc.generation !== GENERATION
const STALE = 'This hook is from an older ade; cancel it and set a new wake'

const sha256 = (text) => createHash('sha256').update(text).digest()
const same = (given, secret) => timingSafeEqual(sha256(given), sha256(secret))
const fail = (status, message) => Object.assign(new Error(message), { status })

/** A fact as GitHub gives it if it fits its own shape, else `(unusual)`: no free text reaches the agent this way */
const fact = (value, shape) =>
	typeof value === 'string' && shape.test(value) ? value : value == null ? undefined : '(unusual)'
const SHAPES = {
	repo: /^[\w.-]{1,100}\/[\w.-]{1,100}$/,
	branch: /^[\w./-]{1,100}$/,
	commit: /^[0-9a-f]{7,64}$/,
	login: /^[\w.[\]-]{1,60}$/,
	workflow: /^\.github\/workflows\/[\w.-]{1,100}\.ya?ml$/,
	url: /^https:\/\/github\.com\/[\w./-]{1,200}$/,
	event: /^[\w.:-]{1,64}$/,
}

/**
 * What a signed GitHub body says, by its own shape: `{from, facts, text}` (text only for a wake that asked for it),
 * `{ignored}`, or undefined when it isn't GitHub's
 */
function github(on, payload) {
	if (!payload || typeof payload !== 'object') return undefined
	if (typeof payload.zen === 'string' && payload.hook_id !== undefined) return { ignored: 'ping' }
	const repo = fact(payload.repository?.full_name, SHAPES.repo)
	if (
		typeof payload.ref === 'string' &&
		typeof payload.after === 'string' &&
		Array.isArray(payload.commits) &&
		payload.pusher
	) {
		if (on !== 'push') return { ignored: 'push' }
		return {
			from: 'GitHub push',
			facts: {
				repo,
				branch: fact(payload.ref.replace(/^refs\/(heads|tags)\//, ''), SHAPES.branch),
				before: fact(payload.before, SHAPES.commit),
				after: fact(payload.after, SHAPES.commit),
				pusher: fact(payload.pusher.name, SHAPES.login),
				commits: payload.commits.length,
			},
			text: String(payload.head_commit?.message ?? ''),
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
			facts: {
				repo,
				workflow: fact(run.path, SHAPES.workflow),
				workflow_id: Number.isSafeInteger(run.workflow_id ?? run.app?.id)
					? (run.workflow_id ?? run.app.id)
					: undefined,
				conclusion: run.conclusion,
				url: fact(run.html_url, SHAPES.url),
			},
			text: String(run.display_title ?? ''),
		}
	}
	return undefined
}

export function server(core) {
	if (!core.modulesOn.includes('wake')) throw new Error('hooks needs wake: MODULES=+wake,+hooks')
	const hookOf = (wakeId) =>
		core.commit(async (tx) => JSON.parse(JSON.stringify(await tx.doc(Hook, wakeId))))
	/** Each wake's admitted events in the last minute */
	const recent = new Map()
	/**
	 * Each caller's unsigned tries at GitHub hooks in the last minute, by its address: the last X-Forwarded-For entry,
	 * the one the proxy in front (Funnel) added, so one flooding caller can't lock GitHub out
	 */
	const tries = new Map()
	/** Takes one into a wake's minute in `windows`, or refuses it; checks and records with no await between */
	function admit(windows, wakeId, cap, what) {
		const minute = (windows.get(wakeId) ?? []).filter((at) => at > Date.now() - 60_000)
		if (minute.length >= cap) throw fail(429, `At most ${cap} ${what} a minute; try again`)
		minute.push(Date.now())
		windows.set(wakeId, minute)
	}

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
		if (stale(hook)) throw fail(410, STALE)
		const gitHub = record.input.on !== 'hook'
		const signature = headers['x-hub-signature-256']
		const bearer = /^Bearer (.+)$/.exec(headers.authorization ?? '')?.[1]
		if (gitHub ? typeof signature !== 'string' : !bearer || !same(bearer, hook.secret))
			throw fail(403, "That is not this hook's secret")
		if (hook.events >= LIFETIME)
			throw fail(429, `This hook took its ${LIFETIME} events; set a new wake`)
		// A bearer is checked by now; a GitHub signature needs the body, so strangers get their own, smaller budget
		if (gitHub)
			admit(
				tries,
				String(headers['x-forwarded-for'] ?? 'here')
					.split(',')
					.at(-1)
					.trim(),
				PROBES,
				'tries',
			)
		else admit(recent, id, RATE, 'events')

		const raw = await body()
		let event
		if (gitHub) {
			const expected = `sha256=${createHmac('sha256', hook.secret).update(raw).digest('hex')}`
			if (!same(String(signature), expected)) throw fail(403, "That is not this hook's secret")
			admit(recent, id, RATE, 'events')
			let payload
			try {
				payload = JSON.parse(raw.toString('utf8'))
			} catch {
				throw fail(400, 'A GitHub webhook here sends JSON')
			}
			event = github(record.input.on, payload)
			if (!event) throw fail(400, 'Not an event GitHub sends')
			if (event.ignored) return { ignored: event.ignored }
		} else
			event = {
				from: 'hook',
				facts: {
					event: fact(headers['x-hook-event'] ?? 'call', SHAPES.event),
					bytes: raw.length,
				},
				text: raw.toString('utf8').trim(),
			}
		const idempotency = !gitHub && headers['idempotency-key']
		const digest = sha256(idempotency ? `key ${idempotency}` : raw).toString('hex')
		const receipt = `hook ${id}/${digest}`
		if (await core.receipt(receipt, 'hook')) return { repeat: id }

		return core.once(receipt, 'hook', async (tx) => {
			const doc = await tx.doc(Hook, id)
			// A secret rotated while this one was on its way: what it was signed with no longer counts
			if (stale(doc)) throw fail(410, STALE)
			if (!same(hook.secret, doc.secret)) throw fail(403, "That is not this hook's secret")
			if (doc.events >= LIFETIME)
				throw fail(429, `This hook took its ${LIFETIME} events; set a new wake`)
			const facts = Object.fromEntries(
				Object.entries(event.facts).filter(([, value]) => value !== undefined),
			)
			const sent = await tx.signal(id, Hooked, `event-${doc.events}`, {
				from: event.from,
				facts,
				...(doc.raw && event.text ? { said: event.text.slice(0, SAID) } : {}),
			})
			if (sent !== 'delivered') throw fail(404, 'No hook here')
			doc.events += 1
			return { woke: id }
		})
	}

	/**
	 * The owner only. GET `?wake=N`: where wake N's hook is, its secret, and whether its sender's text gets through;
	 * POST `{rotate: N}`: a new secret, the old one refused from then on; POST `{wake: N, raw}`: let the sender's text
	 * through to the agent, or stop it. A hook from an older generation answers 410: set a new wake.
	 */
	async function serve(threadId, query, body, user) {
		if (user !== core.owner) throw fail(403, 'Only the owner reads or changes a hook')
		if (threadId === undefined) throw new Error('Hooks live in a thread')
		const wakeId = Number(body === undefined ? query.get('wake') : (body.rotate ?? body.wake))
		if (!Number.isInteger(wakeId)) throw new Error('wake, or rotate, is the wake id')
		if (body !== undefined && body.rotate === undefined && typeof body.raw !== 'boolean')
			throw new Error('raw is true or false')
		const record = await live(wakeId, threadId)
		const doc = await core.commit(async (tx) => {
			const doc = await tx.doc(Hook, wakeId)
			if (stale(doc)) throw fail(410, STALE)
			if (body?.rotate !== undefined) doc.secret = newSecret()
			else if (body !== undefined) doc.raw = body.raw
			return JSON.parse(JSON.stringify(doc))
		})
		return {
			wake: wakeId,
			on: record.input.on,
			path: `/hooks/${wakeId}`,
			secret: doc.secret,
			raw: doc.raw,
			...(record.input.on === 'hook'
				? { send: `Authorization: Bearer ${doc.secret}` }
				: {
						github: `a webhook with content type application/json, ${record.input.on === 'push' ? 'push events' : 'workflow runs'}, and this secret`,
					}),
		}
	}

	return { webhook, serve }
}
