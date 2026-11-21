#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
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
	Harness,
} from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
} from '@earendil-works/pi-durable/tools'
import { createCodemodeExtension } from '@earendil-works/pi-durable/codemode'
import { CodemodeSandbox } from '@earendil-works/pi-codemode'
import { about, builtIn, dataDir, load, readConfig } from './modules.js'
import { DEFAULT_VOICE } from './modules/bots.js'
import { WebSocketServer } from 'ws'
import {
	AGENT,
	writtenTo,
	agentTo,
	collect,
	field,
	keyOf,
	said,
	byAgent,
	speaker,
	finished,
	directorTimes,
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
 * @property {number} [wake]  The wake that posted it: an agent's own note, back to it when its time came.
 * @property {true} [error]  The agent gave no answer.
 * @property {{ runner: string, code: number | null, stdout: string, stderr: string, error?: string }} [shell]  What `$ cmd` printed.
 * @typedef {{ id: number, kind: 'ade.message', data: Message }} Entry
 * @typedef {{ name: string, conversation: import("@earendil-works/pi-durable").ConversationId, to: To | null, status: string, contextWindow?: number }} Agent  An agent or bot, as a thread view shows it.
 * @typedef {{ conversation: import("@earendil-works/pi-durable").ConversationId, unseen: number[], admission?: { admit: number, deliver: number }, note?: string }} Recipient
 *   A thread doc's row for its agent or a bot: its conversation, the thread messages it hasn't seen, its latest input's
 *   tasks, and what to tell it about a change before its next one.
 * @typedef {{ agent: number, upTo: number, admit: number }} Delivery  One input to an agent: what it hasn't seen up to
 *   the message `upTo` that asked, taken when Admit submits it.
 * @typedef {{ author: string, command: string, to: To }} Command
 */

// ── Start-up: store lock and port ─────────────────────────────────────────

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
	logged(`${origin}: ${error?.stack ?? error}`),
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
// ── Docs and tasks ────────────────────────────────────────────────────────

const KIND = 'ade.message'
/** Whom the director picked for a message saved before it chose: `{message, to, picked}`, read as that message's own */
const ROUTE = 'ade.route'
/** An agent's input in its conversation; `held` names the thread messages it gave */
const DELIVERY = 'ade.delivery'
/** How much of a `$ cmd`'s stdout and of its stderr is kept, from the end */
const TAIL = 20000
/** Our docs are small, so every change stores the whole doc and a read replays nothing */
const base = () => true
const Runners = defineDoc({
	kind: 'ade.runners',
	version: 1,
	scope: 'session',
	checkpointWhen: base,
	initial: () => ({}),
})
const Keys = defineDoc({
	kind: 'ade.keys',
	version: 1,
	scope: 'session',
	checkpointWhen: base,
	initial: () => ({}),
})
/** The name the server's own runner got the first time, kept so a new hostname doesn't make it another runner */
const Lent = defineDoc({
	kind: 'ade.lent',
	version: 1,
	scope: 'session',
	checkpointWhen: base,
	initial: () => ({ name: '' }),
})
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
		/** The director's Pick task still deciding for this thread's newest message, which a newer one takes over */
		pick: null,
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
		async ask({ id, conversationId: threadId, input: { agent, upTo, steer, turn } }, rt, ctx) {
			await reachable(agent, rt.signal)
			const row = await thread(threadId)
			const { unseen, note } = recipientOf(row, agent)
			/** Its turn comes after the answer before it, so it takes that answer, and whatever was said meanwhile */
			const held = turn ? unseen : unseen.filter((id) => id <= upTo)
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
			if (
				submitted?.submission &&
				(await tx.submissionByRequest(agent, String(admit)))?.entry === undefined
			)
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
		async run({ id, conversationId: threadId, input }, rt, ctx) {
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
			notify(listOf(threadId))
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
						notify(listOf(threadId))
					},
				},
				ctx,
			)
			const output =
				result.ok === true ? { code: result.value.exitCode } : { error: result.error.message }
			await rt.commit(
				async (tx) => (await printed(tx, threadId, input, { ...run, ...output }), finished()),
				ctx,
			)
			shells.delete(id)
		},
		interrupted: ({ conversationId, input }, rt, ctx) =>
			rt.commit(
				async (tx) => (
					await printed(tx, conversationId, input, { error: 'interrupted by a restart' }),
					finished()
				),
				ctx,
			),
	},
	async abort({ id, conversationId, input }, rt, ctx) {
		await rt.commit(
			async (tx) => (
				await printed(tx, conversationId, input, { ...shells.get(id), error: 'stopped' }),
				finished('aborted')
			),
			ctx,
		)
		shells.delete(id)
	},
})

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
/** The runner this server ships, and the updater that fetches it */
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
			createBashTool({
				prepare: async (execution, api, context) => {
					const { model, thinkingLevel } = await api.agent(context)
					Object.assign(execution.env, {
						PI_SESSION_ID: String(api.conversationId),
						...(model && { PI_MODEL: model.modelId.replace(/^[^/]+\//, '') }),
						...(thinkingLevel && thinkingLevel !== 'off' && { PI_REASONING_LEVEL: thinkingLevel }),
					})
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
		settings: () => ({
			afterFailedRun: 'continue',
			/** RESTART_LIMIT=n: how many crashes in a row end a task; Pi's own limit unless set */
			...(Number(process.env.RESTART_LIMIT) >= 1 && {
				restartLimit: Number(process.env.RESTART_LIMIT),
			}),
			...(compactAt && { compaction: compactingAt(compactAt) }),
		}),
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
/** A stop closes the harness, so the tasks it cuts off wait to resume, and Pi doesn't count them as crashed */
let stopping
for (const signal of ['SIGINT', 'SIGTERM'])
	process.on(signal, () => {
		logged(`stopped by ${signal}`)
		stopping ??= harness.close(context).finally(() => process.exit(0))
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

const threadIds = async () =>
	(
		await collect((cursor) =>
			commit((tx) => tx.scanConversations({ order: 'descending' }, 500, cursor)),
		)
	)
		.filter((conversation) => !conversation.owner)
		.map((conversation) => conversation.id)

// ── Small helpers ─────────────────────────────────────────────────────────

const user = (req) => speaker(req.headers['x-user'])

/** The address this request reached the server at, as a runner on another machine dials it */
const origin = (req) =>
	`${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${String(req.headers.host).replace(/[^\w.:[\]-]/g, '')}`
const sha256 = (text) => createHash('sha256').update(text).digest('hex')
/** The start-up table and every runner event after it share one column */
const say = (label, text) => console.log(`  ${label.padEnd(8)} ${text}`)
const tilde = (dir) => (dir?.startsWith(os.homedir()) ? `~${dir.slice(os.homedir().length)}` : dir)
const loopback = (address) =>
	/^(127\.|::ffff:127\.)/.test(address) || ['::1', '[::1]', 'localhost'].includes(address)

// ── Addressing: whom a message asks ───────────────────────────────────────

/** A command needs no model */
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
		if (found.ok && !found.value) throw new Error(`${clean.dir} doesn't exist on ${name}`)
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
	if (typeof text === 'string' && agents?.[text]) return agentOf(agents[text].conversation, text)
	if (text === AGENT) throw new Error(`Thread ${threadId} has no agent yet`)
	const bot = typeof text === 'string' && !/[@=]/.test(text) && (await botAgent?.(text))
	if (bot) return address(bot, command, signal)
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
		models.setProvider(runnerProvider(runners, name, (await known())[name].models))
	}
	const level = thinkingLevel ?? (useDefaultThinking ? defaultThinkingLevel : undefined)
	return { model: ref, ...(level ? { thinkingLevel: level } : {}) }
}

/** A runner with an owner takes work from its owner and the names it allows */
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

/** `key`, its key in the thread when the caller has it, saves looking it up */
async function agentOf(id, key, tx) {
	const agent = tx ? await tx.doc(AgentDoc, id) : await harness.snapshot(AgentDoc, id, context)
	const runnerName = agent?.model?.provider?.match(/^runner:(.+)$/)?.[1]
	if (!runnerName) return null
	const runner = (tx ? await tx.doc(Runners) : await known())[runnerName]
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
 * @returns {Promise<{ thread: number, conversation?: number, runner: string, row?: string, status: string }[]>}
 */
async function work() {
	const tasks = (await harness.inspect(context)).tasks
	const live = tasks.filter(({ record }) =>
		[Deliver.definition.name, Shell.definition.name].includes(record.kind),
	)
	/** A module's own work in a thread, like the director's pick, keeps it working and its Stop in reach */
	const own = tasks
		.filter(({ record }) => moduleWork.includes(record.kind))
		.map(({ record }) => ({ thread: record.conversationId, runner: undefined, status: 'working' }))
	return [
		...own,
		...(await Promise.all(
			live.map(async ({ record }) => {
				const task = /** @type {any} */ (record)
				const shell = task.kind === Shell.definition.name
				const to = shell ? task.input.to : await agentOf(task.input.agent)
				return {
					thread: task.conversationId,
					...(shell
						? {}
						: {
								conversation: task.input.agent,
								row: to && (to.name ?? `${to.model}@${to.runner}`),
							}),
					runner: to?.runner,
					status: to && runners.isOnline(to.runner) ? 'working' : 'blocked',
				}
			}),
		)),
	]
}

/** @returns {Promise<Agent[]>} */
async function agentsIn(row, busy) {
	return Promise.all(
		Object.entries(row.agents).map(async ([key, { conversation }]) => {
			const to = await agentOf(conversation, key)
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
/** A thread's messages among its entries, each with the director's pick for it, once there is one */
function routed(entries, routes = new Map()) {
	for (const entry of entries) if (entry.kind === ROUTE) routes.set(entry.data.message, entry.data)
	return entries.filter((entry) => entry.kind === KIND).map((entry) => withRoute(entry, routes))
}
const withRoute = (entry, routes) => {
	const route = routes.get(entry.id)
	if (!route) return entry
	const { to, picked } = route
	return {
		...entry,
		data: { ...entry.data, ...(to.length ? { to } : {}), ...(picked ? { picked } : {}) },
	}
}
/** The newest matching message, stopping as soon as it is found rather than loading a thread. */
async function latestMessage(id, matches, kind = KIND) {
	const handle = await conversation(id)
	let cursor
	do {
		const page = await handle.entries({ order: 'descending' }, 50, cursor, context)
		const found = page.items.find((entry) => entry.kind === kind && matches(entry))
		if (found) return found
		cursor = page.next
	} while (cursor)
}
async function lastAsked(id) {
	const names = (await messages(id)).findLast((entry) => entry.data.to)?.data.to ?? []
	const { agents } = await thread(id)
	return Promise.all(
		names.map((name) =>
			agents[keyOf(name)] ? agentOf(agents[keyOf(name)].conversation, keyOf(name)) : whom(id, name),
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
	{ steer = false, empty = false, direct = false } = {},
) {
	const row = await tx.doc(Thread, threadId)
	const names = (to ?? []).map(writtenTo)
	const data = { createdAt: now(), ...message, ...(to ? { to: names } : {}) }
	const prior =
		!empty && names.some((name) => !row.agents[keyOf(name)]) ? await messageIds(tx, threadId) : []
	// A fresh message, an @mention too, takes over the pick still pending; whoever it asks reads that message too
	if (row.pick && fresh({ kind: KIND, data })) {
		await supersede?.(tx, threadId, row.pick)
		row.pick = null
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
				})
			: undefined
	if (pick) row.pick = pick
	return { entry: entry.id, to: names, ...(pick ? { pick } : {}) }
}

/** Every message's id in a thread, oldest first, which a new agent hasn't seen */
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
async function route(tx, threadId, messageId, { to, picked }, { steer = false, pick } = {}) {
	const { data } = await tx.entry(messageId)
	// A newer message saved since takes over: this one asks no one, and whoever that one asks reads it too
	if (await newerThan(tx, threadId, messageId)) [to, picked] = [[], undefined]
	const row = await tx.doc(Thread, threadId)
	if (row.pick === pick) row.pick = null
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

/** A message someone wrote to the thread, not an agent's answer back, its own wake or a command's output: one that takes over a pick */
const fresh = ({ kind, data }) =>
	kind === KIND && !data.answer && !data.error && !data.shell && !data.re && !data.wake

/** Whether a fresh message came after `messageId`, reading back from the newest */
async function newerThan(tx, threadId, messageId) {
	let cursor
	do {
		const page = await tx.scanEntries({ conversationId: threadId, order: 'descending' }, 50, cursor)
		for (const entry of page.items) {
			if (entry.id <= messageId) return false
			if (fresh(entry)) return true
		}
		cursor = page.next
	} while (cursor)
	return false
}

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
	await configure(tx, recipient.conversation, {
		...(remodelled ? { model, cwd } : {}),
		...(thinks ? { thinkingLevel: to.thinkingLevel } : {}),
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

/** Whether a person wrote it: not an agent, in this thread or from another, nor a bot of this thread */
const person = (row, { data }) => !byAgent(data) && !row.agents[keyOf(data.author)]

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
	if (!done && settled.reason === 'aborted') return []
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
	if (submitted?.submission && settled.entry === undefined)
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
	const handle = await harness.conversation(id, context)
	let cursor
	do {
		const page = await handle.entries({}, 50, cursor, context)
		for (const record of page.items) {
			const entry = /** @type {import("@earendil-works/pi-durable").TypedEntry<Message>} */ (record)
			if (seen.has(entry.id)) return 'idle'
			if (entry.data?.shell?.error === 'stopped') continue
			if (entry.data?.answer || entry.data?.error || entry.data?.shell)
				return entry.data.error || entry.data.shell?.error ? 'error' : 'done'
		}
		cursor = page.next
	} while (cursor)
	return 'idle'
}

/** Each thread's people who wrote there so far, and the newest entry read for them, so a thread is read once per server */
const writers = new Map()
/** Who's in a thread needs no state of its own: the people who wrote there, or read. Only an open thread needs it. */
async function people(id) {
	const handle = await conversation(id)
	const wrote = writers.get(id) ?? { after: 0, authors: new Set() }
	writers.set(id, wrote)
	for (let cursor; ;) {
		const page = await handle.entries(
			{ order: 'ascending', minEntryId: wrote.after + 1 },
			500,
			cursor,
			context,
		)
		for (const record of page.items) {
			const entry = /** @type {import("@earendil-works/pi-durable").TypedEntry<Message>} */ (record)
			if (entry.kind === KIND && !byAgent(entry.data)) wrote.authors.add(entry.data.author)
			wrote.after = Math.max(wrote.after, entry.id)
		}
		if (!(cursor = page.next)) break
	}
	const { reads } = await thread(id)
	return [...new Set([...wrote.authors, ...Object.keys(reads)])]
}

/** `homes`, each bot's home thread → its name, saves reading them for every row of a list */
async function threadRow(id, reader, all, homes) {
	const { reads, hidden, dismissed: _, ...row } = await thread(id)
	const busy = all.filter((job) => job.thread === id)
	const agents = await agentsIn(row, busy)
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
		status: await status(id, { ...row, reads }, busy, reader),
		conversation: await storage.conversation(id, context),
	}
}
/** Each shown thread's row; the client works out families from `parent` and forks */
const threadList = async (reader, archived = false) => {
	const busy = await work()
	const homes = (await homesOf?.()) ?? {}
	/** Only the threads this list shows get a row, since a row reads its thread's entries for its status */
	const ids = await threadIds()
	const shown = await Promise.all(
		ids.map(async (id) => Boolean((await thread(id)).hidden) === archived),
	)
	return Promise.all(
		ids.filter((_, index) => shown[index]).map((id) => threadRow(id, reader, busy, homes)),
	)
}
/** A thread's row and people, with its messages: all of them, those after `after`, or the newest `last` */
async function threadView(id, reader, { after, last } = {}) {
	const handle = await conversation(id)
	return {
		...(await threadRow(id, reader, await work())),
		people: await people(id),
		entries:
			after === undefined && last === undefined
				? await messages(id)
				: await newest(handle, { after, last }),
	}
}
/** A thread's newest messages, read back from its end: those after `after`, or the newest `last`, with their picks */
async function newest(handle, { after = -1, last = Infinity }) {
	const read = []
	let count = 0
	for (let cursor; count < last;) {
		const page = await handle.entries({ order: 'descending' }, 200, cursor, context)
		const ended = page.items.findIndex((entry) => entry.id <= after)
		for (const entry of ended < 0 ? page.items : page.items.slice(0, ended)) {
			if (entry.kind === KIND && ++count > last) break
			read.push(entry)
		}
		if (ended >= 0 || !(cursor = page.next)) break
	}
	return routed(read.reverse())
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
	const saved = (await harness.snapshot(Receipts, requestId, context))?.receipt
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
		if (doc.receipt) {
			if (doc.receipt.command !== command)
				throw new Error(`requestId ${requestId} was used for ${doc.receipt.command}`)
			return JSON.parse(JSON.stringify(doc.receipt.result))
		}
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
	const directed = director && (await direct?.(id, message, explicit === undefined))
	if (directed?.direct) return { to: [], direct: true }
	if (directed) return directed
	if (explicit) return { to: await explicit() }
	if (director) {
		const { agents } = await thread(id)
		const here = (
			await Promise.all(
				Object.entries(agents).map(([key, agent]) => agentOf(agent.conversation, key)),
			)
		).filter(Boolean)
		if (here.length > 1) {
			const agent = here.find((agent) => !agent.name)
			return {
				to: agent ? [agent] : [],
				picked: `Pick failed: the director is unavailable. ${agent ? "The thread's agent answers." : 'No thread agent to answer; @mention a bot.'}`,
			}
		}
	}
	return { to: await fallback() }
}

/** No `to` asks the director in a group, or the last recipient in a solo chat or command. */
async function postEntry(id, author, input) {
	const saved = await receipt(input.requestId, `post ${id}`)
	if (saved) return withPick(id, saved.result)
	await conversation(id)
	const images = imageList(input.images)
	const body = images ? (input.body ?? '').trim() : field(input.body, 'body')
	const command = !images && body.match(/^\$\s+([\s\S]+)/)?.[1]
	const { to, picked, direct } = await recipients(
		id,
		{ author, body },
		{
			director: !command,
			explicit: 'to' in input ? () => addresses(input.to, Boolean(command), id) : undefined,
		},
	)
	if (command && !to.length) throw new Error('Pick a runner to run the command on')
	if (command) await reach(to, author, await known())
	if (!command && to.filter((to) => !to.name).length > 1)
		throw new Error('A thread has one agent: ask one model here, plus any bots')
	const result = await once(input.requestId, `post ${id}`, async (tx) =>
		command
			? (await tx.createTask(Shell, { author, command, to: to[0] }, { ...own, conversationId: id }),
				{ command, to: to[0] })
			: post(
					tx,
					id,
					{
						author,
						body,
						...(images ? { images } : {}),
						...(to.length ? { to } : {}),
						...(picked ? { picked } : {}),
					},
					{ steer: input.steer === true, direct },
				),
	)
	return withPick(id, result)
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

async function createThread({ title, parent = null, tools = null, requestId }) {
	if (parent !== null) await conversation((parent = Number(parent)))
	title = field(title, 'title')
	tools = toolList(tools)
	return once(requestId, 'create thread', async (tx) => ({
		id: await startThread(tx, title, parent, tools),
	}))
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

async function setTitle(id, { title }) {
	await conversation(id)
	title = field(title, 'title')
	const bot = ((await homesOf?.()) ?? {})[id]
	if (bot) throw new Error(`Thread ${id} is ${bot}'s home; it shows ${bot}'s name`)
	return commit((tx) => setTitleIn(tx, id, title))
}

/** The title's one write path; an automatic title must still match its default. */
async function setTitleIn(tx, id, title, expected) {
	const row = await tx.doc(Thread, id)
	if (expected === undefined || row.title === expected) row.title = title
	return { title: row.title }
}

/** Changes the thread's tools and its agent's and bots' selection together */
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

/** Forks history, the agent and bots at `at`, but keeps the source's current thread-wide tools */
async function forkThread(id, { at, title }) {
	await conversation(id)
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

/** Compacts each agent of the thread now, as Pi does when its context fills; what each came to is its outcome */
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

// ── Modules ───────────────────────────────────────────────────────────────

const core = {
	/** A thread's doc inside a commit, where a snapshot would wait for the commit itself */
	threadIn: (tx, id) => tx.doc(Thread, id),
	work,
	busiest,
	person,
	models,
	runners,
	known,
	reach,
	address,
	whom,
	agentOf,
	conversation,
	thread,
	home,
	threadList,
	entries,
	messages,
	latestMessage,
	/** With blocked on, a thread's open `ask_person` message, else undefined */
	openQuestion: (id, row) => openQuestion?.(id, row),
	lastAsked,
	recipients,
	instructionsOf: (name) => instructionsOf?.(name),
	botAgent: (name) => botAgent?.(name),
	botNames: () => botNames?.() ?? [],
	startThread,
	newAgent,
	setUp,
	setTitleIn,
	threadIds,
	renameIn,
	/** `within` is a caller's own context, such as a hook's, so its cancellation ends the wait */
	waitForTask: (id, within = context) => harness.waitForTask(id, within),
	post,
	route,
	fresh,
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
		for (const socket of clients) if (socket.pages?.id === threadId) socket.send(sent)
	},
	seenBy,
	commit,
	once,
	receipt,
}
/** Each module in modules/ → on by default, as its own file says */
const defaults = await builtIn()
/** ade.json, as it started; the page changes it, and a restart takes it up */
const settings = await readConfig()
core.config = settings.config
const modules = await load('server', core, settings)
for (const module of modules) if (module.extension) registry.install(module.extension)
const customModules = (settings.config.modules ?? [])
	.map((entry) => entry.replace(/^[+-]/, ''))
	.filter((entry) => entry.includes('/'))
/** Each module's name → what it does, from its own file */
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
/** Task kinds of modules' own work in a thread, counted as the thread working */
const moduleWork = modules.flatMap((module) => module.work ?? [])
const archiving = modules.flatMap((module) => module.archiving ?? [])
const [
	direct,
	directing,
	supersede,
	turns,
	reply,
	catchUp,
	botAgent,
	instructionsOf,
	botNames,
	homesOf,
	expand,
	openQuestion,
] = [
	'direct',
	'directing',
	'supersede',
	'turns',
	'reply',
	'catchUp',
	'botAgent',
	'instructionsOf',
	'botNames',
	'homesOf',
	'expand',
	'openQuestion',
].map(hook)
compactAt = hook('compactAt')
const remembers = hook('remembers')
for (const [name, runner] of Object.entries(await known()))
	models.setProvider(runnerProvider(runners, name, runner.models))
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

async function archiveThread(id, archived) {
	await conversation(id)
	await commit(async (tx) => {
		if (archived) for (const hook of archiving) await hook(tx, id)
		;(await tx.doc(Thread, id)).hidden = Boolean(archived)
	})
	return { id, archived: Boolean(archived) }
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

/** @type {[RegExp, Function][]} */
const routes = /** @type {[string, Function][]} */ ([
	[
		'GET /api/server',
		async (req) => ({
			port,
			file,
			modules: modules.map((module) => module.name),
			off: Object.keys(defaults).filter((name) => !modules.some((module) => module.name === name)),
			about: aboutModules,
			threads: (await threadIds()).length,
			runners: Object.keys(await keys()).length,
			work: await harness.inspect(context),
			settings: {
				memory: {
					model: settings.config.memory?.model ?? '',
					compactAt: compactAt ?? null,
				},
				...Object.fromEntries(
					modules
						.filter((module) => module.settings)
						.map((module) => [module.name, module.settings]),
				),
				/** Set in the environment, these win over ade.json */
				overrides: ['MODULES', 'MEMORY_MODEL', 'DIRECTOR_MODEL'].filter(
					(name) => process.env[name],
				),
				restarts: typeof process.execve === 'function',
			},
		}),
	],
	['POST /api/settings', async (req) => saveSettings(await input(req))],
	[
		'GET /api/runners',
		async () => {
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
					busy: new Set(here.filter((job) => job.status === 'working').map((job) => job.thread))
						.size,
					outdated: Boolean(runner.version) && runner.version !== bundle.version,
				}
			})
		},
	],
	['POST /api/runners', async (req) => mintKey(String((await input(req)).name ?? ''), origin(req))],
	['DELETE /api/runners/:name', (req, name) => revoke(name)],
	[
		'GET /api/runners/:name/available',
		async (req, name) => {
			if (!runners.isOnline(name)) throw new Error(`${name} is offline`)
			return runners.call(name, { op: 'available' }, {})
		},
	],
	['GET /runner/bundle', () => bundle],
	['GET /api/threads', (req) => threadList(user(req))],
	['GET /api/threads/archived', (req) => threadList(user(req), true)],
	['POST /api/threads', async (req) => createThread(await input(req))],
	[
		'GET /api/threads/:id',
		(req, id, url) => {
			const number = (name) =>
				url.searchParams.has(name) ? Number(url.searchParams.get(name)) : undefined
			return threadView(id, user(req), { after: number('after'), last: number('last') })
		},
	],
	[
		'POST /api/threads/:id/archive',
		async (req, id) => archiveThread(id, (await input(req)).archived),
	],
	['POST /api/threads/:id/entries', async (req, id) => postEntry(id, user(req), await input(req))],
	['POST /api/threads/:id/fork', async (req, id) => forkThread(id, await input(req))],
	['POST /api/threads/:id/title', async (req, id) => setTitle(id, await input(req))],
	['POST /api/threads/:id/tools', async (req, id) => setTools(id, await input(req))],
	['POST /api/threads/:id/read', (req, id) => markRead(id, user(req))],
	[
		'POST /api/threads/:id/stop',
		async (req, id) => {
			await (await conversation(id)).abort(context)
			return { stopped: id }
		},
	],
	['POST /api/threads/:id/compact', async (req, id) => ({ compacted: await compact(id) })],
	['GET /api/conversations/:id', (req, id) => conversationView(id)],
	...modules.flatMap((module) =>
		module.serve
			? [
					[
						`GET /api/${module.name}`,
						(req, _, url) => module.serve(undefined, url.searchParams, undefined, user(req)),
					],
					[
						`POST /api/${module.name}`,
						async (req, _, url) =>
							module.serve(undefined, url.searchParams, await input(req), user(req)),
					],
					...(module.remove
						? [[`DELETE /api/${module.name}/:name`, (req, name) => module.remove(name)]]
						: []),
					[
						`GET /api/threads/:id/${module.name}`,
						(req, id, url) => module.serve(id, url.searchParams, undefined, user(req)),
					],
					[
						`POST /api/threads/:id/${module.name}`,
						async (req, id, url) => module.serve(id, url.searchParams, await input(req), user(req)),
					],
				]
			: [],
	),
]).map(([key, handle]) => [
	new RegExp(`^${key.replace(':id', String.raw`(\d+)`).replace(':name', '([^/]+)')}$`),
	handle,
])

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
		res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' })
		return res.end(head ? undefined : body)
	}
	return send(res, 404, { error: 'Not found' })
}

function send(res, status, value) {
	res.writeHead(status, { 'Content-Type': 'application/json' })
	res.end(JSON.stringify(value))
}

async function handleRequest(req, res) {
	const url = new URL(req.url, 'http://localhost')
	if (
		!['GET', 'HEAD'].includes(req.method) &&
		req.headers.origin &&
		req.headers.origin !== origin(req)
	)
		return send(res, 403, { error: 'Cross-origin writes are refused; use the server’s own page' })
	if (req.method === 'OPTIONS') {
		res.writeHead(204)
		return res.end()
	}
	const head = req.method === 'HEAD'
	const asGet = ['GET', 'HEAD'].includes(req.method)
	if (asGet && url.pathname === '/') {
		const page = await readFile(new URL('./apps/client/client.html', import.meta.url))
		res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
		return res.end(head ? undefined : page)
	}
	if (asGet && url.pathname.startsWith('/packages/')) return servePackage(res, url.pathname, head)
	if (asGet) {
		const file = await clientFile(url.pathname)
		if (file) {
			res.writeHead(200, { 'Content-Type': file.type })
			return res.end(head ? undefined : file.body)
		}
	}
	if (asGet && url.pathname === '/runner/updater.js') {
		res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' })
		return res.end(head ? undefined : updater)
	}
	if (asGet && url.pathname === '/connect-runner') {
		res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
		return res.end(head ? undefined : runnerScript(origin(req)))
	}
	const key = `${req.method} ${url.pathname}`
	for (const [pattern, handle] of routes) {
		const match = pattern.exec(key)
		if (!match) continue
		try {
			send(
				res,
				req.method === 'POST' ? 201 : 200,
				await handle(
					req,
					match[1] && (/^\d+$/.test(match[1]) ? Number(match[1]) : decodeURIComponent(match[1])),
					url,
				),
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
# Connects this machine to the ade server at ${server}, with a key from \`node cli.js key laptop\` there:
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
  set -- "$@" --key-file "$keyfile"
fi
curl -fsSL "${server}/runner/updater.js" -o "$data/runner-updater.js"
printf "Next time, without curl: %s '%s' '%s'" "$run" "$data/runner-updater.js" '${server}'
for arg do printf " '%s'" "$(printf %s "$arg" | sed "s/'/'\\\\''/g")"; done
printf '\\n'
exec "$run" "$data/runner-updater.js" "${server}" "$@"
`

// ── WebSocket: notify, watch ──────────────────────────────────────────────

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

/**
 * The lists a browser fetches, by the names its socket hears them changed by: threads, archived, runners, bots and
 * inbox. A thread's change names the list it's in; the inbox, only a question asked, answered or dismissed.
 */
/** A runner coming or going moves every agent on it, in either list */
const WORK = ['threads', 'archived', 'runners']
const docLists = {
	'ade.runners': WORK,
	'ade.keys': ['runners'],
	'ade.lent': ['runners'],
	'ade.bots': ['threads', 'archived', 'bots'],
}
/** Each thread's place, kept from its doc as it changes: archived or not, its dismissed question, and whether a question waits on a person */
const placed = new Map()
/** The work tasks the lists have heard start and not yet end */
const live = new Set()
/** Each agent's thread, by the agent's conversation */
const agentThreads = new Map()
const place = (id, value) => {
	const before = placed.get(id)
	const now = {
		hidden: Boolean(value.hidden),
		dismissed: value.dismissed ?? null,
		asked: before?.asked ?? false,
	}
	placed.set(id, now)
	for (const { conversation } of Object.values(value.agents ?? {}))
		agentThreads.set(conversation, id)
	return { before, now }
}
/** The list a thread's row is in, or both while it's not known yet */
const listOf = (conversationId) => {
	const at = placed.get(agentThreads.get(conversationId) ?? conversationId)
	return at ? [at.hidden ? 'archived' : 'threads'] : ['threads', 'archived']
}
/** Which lists one stored commit can move; an agent's own transcript and live doc move none */
function listsOf({ changes }) {
	// A thread's doc first, so the rest of its commit, like its creation, names the list it's in
	const moves = new Map()
	for (const change of changes)
		if (
			change.type === 'document' &&
			change.kind === 'change' &&
			change.record.kind === 'ade.thread'
		)
			moves.set(change, place(change.conversationId, change.value))
	return changes.flatMap((change) => {
		if (change.type === 'conversation') return listOf(change.value.id)
		if (change.type === 'entry') {
			const { kind, conversationId, data } = /** @type {any} */ (change.value)
			if (!kind.startsWith('ade.')) return []
			// The inbox moves with a question asked, or a person's message after one
			const at = placed.get(conversationId)
			const asks =
				kind === KIND && at && (data?.waitingOnPerson || (at.asked && !byAgent(data ?? {})))
			if (asks) at.asked = Boolean(data?.waitingOnPerson)
			return [...listOf(conversationId), ...(asks ? ['inbox'] : [])]
		}
		if (change.type === 'task') {
			// A thread or runner works while its task lives: only the task's start and end move a list
			const { id, kind, status, conversationId } = change.value
			const runs = [Deliver.definition.name, Shell.definition.name].includes(kind)
			if (!runs && !moduleWork.includes(kind)) return []
			if (status === 'terminal') live.delete(id)
			else if (live.has(id)) return []
			else live.add(id)
			return [...listOf(conversationId), ...(runs ? ['runners'] : [])]
		}
		if (change.type === 'submission') return []
		const { kind } = change.record
		if (kind === 'ade.thread') {
			if (!moves.has(change)) return ['threads', 'archived', 'inbox']
			const { before = moves.get(change).now, now } = moves.get(change)
			const moved = before.hidden !== now.hidden
			return [
				...(moved ? ['threads', 'archived'] : listOf(change.conversationId)),
				...(moved || before.dismissed !== now.dismissed ? ['inbox'] : []),
			]
		}
		if (kind === AgentDoc.definition.kind)
			return [
				...(change.type === 'document' && change.conversationId
					? listOf(change.conversationId)
					: ['threads', 'archived']),
				'runners',
			]
		return docLists[kind] ?? []
	})
}

/** Browsers hear which lists changed, at most every 100 ms, and fetch only those again */
let flushing
const changedLists = new Set()
function notify(lists) {
	for (const list of lists) changedLists.add(list)
	flushing ??= setTimeout(() => {
		flushing = undefined
		const changed = [...changedLists]
		changedLists.clear()
		for (const wake of changes) wake()
		nudge()
		if (changed.length) {
			const sent = JSON.stringify({ changed })
			for (const socket of clients) socket.send(sent)
		}
		for (const module of modules) module.changed?.(changed)
	}, 100)
}
harness.observeCommits({ advance: (publication) => notify(listsOf(publication)), end: () => {} })
for (const id of await threadIds()) {
	const row = await thread(id)
	place(id, row).now.asked = Boolean(await openQuestion?.(id, row))
}

/** Messages a thread opens on: few, so it shows at once, with only their agents' turns */
const FIRST = 15
/** Messages each earlier page brings as a browser scrolls up */
const PAGE = 50

/** A browser watches one thread, or asks for its page before the ones it has */
const watch = (socket, id) =>
	(socket.watches = (socket.watches ?? Promise.resolve())
		.then(() => rewatch(socket, id))
		.catch(() => {}))
const earlier = (socket, id, all) =>
	(socket.watches = (socket.watches ?? Promise.resolve())
		.then(() => socket.pages?.id === id && socket.pages.back(all))
		.catch(() => {}))
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
	for (let cursor; ;) {
		const page = await handle.entries(
			{ minEntryId: marker.head, order: 'ascending' },
			20,
			cursor,
			context,
		)
		const kept = page.items.find((entry) => entry.kind === DELIVERY)
		const held = /** @type {any} */ (kept?.data)?.held ?? []
		if (held.length)
			return { id: marker.id, model: marker.model?.map(visible), first: Math.min(...held) }
		if (!(cursor = page.next)) return null
	}
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
	const messages = await handle.watch(context)
	if (!keep(messages)) return
	/** Who's there changes with a message, or a read */
	const present = async () => ({ people: await people(id) })
	const only = (entries) => entries.filter((entry) => entry.kind === KIND)
	/** Messages with the director's picks, and a message sent before whose pick just came, again */
	const routes = new Map()
	const sentMessages = new Map()
	const withPicks = (entries) => {
		const fresh = routed(entries, routes)
		for (const entry of fresh) sentMessages.set(entry.id, entry)
		const again = entries
			.filter(
				(entry) => entry.kind === ROUTE && !fresh.some((one) => one.id === entry.data.message),
			)
			.flatMap((entry) => {
				const before = sentMessages.get(entry.data.message)
				return before ? [withRoute(before, routes)] : []
			})
		return [...fresh, ...again]
	}
	/** Its newest page of messages, at least `size` of them, or all there are */
	const page =
		(after, size = PAGE) =>
		(entries) =>
			only(entries).filter((entry) => entry.id < after).length >= size
	const thread = await told(
		handle,
		messages,
		async (entries, more) => send({ entries: withPicks(entries), ...more, ...(await present()) }),
		{ enough: page(Infinity, FIRST) },
	)
	/** The oldest message the browser has, or 0 once it has them all, which its agents' turns reach back to */
	const from = () => (thread.earlier() ? (only(thread.entries())[0]?.id ?? 0) : 0)
	/** Each followed agent's way back through its conversation */
	const pagers = new Map()
	socket.pages = {
		id,
		/** The page before the oldest message sent, or all of them: each agent's turns for it first, then the messages */
		back: async (all) => {
			const oldest = only(thread.entries())[0]?.id ?? Infinity
			const older = await thread.back(all ? () => false : page(oldest))
			for (const [agent, back] of pagers) {
				const entries = await back(covers(from()))
				if (entries.length) send({ agent, older: true, entries })
			}
			send({ older: true, earlier: older.earlier, entries: withPicks(older.entries) })
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
					enough: covers(from()),
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
		send(await present())
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
async function lastDelivery(handle, first) {
	for (let cursor; ;) {
		const page = await handle.entries(
			{ minEntryId: first, order: 'descending' },
			100,
			cursor,
			context,
		)
		const found = page.items.find((entry) => entry.kind === DELIVERY)
		if (found || !page.next) return found
		cursor = page.next
	}
}

// ── Runner keys ───────────────────────────────────────────────────────────

/** A new key for a runner, replacing its old one, whose runner is cut off */
async function mintKey(name, server) {
	if (!/^[\w.-]+$/.test(name))
		throw new Error('name the runner: letters, digits, dot, dash or underscore')
	if (process.env.HOST === '0.0.0.0' && loopback(new URL(server).hostname)) {
		const interfaces = os.networkInterfaces()
		const address = [...(interfaces.tailscale0 ?? []), ...Object.values(interfaces).flat()].find(
			(net) => net.family === 'IPv4' && !net.internal,
		)?.address
		if (address) server = server.replace(new URL(server).hostname, address)
	}
	const key = `air_${randomBytes(24).toString('base64url')}`
	await commit(async (tx) => {
		;(await tx.doc(Keys))[name] = sha256(key)
	})
	runners.kick(name, 4001, `${name}'s key was replaced`)
	notify(['runners'])
	return {
		name,
		key,
		connect: `curl -fsSL ${server}/connect-runner | ADE_KEY=${key} sh -s -- --name ${name} --dir .`,
	}
}
async function revoke(name) {
	const had = await commit(async (tx) => {
		const all = await tx.doc(Keys)
		if (!all[name]) return false
		delete all[name]
		return true
	})
	if (!had) throw Object.assign(new Error(`No runner named ${name}`), { status: 404 })
	runners.kick(name, 4001, `${name} was revoked`)
	notify(['runners'])
	return { revoked: name }
}

// ── Upgrade: sockets and runner connections ───────────────────────────────

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: true })
async function upgrade(req, raw, head) {
	const url = new URL(req.url, 'http://localhost')
	/** A module's own socket, at /api/<module> or for a thread at /api/threads/:id/<module>: the module's `connect` takes it */
	const [, threadId, named] = url.pathname.match(/^\/api\/(?:threads\/(\d+)\/)?([\w-]+)$/) ?? []
	const taker = modules.find((module) => module.name === named && module.connect)
	if (url.pathname !== '/ws' && !taker) return raw.destroy()
	if (req.headers.origin && req.headers.origin !== origin(req))
		return raw.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
	const socket = await new Promise((resolve) => wss.handleUpgrade(req, raw, head, resolve))
	if (taker)
		return taker.connect(threadId && Number(threadId), socket, url).catch((error) => {
			console.error(`${named} socket: ${error.message}`)
			socket.close(4004, error.message.slice(0, 120))
		})
	const name = url.searchParams.get('runner')
	/** A runner's connection: once closed, by its socket or by a newer one for its name, it stops wherever it is */
	const connection =
		name &&
		runners.connection(name, (code, reason) =>
			code ? socket.close(code, reason) : socket.terminate(),
		)
	const close = () => {
		clients.delete(socket)
		watch(socket, null)
		if (connection && runners.disconnect(connection)) {
			say('runner', `${name} offline`)
			notify(WORK)
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
		listen((text) => {
			const message = JSON.parse(text)
			if ('earlier' in message) earlier(socket, message.earlier, message.all)
			else watch(socket, message.watch)
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
				? `${name}'s key is wrong or was revoked; on the server: node cli.js key ${name}`
				: `${name} needs a key; on the server: node cli.js key ${name}`,
		)
	}
	runners.register(connection)
	const query = (param) => url.searchParams.get(param) || ''
	const resolved = (await known())[name]?.models ?? {}
	if (connection.phase === 'closed') return
	const runner = {
		owner: query('owner') && speaker(query('owner')),
		allow: url.searchParams.getAll('allow').map(speaker),
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
	if (!models.getProvider(`runner:${name}`))
		models.setProvider(runnerProvider(runners, name, resolved))
	listen(runners.receive)
	runners.connect(connection, (text) => socket.send(text))
	notify(WORK)
	socket.send(JSON.stringify({ op: 'ready' }))
	if (runner.version && runner.version !== bundle.version) {
		outdated.add(connection)
		notify(['runners'])
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
async function saveSettings({ modules: wanted = {}, memory, director, bots }) {
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
	if (memory !== undefined) {
		const model = typeof memory.model === 'string' ? memory.model.trim() : ''
		if (model && !model.includes('@'))
			throw new Error("A memory model is model@runner, or empty for each thread's agent")
		if (memory.model !== undefined) {
			if (model) next.memory = { ...next.memory, model }
			else if (next.memory) delete next.memory.model
		}
		if (memory.compactAt !== undefined) {
			const tokens = Number(memory.compactAt)
			if (!Number.isInteger(tokens) || tokens < 10000)
				throw new Error('memory compacts past at least 10000 tokens')
			if (tokens === 100000) delete next.memory?.compactAt
			else next.memory = { ...next.memory, compactAt: tokens }
		}
		if (next.memory && !Object.keys(next.memory).length) delete next.memory
	}
	if (director !== undefined) {
		if (director.model !== undefined) {
			const model = typeof director.model === 'string' ? director.model.trim() : ''
			if (model) next.director = { ...next.director, model }
			else if (next.director) delete next.director.model
		}
		/** Each number as given, checked as the director reads it; a default is left out of ade.json */
		const fallbacks = { context: 20, timeout: 60, burst: 1.5 }
		for (const [field, fallback] of Object.entries(fallbacks)) {
			if (director[field] === undefined) continue
			const value = Number(director[field])
			directorTimes({ [field]: value })
			if (value === fallback) delete next.director?.[field]
			else next.director = { ...next.director, [field]: value }
		}
		if (next.director && !Object.keys(next.director).length) delete next.director
	}
	if (bots !== undefined) {
		if (typeof bots.voice !== 'string') throw new Error('bots voice is text')
		if (bots.voice === DEFAULT_VOICE) {
			if (next.bots) delete next.bots.voice
		} else next.bots = { ...next.bots, voice: bots.voice }
		if (next.bots && !Object.keys(next.bots).length) delete next.bots
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
	process.execve(process.execPath, process.argv, { ...process.env, PORT: String(port) })
}

/** The server connects this machine too, in its `--dir` folders */
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
	// Through this process's own output, so the log has it too
	lent.stdout.on('data', (chunk) => process.stdout.write(chunk))
	lent.stderr.on('data', (chunk) => process.stderr.write(chunk))
	for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => lent.kill(signal))
}

// A list of names alone replaces the defaults, so say which of them it left out.
const off = (on) =>
	Object.keys(defaults).filter(
		(name) => defaults[name] === on && !modules.some((module) => module.name === name),
	)
for (const host of process.env.HOST ? [process.env.HOST] : ['127.0.0.1', '::1']) {
	const server = http.createServer(handleRequest)
	server.on('upgrade', (req, socket, head) =>
		upgrade(req, socket, head).catch((error) => {
			console.error(error)
			socket.destroy()
		}),
	)
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
			say(
				'modules',
				[
					modules.map((module) => module.name).join(' ') || 'none',
					...(off(false).length ? [`off: ${off(false).join(' ')}`] : []),
					...(off(true).length ? [`defaults left out: ${off(true).join(' ')}`] : []),
				].join(' · '),
			)
		}
		connectSelf(
			`http://${host === '0.0.0.0' ? '127.0.0.1' : addresses[0]}:${listening.port}`,
		).catch((error) => console.error(error))
	})
}
