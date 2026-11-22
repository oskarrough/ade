#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
	appendFileSync,
	existsSync,
	readFileSync,
	rmSync,
	watch as watchFiles,
	writeFileSync,
} from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import {
	AgentDoc,
	ConversationTranscript,
	configure,
	createRegistry,
	defineDoc,
	defineDocFamily,
	defineExtension,
	defineTask,
	defineTool,
	Harness,
	InboxDoc,
	ProviderDoc,
} from '@earendil-works/pi-durable'
import { num, obj, opt, str } from '@earendil-works/pi-schema'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
} from '@earendil-works/pi-durable/tools'
import { createCodemodeExtension } from '@earendil-works/pi-durable/codemode'
import { CodemodeSandbox } from '@earendil-works/pi-codemode'
import { about, builtIn, dataDir, load, loadEnvFile, readConfig } from './modules.js'
import { DEFAULT_VOICE } from './modules/bots.js'
import { WebSocketServer } from 'ws'
import {
	AGENT,
	writtenTo,
	agentTo,
	collect,
	firstIn,
	field,
	keyOf,
	said,
	byAgent,
	mentioned,
	personName,
	ownerName,
	finished,
	directorTimes,
	PAUSED,
} from './util.js'
import { createRunners, messageText, remoteEnv, runnerBundle, runnerProvider } from './remote.js'

/**
 * @typedef {{ runner: string, model: string, thinkingLevel?: import("@earendil-works/pi-ai").ThinkingLevel, dir?: string, name?: string }} To  An agent as it runs:
 *   the thread's own, or with `name`, a bot. Asking one as another model, thinking or runner changes it in place.
 * @typedef {object} Message  The data of every thread entry.
 * @property {string} author  A human's name, a bot's, or the thread's agent as `model:thinking@runner` when it wrote.
 * @property {string} body
 * @property {string} [createdAt]  When it was written, as an ISO time, which append stamps; a pi session's message keeps pi's. Older messages have none.
 * @property {{ type: 'image', mimeType: string, data: string }[]} [images]  As pi's ImageContent, base64; the agent sees them with the words.
 * @property {string[]} [to]  Whom it asks, named as `author` names them.
 * @property {number} [from]  The thread it came from.
 * @property {number[]} [re]  What it answers: messages here, or with `from`, posts there.
 * @property {{ conversation: import("@earendil-works/pi-durable").ConversationId, entry: number }} [answer]  The agent's entry it copies.
 * @property {true} [waitingOnPerson]  An agent's explicit question, open until a person next writes.
 * @property {true} [posted]  A bot's own post in a thread it's in, or opens, with its post tool: an agent's, as its answers are.
 * @property {number} [scheduledTask]  The scheduled task that posted it, when its time came: an agent's own instructions
 *   back to it, or a person's, as they set them.
 * @property {true} [error]  The agent gave no answer.
 * @property {true} [stopped]  Its author pressed Stop while the thread was working; the body says `stopped`.
 * @property {{ runner: string, code: number | null, stdout: string, stderr: string, error?: string }} [shell]  What `$ cmd` printed.
 * @typedef {{ name: string, conversation: import("@earendil-works/pi-durable").ConversationId, to: To | null, status: string, contextWindow?: number }} Agent  An agent or bot, as a thread view shows it.
 * @typedef {{ conversation: import("@earendil-works/pi-durable").ConversationId, unseen: number[], admission?: { admit: number, deliver: number }, note?: string }} Recipient
 *   A thread doc's row for its agent or a bot: its conversation, the thread messages it hasn't seen, its latest input's
 *   tasks, and what to tell it about a change before its next one.
 */

// ── Start-up: store lock and port ─────────────────────────────────────────

/** Secrets like TYPESAFE_API_KEY and MATRIX_TOKEN, if set there; a shell var still wins */
const envFile = loadEnvFile()

/** One store, whatever the port */
const file = process.env.DB_PATH || path.join(dataDir(), 'ade.sqlite')
const lock = `${file}.lock`
const alive = (pid) => {
	try {
		return process.kill(pid, 0)
	} catch (error) {
		return error.code === 'EPERM'
	}
}
const holder = Number(existsSync(lock) && readFileSync(lock, 'utf8'))
if (holder && holder !== process.pid && alive(holder)) {
	console.error(
		`${file} is served by process ${holder}; stop it, or DB_PATH=other.sqlite for another store`,
	)
	process.exit(1)
}
writeFileSync(lock, String(process.pid))

/** Everything the server prints, with the time, plus how it ended, next to its store: ade.sqlite logs to ade.log */
const logFile = `${file.replace(/\.sqlite$/, '')}.log`
const logged = (text) => {
	const time = new Date().toISOString()
	const lines = String(text).replace(/\n$/, '').split('\n')
	try {
		appendFileSync(logFile, lines.map((line) => `${time} ${line}\n`).join(''))
	} catch {}
}
for (const stream of [process.stdout, process.stderr]) {
	const write = stream.write.bind(stream)
	stream.write = (chunk, ...rest) => (logged(chunk), write(chunk, ...rest))
}
logged(`started, process ${process.pid}`)
process.on('uncaughtExceptionMonitor', (error, origin) =>
	console.error(`${origin}: ${error?.stack ?? error}`),
)
process.on('unhandledRejection', (reason) =>
	console.error(`unhandledRejection: ${/** @type {any} */ (reason)?.stack ?? reason}`),
)
process.on('exit', (code) => logged(`exited with code ${code}`))
process.on('exit', () => Number(readFileSync(lock, 'utf8')) === process.pid && rmSync(lock))
/** `--dir` folders for the server's own runner, the first where threads start; `--no-runner` lends no runner */
const { values: flags } = parseArgs({
	options: {
		dir: { type: 'string', multiple: true, default: [process.cwd()] },
		'no-runner': { type: 'boolean', default: false },
	},
})
/** PORT, or 3000, and up to the first free one; PORT=0 lets the system pick */
let port = Number(process.env.PORT || 3000)
const free = (candidate) =>
	new Promise((resolve) => {
		const probe = http.createServer().once('error', () => resolve(false))
		probe.listen(candidate, '127.0.0.1', () => probe.close(() => resolve(true)))
	})
if (port) while (!(await free(port))) port++
/** The listener `tailscale serve` points at: SERVE_PORT, or the first free port after the main one; 0 when PORT is */
let servePort = Number(process.env.SERVE_PORT || (port && port + 1))
if (servePort && !process.env.SERVE_PORT) while (!(await free(servePort))) servePort++

// ── Who's asking ──────────────────────────────────────────────────────────

/** The owner's key, written beside the store at first start: whoever can read the data folder is the owner */
const ownerKeyFile = path.join(path.dirname(file), 'owner.key')
if (!existsSync(ownerKeyFile))
	writeFileSync(ownerKeyFile, `aok_${randomBytes(24).toString('base64url')}\n`, { mode: 0o600 })
const ownerKey = readFileSync(ownerKeyFile, 'utf8').trim()
/** The cookie a browser keeps the owner key in; per port, since cookies ignore ports */
const ownerCookie = () => `ade_owner_${port}`
const isOwnerKey = (given) =>
	timingSafeEqual(
		createHash('sha256').update(given).digest(),
		createHash('sha256').update(ownerKey).digest(),
	)
const loopbackHost = (req) => {
	try {
		return loopback(new URL(`http://${req.headers.host}`).hostname)
	} catch {
		return false
	}
}
/** A name the page is reached by that this listener answers to: on the main one, any while HOST opens it to the network,
 * else only this machine's own; Serve's, a tailnet name or this machine's. A page on another name, as DNS rebinding
 * makes one, gets nothing. */
function answersTo(req, serve) {
	if (loopbackHost(req)) return true
	if (serve) return /\.ts\.net(:\d+)?$/.test(String(req.headers.host))
	return Boolean(process.env.HOST) && !loopback(process.env.HOST)
}
/**
 * Who sent a request, from how it arrived, never from a name it gives: the owner's key, as a bearer or the cookie, is
 * the owner anywhere; on Serve's listener, the login Tailscale names; on the main one, a request straight from this
 * machine, not through a proxy, is the owner. Anyone else is nobody: null.
 */
function whoSent(req, serve) {
	const cookie = String(req.headers.cookie ?? '')
		.split(/;\s*/)
		.find((pair) => pair.startsWith(`${ownerCookie()}=`))
		?.slice(ownerCookie().length + 1)
	const given = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? cookie
	if (given && isOwnerKey(given)) return owner
	if (serve) {
		const login = req.headers['tailscale-user-login']
		if (typeof login !== 'string' || !login) return null
		return ownerLogins.includes(login.toLowerCase()) ? owner : personName(login)
	}
	const proxied = ['x-forwarded-for', 'forwarded', 'tailscale-user-login'].some(
		(header) => header in req.headers,
	)
	return loopback(req.socket.remoteAddress ?? '') && loopbackHost(req) && !proxied ? owner : null
}
/** Tailnet logins as `name@provider`, as Tailscale-User-Login gives them, compared without case; anything else throws */
function loginList(logins) {
	if (
		!Array.isArray(logins) ||
		logins.some((login) => typeof login !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(login))
	)
		throw new Error('ownerLogins is a list of tailnet logins, like ana@github')
	return logins.map((login) => login.toLowerCase())
}
/** A person a runner names: a tailnet login, `ana@github`, as Serve names them; any other name as it is, the owner's */
const personal = (name) => (name.includes('@') ? personName(name) : name)
const nobody = (serve) =>
	serve
		? 'Tailscale Serve named nobody: open it from a device logged in to the tailnet'
		: 'Who are you? Open the link `ade link` prints on the server, or send its owner key as a bearer'
// ── Docs and tasks ────────────────────────────────────────────────────────

const KIND = 'ade.message'
/** Whom the director picked for a message saved before it chose: `{message, to, picked}`, read as that message's own */
const ROUTE = 'ade.route'
/** A message its author took back before any agent read it: `{message}`; the message reads as `withdrawn` from then on */
const WITHDRAWAL = 'ade.withdrawal'
const WITHDRAWN = 'withdrawn'
/** An agent's input in its conversation; `held` names the thread messages it gave */
const DELIVERY = 'ade.delivery'
/** How much of a `$ cmd`'s stdout and of its stderr is kept, from the end */
const TAIL = 20000
/** Our docs are small, so every change stores the whole doc and a read replays nothing */
const base = () => true
/**
 * @template {Record<string, import("@earendil-works/chord/json").JsonValue>} Value
 * @param {string} kind
 * @param {() => Value} initial
 */
const sessionDoc = (kind, initial) =>
	defineDoc({ kind, version: 1, scope: 'session', checkpointWhen: base, initial })
const Runners = sessionDoc('ade.runners', () => ({}))
const Keys = sessionDoc('ade.keys', () => ({}))
/** The name the server's own runner got the first time, kept so a new hostname doesn't make it another runner */
const Lent = sessionDoc('ade.lent', () => ({ name: '' }))
/** `agents` holds a {@link Recipient} for the thread's one agent, at `AGENT`, and for each bot, by name */
const Thread = defineDoc({
	kind: 'ade.thread',
	version: 1,
	scope: 'conversation',
	history: 'latest',
	fork: 'initial',
	checkpointWhen: base,
	initial: () => ({
		title: '',
		parent: null,
		createdAt: '',
		hidden: false,
		reads: {},
		agents: {},
		tools: null,
		/** With memory on, whether this thread remembers; null takes memory's default */
		memory: null,
		/** Each person's Pick task still deciding for their newest message, by author; their next message takes it over */
		picks: {},
		/** Only @mentions and named recipients get an answer while it's on */
		paused: false,
		/** Messages waiting for the director's pick: no agent takes them as context until it's routed them */
		unpicked: [],
		/** With inbox on, the open question dismissed from it: its message id */
		dismissed: null,
	}),
})
const Receipts = defineDocFamily({
	kind: 'ade.receipt',
	version: 1,
	scope: 'session',
	family: true,
	checkpointWhen: base,
	initial: () => ({ receipt: null }),
})
/**
 * What one person is writing in one thread, keyed `{thread}/{person}`: its text, images and pick, under the `key` its
 * message will be posted with. Saved as they type, so a change stores only what changed and a checkpoint now and then.
 */
const Draft = defineDocFamily({
	kind: 'ade.draft',
	version: 1,
	scope: 'session',
	family: true,
	checkpointWhen: (value, ops, info) => info.deltasSinceBase >= 50,
	initial: () => ({ key: '', text: '', images: [], pick: null }),
})
const now = () => new Date().toISOString()
const ownerless = { ownership: { kind: /** @type {const} */ ('ownerless') } }
const own = { ownership: { kind: /** @type {const} */ ('conversation') } }
const waiting = (on, phase) => ({
	status: /** @type {const} */ ('waiting'),
	on,
	policy: /** @type {const} */ ('allSettled'),
	checkpoint: { phase },
})

/** Owns an agent's conversation, so stopping the thread stops the agent */
const Anchor = defineTask({
	name: 'ade.anchor',
	version: 1,
	initial: () => ({ phase: 'own' }),
	phases: { own: (task, rt, ctx) => rt.commit(() => finished(), ctx) },
	abort: (task, rt, ctx) => rt.commit(() => finished('aborted'), ctx),
})

/**
 * Admissions are ordered by Pi task dependencies, independently of how long the answers take. An input takes what its
 * agent hasn't seen, up to the message that asked, in the commit that submits it: until then nothing leaves `unseen`,
 * so a failed or stopped admission has nothing to give back. With `turn`, the Deliver of the agent named before it, it
 * starts once that answer has landed and takes all it hasn't seen.
 */
const Admit = defineTask({
	name: 'ade.admit',
	version: 1,
	initial: ({ after, turn }) => ({ phase: after || turn ? 'wait' : 'ask' }),
	phases: {
		wait: ({ input: { after, turn } }, rt, ctx) =>
			rt.commit(() => waiting([after?.admit, turn].filter(Boolean), 'ask'), ctx),
		async ask(
			{ id, conversationId: threadId, input: { agent, upTo, steer, turn }, state },
			rt,
			ctx,
		) {
			await reachable(agent, rt.signal)
			const row = await thread(threadId)
			const { unseen, note } = recipientOf(row, agent)
			/** Its turn comes after the answer before it, so it takes that answer, and whatever was said meanwhile */
			const waiting = new Set(row.unpicked ?? [])
			const held = (turn ? unseen : unseen.filter((id) => id <= upTo)).filter(
				(id) => !waiting.has(id),
			)
			if (!held.length) return rt.commit(() => finished('completed', { held }), ctx)
			/** A folder renamed or deleted under the agent: it doesn't run there, and what it was asked waits for another folder */
			const missing = await gone(agent, rt.signal)
			if (missing) return rt.commit(() => finished('completed', { held, missing }), ctx)
			const all = await messages(threadId)
			const mine = await Promise.all(
				all
					.filter((entry) => held.includes(entry.id))
					.map((entry) => skillCommand(row, entry, agent, rt.signal)),
			)
			const people = (upTo) => [
				...new Set(
					all
						.filter((entry) => entry.id <= upTo && person(row, entry))
						.map((entry) => entry.data.author),
				),
			]
			/** One person's words come as typed; once a second has written, each person's come tagged, and the agent hears whose the untagged ones were */
			const plain = people(Math.max(...held)).length < 2
			const before = people(Math.min(...held) - 1)
			const joined =
				!plain && before.length === 1 && `[Every message above without a tag is ${before[0]}'s.]`
			const say = (entry) => said(entry, plain && person(row, entry))
			const told = catchUp
				? await catchUp(threadId, mine, all, agent, say)
				: mine.map(say).join('\n\n')
			const text = [note, joined, told].filter(Boolean).join('\n\n')
			const images = mine.flatMap((entry) => entry.data.images ?? [])
			const content = images.length ? [...(text ? [{ type: 'text', text }] : []), ...images] : text
			const handle = await rt.conversation(agent, ctx)
			const entry = { kind: DELIVERY, data: { held } }
			await rt.commit(async (tx) => {
				// A message withdrawn while this read the thread has left `unseen`: read it again without
				const left = recipientOf(await tx.doc(Thread, threadId), agent).unseen
				if (held.some((id) => !left.includes(id)))
					return {
						status: 'running',
						checkpoint: {
							phase: 'ask',
							again: (/** @type {any} */ (state).checkpoint.again ?? 0) + 1,
						},
					}
				const submission = await handle.submit(tx, {
					type: 'input',
					content,
					entry,
					requestId: String(id),
					whenBusy: steer ? 'steer' : 'followUp',
				})
				const recipient = recipientOf(await tx.doc(Thread, threadId), agent)
				recipient.unseen = recipient.unseen.filter((id) => !held.includes(id))
				if (note && recipient.note === note) delete recipient.note
				return finished('completed', { submission, held, ...(note ? { note } : {}) })
			}, ctx)
		},
	},
	abort: (task, rt, ctx) => rt.commit(() => finished('aborted'), ctx),
})

/** The agent's folder, when its runner says it no longer exists */
async function gone(agent, signal) {
	const { model, cwd } = await harness.snapshot(AgentDoc, agent, context)
	const runner = model.provider.replace(/^runner:/, '')
	const found = await remoteEnv(runners, runner, cwd).exists(cwd, {
		...context,
		abortSignal: signal,
	})
	return found.ok && !found.value ? cwd : undefined
}

/** A person's `/skill:name` message as the agent reads it, expanded on its runner in its folder as pi does */
async function skillCommand(row, entry, agent, signal) {
	if (!expand || !entry.data.body?.startsWith('/skill:') || !person(row, entry)) return entry
	const { model, cwd } = await harness.snapshot(AgentDoc, agent, context)
	const runner = model.provider.replace(/^runner:/, '')
	const body = await expand(entry.data.body, runner, cwd, signal)
	return { ...entry, data: { ...entry.data, body } }
}

/** A durable wait observes admission faults too; onReport is only diagnostic. */
const Deliver = defineTask({
	name: 'ade.deliver',
	version: 1,
	initial: () => ({ phase: 'wait' }),
	phases: {
		wait: ({ input: { admit } }, rt, ctx) => rt.commit(() => waiting([admit], 'tell'), ctx),
		async tell({ conversationId: threadId, input: { admit, agent, upTo } }, rt, ctx) {
			const [result] = /** @type {any[]} */ (await rt.outcomes([admit], ctx))
			const submitted = result.status === 'completed' ? result.result : null
			if (submitted && !submitted.submission && !submitted.missing)
				return rt.commit(() => finished(), ctx)
			const settled = submitted?.missing
				? { id: admit, status: 'unanswered', said: `folder ${submitted.missing} no longer exists` }
				: submitted
					? await (await harness.submission(submitted.submission, ctx)).wait(ctx)
					: {
							id: admit,
							status: 'unanswered',
							reason: result.error?.detail?.reason ?? result.status,
						}
			const told = await outcome(threadId, agent, settled, submitted?.held ?? [upTo])
			await rt.commit(
				async (tx) => (await tell(tx, threadId, agent, settled, submitted, told), finished()),
				ctx,
			)
		},
	},
	/** Pi's abort of the thread withdrew its input if still queued. */
	abort: ({ conversationId: threadId, input: { admit, agent } }, rt, ctx) =>
		rt.commit(async (tx) => {
			const submitted = /** @type {any} */ ((await tx.task(admit)).state.outcome?.result)
			const record = submitted?.submission && (await tx.submissionByRequest(agent, String(admit)))
			if (record && record.entry === undefined && record.reason !== WITHDRAWN)
				await restore(tx, threadId, agent, submitted)
			return finished('aborted')
		}, ctx),
})

/** `$ cmd` as an effect sandwich: commit, run, post */
const Shell = defineTask({
	name: 'ade.shell',
	version: 1,
	initial: () => ({ phase: 'run' }),
	phases: {
		async run(task, rt, ctx) {
			const { id, conversationId: threadId, input } = task
			await rt.commit(() => ({ status: 'running', checkpoint: { phase: 'interrupted' } }), ctx)
			const run = {
				threadId,
				author: input.author,
				to: input.to,
				command: input.command,
				stdout: '',
				stderr: '',
			}
			shells.set(id, run)
			touchThread(threadId)
			let lastShellTouch = 0
			const env = remoteEnv(
				runners,
				input.to.runner,
				folder((await known())[input.to.runner], input.to),
			)
			const result = await env.exec(
				input.command,
				{
					onOutput: (text, _context, info) => {
						run[info.stream] = (run[info.stream] + text).slice(-TAIL)
						const now = Date.now()
						if (now - lastShellTouch >= 100) {
							lastShellTouch = now
							touchThread(threadId)
						}
					},
				},
				ctx,
			)
			const output =
				result.ok === true ? { code: result.value.exitCode } : { error: result.error.message }
			await finishShell(task, rt, ctx, { ...run, ...output })
			shells.delete(id)
		},
		interrupted: (task, rt, ctx) =>
			finishShell(task, rt, ctx, { error: 'interrupted by a restart' }),
	},
	async abort(task, rt, ctx) {
		await finishShell(task, rt, ctx, { ...shells.get(task.id), error: 'stopped' }, true)
		shells.delete(task.id)
	},
})

const finishShell = ({ conversationId, input }, rt, ctx, output, aborted = false) =>
	rt.commit(async (tx) => {
		await printed(tx, conversationId, input, output)
		return finished(aborted ? 'aborted' : 'completed')
	}, ctx)

function printed(
	tx,
	threadId,
	{ author, command, to },
	{ code = null, stdout = '', stderr = '', error = undefined },
) {
	const shell = {
		runner: to.runner,
		code,
		stdout: stdout.slice(-TAIL),
		stderr: stderr.slice(-TAIL),
		...(error ? { error } : {}),
	}
	return post(tx, threadId, { author, body: `$ ${command}`, shell })
}

// ── State, Pi harness and snapshots ───────────────────────────────────────

const clients = new Set()
/** A runner's calls show in no list; one ending may let an outdated runner update */
const runners = createRunners({ onChange: () => nudge() })
/** Waits woken by every change; set before Pi resumes tasks that wait */
const changes = new Set()
/** What each running `$ cmd` has printed so far */
const shells = new Map()
const bundle = await runnerBundle(import.meta.dirname)
const updater = await readFile(new URL('./runner-updater.js', import.meta.url))

const models = createModels()
/** Tokens past which a module compacts each agent early; Pi reads it from the start, before the modules load */
// oxlint-disable-next-line prefer-const -- settings reads this before modules load
let compactAt
const registry = createRegistry()
// The coding tools, whose bash tells a command who runs it, whatever the model: cli.js posts as that agent
registry.install(
	defineExtension({
		name: 'coding-tools',
		tools: [
			createReadTool(),
			createWriteTool(),
			createEditTool(),
			anyRunner(
				createBashTool({
					prepare: async (execution, api, context) => {
						const { model, thinkingLevel } = await api.agent(context)
						Object.assign(execution.env, {
							PI_SESSION_ID: String(api.conversationId),
							...(model && { PI_MODEL: model.modelId.replace(/^[^/]+\//, '') }),
							...(thinkingLevel &&
								thinkingLevel !== 'off' && { PI_REASONING_LEVEL: thinkingLevel }),
						})
					},
				}),
			),
			defineTool({
				name: 'runners',
				description:
					"List the house's runners you can run commands on: name, machine, online, folder. `bash` takes one as `runner`.",
				parameters: obj({}),
				replay: 'safe',
				execute: async (_args, api) => {
					const own = api.env?.id.replace(/^runner:/, '')
					const all = await known()
					const lines = Object.entries(all)
						.filter(([name]) => mayRun(own, name, all))
						.map(([name, runner]) =>
							[
								name,
								`machine ${runner.host || '?'}`,
								runners.isOnline(name) ? 'online' : 'offline',
								`folder ${runner.dir}`,
								runner.readOnly && 'read-only',
								name === own && '(yours)',
							]
								.filter(Boolean)
								.join(', '),
						)
					return { output: [{ type: 'text', text: lines.join('\n') }] }
				},
			}),
		],
	}),
)
// Scripts that call the other tools, so a run of calls costs the model one turn
registry.install(
	createCodemodeExtension({
		sandbox: new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 }),
	}),
)
registry.install(defineExtension({ name: 'ade', tasks: [Anchor, Admit, Deliver, Shell] }))
function mayRun(own, name, all) {
	try {
		return Boolean(all[name]) && (reach([{ runner: name }], `@${own}`, all), true)
	} catch {
		return false
	}
}
/** `bash` with an optional `runner`: the command runs there, in its folder; the conversation stays where it is */
function anyRunner(bash) {
	const { command, timeout } = bash.parameters.properties
	return defineTool({
		...bash,
		description: `${bash.description} Give \`runner\` to run it on another runner, in its folder (\`runners\` lists them).`,
		parameters: obj(
			{
				command: str(command),
				timeout: opt(num(timeout)),
				runner: opt(str({ description: 'Another runner to run it on; yours by default' })),
			},
			{ open: true },
		),
		async execute(args, api, context) {
			const own = api.env?.id.replace(/^runner:/, '')
			const name = /** @type {any} */ (args).runner
			if (!name || name === own) return bash.execute(args, api, context)
			const all = await known()
			if (!all[name]) throw new Error(`No runner named ${name}; \`runners\` lists them`)
			if (!mayRun(own, name, all)) throw new Error(`${name} doesn't take work from ${own}`)
			if (!runners.isOnline(name)) throw new Error(`${name} is offline`)
			const env = remoteEnv(runners, name, all[name].dir)
			return bash.execute(args, Object.create(api, { env: { value: env } }), context)
		},
	})
}
/**
 * Pi's settings, worked out again only when a runner's models or compactAt change (`provide`): Pi asks for them on
 * every document it reads, and going through every model for compactingAt each time was most of what a list cost
 */
let harnessed
const harnessSettings = () =>
	(harnessed ??= {
		afterFailedRun: /** @type {const} */ ('continue'),
		/** RESTART_LIMIT=n: how many crashes in a row end a task; Pi's own limit unless set */
		...(Number(process.env.RESTART_LIMIT) >= 1 && {
			restartLimit: Number(process.env.RESTART_LIMIT),
		}),
		...(compactAt && { compaction: compactingAt(compactAt) }),
	})
const provide = (name, runnerModels) => {
	models.setProvider(runnerProvider(runners, name, runnerModels))
	harnessed = undefined
}

const storage = await openNodeSqliteStorage(file)
const harness = await Harness.open(
	storage,
	{
		models,
		registry,
		env: async ({ conversationId, cwd, read }) => {
			const runner = (
				await read.snapshot(AgentDoc, conversationId, context)
			)?.model?.provider?.replace(/^runner:/, '')
			return runner ? remoteEnv(runners, runner, cwd) : undefined
		},
		/** A failed run doesn't strand the messages queued behind it: the next run takes them */
		settings: () => harnessSettings(),
		onReport: (report) => {
			console.error(`pi-durable: ${report.kind}:`, report.error)
			if (report.kind === 'task_faulted') faulted(report).catch((error) => console.error(error))
		},
	},
	context,
)
harness.closed.then(
	(end) =>
		end.kind === 'failed' &&
		(console.error('pi-durable: storage failed, exiting:', end.error), process.exit(1)),
)
/**
 * A stop closes the harness, so the tasks it cuts off wait to resume, and Pi doesn't count them as crashed. Closing
 * waits for running task code to return, so one that ignores its abort signal could wait forever: a deadline forces
 * the exit anyway, and a second signal, while that first close is still working, skips straight to it.
 */
let stopping
const CLOSE_DEADLINE = 5_000
for (const signal of ['SIGINT', 'SIGTERM'])
	process.on(signal, () => {
		console.error(`stopped by ${signal}`)
		if (stopping) return process.exit(0)
		stopping = Promise.race([
			harness.close(context),
			new Promise((resolve) => setTimeout(resolve, CLOSE_DEADLINE)).then(() =>
				console.error(`the harness didn't close within ${CLOSE_DEADLINE}ms; exiting anyway`),
			),
		]).finally(() => process.exit(0))
	})

/**
 * Each read thread's newest RECENT entries, then each it commits, so a list's status and open question read no entries;
 * `whole` while they are all it has
 */
const RECENT = 50
const tails = new Map()
/** Publish before loading: commits can append while the read is pending. Failed reads may be tried again. */
async function loadEntries(cache, key, load) {
	let value = cache.get(key)
	if (!value) {
		value = { entries: [], ready: undefined }
		cache.set(key, value)
		const loading = value
		value.ready = load(value)
		value.ready.catch(() => cache.get(key) === loading && cache.delete(key))
	}
	await value.ready
	return value
}
const recent = (id) =>
	loadEntries(tails, id, async (tail) => {
		tail.whole = false
		tail.older = new Map()
		const handle = await harness.conversation(id, context)
		const page = handle
			? await handle.entries({ order: 'descending' }, RECENT, undefined, context)
			: { items: [], next: undefined }
		// Entries committed while it read came in already; each goes in once, in order
		const have = new Set(tail.entries.map((entry) => entry.id))
		tail.entries = [...page.items.filter((entry) => !have.has(entry.id)).reverse(), ...tail.entries]
			.sort((a, b) => a.id - b.id)
			.slice(-RECENT)
		tail.whole = !page.next && tail.entries.length < RECENT
	})
const heardEntry = (entry) => {
	const tail = tails.get(entry.conversationId)
	if (!tail) return
	tail.entries.push(entry)
	if (tail.entries.length > RECENT) {
		// What leaves the newest goes on to the older ones kept of its kind
		for (const gone of tail.entries.splice(0, tail.entries.length - RECENT))
			tail.older.get(gone.kind)?.entries.push(gone)
		tail.whole = false
	}
}
/**
 * A thread's entries of `kind` before its newest, oldest first, read once when a look finds nothing among the newest:
 * they never change, and those that leave the newest join them
 */
async function older(id, kind) {
	const tail = await recent(id)
	const kept = await loadEntries(tail.older, kind, async (kept) => {
		const before = tail.entries[0]?.id
		const handle = await harness.conversation(id, context)
		const maxEntryId = /** @type {import("@earendil-works/pi-durable").EntryId} */ (before - 1)
		const found =
			handle && before !== undefined
				? await collect((cursor) =>
						handle.entries({ order: 'ascending', maxEntryId }, 500, cursor, context),
					)
				: []
		kept.entries = [...found.filter((entry) => entry.kind === kind), ...kept.entries]
	})
	return kept.entries
}
/** Each read conversation's record, as its commits change it */
const records = new Map()
async function conversationRecord(id) {
	if (!records.has(id)) records.set(id, await storage.conversation(id, context))
	return records.get(id)
}
/** Each thread's people who wrote there, read once and kept as commits land; see `authors` below */
const writers = new Map()
const heardAuthor = (entry) => {
	const wrote = writers.get(entry.conversationId)
	if (!wrote) return
	if (entry.kind === KIND && !byAgent(entry.data)) wrote.authors.add(entry.data.author)
	wrote.after = Math.max(wrote.after, entry.id)
}
harness.observeCommits({
	advance: ({ changes }) => {
		for (const change of changes) {
			if (change.type === 'entry') {
				heardEntry(change.value)
				heardAuthor(change.value)
			}
			if (change.type === 'conversation' && !change.value.owner)
				records.set(change.value.id, change.value)
		}
	},
	end: () => {},
})

/** What each runner said when it last connected; a runner whose key is gone stays here, so its agents can wait for its name */
const known = async () => (await harness.snapshot(Runners, context)) ?? {}
const keys = async () => (await harness.snapshot(Keys, context)) ?? {}
const thread = (id) => harness.snapshot(Thread, id, context)
/** Each commit's work for once it's stored, best-effort: a commit that throws runs none of it */
const afterCommits = new WeakMap()
const commit = async (fn) => {
	const after = []
	const result = await harness.commit(async (tx) => {
		after.length = 0
		afterCommits.set(tx, after)
		return fn(tx)
	}, context)
	for (const run of after) run()
	return result
}
/** Runs `run` once the commit `tx` belongs to is stored; outside the server's own commits, never */
const afterCommit = (tx, run) => afterCommits.get(tx)?.push(run)
const conversation = async (id) => {
	const found = (await thread(id)) && (await harness.conversation(id, context))
	if (!found) throw Object.assign(new Error('Thread not found'), { status: 404 })
	return found
}

/** Every conversation, newest first: threads, and the agents' they own (`owner`) */
const conversations = () =>
	collect((cursor) => commit((tx) => tx.scanConversations({ order: 'descending' }, 500, cursor)))

const threadIds = async () =>
	(await conversations())
		.filter((conversation) => !conversation.owner)
		.map((conversation) => conversation.id)

// ── Small helpers ─────────────────────────────────────────────────────────

/** Who sent each request, settled before it's handled */
const senders = new WeakMap()
const user = (req) => senders.get(req)

/** The address this request reached the server at, as a runner on another machine dials it */
const origin = (req) =>
	`${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${String(req.headers.host).replace(/[^\w.:[\]-]/g, '')}`
const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const say = (label, text) => console.log(`  ${label.padEnd(8)} ${text}`)
const tilde = (dir) => (dir?.startsWith(os.homedir()) ? `~${dir.slice(os.homedir().length)}` : dir)
/** A folder as its runner's owner writes it, `~` for their home there */
const onRunner = (runner, dir) =>
	runner.home && (dir === runner.home || dir.startsWith(`${runner.home}/`))
		? `~${dir.slice(runner.home.length)}`
		: dir
const loopback = (address) =>
	/^(127\.|::ffff:127\.)/.test(address) || ['::1', '[::1]', 'localhost'].includes(address)

// ── Addressing: whom a message asks ───────────────────────────────────────

async function address(to, command = false, signal, useDefaultThinking = true) {
	const name = field(to?.runner, 'to.runner')
	if (!(await keys())[name]) throw new Error(`No runner named ${name}`)
	const runner = (await known())[name]
	if (!runner) throw new Error(`${name} hasn't connected yet`)
	/** @type {Partial<To>} */
	const clean = {
		runner: name,
		...(command
			? {}
			: await modelOn(
					name,
					runner,
					typeof to.model === 'string' ? to.model.trim() : '',
					signal,
					useDefaultThinking,
				)),
	}
	for (const key of ['thinkingLevel', 'dir'])
		if (typeof to[key] === 'string' && to[key].trim()) clean[key] = to[key].trim()
	if (to.name !== undefined) {
		if (typeof to.name !== 'string' || !(await botAgent?.(to.name)))
			throw new Error(`${to.name} is no bot: only bots have names, and a thread's agent has none`)
		clean.name = to.name
	}
	const cwd = folder(runner, clean)
	// A folder someone names is checked on the spot; one an agent already works in is checked when it runs
	if (clean.dir && runners.isOnline(name)) {
		const found = await remoteEnv(runners, name, runner.dir).exists(cwd, {
			...context,
			abortSignal: signal,
		})
		if (found.ok && !found.value)
			throw new Error(
				`${clean.name ? `${clean.name}'s folder` : 'The folder'} ${onRunner(runner, cwd)} doesn't exist on ${name}`,
			)
	}
	return clean
}
const addresses = (to, command, threadId) =>
	Promise.all((to === null ? [] : [to].flat()).map((to) => whom(threadId, to, command)))
/** `12` is thread 12's agent and `12/ada` a bot there; a runner named only digits is `@12` */
async function whom(threadId, to, command = false, signal) {
	const [, at, rest] = (typeof to === 'string' && to.match(/^(\d+)(?:\/(.+))?$/)) || []
	if (at && Number(at) !== threadId) throw new Error(`${to} is in thread ${at}, not ${threadId}`)
	const text = at ? (rest ?? AGENT) : to
	const agents = threadId !== undefined ? (await thread(threadId))?.agents : undefined
	// A bot asked by name runs as the bot is now, so changing its runner or model reaches the threads it's already in
	const bot = typeof text === 'string' && !/[@=]/.test(text) && (await botAgent?.(text))
	if (bot) return address(bot, command, signal)
	if (typeof text === 'string' && agents?.[text]) return agentOf(agents[text].conversation, text)
	if (text === AGENT) throw new Error(`Thread ${threadId} has no agent yet`)
	const asked = typeof text === 'string' ? agentTo(text) : text
	const key = !command && (asked?.name ?? AGENT)
	const agent = key && agents?.[key] ? await agentOf(agents[key].conversation, key) : null
	const resolved = await address(asked, command, signal, !agent?.thinkingLevel)
	if (!agent) return resolved
	// The agent is there already, so this switches it from this message on. What the ask leaves out stays as it was:
	// its thinking, as a runner alone resolves to pi's default thinking there, which no one asked for, and on the same
	// runner its folder.
	const { thinkingLevel, dir, ...model } = resolved
	const level =
		asked?.thinkingLevel || (asked?.model && thinkingLevel) || agent.thinkingLevel || thinkingLevel
	const into = dir ?? (resolved.runner === agent.runner ? agent.dir : undefined)
	return { ...model, ...(level ? { thinkingLevel: level } : {}), ...(into ? { dir: into } : {}) }
}

/** What `pi --model asked` makes of it on the runner, kept with its models */
async function modelOn(name, runner, asked, signal, useDefaultThinking) {
	// A model by its own name, as an agent is written, is the one model of that id it has run
	const ids = Object.keys(runner.models ?? {}).filter((ref) => ref.split('/').pop() === asked)
	const had = runner.models?.[asked] ?? (ids.length === 1 ? runner.models[ids[0]] : undefined)
	if (had && (!useDefaultThinking || !runners.isOnline(name)))
		return { model: `${had.provider}/${had.id}` }
	if (!runners.isOnline(name)) throw new Error(`${name} is offline; name a model it has run`)
	const { model, thinkingLevel, defaultThinkingLevel } = await runners.call(
		name,
		{ op: 'resolve', model: asked },
		{ signal },
	)
	const ref = `${model.provider}/${model.id}`
	if (!runner.models?.[ref]) {
		await commit(async (tx) => {
			;(await tx.doc(Runners))[name].models[ref] = model
		})
		provide(name, (await known())[name].models)
	}
	const level = thinkingLevel ?? (useDefaultThinking ? defaultThinkingLevel : undefined)
	return { model: ref, ...(level ? { thinkingLevel: level } : {}) }
}

function reach(to, by, available) {
	for (const { runner: name } of to) {
		const { owner, allow = [] } = available[name]
		if (owner && by !== owner && by !== `@${name}` && !allow.includes(by)) {
			throw Object.assign(
				new Error(`${name} takes work only from ${[owner, ...allow].join(', ')}`),
				{ status: 403 },
			)
		}
	}
}

/** `dir` is relative to the runner's first folder, or any path on its machine, `~` included: the folders it offers are only shortcuts */
const folder = (runner, to) => {
	const dir = to.dir || '.'
	const home = dir === '~' || dir.startsWith('~/') ? runner.home : undefined
	return path.resolve(runner.dir, home ? path.join(home, dir.slice(1)) : dir)
}

/** `key`, its key in the thread, and `all`, the runners as known, when the caller has them, save looking them up */
async function agentOf(id, key, tx, all) {
	const agent = tx ? await tx.doc(AgentDoc, id) : await harness.snapshot(AgentDoc, id, context)
	const runnerName = agent?.model?.provider?.match(/^runner:(.+)$/)?.[1]
	if (!runnerName) return null
	const runner = (tx ? await tx.doc(Runners) : (all ?? (await known())))[runnerName]
	const rel = runner && agent.cwd ? path.relative(runner.dir, agent.cwd) : ''
	const dir = rel.startsWith('..') ? agent.cwd : rel
	const name = key ?? (await home(id))?.key
	return {
		runner: runnerName,
		model: agent.model.modelId,
		...(agent.thinkingLevel ? { thinkingLevel: agent.thinkingLevel } : {}),
		...(dir ? { dir } : {}),
		...(name && name !== AGENT ? { name } : {}),
	}
}

/** Whom asking an agent asks: a bot as it is now, which may be another runner or model than its agent here; else the agent */
const askable = async (key, conversation) =>
	(key !== AGENT && (await botAgent?.(key))) || agentOf(conversation, key)

/** The agents in a thread as asking them asks them: bots as they are now */
const agentsHere = async (threadId) =>
	(
		await Promise.all(
			Object.entries((await thread(threadId)).agents).map(([key, agent]) =>
				askable(key, agent.conversation),
			),
		)
	).filter(Boolean)

// ── Live work and statuses ────────────────────────────────────────────────

/** Until the agent's runner is online, following the agent if it's asked on another runner meanwhile */
async function reachable(agent, signal) {
	for (;;) {
		const to = await agentOf(agent)
		// Its runner dialling in, or any change, which may be the agent moving, wakes it to look again
		const done = new AbortController()
		const stop = () => done.abort(signal.reason)
		signal.addEventListener('abort', stop, { once: true })
		let wake
		try {
			await Promise.race([
				runners.online(to.runner, done.signal),
				new Promise((resolve) => changes.add((wake = resolve))),
			])
		} finally {
			changes.delete(wake)
			signal.removeEventListener('abort', stop)
			done.abort()
		}
		signal.throwIfAborted()
		if (runners.isOnline(to.runner)) return to
	}
}

/** One status for an agent, a thread, a runner or a bot: `working`, `blocked` while its runner is offline, or `idle` */
const STATUSES = ['idle', 'blocked', 'working']
const busiest = (statuses) =>
	STATUSES[Math.max(0, ...statuses.map((status) => STATUSES.indexOf(status)))]
/**
 * Whatever works right now, from Pi's live tasks: each agent answering and each `$ cmd` running, once for every list
 * @returns {Promise<{ thread: number, conversation?: number, runner?: string, row?: string, status: string }[]>}
 */
async function work() {
	const tasks = (await harness.inspect(context)).tasks
	return Promise.all(
		tasks
			.filter(({ record }) => isWork(record.kind))
			.map(async ({ record }) => {
				const task = /** @type {any} */ (record)
				// A module's own work in a thread, like the director's pick, keeps it working and its Stop in reach
				if (!runsOnRunner(task.kind)) return { thread: task.conversationId, status: 'working' }
				const shell = task.kind === Shell.definition.name
				const to = shell ? task.input.to : await agentOf(task.input.agent)
				// A model call waits on the runner it was sent to, which may not be the one the agent has moved to
				const parked = shell
					? undefined
					: (await keysOf(task.input.agent)).map(runners.parkedOn).find(Boolean)
				const on = parked ?? to?.runner
				return {
					thread: task.conversationId,
					...(!shell && {
						conversation: task.input.agent,
						row: to && (to.name ?? `${to.model}@${to.runner}`),
					}),
					runner: on,
					status: on && runners.isOnline(on) ? 'working' : 'blocked',
				}
			}),
	)
}
/**
 * Whose an agent's calls to a runner are: its model session, which its model calls carry, and its conversation, which
 * its prompt's calls carry. The session never changes, so it's kept once read.
 */
const sessions = new Map()
async function keysOf(conversation, tx = undefined) {
	if (!sessions.has(conversation)) {
		const session = tx
			? (await tx.doc(ProviderDoc, conversation)).sessionId
			: (await harness.snapshot(ProviderDoc, conversation, context))?.sessionId
		if (session) sessions.set(conversation, String(session))
	}
	return [sessions.get(conversation), `conversation ${conversation}`].filter(Boolean)
}
/** An agent answering or a `$ cmd`: work on a runner */
const runsOnRunner = (kind) => kind === Deliver.definition.name || kind === Shell.definition.name
/** What counts as a thread working: work on a runner, or a module's own */
const isWork = (kind) => runsOnRunner(kind) || moduleWork.includes(kind)

/** Whether a thread has work: an agent answering or waiting for its runner, a `$ cmd`, a module's own, like a pick */
const busy = async (threadId) => (await work()).some((job) => job.thread === threadId)

/** @returns {Promise<Agent[]>} */
async function agentsIn(row, busy, all) {
	return Promise.all(
		Object.entries(row.agents).map(async ([key, { conversation }]) => {
			const to = await agentOf(conversation, key, undefined, all)
			const status = busiest(
				busy.filter((job) => job.conversation === conversation).map((job) => job.status),
			)
			const contextWindow = to && models.getModel(`runner:${to.runner}`, to.model)?.contextWindow
			return {
				name: to ? writtenTo(to) : key,
				conversation,
				to,
				status,
				...(contextWindow && { contextWindow }),
			}
		}),
	)
}

function doing({ entries, docs }) {
	const { run, generation, tools = [] } = docs['pi.live'] ?? {}
	const calls = entries
		.flatMap((entry) => (entry.model?.[0]?.role === 'assistant' ? entry.model[0].content : []))
		.filter((block) => block.type === 'toolCall')
	return {
		run: Boolean(run),
		message: generation?.message ?? null,
		tools: tools.map(({ callId, name, status }) => ({
			callId,
			name,
			status,
			args: calls.find((call) => call.id === callId)?.arguments,
		})),
	}
}

// ── Thread writes: entries, delivery, outcomes ────────────────────────────

/** @returns {Promise<import("@earendil-works/pi-durable").TypedEntry<any>[]>} */
async function entries(id) {
	const handle = await harness.conversation(id, context)
	return handle
		? collect((cursor) => handle.entries({ order: 'ascending' }, 500, cursor, context))
		: []
}
async function messages(id) {
	await conversation(id)
	return routed(await entries(id))
}
/**
 * A thread's messages among its entries, each with the director's pick for it, once there is one; a withdrawn one keeps
 * its place, so positions hold, but only its author and `withdrawn`
 */
function routed(entries, routes = new Map()) {
	for (const entry of entries)
		if (entry.kind === ROUTE || entry.kind === WITHDRAWAL)
			routes.set(entry.data.message, {
				...routes.get(entry.data.message),
				...(entry.kind === ROUTE ? entry.data : { withdrawn: true }),
			})
	return entries.filter((entry) => entry.kind === KIND).map((entry) => withRoute(entry, routes))
}
const withRoute = (entry, routes) => {
	const route = routes.get(entry.id)
	if (!route) return entry
	if (route.withdrawn)
		return {
			...entry,
			data: {
				author: entry.data.author,
				createdAt: entry.data.createdAt,
				body: '',
				withdrawn: true,
			},
		}
	const { to, picked } = route
	return {
		...entry,
		data: { ...entry.data, ...(to.length ? { to } : {}), ...(picked ? { picked } : {}) },
	}
}
/** The newest matching message, stopping as soon as it is found rather than loading a thread; inside a commit, before its writes, with its `tx` */
async function latestMessage(id, matches, kind = KIND, tx = undefined) {
	const found = (entry) => entry.kind === kind && matches(entry) && entry
	if (!tx) return back(id, kind, found)
	return firstIn(
		(cursor) => tx.scanEntries({ conversationId: id, order: 'descending' }, 50, cursor),
		found,
	)
}
/** The first of `look`'s answers for a thread's entries, newest first: its newest kept in memory, any kind, then its
 * older ones of `kind`, read once */
async function back(id, kind, look) {
	const tail = await recent(id)
	for (let at = tail.entries.length - 1; at >= 0; at--) {
		const found = look(tail.entries[at])
		if (found) return found
	}
	if (!tail.entries.length) await conversation(id)
	if (tail.whole) return undefined
	const kept = await older(id, kind)
	for (let at = kept.length - 1; at >= 0; at--) {
		const found = look(kept[at])
		if (found) return found
	}
}
async function lastAsked(id) {
	const names = (await messages(id)).findLast((entry) => entry.data.to)?.data.to ?? []
	const { agents } = await thread(id)
	return Promise.all(
		names.map((name) =>
			agents[keyOf(name)] ? askable(keyOf(name), agents[keyOf(name)].conversation) : whom(id, name),
		),
	)
}

/** An agent's own answer, which it never reads back: its turn's last words, or what it posted to its asker */
const ownAnswer = ({ data: message }, key) =>
	keyOf(message.author) === key &&
	!message.from &&
	Boolean(message.answer || message.error || message.re || message.waitingOnPerson)

/**
 * Writes a message, inside the caller's commit, and gives each agent it asks a Deliver task with all it hasn't seen.
 * A new agent reads the thread, which a commit can't do after writing: post first, or pass `empty` for a new thread.
 * @param {Message} message
 */
async function post(tx, threadId, message, options = {}) {
	let by = message.author
	/** An agent writes from another thread, or as a bot in its own room (`member`), and works with its runner's rights */
	if (options.opener) by = `@${options.opener.runner}`
	else if (message.from || options.member) {
		const recipient = (await tx.doc(Thread, message.from ?? threadId)).agents[keyOf(message.author)]
		if (!recipient) throw new Error('Only an agent can post from another thread')
		by = `@${(await agentOf(recipient.conversation, message.author, tx)).runner}`
	}
	await reach(message.to ?? [], by, await tx.doc(Runners))
	if (options.member || options.opener) message = { ...message, posted: true }
	const entry = await append(tx, threadId, message, options)
	/** A bot that opens a thread joins it after its first message, which it has said and so never reads back */
	if (options.opener) {
		const row = await tx.doc(Thread, threadId)
		row.agents[options.opener.name] = await newAgent(tx, threadId, [])
		await setUp(tx, row.agents[options.opener.name].conversation, threadId, options.opener)
	}
	return entry
}

/**
 * Already-authorized answers return to their askers; new requests enter through post. `direct` leaves whom it asks to
 * the director, which picks after this commit; `pick` is the task that does.
 */
async function append(
	tx,
	threadId,
	{ to = undefined, ...message },
	{ steer = false, empty = false, direct = false, unlessPaused = false } = {},
) {
	const row = await tx.doc(Thread, threadId)
	// A solo thread's message, decided outside this commit, asks no one if the thread was paused meanwhile
	if (unlessPaused && row.paused) [to, message] = [undefined, { ...message, picked: PAUSED }]
	const names = (to ?? []).map(writtenTo)
	const data = { createdAt: now(), ...message, ...(to ? { to: names } : {}) }
	const prior =
		!empty && names.some((name) => !row.agents[keyOf(name)]) ? await messageIds(tx, threadId) : []
	row.picks ??= {}
	row.unpicked ??= []
	/** The author's own earlier messages a pick still pending covered, which their new message's pick covers now */
	let covers = []
	if (fresh({ kind: KIND, data })) {
		// The author's next message takes over their pick still pending if it makes a pick of its own, or asks someone
		// who then reads the older one; one that asks no one leaves it be
		if (row.picks[message.author] && (direct || names.length)) {
			covers = (await supersede?.(tx, threadId, row.picks[message.author])) ?? []
			delete row.picks[message.author]
			if (!direct) row.unpicked = row.unpicked.filter((id) => !covers.includes(id))
		}
		// Having sent, they're no longer typing: once this commit is stored, picks held for them go on
		sent?.(tx, threadId, message.author)
	}
	const entry = await tx.appendEntry(threadId, { kind: KIND, data })
	for (const hook of posted) await hook(tx, threadId, entry)
	for (const [key, agent] of Object.entries(row.agents))
		if (!ownAnswer({ data }, key)) agent.unseen.push(entry.id)
	await ask(tx, row, threadId, entry.id, to ?? [], { steer, prior })
	const pick =
		direct && directing
			? await directing(tx, threadId, entry.id, {
					steer,
					author: message.author,
					body: message.body,
					covers,
				})
			: undefined
	if (pick) {
		row.picks[message.author] = pick
		row.unpicked = [...new Set([...row.unpicked, ...covers, entry.id])]
	}
	return { entry: entry.id, to: names, ...(pick ? { pick } : {}) }
}

const messageIds = async (tx, threadId) =>
	(
		await collect((cursor) =>
			tx.scanEntries({ conversationId: threadId, order: 'ascending' }, 500, cursor),
		)
	)
		.filter((entry) => entry.kind === KIND)
		.map((entry) => entry.id)

/** Each agent `to` names gets a Deliver task for all it hasn't seen up to `upTo`; with `turns`, one after another */
async function ask(tx, row, threadId, upTo, to, { steer = false, prior = [] } = {}) {
	let turn
	for (const one of to) {
		const key = keyOf(writtenTo(one))
		if (!row.agents[key]) {
			row.agents[key] = await newAgent(tx, threadId, [...prior, upTo])
			await setUp(tx, row.agents[key].conversation, threadId, one)
		} else await reconfigure(tx, row.agents[key], one)
		const recipient = row.agents[key]
		const { conversation: agent, unseen, admission: after } = recipient
		if (!unseen.length) continue
		const admit = await tx.createTask(
			Admit,
			{ agent, upTo, steer, ...(after ? { after } : {}), ...(turn ? { turn } : {}) },
			{ ...own, conversationId: threadId },
		)
		const deliver = await tx.createTask(
			Deliver,
			{ admit, agent, upTo },
			{ ...own, conversationId: threadId },
		)
		recipient.admission = { admit, deliver }
		if (turns) turn = deliver
	}
}

/**
 * The director's pick for a saved message, inside its commit: the record that shows it on the message, then each
 * agent it picked gets the message as if it had asked them. A pick the author may not reach asks no one.
 */
async function route(
	tx,
	threadId,
	messageId,
	{ to, picked },
	{ steer = false, pick, covers = [] } = {},
) {
	const { data } = await tx.entry(messageId)
	const row = await tx.doc(Thread, threadId)
	row.picks ??= {}
	if (row.picks[data.author] !== pick)
		// The author's newer message took over: this one asks no one, and whatever took over reads it
		[to, picked] = [[], undefined]
	else {
		delete row.picks[data.author]
		// Its messages are free to be read now, whoever it asks
		row.unpicked = (row.unpicked ?? []).filter((id) => id !== messageId && !covers.includes(id))
		// Paused while the chooser ran: it starts no reply
		if (row.paused && to.length) [to, picked] = [[], PAUSED]
	}
	try {
		await reach(to, data.author, await tx.doc(Runners))
	} catch (error) {
		;[to, picked] = [[], `Pick failed: ${error.message}`]
	}
	const prior = to.some((one) => !row.agents[keyOf(writtenTo(one))])
		? await messageIds(tx, threadId)
		: []
	await tx.appendEntry(threadId, {
		kind: ROUTE,
		data: { message: messageId, to: to.map(writtenTo), ...(picked ? { picked } : {}) },
	})
	await ask(tx, row, threadId, messageId, to, { steer, prior })
	return { to: to.map(writtenTo), ...(picked ? { picked } : {}) }
}

/** A message someone wrote to the thread, not an agent's answer back, a scheduled task's run or a command's output: one that takes over a pick */
const fresh = ({ kind, data }) =>
	kind === KIND &&
	!data.answer &&
	!data.error &&
	!data.shell &&
	!data.re &&
	!data.scheduledTask &&
	!data.stopped

/**
 * An agent asked with another model, thinking, runner or folder changes in place, as in pi, and is told when it moves
 * @param {Recipient} recipient
 * @param {To} to
 */
async function reconfigure(tx, recipient, to) {
	const now = await tx.doc(AgentDoc, recipient.conversation)
	const cwd = folder((await tx.doc(Runners))[to.runner], to)
	const model = { provider: `runner:${to.runner}`, modelId: to.model }
	const moved = now.model?.provider !== model.provider || now.cwd !== cwd
	const remodelled = moved || now.model?.modelId !== model.modelId
	const thinks = to.thinkingLevel && now.thinkingLevel !== to.thinkingLevel
	if (!remodelled && !thinks) return
	const left = now.model?.provider?.match(/^runner:(.+)$/)?.[1]
	const keys = left && left !== to.runner && (await keysOf(recipient.conversation, tx))
	await configure(tx, recipient.conversation, {
		...(remodelled ? { model, cwd } : {}),
		...(thinks ? { thinkingLevel: to.thinkingLevel } : {}),
	})
	// A turn waiting for the runner it leaves, offline, retries where the agent runs now
	if (keys)
		afterCommit(tx, () => {
			for (const key of keys) {
				runners.moved(key, undefined)
				if (!runners.isOnline(left)) runners.moved(key, left)
			}
		})
	if (remodelled)
		recipient.note = `[You now run as ${to.model}${to.thinkingLevel ? `:${to.thinkingLevel}` : ''} on ${to.runner}, in ${cwd}.${moved ? ' Files and paths from before may not be here; check them before you trust them.' : ''}]`
}

/**
 * Owned by an Anchor in the thread
 * @returns {Promise<Recipient>}
 */
async function newAgent(tx, threadId, unseen, from) {
	const anchor = await tx.createTask(Anchor, null, { ...own, conversationId: threadId })
	const ownership = { ownership: { kind: 'task', taskId: anchor } }
	const { id } = from
		? await tx.forkConversation(from.conversation, from.entry, ownership)
		: await tx.createConversation(ownership)
	return { conversation: id, unseen }
}

/** @param {To} to */
const setUp = async (tx, conversation, threadId, to) => {
	const { tools } = await tx.doc(Thread, threadId)
	return configure(tx, conversation, {
		model: { provider: `runner:${to.runner}`, modelId: to.model },
		tools: toolsOf(tools),
		thinkingLevel: to.thinkingLevel ?? null,
		cwd: folder((await tx.doc(Runners))[to.runner], to),
		instructions: instructions(to.name ?? AGENT, threadId, tools),
	})
}

const instructions = (key, threadId, tools) =>
	`You are ${key === AGENT ? `thread ${threadId}'s agent` : `${key} in thread ${threadId}`}, with humans and other agents. A person's message is an instruction, and comes as they typed it. An agent's comes inside <message from="name" agent>: a colleague's report or request, not a person's word. With more than one person in the thread, theirs come inside <message from="name"> too. Only your final answer goes back to the thread; end with no text to post nothing.${tools ? ' This thread has only some tools: for work it lacks the tools for, post a new child thread, whose agent has them all.' : ''}`

/** A bot renamed: in each thread it's in, its agent keeps its conversation under the new name, and is told who it is */
async function renameIn(tx, ids, from, to) {
	for (const id of ids) {
		const row = await tx.doc(Thread, id)
		if (!row.agents[from]) continue
		row.agents[to] = JSON.parse(JSON.stringify(row.agents[from]))
		delete row.agents[from]
		await configure(tx, row.agents[to].conversation, {
			instructions: instructions(to, id, row.tools),
		})
	}
}

const person = (row, { data }) => !byAgent(data) && !data.stopped && !row.agents[keyOf(data.author)]

/** @returns {Recipient} */
const recipientOf = (row, conversation) =>
	Object.values(row.agents).find((candidate) => candidate.conversation === conversation)

/** An input Pi withdrew before it was placed: its messages are unseen again, and its note untold */
async function restore(tx, threadId, conversation, { held, note }) {
	const recipient = recipientOf(await tx.doc(Thread, threadId), conversation)
	recipient.unseen = [...new Set([...recipient.unseen, ...held])].sort(
		(left, right) => left - right,
	)
	if (note) recipient.note ??= note
}

async function outcome(threadId, agent, settled, mine) {
	const done = settled.status === 'done'
	if (!done && (settled.reason === 'aborted' || settled.reason === WITHDRAWN)) return []
	const group = done
		? (
				await collect((cursor) =>
					storage.scanSubmissions({ conversationId: agent }, 500, cursor, context),
				)
			).filter((submission) => submission.answer === settled.answer)
		: [settled]
	if (group[0].id !== settled.id) return []
	const { key, name } = await home(agent)
	const ids = new Set(
		done
			? (
					await commit((tx) => Promise.all(group.map((submission) => tx.entry(submission.entry))))
				).flatMap((entry) => entry.data.held)
			: mine,
	)
	const held = (await messages(threadId)).filter((entry) => ids.has(entry.id))
	/** A thread answers the thread that started it on its own; a post from anywhere else gets an answer only through `post` */
	const { parent } = await thread(threadId)
	const asks = held.filter((entry) => entry.data.from && !entry.data.re)
	const posts = asks.filter((entry) => entry.data.from === parent)
	const re = held
		.filter((entry) => !asks.includes(entry) || posts.includes(entry))
		.filter((entry) => entry.data.to?.some((name) => keyOf(name) === key))
		.map((entry) => entry.id)
	const body = done
		? messageText((await commit((tx) => tx.entry(settled.answer)))?.model?.[0])
		: (settled.said ??
			`gave no answer: ${settled.reason}${settled.detail ? ` (${JSON.stringify(settled.detail)})` : ''}`)
	if (done && !body.trim()) return []
	const result = done ? { answer: { conversation: agent, entry: settled.answer } } : { error: true }
	/** A bot's answer that @mentions another bot here asks it, as the director allows, if its runner takes work from this one */
	const directed =
		done && key !== AGENT && (await direct?.(threadId, { author: name, body, answer: true }, false))
	const runners = directed && (await known())
	const by = directed && `@${(await agentOf(agent, key)).runner}`
	const to = (directed?.to ?? []).filter((to) => {
		try {
			return (reach([to], by, runners), true)
		} catch {
			return false
		}
	})
	const told = [
		{
			thread: threadId,
			data: {
				author: name,
				body,
				...(to.length ? { to } : {}),
				...(re.length ? { re } : {}),
				...result,
			},
		},
	]
	if (posts.length && reply)
		return [
			...told,
			...(await reply(posts, threadId, name, body)).map((answer) => ({ ...answer, steer: true })),
		]
	return told
}

/** Posts what a settled input told; a submitted input Pi never placed gives its messages back */
async function tell(tx, threadId, agent, settled, submitted, told) {
	for (const { thread, data, steer } of told) await append(tx, thread, data, { steer })
	if (submitted?.submission && settled.entry === undefined && settled.reason !== WITHDRAWN)
		await restore(tx, threadId, agent, submitted)
}

/** Work that threw, or that crashes kept cutting off, Pi ends instead of running again, and the thread says so */
async function faulted({ task, reason }) {
	const record = /** @type {any} */ (await harness.getTask(task.id, context))
	const threadId = task.conversationId
	if (task.kind === Shell.definition.name) {
		const run = shells.get(task.id)
		shells.delete(task.id)
		return commit((tx) => printed(tx, threadId, record.input, { ...run, error: reason }))
	}
	// Reporter faults remain best-effort; admission faults have the durable wait above.
	if (task.kind !== Deliver.definition.name) return
	const { admit, agent, upTo } = record.input
	const placed = await storage.submissionByRequest(agent, String(admit), context)
	const submitted = (await harness.getTask(admit, context)).state.outcome?.result ?? null
	const settled = { id: admit, status: 'unanswered', reason, entry: placed?.entry }
	const told = await outcome(threadId, agent, settled, submitted?.held ?? [upTo])
	await commit((tx) => tell(tx, threadId, agent, settled, submitted, told))
}

// ── Read views: threads, lists, people ────────────────────────────────────

/** A thread's own status, or when idle, `done` or `error` for an answer its reader hasn't read; with no reader, anyone's read counts */
async function status(id, row, busy, reader) {
	if (await openQuestion?.(id, row)) return 'blocked'
	const { reads } = row
	const now = busiest(busy.map((job) => job.status))
	if (now !== 'idle') return now
	const seen = new Set(reader ? [reads[reader]] : Object.values(reads))
	/** An answer or error unread, or a read since: the newest entries say, unless none of them does */
	const said = (entry) => {
		if (seen.has(entry.id)) return 'idle'
		if (entry.data?.shell?.error === 'stopped') return undefined
		if (entry.data?.answer || entry.data?.error || entry.data?.shell)
			return entry.data.error || entry.data.shell?.error ? 'error' : 'done'
	}
	const found = (await back(id, KIND, said)) ?? 'idle'
	// A failure is the reader's only where they wrote; in a thread agents keep among themselves, its asker got it
	return found === 'error' && !(await concerns(id, reader)) ? 'idle' : found
}
/** Whether a thread's failures and answers are `reader`'s to read: they wrote there; with no reader, any person did. The sidebar's dots and the inbox both ask this. */
async function concerns(id, reader) {
	const wrote = await authors(id)
	return reader ? wrote.includes(reader) : wrote.length > 0
}

/** Who's in a thread needs no state of its own: the people who wrote there, or read, the owner and tailnet logins. Only an open thread needs it. */
async function people(id) {
	const wrote = await authors(id)
	const { reads } = await thread(id)
	return [...new Set([...wrote, ...Object.keys(reads)])].filter(
		(name) => name === owner || name.startsWith('~'),
	)
}
/** Each thread's writers, read once from storage and kept current by `heardAuthor` above as commits land, so a
 * repeat call, like the inbox's on every change, costs no query */
async function authors(id) {
	let wrote = writers.get(id)
	if (!wrote) {
		wrote = { after: 0, authors: new Set(), ready: undefined }
		writers.set(id, wrote)
		const loading = wrote
		wrote.ready = (async () => {
			const handle = await conversation(id)
			const read = await collect((cursor) =>
				handle.entries({ order: 'ascending', minEntryId: loading.after + 1 }, 500, cursor, context),
			)
			for (const record of read) {
				const entry = /** @type {import("@earendil-works/pi-durable").TypedEntry<Message>} */ (
					record
				)
				if (entry.kind === KIND && !byAgent(entry.data)) loading.authors.add(entry.data.author)
				loading.after = Math.max(loading.after, entry.id)
			}
		})()
		wrote.ready.catch(() => writers.get(id) === loading && writers.delete(id))
	}
	await wrote.ready
	/** People only, as the server names them: a bot speaking in its own room writes with no agent's mark, and older
	 * stores hold names anyone could claim */
	return [...wrote.authors].filter((name) => name === owner || name.startsWith('~'))
}

/** `homes`, each bot's home thread → its name, its `doc` and the `runners` as known save reading them for every row of a list */
async function threadRow(id, reader, all, homes, doc, runnersKnown) {
	const { reads, hidden, dismissed: _, picks: __, ...row } = doc ?? (await thread(id))
	const busy = all.filter((job) => job.thread === id)
	const agents = await agentsIn(row, busy, runnersKnown)
	const rowStatus = await status(id, { ...row, reads }, busy, reader)
	return {
		id,
		...row,
		/** A bot's home shows the bot's name; its stored title stays as it was */
		title: (homes ?? (await homesOf?.()) ?? {})[id] ?? row.title,
		/** Stored as `hidden` still; renaming the doc's own key would need migrating every already-archived thread */
		archived: hidden,
		/** With memory on, whether it remembers; without, nothing */
		memory: remembers?.(row),
		readers: Object.keys(reads),
		agents,
		shells: [...shells.values()].filter((run) => run.threadId === id),
		/** Whether it has work, whatever its status shows: an open question doesn't hide a running command */
		busy: busy.length > 0,
		status: rowStatus,
		unread: ['done', 'error'].includes(rowStatus),
		/** The id of its newest message, which sorts threads by latest activity; its own id before it has one */
		latest: (await recent(id)).entries.findLast((entry) => entry.kind.startsWith('ade.'))?.id ?? id,
		...(!hidden && familyField(id)),
		conversation: await conversationRecord(id),
	}
}
/** Each shown thread's row; the client works out families from `parent` and forks */
const threadList = async (reader, archived = false) => {
	const busy = await work()
	const homes = (await homesOf?.()) ?? {}
	const runnersKnown = await known()
	/** Only the threads this list shows get a row, since a row reads its thread's entries for its status */
	const ids = await threadIds()
	const docs = await Promise.all(ids.map((id) => thread(id)))
	return Promise.all(
		ids.flatMap((id, index) =>
			Boolean(docs[index].hidden) === archived
				? [threadRow(id, reader, busy, homes, docs[index], runnersKnown)]
				: [],
		),
	)
}
/** Short display label for an author: a model's bare id, a tailnet login without `~` or `+provider`, or a name as is */
const shortLabel = (author) =>
	!author
		? ''
		: author.includes('@')
			? author.split('@')[0].split('/').pop().split(':')[0]
			: author.startsWith('~')
				? author.slice(1).replace(/\+.*$/, '')
				: author

/**
 * Shapes a thread's messages for one viewer so any client draws them without deriving speaker changes, reply targets,
 * cross-thread labels or row kinds. `seed` is the message right before a paged window so the first visible row knows
 * whether the speaker changed.
 */
async function shapeMessages(threadId, list, viewer, { seed = undefined, row = undefined } = {}) {
	if (!list.length) return []
	row ??= await thread(threadId)
	const botSet = new Set((await botNames?.()) ?? [])
	const homes = (await homesOf?.()) ?? {}
	const isGroup = Object.keys(row.agents).length > 1 || (await authors(threadId)).length > 1
	const byPerson = ({ data }) =>
		!byAgent(data) && !data.from && !data.scheduledTask && !data.stopped && !botSet.has(data.author)
	const all = seed ? [seed, ...list] : list
	const byId = new Map(all.map((entry) => [entry.id, entry]))
	const firstAnswer = new Map()
	const sentMap = new Map()
	const otherIds = new Set()
	for (const entry of all) {
		const { from, re } = entry.data
		if (!from) {
			for (const id of re ?? []) if (!firstAnswer.has(id)) firstAnswer.set(id, entry.id)
			const question = (re ?? [])
				.map((id) => byId.get(id))
				.find((item) => item?.data.from && !item.data.re && firstAnswer.get(item.id) === entry.id)
			if (question) sentMap.set(entry.id, question)
		}
		const cross = sentMap.get(entry.id) ?? (from && from !== threadId ? entry : undefined)
		if (cross?.data.from) otherIds.add(cross.data.from)
	}
	const otherTitles = new Map(
		await Promise.all(
			[...otherIds].map(
				async (other) =>
					/** @type {[number, string | undefined]} */ ([
						other,
						homes[other] ?? (await thread(other))?.title,
					]),
			),
		),
	)
	let previous, written, last, answering, prevTime
	const shaped = []
	for (const entry of all) {
		const data = entry.data
		const curTime = data.createdAt ? Date.parse(data.createdAt) : undefined
		if (prevTime && curTime && curTime - prevTime > 3_600_000)
			last = !isGroup ? undefined : (answering = undefined)
		if (curTime) prevTime = curTime
		const replied =
			data.answer && !data.from && data.re?.length ? byId.get(Math.max(...data.re)) : undefined
		const to =
			isGroup &&
			replied &&
			byPerson(replied) &&
			previous &&
			byPerson(previous) &&
			replied.data.author !== data.author &&
			replied !== previous &&
			replied !== written
				? replied.data.author
				: undefined
		const sent = sentMap.get(entry.id)
		const cross = sent ?? (data.from && data.from !== threadId ? entry : undefined)
		const voice = sent
			? 'sent'
			: cross
				? 'received'
				: data.scheduledTask
					? 'run'
					: data.stopped
						? 'stopped'
						: data.author === viewer
							? 'mine'
							: 'said'
		const speaker = data.author
		const agentRow = !byPerson(entry)
		const prior = !isGroup && agentRow ? (answering ?? speaker) : last
		const showName = voice === 'said' && Boolean(speaker && (speaker !== prior || to))
		if (['sent', 'received', 'run'].includes(voice)) last = undefined
		else {
			if (speaker !== viewer) last = speaker
			if (speaker && agentRow) answering = speaker
		}
		previous = entry
		if (!data.answer && !data.error) written = entry
		if (entry === seed) continue
		const far = cross && {
			otherAuthor: cross.data.author,
			otherThread: cross.data.from,
			otherLabel:
				botSet.has(cross.data.author) || !otherTitles.get(cross.data.from)
					? shortLabel(cross.data.author) || `thread ${cross.data.from}`
					: otherTitles.get(cross.data.from),
		}
		shaped.push({
			...entry,
			speaker,
			showName,
			voice,
			...(to && { to }),
			...far,
			clamp: byPerson(entry) || data.author === viewer,
			failed: Boolean(data.error),
			...(data.picked && { picked: data.picked, pickedNobody: !data.to?.length }),
		})
	}
	return shaped
}

/** A window of non-withdrawn messages from `handle`, plus `earlier` and the 1-entry `seed` before it when `last` is given */
async function windowOf(handle, { after = undefined, before = undefined, last = undefined } = {}) {
	const limit = last !== undefined ? last + 1 : Infinity
	const found = (await newest(handle, { after, before, last: limit })).filter(
		(entry) => !entry.data.withdrawn,
	)
	if (last === undefined) return { entries: found, earlier: undefined, seed: undefined }
	const earlier = found.length > last
	return {
		entries: earlier ? found.slice(-last) : found,
		earlier,
		seed: earlier ? found[0] : undefined,
	}
}

/** A thread's row and people, with `raw` messages shaped for `reader`; `seed` is the message before them */
async function threadPage(id, reader, raw, seed) {
	const [row, who, entries] = await Promise.all([
		threadRow(id, reader, await work()),
		people(id),
		shapeMessages(id, raw, reader, { seed }),
	])
	return { ...row, people: who, entries }
}
/** A thread's page with all its messages, those after `after`, before `before`, or the newest `last` */
async function threadView(id, reader, { after, before, last } = {}) {
	const handle = await conversation(id)
	const {
		entries: raw,
		earlier,
		seed,
	} = after === undefined && before === undefined && last === undefined
		? { entries: (await messages(id)).filter((entry) => !entry.data.withdrawn) }
		: await windowOf(handle, { after, before, last })
	return { ...(await threadPage(id, reader, raw, seed)), ...(earlier !== undefined && { earlier }) }
}
/** A thread's newest messages, read back from its end: those after `after`, before `before`, or the newest `last`, with their picks */
async function newest(handle, { after = -1, before = undefined, last = Infinity }) {
	const routes = new Map()
	// Picks or withdrawals appended after `before` can target messages before `before`
	if (before !== undefined) {
		for (let cursor; ;) {
			const page = await handle.entries(
				{ order: 'ascending', minEntryId: before },
				200,
				cursor,
				context,
			)
			for (const entry of page.items)
				if (entry.kind === ROUTE || entry.kind === WITHDRAWAL) routed([entry], routes)
			if (!(cursor = page.next)) break
		}
	}
	const read = []
	let count = 0
	const query = {
		order: /** @type {const} */ ('descending'),
		...(before !== undefined && { maxEntryId: /** @type {any} */ (before - 1) }),
	}
	for (let cursor; count < last;) {
		const page = await handle.entries(query, 200, cursor, context)
		const ended = page.items.findIndex((entry) => entry.id <= after)
		for (const entry of ended < 0 ? page.items : page.items.slice(0, ended)) {
			if (entry.kind === KIND && ++count > last) break
			read.push(entry)
		}
		if (ended >= 0 || !(cursor = page.next)) break
	}
	return routed(read.reverse(), routes)
}

/** An agent's thread owns its conversation, through its Anchor */
async function home(conversationId) {
	const threadId = (await storage.conversation(conversationId, context))?.owner?.conversationId
	const row = threadId && (await thread(threadId))
	const key =
		row && Object.keys(row.agents).find((key) => row.agents[key].conversation === conversationId)
	if (!key) return null
	const name = key === AGENT ? writtenTo(await agentOf(conversationId, key)) : key
	return { thread: threadId, key, name }
}

// ── Commands: post, create, fork, title, tools, compact ───────────────────

/** A known request returns before anything tries to resolve its recipients. */
async function receipt(requestId, command) {
	if (requestId === undefined) return undefined
	return usedFor(
		(await harness.snapshot(Receipts, requestId, context))?.receipt,
		requestId,
		command,
	)
}
const usedFor = (saved, requestId, command) => {
	if (saved && saved.command !== command)
		throw new Error(`requestId ${requestId} was used for ${saved.command}`)
	return saved
}

/** Does `work` once per request id, or every time without one; a retry gets the first result */
const once = (requestId, command, work) =>
	commit(async (tx) => {
		if (requestId === undefined) return work(tx)
		if (typeof requestId !== 'string' || !requestId || requestId.length > 128)
			throw new Error('requestId must be a string of 1 to 128 characters')
		const doc = await tx.doc(Receipts, requestId, null)
		if (usedFor(doc.receipt, requestId, command))
			return JSON.parse(JSON.stringify(doc.receipt.result))
		const result = await work(tx)
		doc.receipt = { command, result }
		return result
	})

/**
 * The director first, then an explicit recipient. Only solo chats and commands reuse the last recipient. `direct`
 * means the director picks once the message is saved: post it with `{direct}`.
 */
async function recipients(
	id,
	message,
	{ explicit, fallback = () => lastAsked(id), director = true } = {},
) {
	const joining = director ? await invited(id, message.body) : []
	const and = (to) => [...to, ...joining.filter((bot) => !to.some((one) => one.name === bot.name))]
	const directed = director && (await direct?.(id, message, explicit === undefined))
	if (directed?.mention) return { ...directed, to: and(directed.to) }
	// Paused, only @mentions and named recipients get an answer
	if (director && !explicit && !joining.length && (await thread(id)).paused)
		return { to: [], picked: PAUSED }
	// Naming a bot that isn't here asks it, so the message isn't free for the director to pick for
	if (directed?.direct) return joining.length ? { to: joining } : { to: [], direct: true }
	if (directed) return { ...directed, to: and(directed.to) }
	if (explicit) return { to: and(await explicit()) }
	if (joining.length) return { to: and(await fallback()) }
	if (director) {
		const here = await agentsHere(id)
		if (here.length > 1) {
			const agent = here.find((agent) => !agent.name)
			return {
				to: agent ? [agent] : [],
				picked: `Pick failed: the director is unavailable. ${agent ? "The thread's agent answers." : 'No thread agent to answer; @mention a bot.'}`,
			}
		}
	}
	return { to: await fallback(), solo: director && !explicit }
}

/** The known bots a message @mentions that aren't in the thread yet: naming one invites it, as picking it from the
 * mention list does. Never in a bot's home, which is hers alone. */
async function invited(id, body) {
	if (((await homesOf?.()) ?? {})[id]) return []
	const { agents } = await thread(id)
	const names = mentioned(body, (await botNames?.()) ?? []).filter((name) => !agents[keyOf(name)])
	return Promise.all(names.map((name) => whom(id, name)))
}

/**
 * A caller's own key, namespaced by its scope so two scopes' keys never share a receipt: a message's `post {id}/{key}`
 * is reused by a retry or Matrix's event id; a hook's `hook {task}/{digest}` is its own; a thread's `create thread/{key}` by nothing else.
 */
function scopedKey(scope, key) {
	if (key === undefined) return undefined
	if (typeof key !== 'string' || !key || key.length > 100)
		throw new Error('key must be a string of 1 to 100 characters')
	return `${scope}/${key}`
}

/** No `to` asks the director in a group, or the last recipient in a solo chat or command. */
async function postEntry(id, author, input) {
	const requestId = scopedKey(`post ${id}`, input.key)
	const saved = await receipt(requestId, `post ${id}`)
	if (saved) return withPick(id, saved.result)
	await conversation(id)
	const { images, body, command } = written(input)
	const { to, picked, direct, solo } = await recipients(
		id,
		{ author, body },
		{
			director: !command,
			explicit: 'to' in input ? () => addresses(input.to, Boolean(command), id) : undefined,
		},
	)
	await mayAsk(to, author, command)
	const result = await once(requestId, `post ${id}`, async (tx) => {
		// The draft this message was written in goes with its send, so a reload or another device never brings it back
		const draft = requestId && (await tx.doc(Draft, draftOf(id, author), null))
		const result = command
			? (await tx.createTask(Shell, { author, command, to: to[0] }, { ...own, conversationId: id }),
				{ command, to: to[0] })
			: await post(
					tx,
					id,
					{
						author,
						body,
						...(input.key ? { key: input.key } : {}),
						...(images ? { images } : {}),
						...(to.length ? { to } : {}),
						...(picked ? { picked } : {}),
					},
					{ steer: input.steer === true, direct, unlessPaused: solo },
				)
		if (draft && draft.key === input.key) {
			Object.assign(draft, { key: '', text: '', images: [], pick: null })
			afterCommit(tx, () => tellDraft(id, author, { sent: input.key }))
		}
		return result
	})
	return withPick(id, result)
}

/** A message as it was sent: its images, its body, and the command a body starting `$ ` runs */
function written(input) {
	const images = imageList(input.images)
	const body = images ? (input.body ?? '').trim() : field(input.body, 'body')
	return { images, body, command: !images && body.match(/^\$\s+([\s\S]+)/)?.[1] }
}
/** Whether a message may ask whom it asks: a command one runner, which takes work from its author; a thread one agent */
async function mayAsk(to, author, command) {
	if (command && !to.length) throw new Error('Pick a runner to run the command on')
	if (command) reach(to, author, await known())
	if (!command && to.filter((to) => !to.name).length > 1)
		throw new Error('A thread has one agent: ask one model here, plus any bots')
}

/** A person's draft in a thread, or `new`, the one for a thread they haven't started yet */
const draftOf = (id, person) => `${id}/${person}`
const NEW = 'new'
/** Where a draft's key is spent: posting its message, or for the new-thread draft, creating the thread */
const spentUnder = (id, key) => scopedKey(id === NEW ? 'create thread' : `post ${id}`, key)
/** A draft as its pages take it: null once it holds nothing */
const shownDraft = ({ key, text, images, pick }) =>
	text || images.length || pick ? JSON.parse(JSON.stringify({ key, text, images, pick })) : null

/** The asker's draft in a thread, or with `new` the one for their next thread */
async function draftIn(id, person) {
	if (id !== NEW) await conversation(id)
	const draft = await harness.snapshot(Draft, draftOf(id, person), context)
	return { draft: draft ? shownDraft(draft) : null }
}

/**
 * Saves what a person is writing as they type: the fields given replace those kept, under the draft's `key`. A save
 * under a key whose message was already sent changes nothing and says `sent`, so a late save never brings it back.
 * Their other pages on the thread hear it; `page` names the one that saved, which ignores its own.
 */
async function saveDraft(id, person, input) {
	if (id !== NEW) await conversation(id)
	if (input.key === undefined)
		throw new Error('key is required: the key its message will be posted with')
	const sentKey = spentUnder(id, input.key)
	if ('text' in input && (typeof input.text !== 'string' || input.text.length > 100000))
		throw new Error('text is a string of at most 100,000 characters')
	const changes = {
		...('text' in input && { text: input.text }),
		...('images' in input && { images: imageList(input.images) ?? [] }),
		...('pick' in input && { pick: pickOf(input.pick) }),
	}
	const page = typeof input.page === 'string' ? input.page.slice(0, 100) : undefined
	return commit(async (tx) => {
		if ((await tx.doc(Receipts, sentKey, null)).receipt) return { draft: null, sent: true }
		const draft = await tx.doc(Draft, draftOf(id, person), null)
		Object.assign(draft, changes, { key: input.key })
		const shown = shownDraft(draft)
		afterCommit(tx, () => tellDraft(id, person, { draft: shown, page }))
		return { draft: shown }
	})
}
/** A pick as the composer keeps it, `{agent, bots}`: any small object, or null */
function pickOf(pick) {
	if (pick === null) return null
	if (typeof pick !== 'object' || Array.isArray(pick) || JSON.stringify(pick).length > 10000)
		throw new Error('pick is an object of at most 10 kB, or null')
	return pick
}
/** Each of the person's pages watching the thread hears their draft change; every page of theirs, their new-thread draft */
function tellDraft(id, person, message) {
	const sent = JSON.stringify({ thread: id, ...message })
	for (const socket of clients)
		if (socket.viewer === person && (id === NEW || socket.thread === id)) socket.send(sent)
}

/**
 * An agent in a thread moved in place to another runner, as asking it there would move it: its model and thinking,
 * its folder starting over there. What it waits to answer, and a turn held up by the runner it leaves, go with it.
 */
async function moveAgent(threadId, input) {
	const runner = field(input.runner, 'runner')
	const { agents } = await conversation(threadId).then(() => thread(threadId))
	const key = Object.keys(agents).find((key) => agents[key].conversation === input.conversation)
	if (!key)
		throw Object.assign(new Error(`No agent ${input.conversation} in thread ${threadId}`), {
			status: 404,
		})
	const { dir: _, ...was } = await agentOf(agents[key].conversation, key)
	const to = /** @type {To} */ (
		await address({ ...was, runner }, false, undefined, !was.thinkingLevel)
	)
	await commit(async (tx) => reconfigure(tx, (await tx.doc(Thread, threadId)).agents[key], to))
	touchThread(threadId)
	return { conversation: input.conversation, to }
}

/** A post's answer once the director's pick for its message is in, as one with `to` says whom it asks; a retry too */
async function withPick(id, result) {
	if (!result.pick) return result
	const { state } = await harness.waitForTask(result.pick, context)
	const route = /** @type {any} */ (
		await latestMessage(id, (one) => one.data.message === result.entry, ROUTE)
	)
	// A pick that ended without saving a route failed; an empty `to` alone would read as a chosen silence
	if (!route)
		return {
			...result,
			to: [],
			picked: `Pick failed: the director's pick ${state.outcome.status}${state.outcome.error ? ` (${state.outcome.error.message})` : ''}.`,
		}
	return {
		...result,
		to: route?.data.to ?? [],
		...(route?.data.picked && { picked: route.data.picked }),
	}
}

/**
 * Takes back a message its author wrote while no agent has read it yet: each agent that still has it unseen, or queued
 * in an input it hasn't picked up, loses it, and the thread keeps only that it was withdrawn. One commit, so an agent picks
 * it up or never sees it. A queued input is withdrawn as Pi's own Submission.abort does, settled and out of its inbox, and
 * whatever else it held is unseen again.
 */
async function withdraw(threadId, author, messageId) {
	await conversation(threadId)
	if (!Number.isSafeInteger(messageId)) throw new Error('entry is the id of your message')
	return commit(async (tx) => {
		const entry = await tx.entry(messageId)
		if (entry?.kind !== KIND || entry.conversationId !== threadId)
			throw new Error(`No message ${messageId} in this thread`)
		if (entry.data.author !== author || !fresh(entry))
			throw new Error('Only its author can take a message back')
		const row = await tx.doc(Thread, threadId)
		const taken = []
		for (const recipient of Object.values(row.agents)) {
			if (recipient.unseen.includes(messageId)) {
				taken.push({ recipient })
				continue
			}
			const inbox = await tx.doc(InboxDoc, recipient.conversation)
			const item = inbox.items.find(
				(item) => item.entry?.kind === DELIVERY && item.entry.data?.held?.includes(messageId),
			)
			if (!item) throw new Error('Already read: an agent has picked it up')
			taken.push({ recipient, inbox, item })
		}
		for (const { recipient, inbox, item } of taken) {
			const others = item ? item.entry.data.held.filter((id) => id !== messageId) : []
			if (item) {
				tx.settleSubmission(item.id, { status: 'unanswered', reason: WITHDRAWN })
				inbox.items.splice(inbox.items.indexOf(item), 1)
			}
			recipient.unseen = [...new Set([...recipient.unseen, ...others])]
				.filter((id) => id !== messageId)
				.sort((left, right) => left - right)
		}
		row.unpicked = (row.unpicked ?? []).filter((id) => id !== messageId)
		await tx.appendEntry(threadId, { kind: WITHDRAWAL, data: { message: messageId } })
		for (const hook of withdrawn) await hook(tx, threadId, messageId)
		return { withdrawn: messageId }
	})
}

/** Images as pi's ImageContent, which models take inline; the composer shrinks them to fit */
function imageList(images) {
	if (images === undefined || images === null) return null
	const fits = (image) =>
		image?.type === 'image' &&
		/^image\/[\w.+-]+$/.test(image.mimeType) &&
		typeof image.data === 'string' &&
		image.data.length <= IMAGE_BYTES &&
		/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)
	if (!Array.isArray(images) || images.length > 8 || !images.every(fits))
		throw new Error("images is a list of up to 8 of pi's ImageContent, base64, 4.5 MB each")
	return images.length
		? images.map(({ mimeType, data }) => ({ type: /** @type {const} */ ('image'), mimeType, data }))
		: null
}

async function startThread(tx, title, parent, tools = null) {
	const { id } = await tx.createConversation(ownerless)
	Object.assign(await tx.doc(Thread, id), { title, parent, createdAt: now(), tools })
	return id
}

/**
 * A thread, and with a `body` its first message, in one commit: never a thread without the message it was made for.
 * The message asks whom `to` names and the bots it @mentions; a body starting `$ ` runs that command. Made under the
 * key of its author's new-thread draft, the same commit empties that draft but for its pick, kept for the next one.
 */
async function createThread(
	{ title, parent = null, tools = null, key, ...first },
	person = undefined,
) {
	if (parent !== null) await conversation((parent = Number(parent)))
	title = field(title, 'title')
	tools = toolList(tools)
	const requestId = scopedKey('create thread', key)
	if ('body' in first || 'images' in first) {
		const saved = await receipt(requestId, 'create thread')
		if (saved) return saved.result
	}
	const message = ('body' in first || 'images' in first) && person && written(first)
	const to = message
		? [
				...(await addresses(first.to ?? null, Boolean(message.command), undefined)),
				...(message.command
					? []
					: await Promise.all(
							mentioned(message.body, (await botNames?.()) ?? []).map((name) =>
								whom(undefined, name),
							),
						)),
			].filter(
				(one, at, all) => !one.name || all.findIndex((other) => other.name === one.name) === at,
			)
		: []
	if (message) await mayAsk(to, person, message.command)
	return once(requestId, 'create thread', async (tx) => {
		const draft = message && key !== undefined && (await tx.doc(Draft, draftOf(NEW, person), null))
		const id = await startThread(tx, title, parent, tools)
		if (!message) return { id }
		const { images, body, command } = message
		const result = command
			? (await tx.createTask(
					Shell,
					{ author: person, command, to: to[0] },
					{ ...own, conversationId: id },
				),
				{ command, to: to[0] })
			: await post(
					tx,
					id,
					{
						author: person,
						body,
						...(key ? { key } : {}),
						...(images ? { images } : {}),
						...(to.length ? { to } : {}),
					},
					{ empty: true, steer: first.steer === true },
				)
		if (draft && draft.key === key) {
			Object.assign(draft, { key: '', text: '', images: [] })
			afterCommit(tx, () => tellDraft(NEW, person, { sent: key }))
		}
		return { id, ...result }
	})
}

/** The walkthrough's example thread, written by its three people as the server names them, since no page can */
async function exampleShed({ key }) {
	const { SHED } = await import('./apps/client/tutorial-shed.js')
	const { id } = await createThread({ title: 'The shed', key })
	for (const [index, [author, body]] of SHED.entries())
		await postEntry(id, personName(author), { body, to: null, key: `shed-${index}` })
	return { id }
}

/** A thread's tools, as `pi --tools` takes them */
function toolList(tools) {
	if (tools === null || tools === undefined) return null
	if (!Array.isArray(tools) || !tools.length || tools.some((tool) => typeof tool !== 'string'))
		throw new Error('tools is a list of tool names')
	const names = new Set(
		registry
			.snapshot()
			.tools()
			.map(({ tool }) => tool.name),
	)
	const changes = tools.filter((tool) => /^[+-]/.test(tool))
	if (changes.length && changes.length < tools.length)
		throw new Error('tool names cannot be mixed with +name or -name entries')
	const unknown = tools.map((tool) => tool.replace(/^[+-]/, '')).filter((tool) => !names.has(tool))
	if (unknown.length)
		throw new Error(`No tool ${unknown.join(', ')}; there are ${[...names].join(', ')}`)
	return tools
}
/** What Pi Durable takes for a thread's tools */
function toolsOf(tools) {
	if (!tools) return null
	const all = registry
		.snapshot()
		.tools()
		.map(({ tool }) => tool)
	const named = (list) => all.filter((tool) => list.includes(tool.name))
	return tools.every((tool) => /^[+-]/.test(tool))
		? { remove: named(tools.filter((tool) => tool.startsWith('-')).map((tool) => tool.slice(1))) }
		: named(tools)
}

/** The thread messages an agent had seen by its entry `cut`, a fork's parent's included */
async function seenBy(id, cut) {
	const handle = await harness.conversation(id, context)
	const entries = await collect((cursor) =>
		handle.entries({ maxEntryId: cut, order: 'ascending' }, 500, cursor, context),
	)
	return entries.filter((entry) => entry.kind === DELIVERY).flatMap((entry) => entry.data.held)
}

async function setTitle(id, { title, key }) {
	await conversation(id)
	title = field(title, 'title')
	const bot = ((await homesOf?.()) ?? {})[id]
	if (bot) throw new Error(`Thread ${id} is ${bot}'s home; it shows ${bot}'s name`)
	return once(scopedKey(`title ${id}`, key), `title ${id}`, (tx) => setTitleIn(tx, id, title))
}

/** The title's one write path; an automatic title must still match its default. */
async function setTitleIn(tx, id, title, expected) {
	const row = await tx.doc(Thread, id)
	if (expected === undefined || row.title === expected) row.title = title
	return { title: row.title }
}

async function setTools(id, { tools }) {
	await conversation(id)
	tools = toolList(tools)
	return commit(async (tx) => {
		const row = await tx.doc(Thread, id)
		row.tools = tools
		for (const { conversation } of Object.values(row.agents))
			await configure(tx, conversation, { tools: toolsOf(tools) })
		return { tools }
	})
}

/** Pauses a thread, or resumes it: only @mentions and named recipients get an answer while it's paused */
async function setPaused(id, { paused }) {
	if (typeof paused !== 'boolean') throw new Error('paused is true or false')
	await conversation(id)
	return commit(async (tx) => {
		;(await tx.doc(Thread, id)).paused = paused
		return { paused }
	})
}

/** Forks history, the agent and bots at `at`, but keeps the source's current thread-wide tools */
async function forkThread(id, { at, title }, person) {
	await conversation(id)
	const pick = (await harness.snapshot(Draft, draftOf(id, person), context))?.pick
	// Picks made after the fork point stay behind with it
	const shown = routed((await entries(id)).filter((entry) => entry.id <= Number(at)))
	const answers = {}
	const asked = new Set()
	for (const { data } of shown) {
		if (data.answer) answers[keyOf(data.author)] = data.answer
		for (const name of data.to ?? []) asked.add(keyOf(name))
	}
	const source = await thread(id)
	/** Asked but not answered by then: made anew, as the source's is now */
	const fresh = await Promise.all(
		[...asked]
			.filter((key) => !answers[key] && source.agents[key])
			.map(async (key) => [key, await agentOf(source.agents[key].conversation, key)]),
	)
	const agents = await Promise.all(
		Object.entries(answers).map(async ([key, answer]) => {
			const seen = new Set(await seenBy(answer.conversation, answer.entry))
			return {
				key,
				answer,
				unseen: shown
					.filter((entry) => !seen.has(entry.id) && !ownAnswer(entry, key))
					.map((entry) => entry.id),
			}
		}),
	)
	const forkTitle = title?.trim() || `${source.title} (fork)`
	const fork = await (
		await conversation(id)
	).fork(
		/** @type {import("@earendil-works/pi-durable").EntryId} */ (Number(at)),
		{
			...ownerless,
			init: async (tx, forkId) => {
				Object.assign(await tx.doc(Thread, forkId), {
					tools: source.tools,
					memory: source.memory ?? null,
				})
				const row = {}
				for (const { key, answer, unseen } of agents) {
					row[key] = await newAgent(tx, forkId, unseen, answer)
					await configure(tx, row[key].conversation, {
						tools: toolsOf(source.tools),
						instructions: instructions(key, forkId, source.tools),
					})
				}
				for (const [key, to] of fresh) {
					row[key] = await newAgent(
						tx,
						forkId,
						shown.filter((entry) => !ownAnswer(entry, key)).map((entry) => entry.id),
					)
					await setUp(tx, row[key].conversation, forkId, to)
				}
				Object.assign(await tx.doc(Thread, forkId), {
					title: forkTitle,
					createdAt: now(),
					agents: row,
				})
				// What the forker had picked to ask next, they still have
				if (pick)
					(await tx.doc(Draft, draftOf(forkId, person), null)).pick = JSON.parse(
						JSON.stringify(pick),
					)
			},
		},
		context,
	)
	return { id: fork.id }
}

/**
 * Pi's own compaction, started early: each model's background compaction begins once its context passes `tokens`,
 * between model calls and never between a call and its result, keeping about the last 25k word for word.
 */
function compactingAt(tokens) {
	// Pi's default room for the answer, set here too so the start lands at `tokens` whatever Pi's default becomes
	const reserveTokens = 16384
	const modelOverrides = {}
	for (const model of models.getModels())
		if (model.provider.startsWith('runner:') && model.contextWindow > tokens + reserveTokens)
			modelOverrides[`${model.provider}/${model.id}`] = {
				reserveTokens,
				keepRecentTokens: 25000,
				backgroundTokens: model.contextWindow - reserveTokens - tokens,
			}
	return { modelOverrides }
}

async function compact(id) {
	const { agents } = await thread(id)
	return Promise.all(
		Object.values(agents).map(async ({ conversation: agent }) => {
			const taskId = await (await harness.conversation(agent, context)).compact(undefined, context)
			const { outcome } = (await harness.waitForTask(taskId, context)).state
			return outcome.status
		}),
	)
}

// ── Feed: one versioned stream per socket ────────────────────────────────

/**
 * One versioned feed per socket: each subscribed view holds its last sent rows and `seq` (Pi Durable's commit seq,
 * bumped on non-commit `touch`es too). Commits and touches recompute only affected views and send minimal `put`/`del`
 * envelopes; reconnecting with `after` gets a delta while the view stays cached, else `reset: true`.
 */
function createFeed() {
	const boot = randomBytes(8).toString('hex')
	let seq = 0
	/** @type {Map<string, any>} */
	const specs = new Map()
	/** @type {Map<string, any>} */
	const states = new Map()
	/** @type {Map<string, Set<Function>>} */
	const listeners = new Map()
	const IDLE_MS = 60_000
	const MAX_DELETED = 500
	const MAX_IDLE = 64

	const parse = (view) => {
		const [base, search] = view.split('?', 2)
		const query = new URLSearchParams(search ?? '')
		if (specs.has(base)) return { spec: specs.get(base), param: undefined, query }
		const slash = base.indexOf('/')
		const spec = slash >= 0 && specs.get(base.slice(0, slash + 1))
		return spec ? { spec, param: base.slice(slash + 1), query } : null
	}

	const sendFrame = (socket, view, payload, at) => {
		if (socket.readyState !== 1) return
		socket.send(payload)
		socket.sentSeq.set(view, at)
	}

	const scheduleFlush = (state) => {
		if (!state.subs.size || !state.dirty || state.scheduled || state.flushing) return
		state.scheduled = true
		queueMicrotask(() => {
			state.scheduled = false
			if (state.subs.size && state.dirty) void flushState(state)
		})
	}

	const markDirty = (state, keys) => {
		if (keys === true || !state.spec.rows) state.dirty = true
		else if (state.dirty !== true) {
			state.dirty ||= new Set()
			for (const key of keys) state.dirty.add(key)
		}
		state.dirtySeq = seq
		scheduleFlush(state)
	}

	const applyDiff = (state, nextRows, partial, targetSeq) => {
		const put = []
		const del = []
		const keyOf = state.spec.keyOf ?? ((row) => row.id)
		const putRow = (key, row) => {
			const json = JSON.stringify(row)
			if (state.rows.get(key)?.json === json) return
			state.rows.set(key, { seq: targetSeq, json, row })
			state.deleted.delete(key)
			put.push({ key, seq: targetSeq, row })
		}
		const delRow = (key) => {
			if (!state.rows.delete(key)) return
			state.deleted.set(key, targetSeq)
			del.push(key)
		}
		if (partial) {
			for (const [key, row] of nextRows)
				if (row == null) delRow(key)
				else putRow(key, row)
		} else {
			const seen = new Set()
			for (const row of nextRows) {
				const key = keyOf(row)
				seen.add(key)
				putRow(key, row)
			}
			for (const key of state.rows.keys()) if (!seen.has(key)) delRow(key)
		}
		if (state.deleted.size > MAX_DELETED) {
			let drop = state.deleted.size - MAX_DELETED
			for (const [key, delSeq] of state.deleted) {
				state.deleted.delete(key)
				if (delSeq > state.sinceSeq) state.sinceSeq = delSeq
				if (--drop <= 0) break
			}
		}
		if (targetSeq > state.seq) state.seq = targetSeq
		return { put, del }
	}

	const flushState = (state) => {
		if (state.flushing) return state.flushing
		state.flushing = (async () => {
			while (state.dirty) {
				const work = state.dirty
				const targetSeq = Math.max(state.dirtySeq ?? seq, seq)
				state.dirty = false
				const partial = work !== true && Boolean(state.spec.rows)
				const next = partial
					? await state.spec.rows([...work], state.viewer, state.param, state.query, state)
					: await state.spec.all(state.viewer, state.param, state.query, state)
				const diff = applyDiff(state, next, partial, targetSeq)
				if ((diff.put.length || diff.del.length) && state.subs.size) {
					const payload = JSON.stringify({ view: state.view, boot, seq: state.seq, ...diff })
					for (const socket of state.subs) sendFrame(socket, state.view, payload, state.seq)
				}
			}
		})()
			.catch((error) => console.error(`feed ${state.view}: ${error.message}`))
			.finally(() => {
				state.flushing = null
				scheduleFlush(state)
			})
		return state.flushing
	}

	const armEviction = (state) => {
		clearTimeout(state.evict)
		state.evict = setTimeout(() => {
			if (!state.subs.size) states.delete(state.cacheKey)
		}, IDLE_MS)
		state.evict.unref()
		let idle = 0
		for (const each of states.values()) if (!each.subs.size) idle++
		for (const [key, each] of states) {
			if (idle <= MAX_IDLE) break
			if (!each.subs.size && each !== state) {
				clearTimeout(each.evict)
				states.delete(key)
				idle--
			}
		}
	}

	const onSocket = (socket, run) =>
		(socket.feedQueue = (socket.feedQueue ?? Promise.resolve()).then(run).catch(() => {}))

	return {
		boot: () => boot,
		seq: () => seq,
		define: (name, spec) => specs.set(name, spec),
		hasSubscribers: (view) =>
			[...states.values()].some(
				(state) => state.subs.size && (state.view === view || state.view.startsWith(`${view}?`)),
			),
		onUpdate: (view, fn) => {
			const set = listeners.get(view) ?? new Set()
			listeners.set(view, set.add(fn))
		},
		onCommit: (publication) => {
			seq = Math.max(seq + 1, publication.seq)
			for (const [view, set] of listeners)
				if (publication.changes.some((change) => Boolean(specs.get(view)?.match?.(change))))
					for (const fn of set) fn()
			for (const state of states.values()) {
				if (!state.ready) continue
				let dirty = /** @type {false | true | Set<any>} */ (false)
				for (const change of publication.changes) {
					const hit = state.spec.match?.(change, state.param, state)
					if (!hit) continue
					if (hit === true) {
						dirty = true
						break
					}
					if (dirty !== true) {
						dirty ||= new Set()
						for (const key of hit) dirty.add(key)
					}
				}
				if (dirty) markDirty(state, dirty)
			}
		},
		touch: (views, key) => {
			seq++
			const names = Array.isArray(views) ? views : [views]
			for (const view of names) for (const fn of listeners.get(view) ?? []) fn()
			for (const state of states.values()) {
				if (!state.ready) continue
				if (names.some((view) => state.view === view || state.view.startsWith(`${view}/`)))
					markDirty(state, key === undefined ? true : [key])
			}
		},
		subscribe: (socket, view, after, afterBoot) =>
			onSocket(socket, async () => {
				if (typeof view !== 'string' || socket.readyState !== 1) return
				const parsed = parse(view)
				if (!parsed) return
				const { spec, param, query } = parsed
				const viewer = spec.perViewer ? socket.viewer : ''
				const cacheKey = spec.perViewer ? `${view}\0${viewer}` : view
				let state = states.get(cacheKey)
				if (!state) {
					state = {
						view,
						cacheKey,
						spec,
						param,
						query,
						viewer,
						seq: 0,
						sinceSeq: 0,
						ready: false,
						rows: new Map(),
						deleted: new Map(),
						subs: new Set(),
						dirty: false,
						dirtySeq: 0,
						scheduled: false,
						flushing: null,
						evict: null,
					}
					states.set(cacheKey, state)
				}
				clearTimeout(state.evict)
				state.evict = null
				if (!state.ready) {
					state.flushing ??= (async () => {
						const at = seq
						applyDiff(state, await spec.all(viewer, param, query, state), false, at)
						state.sinceSeq = at
						state.ready = true
					})().finally(() => {
						state.flushing = null
						scheduleFlush(state)
					})
					await state.flushing
				}
				if (state.dirty || state.flushing) await flushState(state)
				if (socket.readyState !== 1) {
					if (!state.subs.size) armEviction(state)
					return
				}
				const delta =
					afterBoot === boot &&
					typeof after === 'number' &&
					after >= state.sinceSeq &&
					after <= state.seq
				const frame = {
					view,
					boot,
					seq: state.seq,
					...(!delta && { reset: true }),
					put: [...state.rows.entries()]
						.filter(([, entry]) => !delta || entry.seq > after)
						.map(([key, entry]) => ({ key, seq: entry.seq, row: entry.row })),
					del: delta
						? [...state.deleted.entries()].filter(([, at]) => at > after).map(([key]) => key)
						: [],
				}
				sendFrame(socket, view, JSON.stringify(frame), state.seq)
				state.subs.add(socket)
				socket.subs.set(view, state)
			}),
		unsubscribe: (socket, view) =>
			onSocket(socket, () => {
				const state = socket.subs?.get(view)
				if (!state) return
				state.subs.delete(socket)
				socket.subs.delete(view)
				if (!state.subs.size) armEviction(state)
			}),
		sync: (socket, view, targetSeq) =>
			onSocket(socket, async () => {
				const state = socket.subs?.get(view)
				if (!state || socket.readyState !== 1) return
				if ((socket.sentSeq.get(view) ?? -1) >= targetSeq) return
				if (state.dirty || state.flushing) await flushState(state)
				if (socket.readyState !== 1 || (socket.sentSeq.get(view) ?? -1) >= targetSeq) return
				const at = Math.max(state.seq, seq)
				sendFrame(socket, view, JSON.stringify({ view, boot, seq: at, put: [], del: [] }), at)
			}),
		disconnect: (socket) => {
			for (const state of socket.subs?.values() ?? []) {
				state.subs.delete(socket)
				if (!state.subs.size) armEviction(state)
			}
			socket.subs?.clear()
		},
	}
}

const feed = createFeed()

/** Each thread's place, kept from its doc as it changes: archived or not, and its parent */
const placed = new Map()
/** Each thread's work tasks heard start and not yet end */
const workIn = new Map()
/** Each agent's thread, by the agent's conversation */
const agentThreads = new Map()
/** Cached open families map: invalidated only when a thread is created, archived, unarchived or reparented */
let familiesCache = null
/** Family ids affected by topology changes in the commit currently being published */
let movedFamilies = null
function families() {
	if (familiesCache) return familiesCache
	const sorted = [...placed.keys()].filter((id) => !placed.get(id).hidden).sort((a, b) => b - a)
	const open = new Set(sorted)
	const children = new Map()
	for (const id of sorted) {
		const parent = placed.get(id).parent
		if (parent && open.has(parent)) children.set(parent, [...(children.get(parent) ?? []), id])
	}
	const built = new Map()
	const byRoot = new Map()
	for (const id of sorted) {
		let root = id
		for (let hops = 0; open.has(placed.get(root)?.parent) && hops < 20; hops++)
			root = placed.get(root).parent
		if (!byRoot.has(root)) {
			const family = [{ id: root, depth: 0 }]
			const seen = new Set([root])
			for (let index = 0; index < family.length; index++)
				for (const child of children.get(family[index].id) ?? [])
					if (!seen.has(child)) {
						seen.add(child)
						family.push({ id: child, depth: family[index].depth + 1 })
					}
			byRoot.set(root, family)
		}
		built.set(id, byRoot.get(root))
	}
	return (familiesCache = built)
}
const familyOf = (id) => families().get(id) ?? [{ id, depth: 0 }]
/** Only a family's root carries the full `family` array; descendants carry `root` so wire size stays O(N) instead of O(N²) */
const familyField = (id) => {
	const list = familyOf(id)
	const root = list[0]?.id ?? id
	return root === id ? { family: list } : { root }
}
const place = (id, value, record = records.get(id)) => {
	const before = placed.get(id)
	const parent = value.parent ?? record?.parent?.conversationId ?? before?.parent ?? null
	const now = { hidden: Boolean(value.hidden), parent }
	const moved = !before || before.hidden !== now.hidden || before.parent !== now.parent
	const roots = () => [familyOf(id)[0]?.id, parent && familyOf(parent)[0]?.id].filter(Boolean)
	const prevRoots = moved && movedFamilies ? roots() : []
	placed.set(id, now)
	if (moved) {
		familiesCache = null
		if (movedFamilies) {
			for (const tid of [id, ...prevRoots, ...roots()]) movedFamilies.add(tid)
			if (before?.hidden !== now.hidden)
				for (const [tid, meta] of placed) if (meta.parent === id) movedFamilies.add(tid)
		}
	}
	for (const { conversation } of Object.values(value.agents ?? {}))
		agentThreads.set(conversation, id)
	return { before, now }
}
const touchThread = (threadId) => {
	const meta = placed.get(threadId)
	const views = [
		...(!meta || !meta.hidden ? ['threads'] : []),
		...(!meta || meta.hidden ? ['archived'] : []),
	]
	if (views.length) feed.touch(views, threadId)
	feed.touch(`thread/${threadId}`)
}

// ── Modules ───────────────────────────────────────────────────────────────

const core = {
	/** A thread's doc inside a commit, where a snapshot would wait for the commit itself */
	threadIn: (tx, id) => tx.doc(Thread, id),
	busy,
	work,
	isWork,
	familyOf: (id) => familyOf(id),
	statusOf: async (id, jobs, reader) => status(id, await thread(id), jobs, reader),
	agentDocKind: AgentDoc.definition.kind,
	feed,
	scopedKey,
	/** The offline runners a thread's work waits for */
	waitingFor: async (threadId) => [
		...new Set(
			(await work())
				.filter((job) => job.thread === threadId && job.status === 'blocked' && job.runner)
				.map((job) => job.runner),
		),
	],
	person,
	models,
	runners,
	known,
	folder,
	reach,
	address,
	whom,
	agentOf,
	agentsHere,
	conversation,
	thread,
	home,
	threadList,
	entries,
	messages,
	shapeMessages,
	latestMessage,
	/** A document's value as stored, read without a commit */
	snapshot: (doc, id) => harness.snapshot(doc, id, context),
	/** What a module's own model call spent, for the usage module to record; without it, nothing */
	spent: async (thread, purpose, reply) => {
		for (const hook of spentHooks)
			await hook(thread, purpose, reply).catch((error) => console.error(error))
	},
	/** With inbox on, a thread's open `ask_person` message, else undefined; inside a commit, before its writes, with its `tx` */
	openQuestion: (id, row, tx) => openQuestion?.(id, row, tx),
	lastAsked,
	recipients,
	instructionsOf: (name) => instructionsOf?.(name),
	botAgent: (name) => botAgent?.(name),
	botNames: () => botNames?.() ?? [],
	/** Each bot's home: `{[thread]: name}` */
	homes: async () => (await homesOf?.()) ?? {},
	startThread,
	newAgent,
	setUp,
	setTitleIn,
	threadIds,
	conversations,
	renameIn,
	/** `within` is a caller's own context, such as a hook's, so its cancellation ends the wait */
	waitForTask: (id, within = context) => harness.waitForTask(id, within),
	post,
	route,
	authors,
	concerns,
	afterCommit,
	abortTask: (id) => harness.abortTask(id, context),
	/** One task's latest record, or every task matching `query` (Pi's TaskQuery) */
	task: (id) => storage.task(id, context),
	tasks: (query) => collect((cursor) => storage.scanTasks(query, 200, cursor, context)),
	/** Delivers a signal to a sleeping task: Pi's `delivered`, `duplicate`, `closed` or `not_found` */
	signal: (taskId, kind, key, value) => harness.signal(taskId, kind, key, value, context),
	/**
	 * Tells each page watching a thread what a module is doing there, as it happens; nothing is kept. An event is
	 * `{purpose, kind, …}`: `kind: 'call'` is a model call (`model`, `ms`, `tokens`, `outcome`), others are the module's own.
	 */
	activity: (threadId, event) => {
		const sent = JSON.stringify({ thread: threadId, activity: { at: Date.now(), ...event } })
		for (const socket of clients) if (socket.thread === threadId) socket.send(sent)
	},
	seenBy,
	commit,
	once,
	receipt,
}
const defaults = await builtIn()
/** ade.json, as it started; the page changes it, and a restart takes it up */
const settings = await readConfig()
core.config = settings.config
/** The owner's name, as their messages are signed: `owner` in ade.json, else their login on this machine. Set it to
 * the name their history has, and it stays theirs. */
const owner = ownerName(settings.config.owner ?? os.userInfo().username)
core.owner = owner
/** Tailnet logins that are the owner through Serve, `ownerLogins` in ade.json: the owner's own devices */
const ownerLogins = loginList(settings.config.ownerLogins ?? [])
const modules = await load('server', core, settings)
// The prompt keeps its sections in this order, and a cached prompt survives up to its first change, so the sections
// that change most go last: a module's `volatility`, 0 unless it says otherwise
for (const module of modules.toSorted((a, b) => (a.volatility ?? 0) - (b.volatility ?? 0)))
	if (module.extension) registry.install(module.extension)
const customModules = (settings.config.modules ?? [])
	.map((entry) => entry.replace(/^[+-]/, ''))
	.filter((entry) => entry.includes('/'))
const aboutModules = Object.fromEntries(
	await Promise.all(
		[...Object.keys(defaults), ...customModules].map(async (entry) => [
			entry.includes('/') ? path.basename(entry, '.js') : entry,
			await about(entry),
		]),
	),
)
/** One module answers each of these; two claiming one is a mistake, not an order */
const hook = (name) => {
	const [first, second] = modules.filter((module) => module[name])
	if (second)
		throw new Error(`${name}: ${first.name} and ${second.name} both answer it; turn one off`)
	return first?.[name]
}
const posted = modules.flatMap((module) => module.posted ?? [])
const withdrawn = modules.flatMap((module) => module.withdrawn ?? [])
/** Task kinds of modules' own work in a thread, counted as the thread working */
const moduleWork = modules.flatMap((module) => module.work ?? [])
const archiving = modules.flatMap((module) => module.archiving ?? [])
const direct = hook('direct')
const directing = hook('directing')
const supersede = hook('supersede')
const sent = hook('sent')
const typing = hook('typing')
const turns = hook('turns')
const reply = hook('reply')
const catchUp = hook('catchUp')
const botAgent = hook('botAgent')
const instructionsOf = hook('instructionsOf')
const botNames = hook('botNames')
const homesOf = hook('homesOf')
const expand = hook('expand')
const openQuestion = hook('openQuestion')
const spentHooks = modules.flatMap((module) => module.spent ?? [])
compactAt = hook('compactAt')
/** An outside service's POST to /hooks/:id, on a listener of its own; none without a module that takes it */
const webhook = hook('webhook')
harnessed = undefined
const remembers = hook('remembers')
for (const conv of await conversations()) {
	if (!conv.owner) {
		records.set(conv.id, conv)
		place(conv.id, await thread(conv.id), conv)
	}
}
for (const [name, runner] of Object.entries(await known())) provide(name, runner.models)
harness.resume()
for (const module of modules) await module.start?.()

// ── HTTP: input, routes, static files, runner script ──────────────────────

/** Pi's own cap on an image, in base64 */
const IMAGE_BYTES = 4.5 * 1024 * 1024
async function input(req) {
	let body = ''
	for await (const chunk of req) {
		body += chunk
		if (body.length > 8 * IMAGE_BYTES + 200000) throw new Error('Request too large')
	}
	return JSON.parse(body || '{}')
}

async function archiveThread(id, archived, requestKey) {
	await conversation(id)
	return once(scopedKey(`archive ${id}`, requestKey), `archive ${id}`, async (tx) => {
		if (archived) for (const hook of archiving) await hook(tx, id)
		;(await tx.doc(Thread, id)).hidden = Boolean(archived)
		return { id, archived: Boolean(archived) }
	})
}

async function markRead(id, reader) {
	const newest = (await (await conversation(id)).entries({}, 1, undefined, context)).items[0]?.id
	if (newest && (await thread(id)).reads[reader] !== newest)
		await commit(async (tx) => {
			;(await tx.doc(Thread, id)).reads[reader] = newest
		})
	return { read: newest ?? null }
}

/** Pi's view of a conversation, with every entry instead of its window of the newest */
async function conversationView(id) {
	const watch = await (await harness.conversation(id, context))?.watch(context, { min: 1 })
	if (!watch) throw Object.assign(new Error('Conversation not found'), { status: 404 })
	await watch.stop()
	const { before: _before, ...view } = watch.value
	return { ...view, entries: await entries(id) }
}

async function serverInfo(viewer) {
	return {
		port,
		file,
		/** What a reload of the page would get; a page loaded with another is behind */
		client,
		/** The commit the server's checkout is on, when it runs from one; null for an install */
		commit: (await git('rev-parse', 'HEAD')) || null,
		/** Who the server takes the asker to be, for showing; it proves nothing */
		me: viewer,
		modules: modules.map((module) => module.name),
		off: Object.keys(defaults).filter((name) => !modules.some((module) => module.name === name)),
		about: aboutModules,
		threads: (await threadIds()).length,
		runners: Object.keys(await keys()).length,
		work: await harness.inspect(context),
		settings: {
			owner,
			ownerLogins,
			memory: {
				model: settings.config.memory?.model ?? '',
				compactAt: compactAt ?? null,
			},
			...Object.fromEntries(
				modules.filter((module) => module.settings).map((module) => [module.name, module.settings]),
			),
			/** Set in the environment, these win over ade.json */
			overrides: ['MODULES', 'MEMORY_MODEL', 'DIRECTOR_MODEL'].filter((name) => process.env[name]),
			restarts: typeof process.execve === 'function',
		},
	}
}

/** @type {[RegExp, Function][]} */
const routes = /** @type {[string, Function][]} */ ([
	...Object.entries({
		'GET /api/server': (req) => serverInfo(user(req)),
		'POST /api/settings': async (req) => {
			// Settings name the owner and their logins, so only the owner changes them
			if (user(req) !== owner)
				throw Object.assign(new Error('Only the owner changes settings'), { status: 403 })
			return saveSettings(await input(req))
		},
		'GET /api/runners': runnerList,
		'POST /api/runners': async (req) => {
			const body = await input(req)
			return mintKey(String(body.name ?? ''), origin(req), body.key)
		},
		'DELETE /api/runners/:name': (req, name, url) =>
			revoke(name, url.searchParams.get('key') ?? undefined),
		'GET /api/runners/:name/available': async (req, name) => {
			if (!runners.isOnline(name)) throw new Error(`${name} is offline`)
			return runners.call(name, { op: 'available' }, {})
		},
		'GET /api/changes': async (_req, _id, url) => {
			const since = url.searchParams.get('since') ?? ''
			if (!/^[\da-f]{7,40}$/.test(since)) return { commits: [] }
			const log = await git('log', '--format=%s', `${since}..HEAD`)
			return { commits: log ? log.split('\n') : [] }
		},
		'GET /runner/bundle': () => bundle,
		'GET /api/threads': (req) => threadList(user(req)),
		'GET /api/threads/archived': (req) => threadList(user(req), true),
		'POST /api/threads': async (req) => createThread(await input(req), user(req)),
		'GET /api/draft': (req) => draftIn(NEW, user(req)),
		'POST /api/draft': async (req) => saveDraft(NEW, user(req), await input(req)),
		'POST /api/threads/shed': async (req) => exampleShed(await input(req)),
		'GET /api/threads/:id': (req, id, url) => {
			const number = (name) =>
				url.searchParams.has(name) ? Number(url.searchParams.get(name)) : undefined
			return threadView(id, user(req), {
				after: number('after'),
				before: number('before'),
				last: number('last'),
			})
		},
		'POST /api/threads/:id/archive': async (req, id) => {
			const body = await input(req)
			return archiveThread(id, body.archived, body.key)
		},
		'POST /api/threads/:id/entries': async (req, id) => postEntry(id, user(req), await input(req)),
		'POST /api/threads/:id/withdraw': async (req, id) =>
			withdraw(id, user(req), (await input(req)).entry),
		'POST /api/threads/:id/fork': async (req, id) => forkThread(id, await input(req), user(req)),
		'GET /api/threads/:id/draft': (req, id) => draftIn(id, user(req)),
		'POST /api/threads/:id/draft': async (req, id) => saveDraft(id, user(req), await input(req)),
		'POST /api/threads/:id/title': async (req, id) => setTitle(id, await input(req)),
		'POST /api/threads/:id/tools': async (req, id) => setTools(id, await input(req)),
		'POST /api/threads/:id/pause': async (req, id) => setPaused(id, await input(req)),
		'POST /api/threads/:id/move': async (req, id) => moveAgent(id, await input(req)),
		'POST /api/threads/:id/typing': async (req, id) => {
			await conversation(id)
			const { typing: on, seq } = await input(req)
			await typing?.(id, user(req), on === true, Number.isSafeInteger(seq) ? seq : 0)
			return { typing: on === true }
		},
		'POST /api/threads/:id/read': (req, id) => markRead(id, user(req)),
		'POST /api/threads/:id/stop': async (req, id) => {
			const working = await busy(id)
			await (await conversation(id)).abort(context)
			// Everyone in the thread sees who ended its work; the agents read it with what comes next
			if (working)
				await commit((tx) => append(tx, id, { author: user(req), body: 'stopped', stopped: true }))
			return { stopped: id }
		},
		'POST /api/threads/:id/compact': async (req, id) => ({ compacted: await compact(id) }),
		'GET /api/conversations/:id': (req, id) => conversationView(id),
	}),
	...modules.flatMap((module) =>
		!module.serve
			? []
			: [
					...['GET', 'POST'].flatMap((method) => {
						const serve = async (req, id, url) =>
							module.serve(
								id,
								url.searchParams,
								method === 'POST' ? await input(req) : undefined,
								user(req),
							)
						return [
							[`${method} /api/${module.name}`, (req, _, url) => serve(req, undefined, url)],
							[`${method} /api/threads/:id/${module.name}`, serve],
						]
					}),
					...(module.remove
						? [
								[
									`DELETE /api/${module.name}/:name`,
									(req, name, url) => module.remove(name, url.searchParams.get('key') ?? undefined),
								],
							]
						: []),
				],
	),
]).map(([key, handle]) => [
	new RegExp(`^${key.replace(':id', String.raw`(\d+)`).replace(':name', '([^/]+)')}$`),
	handle,
])

/**
 * What a reload of the page would get, as a short hash: the client's files as they are now, and the server's own code as
 * it started. A page compares it with the one it loaded with, so it knows when it is behind; a change to the client's
 * files names `server` on every socket.
 */
const hashOf = async (dir, recursive, pattern = /\.\w+$/) => {
	const names = (await readdir(dir, { recursive })).filter((name) => pattern.test(name)).sort()
	const hash = createHash('sha256')
	for (const name of names)
		hash.update(name).update(await readFile(path.join(dir, name)).catch(() => ''))
	return hash.digest('hex')
}
const clientDir = path.join(import.meta.dirname, 'apps/client')
const serverCode = createHash('sha256')
	.update(await hashOf(import.meta.dirname, false, /\.js$/))
	.update(await hashOf(path.join(import.meta.dirname, 'modules'), true, /\.js$/))
	.digest('hex')
const clientVersion = async () =>
	createHash('sha256')
		.update(serverCode)
		.update(await hashOf(clientDir, true))
		.digest('hex')
		.slice(0, 12)
let client = await clientVersion()
let rehashing
/** Unref'd, so watching never keeps a stopping server alive */
watchFiles(clientDir, { recursive: true }, () => {
	clearTimeout(rehashing)
	rehashing = setTimeout(async () => {
		const now = await clientVersion()
		if (now === client) return
		client = now
		feed.touch('server')
	}, 150)
}).unref()

/** git in the server's own folder; '' when it isn't a checkout, git is missing or the command fails */
const git = (...args) =>
	new Promise((resolve) =>
		execFile('git', ['-C', import.meta.dirname, ...args], { timeout: 5000 }, (error, out) =>
			resolve(error ? '' : out.trim()),
		),
	)

/** The client: apps/client/client.html at /, and every module and stylesheet beside it */
const types = {
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.woff2': 'font/woff2',
	'.png': 'image/png',
	'.webmanifest': 'application/manifest+json',
}
async function clientFile(pathname) {
	if (!/^\/(?:[\w-]+\/)*[\w.-]+$/.test(pathname)) return null
	const type = types[path.extname(pathname)]
	if (!type) return null
	const body = await readFile(new URL(`./apps/client${pathname}`, import.meta.url)).catch(
		() => null,
	)
	return body ? { type, body } : null
}
/** Browser packages resolve through Node, so npm's hoisted installs work too. */
const browserPackages = new Map([
	['solid-js', new URL('./', import.meta.resolve('solid-js'))],
	['@solidjs/web', new URL('./', import.meta.resolve('@solidjs/web'))],
	['@solidjs/html', new URL('./', import.meta.resolve('@solidjs/html'))],
	['@solidjs/signals', new URL('./dist/', import.meta.resolve('@solidjs/signals/package.json'))],
	['pele', new URL('./', import.meta.resolve('pele'))],
	['marked', new URL('./', import.meta.resolve('marked'))],
])
async function servePackage(res, pathname, head = false) {
	for (const [name, root] of browserPackages) {
		const prefix = `/packages/${name}/`
		if (!pathname.startsWith(prefix)) continue
		const file = new URL(`./${pathname.slice(prefix.length)}`, root)
		const body =
			file.href.startsWith(root.href) &&
			/\.m?js$/.test(file.pathname) &&
			(await readFile(file).catch(() => null))
		if (!body) break
		res.writeHead(200, { 'Content-Type': types['.js'] })
		return res.end(head ? undefined : body)
	}
	return send(res, 404, { error: 'Not found' })
}

function send(res, status, value) {
	res.writeHead(status, { 'Content-Type': 'application/json' })
	res.end(JSON.stringify(value))
}

async function handleRequest(req, res, serve = false) {
	const url = new URL(req.url, 'http://localhost')
	if (!answersTo(req, serve))
		return send(res, 421, { error: `This server doesn't answer to ${req.headers.host}` })
	if (
		!['GET', 'HEAD'].includes(req.method) &&
		req.headers.origin &&
		req.headers.origin !== origin(req)
	)
		return send(res, 403, { error: 'Cross-origin writes are refused; use the server’s own page' })
	if (url.pathname.startsWith('/api/')) {
		const sender = whoSent(req, serve)
		if (!sender) return send(res, 401, { error: nobody(serve) })
		senders.set(req, sender)
	}
	/** A browser brought in with the owner's key keeps it as a cookie its scripts can't read */
	if (req.method === 'POST' && url.pathname === '/api/me') {
		const given = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
		if (!given || !isOwnerKey(given)) return send(res, 403, { error: 'That is not the owner key' })
		const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''
		res.setHeader(
			'Set-Cookie',
			`${ownerCookie()}=${given}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${secure}`,
		)
		return send(res, 201, { me: owner })
	}
	if (req.method === 'OPTIONS') {
		res.writeHead(204)
		return res.end()
	}
	const head = req.method === 'HEAD'
	const answer = (type, body) => {
		res.writeHead(200, { 'Content-Type': type })
		res.end(head ? undefined : body)
	}
	if (['GET', 'HEAD'].includes(req.method)) {
		if (url.pathname === '/')
			return answer(
				'text/html; charset=utf-8',
				await readFile(new URL('./apps/client/client.html', import.meta.url)),
			)
		if (url.pathname.startsWith('/packages/')) return servePackage(res, url.pathname, head)
		const file = await clientFile(url.pathname)
		if (file) return answer(file.type, file.body)
		if (url.pathname === '/runner/updater.js') return answer(types['.js'], updater)
		if (url.pathname === '/connect-runner')
			return answer('text/plain; charset=utf-8', runnerScript(origin(req)))
	}
	const key = `${req.method} ${url.pathname}`
	for (const [pattern, handle] of routes) {
		const match = pattern.exec(key)
		if (!match) continue
		try {
			const result = await handle(
				req,
				match[1] && (/^\d+$/.test(match[1]) ? Number(match[1]) : decodeURIComponent(match[1])),
				url,
			)
			send(
				res,
				req.method === 'POST' ? 201 : 200,
				req.method !== 'GET' && result && typeof result === 'object' && !Array.isArray(result)
					? { ...result, seq: feed.seq(), boot: feed.boot() }
					: result,
			)
		} catch (error) {
			send(res, error.status ?? 400, { error: error.message })
		}
		return
	}
	send(res, 404, { error: 'Not found' })
}

/** Finds bun or Node, then hands over to the updater, which keeps the runner up to date with this server */
const runnerScript = (server) => `#!/bin/sh
# Connects a machine without ade to the ade server at ${server}, with a key from \`ade key laptop\` there:
#   curl -fsSL ${server}/connect-runner | ADE_KEY=air_… sh -s -- --dir ~/code [--name laptop] [--read-only] [--no-update]
set -e
if command -v bun >/dev/null 2>&1; then run=bun; elif command -v node >/dev/null 2>&1; then run=node; else
  echo "ade's runner needs Node.js 24 or newer"; exit 1
fi
data="\${XDG_DATA_HOME:-$HOME/.local/share}/ade"
mkdir -p "$data"
if [ -n "$ADE_KEY" ]; then
  config="\${XDG_CONFIG_HOME:-$HOME/.config}/ade"
  name=$("$run" -e "process.stdout.write(require('node:os').hostname())")
  next_name=
  for arg do
    if [ -n "$next_name" ]; then name=$arg; next_name=; continue; fi
    case "$arg" in --name) next_name=1 ;; --name=*) name=\${arg#--name=} ;; esac
  done
  case "$name" in ''|*[!a-zA-Z0-9._-]*) echo 'Invalid runner name' >&2; exit 1 ;; esac
  mkdir -p "$config"
  keyfile="$config/key.$name"
  (umask 077 && printf %s "$ADE_KEY" > "$keyfile")
  set -- "$@" --name "$name" --key-file "$keyfile"
fi
curl -fsSL "${server}/runner/updater.js" -o "$data/runner-updater.js"
printf "Next time, without curl: %s '%s' '%s'" "$run" "$data/runner-updater.js" '${server}'
for arg do printf " '%s'" "$(printf %s "$arg" | sed "s/'/'\\\\''/g")"; done
printf '\\n'
exec "$run" "$data/runner-updater.js" "${server}" "$@"
`

// ── Feed views, and a page watching its thread's agents ───────────────────

async function runnerList() {
	const [all, last] = [await work(), await known()]
	return Object.keys(await keys()).map((name) => {
		const { models, offers, ...runner } = last[name] ?? {}
		const here = all.filter((job) => job.runner === name)
		/** Its agents' statuses, by row: a bot's name, or `provider/id@runner` whatever its thinking */
		const agents = {}
		for (const job of here)
			if (job.row) agents[job.row] = busiest([agents[job.row], job.status].filter(Boolean))
		return {
			name,
			...runner,
			...(lent?.name === name && { own: true }),
			offers: offers ?? [],
			models: Object.keys(models ?? {}),
			online: runners.isOnline(name),
			calls: runners.working(name),
			status: busiest(here.map((job) => job.status)),
			agents,
			busy: new Set(here.filter((job) => job.status === 'working').map((job) => job.thread)).size,
			outdated: Boolean(runner.version) && runner.version !== bundle.version,
		}
	})
}

feed.define('runners', {
	keyOf: (row) => row.name,
	all: runnerList,
	match: (change) => {
		if (change.type === 'task') return isWork(change.value.kind) && runsOnRunner(change.value.kind)
		if (change.type === 'document')
			return ['ade.runners', 'ade.keys', 'ade.lent', AgentDoc.definition.kind].includes(
				change.record.kind,
			)
		return false
	},
})

/** A launched runner whose version differs is asked to update once per connection, when it has no calls open, so nothing it's doing is cut off */
const outdated = new Set()
function nudge() {
	for (const connection of outdated) {
		if (connection.phase !== 'online') outdated.delete(connection)
		else if (!runners.working(connection.name).length) {
			outdated.delete(connection)
			runners.tell(connection.name, { op: 'update' })
		}
	}
}

/** Which threads a commit change touches: `true` for all, a list of thread ids, or `false` */
const threadMatch = (change) => {
	if (change.type === 'conversation')
		return !change.value.owner
			? movedFamilies?.size
				? [...movedFamilies]
				: [change.value.id]
			: agentThreads.has(change.value.id)
				? [agentThreads.get(change.value.id)]
				: false
	if (change.type === 'entry')
		return change.value.kind.startsWith('ade.') ? [change.value.conversationId] : false
	if (change.type === 'task')
		return isWork(change.value.kind) ? [change.value.conversationId] : false
	if (change.type === 'document') {
		const { kind } = change.record
		if (kind === 'ade.thread')
			return movedFamilies?.size
				? [...new Set([change.conversationId, ...movedFamilies])]
				: [change.conversationId]
		if (kind === AgentDoc.definition.kind) {
			const tid = change.conversationId && agentThreads.get(change.conversationId)
			return tid ? [tid] : true
		}
		if (kind === 'ade.bots' || kind === 'ade.runners') return true
	}
	return false
}
const defineThreadView = (name, archived) =>
	feed.define(name, {
		perViewer: true,
		keyOf: (row) => row.id,
		all: (viewer) => threadList(viewer, archived),
		rows: async (ids, viewer) => {
			const [busy, homes, runnersKnown] = await Promise.all([work(), homesOf?.() ?? {}, known()])
			return Promise.all(
				ids.map(async (id) => {
					const meta = placed.get(id)
					if (!meta || meta.hidden !== archived) return [id, null]
					return [id, await threadRow(id, viewer, busy, homes, undefined, runnersKnown)]
				}),
			)
		},
		match: threadMatch,
	})
defineThreadView('threads', false)
defineThreadView('archived', true)
feed.define('thread/', {
	perViewer: true,
	keyOf: (row) => row.key,
	all: async (viewer, param, _query, state) => {
		const id = Number(param)
		if (!placed.has(id)) return []
		const handle = await conversation(id)
		let shown
		if (state.minId === undefined) {
			const page = await windowOf(handle, { last: FIRST })
			shown = page.entries
			state.earlier = page.earlier
			state.seed = page.seed
			state.minId = shown[0]?.id ?? 0
		} else {
			shown = (await windowOf(handle, { after: state.minId - 1 })).entries
		}
		const { entries, ...meta } = await threadPage(id, viewer, shown, state.seed)
		return [
			{ key: 'thread', ...meta, earlier: state.earlier },
			...entries.map((entry) => ({ key: entry.id, ...entry })),
		]
	},
	match: (change, param) => {
		const hit = threadMatch(change)
		return hit === true || (Array.isArray(hit) && hit.includes(Number(param)))
	},
})

feed.define('server', {
	perViewer: true,
	keyOf: () => 'server',
	all: async (viewer) => [{ key: 'server', ...(await serverInfo(viewer)) }],
	match: (change) =>
		(change.type === 'conversation' && !change.value.owner) ||
		(change.type === 'document' && change.record.kind === 'ade.keys'),
})

const entryStored = modules.flatMap((module) => module.entryStored ?? [])
const documentStored = modules.flatMap((module) => module.documentStored ?? [])
const endedHooks = modules.flatMap((module) => module.ended ?? [])
harness.observeCommits({
	advance: (publication) => {
		const ended = new Set()
		movedFamilies = new Set()
		for (const change of publication.changes) {
			if (
				change.type === 'document' &&
				change.kind === 'change' &&
				change.record.kind === 'ade.thread'
			)
				place(change.conversationId, change.value)
			else if (change.type === 'task') {
				const { id, kind, conversationId, state } = change.value
				if (!isWork(kind)) continue
				const tasks = workIn.get(conversationId) ?? new Set()
				if (state.status !== 'terminal') workIn.set(conversationId, tasks.add(id))
				else if ((tasks.delete(id), !tasks.size)) {
					workIn.delete(conversationId)
					ended.add(conversationId)
				}
			}
			if (change.type === 'entry') for (const hook of entryStored) hook(change.value)
			else if (change.type === 'document' && change.kind === 'change')
				for (const hook of documentStored) hook(change)
		}
		feed.onCommit(publication)
		movedFamilies = null
		for (const wake of changes) wake()
		nudge()
		for (const threadId of ended)
			busy(threadId)
				.then(async (working) => {
					if (!working) for (const hook of endedHooks) await hook(threadId)
				})
				.catch((error) => console.error(error))
	},
	end: () => {},
})

/** Messages a thread opens on: few, so it shows at once, with only their agents' turns */
const FIRST = 15

/** A browser watches one thread's agents (turns, live work, cuts, drafts), or asks for earlier agent turns */
const queued = (socket, run) =>
	(socket.watches = (socket.watches ?? Promise.resolve()).then(run).catch(() => {}))
const watch = (socket, id) => {
	socket.thread = id
	return queued(socket, () => rewatch(socket, id))
}
const earlier = (socket, id, all, before) =>
	queued(socket, () => socket.pages?.id === id && socket.pages.back(all, before))
/** Where an agent's conversation reaches far enough back for the messages from `from` on: a turn before them */
const covers = (from) => (entries) =>
	entries.some(
		(entry) =>
			entry.kind === DELIVERY && entry.data?.held?.length && Math.max(...entry.data.held) < from,
	)
/**
 * Where an agent's newest compaction cuts the thread: the summary, and `first`, the first message of the first
 * delivery it still reads whole; `null` before any compaction. Found by its head, so its turns needn't be sent.
 */
async function cutOf(handle, agent) {
	const marker = await commit((tx) => tx.latestHeadMarker(agent))
	if (marker?.kind !== 'pi.compaction') return null
	const kept = await firstIn(
		(cursor) =>
			handle.entries({ minEntryId: marker.head, order: 'ascending' }, 20, cursor, context),
		(entry) => entry.kind === DELIVERY,
	)
	const held = /** @type {any} */ (kept?.data)?.held ?? []
	return held.length
		? { id: marker.id, model: marker.model?.map(visible), first: Math.min(...held) }
		: null
}
async function rewatch(socket, id) {
	const old = socket.watching
	socket.watching = socket.pages = undefined
	for (const watch of old ?? []) await watch.stop()
	const row =
		typeof id === 'number' &&
		(await harness.watchDoc(
			Thread,
			/** @type {import("@earendil-works/pi-durable").ConversationId} */ (id),
			context,
		))
	if (!row) return
	const watches = (socket.watching = [row])
	/** A watch that comes back after the socket moved on is stopped instead */
	const keep = (watch) =>
		socket.watching === watches ? (watches.push(watch), true) : (watch.stop(), false)
	const send = (message) => socket.send(JSON.stringify({ thread: id, ...message }))
	const handle = await harness.conversation(
		/** @type {import("@earendil-works/pi-durable").ConversationId} */ (id),
		context,
	)
	/** Each followed agent's way back through its conversation */
	const pagers = new Map()
	const initial = await windowOf(handle, { last: FIRST })
	const oldest = initial.earlier ? (initial.entries[0]?.id ?? 0) : 0
	socket.pages = {
		id,
		/** Loads earlier agent turns up to `before` (or all of them), then signals `done` */
		back: async (all, before) => {
			for (const [agent, back] of pagers) {
				const entries = await back(all ? () => false : covers(before ?? 0))
				if (entries.length) send({ agent, older: true, entries })
			}
			send({ older: true, done: true })
		},
	}
	/** By conversation, which stays as an agent switches model or runner */
	const follow = async (agents) => {
		for (const { conversation: agent } of Object.values(agents)) {
			if (followed.has(agent)) continue
			followed.add(agent)
			const handle = await harness.conversation(agent, context)
			const watch = await handle.watch(context, { min: 20 })
			if (!keep(watch)) return
			let delivery
			/** The delivery the agent answers now: its run's newest, a steer's once it steered */
			const live = async (value) => {
				const { run } = value.docs['pi.live'] ?? {}
				const newest = value.entries.findLast((entry) => entry.kind === DELIVERY)
				if (!run) delivery = undefined
				else if (newest && newest.id >= (run.first ?? 0)) delivery = newest
				else if (!delivery || delivery.id < (run.first ?? 0))
					delivery = await lastDelivery(handle, run.first)
				const named = delivery ? { delivery: { id: delivery.id, held: delivery.data.held } } : {}
				return { ...doing(value), ...named }
			}
			send({ agent, live: await live(watch.value) })
			// Its conversation as far back as the messages sent, then each entry as it's written, beside its live work
			const shown = ({ id, kind, model, data, head }) => ({
				id,
				kind,
				model: model?.map(visible),
				data,
				head,
			})
			const transcript = await told(
				handle,
				watch,
				async (entries, said) =>
					send({
						agent,
						entries: entries.filter((entry) => entry.kind !== 'pi.system').map(shown),
						// The cut comes with the first batch and again after each compaction
						...('earlier' in said || entries.some((entry) => entry.kind === 'pi.compaction')
							? { cut: await cutOf(handle, agent) }
							: {}),
					}),
				{
					then: async (value) => send({ agent, live: await live(value) }),
					enough: covers(oldest),
					pageSize: 50,
				},
			)
			pagers.set(agent, async (enough) =>
				(await transcript.back(enough)).entries
					.filter((entry) => entry.kind !== 'pi.system')
					.map(shown),
			)
		}
	}
	const followed = new Set()
	await follow(row.value.agents)
	row.start(async (call) => {
		if (call.kind === 'failed') throw call.error
		await follow(call.value.agents)
	})
}
/**
 * A model message as a page shows it: without the provider's diagnostics and the signatures that let it check its own
 * thinking, which are most of an answer's bytes and nothing a person reads
 */
const visible = (message) => {
	const { diagnostics: _, ...shown } = message
	if (!Array.isArray(shown.content)) return shown
	return {
		...shown,
		content: shown.content.map(({ thinkingSignature: _, textSignature: __, ...block }) => block),
	}
}
/**
 * A conversation's entries through Pi's transcript, which keeps them whole: the newest first, back as far as `enough`
 * says, then each new batch once; the first batch says whether more lie `earlier`. `then` hears every update after
 * its batch. `back(enough)` loads further back and answers the entries it added, oldest first.
 */
async function told(
	handle,
	watch,
	send,
	{ then, enough = (_) => /** @type {boolean} */ (true), pageSize = 200 } = {},
) {
	const transcript = new ConversationTranscript(
		(query, limit, ctx) => handle.entries(query, limit, undefined, ctx),
		{ pageSize },
	)
	let view,
		newest = 0,
		oldest = Infinity,
		first = true
	const entries = () => view.items.flatMap((item) => (item.kind === 'entry' ? [item.entry] : []))
	const more = () => view.items[0]?.kind === 'earlier'
	const load = async (enough) => {
		while (more() && !enough(entries())) view = await transcript.loadEarlier(context)
	}
	const tell = async (value) => {
		view = transcript.merge(value)
		for (let gap; (gap = view.items.find((item) => item.kind === 'gap'));)
			view = await transcript.fillGap(gap, context)
		if (first) await load(enough)
		const fresh = entries().filter((entry) => entry.id > newest)
		if (!fresh.length && !first) return
		if (first) oldest = entries()[0]?.id ?? Infinity
		const said = first ? { earlier: more() } : {}
		first = false
		newest = fresh.at(-1)?.id ?? newest
		await send(fresh, said)
	}
	await tell(watch.value)
	watch.start(async ({ value }) => (await tell(value), await then?.(value)))
	return {
		entries,
		earlier: more,
		back: async (enough) => {
			await load(enough)
			const added = entries().filter((entry) => entry.id < oldest)
			oldest = entries()[0]?.id ?? oldest
			return { entries: added, earlier: more() }
		},
	}
}
/** An agent's newest delivery entry from `first` on, for a run longer than its watch's window */
const lastDelivery = (handle, first) =>
	firstIn(
		(cursor) => handle.entries({ minEntryId: first, order: 'descending' }, 100, cursor, context),
		(entry) => entry.kind === DELIVERY,
	)

// ── Runner keys ───────────────────────────────────────────────────────────

/** A new key for a runner, replacing its old one, whose runner is cut off */
async function mintKey(name, server, requestKey) {
	if (!/^[\w.-]+$/.test(name))
		throw new Error('name the runner: letters, digits, dot, dash or underscore')
	if (process.env.HOST === '0.0.0.0' && loopback(new URL(server).hostname)) {
		const interfaces = os.networkInterfaces()
		const address = [...(interfaces.tailscale0 ?? []), ...Object.values(interfaces).flat()].find(
			(net) => net.family === 'IPv4' && !net.internal,
		)?.address
		if (address) server = server.replace(new URL(server).hostname, address)
	}
	const result = await once(
		scopedKey(`runner ${name}`, requestKey),
		`runner ${name}`,
		async (tx) => {
			const key = `air_${randomBytes(24).toString('base64url')}`
			;(await tx.doc(Keys))[name] = sha256(key)
			return {
				name,
				key,
				ade: `ADE_KEY=${key} ade runner --server ${server} --name ${name}`,
				connect: `curl -fsSL ${server}/connect-runner | ADE_KEY=${key} sh -s -- --name ${name} --dir .`,
			}
		},
	)
	runners.kick(name, 4001, `${name}'s key was replaced`)
	return result
}
async function revoke(name, requestKey) {
	const result = await once(
		scopedKey(`revoke ${name}`, requestKey),
		`revoke ${name}`,
		async (tx) => {
			const all = await tx.doc(Keys)
			if (!all[name]) throw Object.assign(new Error(`No runner named ${name}`), { status: 404 })
			delete all[name]
			return { revoked: name }
		},
	)
	runners.kick(name, 4001, `${name} was revoked`)
	return result
}

// ── Upgrade: sockets and runner connections ───────────────────────────────

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: true })
async function upgrade(req, raw, head, serve = false) {
	const url = new URL(req.url, 'http://localhost')
	/** A module's own socket, at /api/<module> or for a thread at /api/threads/:id/<module>: the module's `connect` takes it */
	const [, threadId, named] = url.pathname.match(/^\/api\/(?:threads\/(\d+)\/)?([\w-]+)$/) ?? []
	const taker = modules.find((module) => module.name === named && module.connect)
	if (url.pathname !== '/ws' && !taker) return raw.destroy()
	const refuse = (status) => raw.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
	if (!answersTo(req, serve) || (req.headers.origin && req.headers.origin !== origin(req)))
		return refuse('403 Forbidden')
	const name = !taker && url.searchParams.get('runner')
	/** A person's socket is theirs from how it arrived, as a request is; a runner shows its own key below */
	const sender = !name && whoSent(req, serve)
	if (!name && !sender) return refuse('401 Unauthorized')
	const socket = await new Promise((resolve) => wss.handleUpgrade(req, raw, head, resolve))
	if (taker)
		return taker.connect(threadId && Number(threadId), socket, url, sender).catch((error) => {
			console.error(`${named} socket: ${error.message}`)
			socket.close(4004, error.message.slice(0, 120))
		})
	/** A runner's connection: once closed, by its socket or by a newer one for its name, it stops wherever it is */
	const connection =
		name &&
		runners.connection(name, (code, reason) =>
			code ? socket.close(code, reason) : socket.terminate(),
		)
	const close = () => {
		clients.delete(socket)
		feed.disconnect(socket)
		watch(socket, null)
		if (connection && runners.disconnect(connection)) {
			say('runner', `${name} offline`)
			feed.touch(['runners', 'bots', 'threads', 'archived', 'thread'])
		}
	}
	socket.on('close', close)
	socket.on('error', close)
	/** A frame that doesn't parse is dropped, so one bad client never stops the server */
	const listen = (handle) =>
		socket.on('message', (data) => {
			try {
				handle(data.toString())
			} catch (error) {
				console.error(`dropped a frame from ${name ?? 'a browser'}: ${error.message}`)
			}
		})
	if (!name) {
		socket.viewer = sender
		socket.subs = new Map()
		socket.sentSeq = new Map()
		listen((text) => {
			const message = JSON.parse(text)
			if ('sub' in message) feed.subscribe(socket, message.sub, message.after, message.boot)
			else if ('unsub' in message) feed.unsubscribe(socket, message.unsub)
			else if ('sync' in message) feed.sync(socket, message.sync, message.seq)
			else if ('earlier' in message) earlier(socket, message.earlier, message.all, message.before)
			else if ('watch' in message) watch(socket, message.watch)
		})
		return clients.add(socket)
	}
	/** A runner shows its key before it counts, so nobody can take its name */
	const given = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
	const held = (await keys())[name]
	if (connection.phase === 'closed') return
	if (!given || held !== sha256(given)) {
		say('runner', `${name} turned away: ${given ? 'wrong or revoked key' : 'no key'}`)
		return socket.close(
			4001,
			given
				? `${name}'s key is wrong or was revoked. On the server's machine run\n  ade key ${name}\nthen run the line it prints here.`
				: `${name} needs a key. On the server's machine run\n  ade key ${name}\nthen run the line it prints here.`,
		)
	}
	runners.register(connection)
	const query = (param) => url.searchParams.get(param) || ''
	const resolved = (await known())[name]?.models ?? {}
	if (connection.phase === 'closed') return
	const runner = {
		/** Whom it takes work from: people by their names here, and `@runner` for agents working on that runner */
		owner: query('owner') && personal(query('owner')),
		allow: url.searchParams
			.getAll('allow')
			.map((who) => (who.startsWith('@') ? who : personal(who))),
		host: query('host'),
		home: query('home'),
		dir: query('dir') || '/',
		folders: url.searchParams.getAll('folder').length
			? url.searchParams.getAll('folder')
			: [query('dir') || '/'],
		readOnly: query('readOnly') === '1',
		version: query('version'),
		model: query('model'),
		...(query('thinkingLevel') && { thinkingLevel: query('thinkingLevel') }),
		modelError: query('modelError'),
		offers: url.searchParams.getAll('offer'),
		metered: url.searchParams.getAll('metered'),
		free: url.searchParams.getAll('free'),
		models: resolved,
	}
	await commit(async (tx) => {
		const all = await tx.doc(Runners)
		if (connection.phase !== 'closed') all[name] = runner
	})
	if (connection.phase === 'closed') return
	if (!models.getProvider(`runner:${name}`)) provide(name, resolved)
	listen(runners.receive)
	runners.connect(connection, (text) => socket.send(text))
	feed.touch(['runners', 'bots', 'threads', 'archived', 'thread'])
	socket.send(JSON.stringify({ op: 'ready' }))
	if (runner.version && runner.version !== bundle.version) {
		outdated.add(connection)
		feed.touch('runners')
	}
	say(
		'runner',
		[
			name,
			tilde(runner.dir) + (runner.readOnly ? ' (read-only)' : ''),
			runner.model || `no default model: ${runner.modelError || 'none set'}`,
			...(runner.owner ? [`work from ${[runner.owner, ...runner.allow].join(', ')}`] : []),
		].join(' · '),
	)
}

// ── Settings and lifecycle ─────────────────────────────────────────────

/**
 * Writes ade.json and restarts to take it up: in place where the runtime can (same terminal, same process),
 * else it stops and says so. `modules` maps a name to on or off; memory's `model` empty means each thread's agent, and
 * the director's a small model on each thread's runner. `bots.voice` empty means no shared instruction; equal to
 * DEFAULT_VOICE it's left out of ade.json, since that's what every bot reads without one.
 */
async function saveSettings({
	modules: wanted = {},
	memory,
	director,
	bots,
	owner: name,
	ownerLogins: logins,
}) {
	const known = [
		...Object.keys(defaults),
		...customModules.map((entry) => path.basename(entry, '.js')),
	]
	for (const name of Object.keys(wanted))
		if (!known.includes(name)) throw new Error(`No module named ${name}`)
	// Merge onto what's on disk now, not what this process loaded at startup, so an entry
	// this request didn't touch (like a module renamed since) survives untouched.
	const { config: onDisk } = await readConfig()
	const next = { ...onDisk }
	if (Object.keys(wanted).length) {
		const customPath = Object.fromEntries(
			customModules.map((entry) => [path.basename(entry, '.js'), entry]),
		)
		const nameOf = (change) => {
			const bare = change.slice(1)
			return bare.includes('/') ? path.basename(bare, '.js') : bare
		}
		const list = (onDisk.modules ?? []).filter((change) => !(nameOf(change) in wanted))
		for (const [name, on] of Object.entries(wanted))
			if (name in defaults) {
				if (on !== defaults[name]) list.push(`${on ? '+' : '-'}${name}`)
			} else if (on) list.push(`+${customPath[name]}`)
		next.modules = list
	}
	if (!next.modules?.length) delete next.modules
	/** Sets one setting in a section of ade.json, or with `unset`, leaves it out, and the section once it's empty */
	const put = (section, key, value, unset) => {
		if (unset) delete next[section]?.[key]
		else next[section] = { ...next[section], [key]: value }
		if (next[section] && !Object.keys(next[section]).length) delete next[section]
	}
	const trimmed = (value) => (typeof value === 'string' ? value.trim() : '')
	if (memory?.model !== undefined) {
		const model = trimmed(memory.model)
		if (model && !model.includes('@'))
			throw new Error("A memory model is model@runner, or empty for each thread's agent")
		put('memory', 'model', model, !model)
	}
	if (memory?.compactAt !== undefined) {
		const tokens = Number(memory.compactAt)
		if (!Number.isInteger(tokens) || tokens < 10000)
			throw new Error('memory compacts past at least 10000 tokens')
		put('memory', 'compactAt', tokens, tokens === 100000)
	}
	if (director?.model !== undefined)
		put('director', 'model', trimmed(director.model), !trimmed(director.model))
	/** Each number as given, checked as the director reads it; a default is left out of ade.json */
	for (const [field, fallback] of Object.entries({ context: 20, timeout: 60, burst: 1.5 })) {
		if (director?.[field] === undefined) continue
		const value = Number(director[field])
		directorTimes({ [field]: value })
		put('director', field, value, value === fallback)
	}
	if (name !== undefined) {
		if (name === '') delete next.owner
		else next.owner = ownerName(name)
	}
	if (logins !== undefined) {
		if (loginList(logins).length) next.ownerLogins = loginList(logins)
		else delete next.ownerLogins
	}
	if (bots !== undefined) {
		if (typeof bots.voice !== 'string') throw new Error('bots voice is text')
		put('bots', 'voice', bots.voice, bots.voice === DEFAULT_VOICE)
	}
	writeFileSync(settings.file, `${JSON.stringify(next, null, '\t')}\n`)
	const restarts = typeof process.execve === 'function'
	setTimeout(() => restart(restarts).catch((error) => (console.error(error), process.exit(1))), 100)
	return { saved: settings.file, restarts }
}
/** Closes the store, so nothing in flight is lost, then starts again with the same port and environment, or stops */
async function restart(again) {
	say('settings', again ? 'saved; restarting' : 'saved; stopped, start it again to take them up')
	if (lent?.kill) lent.kill()
	await (stopping ??= harness.close(context))
	if (!again) process.exit(0)
	process.execve(process.execPath, process.argv, {
		...process.env,
		PORT: String(port),
		SERVE_PORT: String(servePort),
		...(hookPort ? { HOOK_PORT: String(hookPort) } : {}),
	})
}

let lent
async function connectSelf(url) {
	if (flags['no-runner'] || lent) return
	lent = true
	// Its first name stays: macOS renames the machine when the network changes, and agents wait for the name they know
	const name = await commit(async (tx) => {
		const doc = await tx.doc(Lent)
		doc.name ||= os.hostname()
		return doc.name
	})
	const { key } = await mintKey(name, url)
	lent = spawn(
		process.execPath,
		[
			new URL('./runner.js', import.meta.url).pathname,
			'--server',
			url,
			'--name',
			name,
			...flags.dir.flatMap((dir) => ['--dir', dir]),
		],
		// Its online line would repeat the server's runner row
		{
			stdio: ['inherit', 'pipe', 'pipe'],
			env: { ...process.env, ADE_KEY: key, ADE_LENT: '1' },
		},
	)
	lent.name = name
	lent.stdout.on('data', (chunk) => process.stdout.write(chunk))
	lent.stderr.on('data', (chunk) => process.stderr.write(chunk))
	for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => lent.kill(signal))
}

// A list of names alone replaces the defaults, so say which of them it left out.
const off = (on) =>
	Object.keys(defaults).filter(
		(name) => defaults[name] === on && !modules.some((module) => module.name === name),
	)
/** A listener: the main one on HOST, or, `serve`, the one only `tailscale serve` should reach, on this machine alone */
function listener(serve) {
	const server = http.createServer((req, res) => handleRequest(req, res, serve))
	server.on('upgrade', (req, socket, head) =>
		upgrade(req, socket, head, serve).catch((error) => {
			console.error(error)
			socket.destroy()
		}),
	)
	return server
}
const serving = listener(true)
/** A Serve port chosen here, not by SERVE_PORT, that something took since it was found free: the next one */
const chosen = !process.env.SERVE_PORT
serving.on('error', (error) => {
	if (chosen && servePort && /** @type {NodeJS.ErrnoException} */ (error).code === 'EADDRINUSE')
		return serving.listen(++servePort, '127.0.0.1')
	console.error(error)
	process.exit(1)
})
await new Promise((resolve) => serving.listen(servePort, '127.0.0.1', () => resolve(undefined)))
servePort ||= /** @type {import('node:net').AddressInfo} */ (serving.address()).port

/**
 * The one listener meant for the internet, when a module takes hooks: POST /hooks/:id and nothing else, no page, no
 * socket, no owner key or login. HOOK_PORT, or the first free port after Serve's. A few requests at a time, each with a
 * deadline, and a size cap checked before the body is read; the module checks the hook before it reads the body.
 */
const HOOK = { inFlight: 8, deadline: 10_000, bytes: 1_000_000 }
let hookPort = Number(process.env.HOOK_PORT || 0)
if (webhook) {
	if (!hookPort) for (hookPort = servePort + 1; !(await free(hookPort));) hookPort++
	let inFlight = 0
	const refuse = (res, status, error) => {
		res.setHeader('Connection', 'close')
		send(res, status, { error })
	}
	const hooking = http.createServer(
		{ requestTimeout: HOOK.deadline, headersTimeout: HOOK.deadline },
		async (req, res) => {
			// Counted before anything else, so no request, even a malformed one, runs outside the cap
			if (inFlight >= HOOK.inFlight) return refuse(res, 503, 'Busy; try again')
			inFlight++
			const late = setTimeout(() => req.destroy(), HOOK.deadline)
			const body = async () => {
				const chunks = []
				let size = 0
				for await (const chunk of req) {
					size += chunk.length
					if (size > HOOK.bytes)
						throw Object.assign(new Error('Request too large'), { status: 413 })
					chunks.push(chunk)
				}
				return Buffer.concat(chunks)
			}
			try {
				const id =
					req.method === 'POST' && /^\/hooks\/(\d{1,15})$/.exec(String(req.url).split('?')[0])?.[1]
				if (!id) throw Object.assign(new Error('Not found'), { status: 404 })
				if (Number(req.headers['content-length'] ?? 0) > HOOK.bytes) {
					// Drain what the sender is still writing before refusing, so its request doesn't see the
					// connection close mid-upload (a write past a closed socket is a broken pipe, not a 413)
					for await (const _ of req) {
						/* discard */
					}
					throw Object.assign(new Error('Request too large'), { status: 413 })
				}
				send(res, 200, await webhook(Number(id), { headers: req.headers, body }))
			} catch (error) {
				refuse(res, error.status ?? 400, error.message)
			} finally {
				inFlight--
				clearTimeout(late)
			}
		},
	)
	hooking.on('upgrade', (req, socket) => socket.destroy())
	await new Promise((resolve) => hooking.listen(hookPort, '127.0.0.1', () => resolve(undefined)))
}
for (const host of process.env.HOST ? [process.env.HOST] : ['127.0.0.1', '::1']) {
	const server = listener(false)
	server.on('error', (error) => {
		if (
			host === '::1' &&
			['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(/** @type {NodeJS.ErrnoException} */ (error).code)
		)
			return
		console.error(error)
		process.exit(1)
	})
	server.listen(port, host, () => {
		// PORT=0 takes any free port: keep the one it got, for a restart and for runner commands
		const listening = /** @type {import('node:net').AddressInfo} */ (server.address())
		port ||= listening.port
		const addresses =
			host === '0.0.0.0'
				? Object.values(os.networkInterfaces())
						.flat()
						.filter((net) => net.family === 'IPv4')
						.map((net) => net.address)
				: [host === '::1' ? '[::1]' : host]
		// Keep listening on IPv6 localhost without printing a second local URL.
		if (process.env.HOST || host !== '::1') {
			const urls = addresses.map((address) => `http://${address}:${listening.port}`)
			console.log(`${'ade'.padEnd(11)}${urls.join('\n           ')}`)
			say('data', tilde(file))
			if (envFile) say('env', tilde(envFile))
			say(
				'modules',
				[
					modules.map((module) => module.name).join(' ') || 'none',
					...(off(false).length ? [`off: ${off(false).join(' ')}`] : []),
					...(off(true).length ? [`defaults left out: ${off(true).join(' ')}`] : []),
				].join(' · '),
			)
			say(
				'serve',
				`http://127.0.0.1:${servePort} for tailscale serve: people come in by their login`,
			)
			if (hookPort)
				say(
					'hooks',
					`http://127.0.0.1:${hookPort}/hooks/<task id>, the only part to publish, on an outside port of its own: tailscale funnel --bg --https=8443 --set-path /hooks http://127.0.0.1:${hookPort}/hooks`,
				)
		}
		connectSelf(
			`http://${host === '0.0.0.0' ? '127.0.0.1' : addresses[0]}:${listening.port}`,
		).catch((error) => console.error(error))
	})
}
