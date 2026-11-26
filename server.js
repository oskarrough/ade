#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
	appendFileSync,
	existsSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	watch as watchFiles,
	writeFileSync,
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { DatabaseSync } from 'node:sqlite'
import { parseArgs } from 'node:util'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import {
	clampThinkingLevel,
	createModels,
	getSupportedThinkingLevels,
} from '@earendil-works/pi-ai/models'
import {
	AgentDoc,
	configure,
	createRegistry,
	defineDoc,
	defineDocFamily,
	defineExtension,
	defineTask,
	defineTool,
	Harness,
	InboxDoc,
	LiveDoc,
	SubmissionSettled,
} from '@earendil-works/pi-durable'
import { num, obj, opt, str } from '@earendil-works/pi-schema'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	DEFAULT_IMAGE_LIMITS,
} from '@earendil-works/pi-durable/tools'
import { createNodePhotonImages } from '@earendil-works/pi-durable/images/node'
import { createCodemodeExtension } from '@earendil-works/pi-durable/codemode'
import { CodemodeSandbox } from '@earendil-works/pi-codemode'
import { about, builtIn, dataDir, leftovers, load, loadEnvFile, readConfig } from './modules.js'
import { DEFAULT_VOICE } from './modules/bots.js'
import { WebSocketServer } from 'ws'
import {
	AGENT,
	writtenTo,
	storedTo,
	writtenBy,
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
	stepText,
	errorLine,
	plainError,
} from './util.js'
import { addressed, serveImage } from './images.js'
import { watchVersion } from './version.js'
import { createFeed } from './feed.js'
import { createRead } from './read.js'
import { createRunners, messageText, remoteEnv, runnerBundle, runnerProvider } from './remote.js'

/**
 * @typedef {{ runner: string, model: string, thinkingLevel?: import("@earendil-works/pi-ai").ThinkingLevel, dir?: string, name?: string, home?: number, forgotten?: true }} To  An agent as it runs:
 *   the thread's own, or with `name` and `home`, a bot, `forgotten` once it's no bot. Asking one as another model, thinking or runner changes it in place.
 * @typedef {object} Message  The data of every thread entry.
 * @property {string} author  A human's name, a bot's as it was then, or the thread's agent as `model:thinking@runner` when it wrote.
 * @property {import("@earendil-works/pi-durable").ConversationId} [conversation]  The conversation of the agent that wrote it, on
 *   all an agent writes but answers, which hold it in `answer`; older messages have none.
 * @property {string} body
 * @property {string} [createdAt]  When it was written, as an ISO time, which append stamps; a pi session's message keeps pi's. Older messages have none.
 * @property {{ type: 'image', mimeType: string, data: string }[]} [images]  As pi's ImageContent, base64; the agent sees them with the words.
 * @property {string[]} [to]  Whom it asks: a bot by its home's id, the thread's agent as `model:thinking@runner`; older messages name bots.
 * @property {number} [from]  The thread it came from.
 * @property {number[]} [re]  What it answers: messages here, or with `from`, posts there.
 * @property {{ conversation: import("@earendil-works/pi-durable").ConversationId, entry: number }} [answer]  The agent's entry it copies.
 * @property {true} [waitingOnPerson]  An agent's explicit question, open until a person next writes.
 * @property {true} [posted]  A bot's own post in a thread it's in, or opens, with its post tool: an agent's, as its answers are.
 * @property {number} [scheduledTask]  The scheduled task that posted it, when its time came: an agent's own instructions
 *   back to it, or a person's, as they set them.
 * @property {string} [checked]  What that task's check found before the run, which the agent reads beside the instructions.
 * @property {true} [error]  The agent gave no answer.
 * @property {true} [stopped]  Its author pressed Stop while the thread was working; the body says `stopped`.
 * @property {{ runner: string, code: number | null, stdout: string, stderr: string, error?: string }} [shell]  What `$ cmd` printed.
 * @typedef {{ name: string, conversation: import("@earendil-works/pi-durable").ConversationId, to: To | null, status: string, contextWindow?: number }} Agent  An agent or bot, as a thread view shows it.
 * @typedef {{ conversation: import("@earendil-works/pi-durable").ConversationId, after: number, earlier?: number[], skip?: number[], admission?: { admit: number, deliver: number }, note?: string }} Recipient
 *   A thread doc's row for its agent, under `agent`, or a bot, under its home's id: its conversation; what it hasn't
 *   seen, as a position, every message for it after `after` but those in `skip`, and the few at or before it in
 *   `earlier`, held back while the director picked or given back by a Stop; its latest input's tasks; and what to tell
 *   it about a change before its next one.
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

/**
 * The store as it was before this start converted it. An installed release that stops before it comes up still has the
 * one it replaced beside it, in `<folder>.old`, and arbe desktop goes back to that one, which can't read the converted
 * store: so the store goes back too, and whatever this start wrote in the new shape goes with it.
 */
let unconverted
process.on('exit', () => {
	if (!unconverted || !existsSync(`${import.meta.dirname}.old/bin.js`)) return
	for (const suffix of ['-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true })
	renameSync(unconverted, file)
	console.log(
		'stopped before it came up; the store is back as it was before this release converted it',
	)
})

/**
 * A store from before members kept a place in the thread: each still holds the list of every message it hadn't been
 * handed, which this server doesn't read, so it would hand them nothing new. It converts them before it opens the store,
 * under its lock and in one transaction, after a copy of the store goes beside it: every member's place at the newest
 * entry, its old list kept as `earlier`.
 */
const oldThreads = String.raw`document_id in (select id from documents where kind = '"ade.thread"') and exists (select 1 from json_each(content, '$.agents') agent where agent.value -> '$.unseen' is not null)`
const oldMembers = (() => {
	if (!existsSync(file)) return false
	const db = new DatabaseSync(file, { readOnly: true })
	try {
		return Boolean(db.prepare(`select 1 from document_revisions where ${oldThreads} limit 1`).get())
	} catch (error) {
		if (/no such table/.test(error.message)) return false
		throw error
	} finally {
		db.close()
	}
})()
if (oldMembers) {
	const backup = [`${file}.before-positions`, `${file}.before-positions-${Date.now()}`].find(
		(name) => !existsSync(name),
	)
	const convert = String.raw`update document_revisions set content = json_set(content, '$.agents', json((select json_group_object(agent.key, json(iif(json_array_length(agent.value, '$.unseen') > 0, json_set(json_remove(agent.value, '$.unseen'), '$.after', newest.id, '$.earlier', json(agent.value -> '$.unseen')), json_set(json_remove(agent.value, '$.unseen'), '$.after', newest.id)))) from json_each(content, '$.agents') agent, (select max(id) as id from entries) newest))) where ${oldThreads}`
	const db = new DatabaseSync(file)
	try {
		db.exec(`vacuum into '${backup.replaceAll("'", "''")}'`)
		unconverted ??= backup
		db.exec(`begin immediate; ${convert}; commit`)
	} finally {
		db.close()
	}
	console.log(
		`converted thread members' unread messages to places in their threads; the store as it was is in ${backup}`,
	)
}
/**
 * A store from before bots had ids keys each bot by its name, in the bots document and in every thread it's in, so a
 * rename moved it everywhere. Bots are keyed by their home thread's id now. The server converts such a store before it
 * opens it, under its lock and in one transaction, after a copy of the store goes beside it (`convertBots`).
 */
const oldBots = String.raw`select 1 from documents d join document_revisions r on r.document_id = d.id, json_each(r.content) where d.kind = '"ade.bots"' and value -> '$.home' is not null union all select 1 from documents d join document_revisions r on r.document_id = d.id, json_each(r.content, '$.agents') where d.kind = '"ade.thread"' and value -> '$.named' is not null limit 1`
const botsByName = (() => {
	if (!existsSync(file)) return false
	const db = new DatabaseSync(file, { readOnly: true })
	try {
		return Boolean(db.prepare(oldBots).get())
	} catch (error) {
		if (/no such table/.test(error.message)) return false
		throw error
	} finally {
		db.close()
	}
})()
if (botsByName) {
	const backup = [`${file}.before-bot-ids`, `${file}.before-bot-ids-${Date.now()}`].find(
		(name) => !existsSync(name),
	)
	const db = new DatabaseSync(file)
	try {
		db.exec(`vacuum into '${backup.replaceAll("'", "''")}'`)
		unconverted ??= backup
		db.exec('begin immediate')
		try {
			convertBots(db)
			db.exec('commit')
		} catch (error) {
			db.exec('rollback')
			throw error
		}
	} finally {
		db.close()
	}
	console.log(
		`converted bots to be known by their home threads; the store as it was is in ${backup}`,
	)
}

/**
 * Each bot goes under its home with its name as a field. A thread's member keyed by a name goes under the home of the
 * bot that had that name when the member joined: the live bot of that name, from its home on, or one forgotten under it,
 * from its home until it was forgotten, as its trail says. A member no bot's span holds, or more than one's, keeps its
 * name, and so does its history; a forgotten bot with members gets a record of its name. A thread keeps the names it
 * re-keyed as `aliases`, for its older messages, which still say them. Each member's own messages it hasn't read, which it
 * told apart by its name and now tells by its conversation, it skips; its instructions lose its name, which the bots
 * section gives; scheduled tasks' recipients go by the thread's keys, and their last run's by conversation. No message
 * is rewritten.
 */
function convertBots(db) {
	const all = (sql, ...params) => db.prepare(sql).all(...params)
	const revisionsOf = (kind) =>
		all(
			`select r.document_id, r.seq, r.content, d.owner_id from document_revisions r join documents d on d.id = r.document_id where d.kind = ?`,
			JSON.stringify(kind),
		)
	const write = db.prepare(
		'update document_revisions set content = ? where document_id = ? and seq = ?',
	)
	const bots = revisionsOf('ade.bots')
	/** Each name's spans: a live bot's from its home on, a forgotten one's until it was forgotten */
	const spans = new Map()
	const span = (name, home, until) => spans.set(name, [...(spans.get(name) ?? []), { home, until }])
	for (const { content } of bots.slice(-1))
		for (const [name, bot] of Object.entries(JSON.parse(content)))
			if (bot.home) span(name, bot.home, Infinity)
	for (const step of all(
		`select id, record ->> '$.data.thread' as home, record ->> '$.data.bot' as name from entries where record ->> '$.kind' = 'ade.trail' and record ->> '$.data.kind' = 'bot-forgotten'`,
	))
		span(step.name, step.home, step.id)
	const homeOf = (name, conversation) => {
		const holding = (spans.get(name) ?? []).filter(
			({ home, until }) => conversation > home && conversation < until,
		)
		return holding.length === 1 ? holding[0].home : undefined
	}
	const forgotten = new Map()
	/** Each thread's keys, old to new, for its tasks */
	const keysIn = new Map()
	const ownUnread = db.prepare(
		`select id, record -> '$.data' as data from entries where conversation_id = ? and id > ? and record ->> '$.kind' = 'ade.message'`,
	)
	const instructions = db.prepare(
		`select r.document_id, r.seq, r.content from document_revisions r join documents d on d.id = r.document_id where d.kind = '"pi.agent"' and d.owner_id = ?`,
	)
	for (const { document_id, seq, content, owner_id: thread } of revisionsOf('ade.thread')) {
		const doc = JSON.parse(content)
		const agents = {}
		const aliases = { ...doc.aliases }
		const keys = new Map()
		for (const [key, { named, ...member }] of Object.entries(doc.agents ?? {})) {
			const bot = key !== AGENT && !key.includes('@')
			const home = bot && homeOf(key, member.conversation)
			const now = home ? String(home) : key
			if (home && !spans.get(key).some((one) => one.home === home && one.until === Infinity))
				forgotten.set(String(home), key)
			if (home) aliases[key] = now
			keys.set(key.includes('@') ? AGENT : key, { key: now, conversation: member.conversation })
			// What it would have taken for its own answers by its name, but its conversation doesn't say it wrote
			const skip = new Set(member.skip ?? [])
			for (const entry of ownUnread.all(thread, member.after)) {
				const data = JSON.parse(entry.data)
				const by = data.author?.includes('@') ? AGENT : data.author
				const answers = data.answer || data.error || data.re || data.waitingOnPerson
				if (by === key && !data.from && answers && entry.id >= (named ?? 0))
					if (data.answer?.conversation !== member.conversation) skip.add(entry.id)
			}
			if (skip.size) member.skip = [...skip].sort((left, right) => left - right)
			else delete member.skip
			agents[now] = member
			if (bot)
				for (const agent of instructions.all(member.conversation)) {
					const value = JSON.parse(agent.content)
					const prefix = `You are ${key} in thread `
					if (!value.instructions?.startsWith(prefix)) continue
					value.instructions = `You are a bot in thread ${value.instructions.slice(prefix.length)}`
					write.run(JSON.stringify(value), agent.document_id, agent.seq)
				}
		}
		keysIn.set(thread, keys)
		write.run(
			JSON.stringify({
				...doc,
				agents,
				...(Object.keys(aliases).length ? { aliases } : {}),
			}),
			document_id,
			seq,
		)
	}
	const tasks = all(
		`select id, conversation_id as thread, record from tasks where kind = '"ade.scheduled-task"'`,
	)
	const writeTask = db.prepare('update tasks set record = ? where id = ?')
	for (const { id, thread, record } of tasks) {
		const task = JSON.parse(record)
		const keys = keysIn.get(thread) ?? new Map()
		const recipients = (list) => list.map((name) => keys.get(name)?.key ?? name)
		if (task.input?.recipients) task.input.recipients = recipients(task.input.recipients)
		const checkpoint = task.state?.checkpoint
		if (checkpoint?.recipients) checkpoint.recipients = recipients(checkpoint.recipients)
		const last = checkpoint?.last
		if (last?.to) {
			const there = keysIn.get(last.thread) ?? new Map()
			last.to = last.to
				.map((name) => there.get(name.includes('@') ? AGENT : name)?.conversation)
				.filter(Boolean)
		}
		writeTask.run(JSON.stringify(task), id)
	}
	for (const { document_id, seq, content } of bots) {
		const now = Object.fromEntries(
			Object.entries(JSON.parse(content)).map(([name, { home, ...bot }]) => [
				home,
				{ ...bot, name },
			]),
		)
		for (const [home, name] of forgotten) now[home] ??= { name, forgotten: true }
		write.run(JSON.stringify(now), document_id, seq)
	}
}
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
/** The cookie a browser keeps its key in, the owner's or an invite's; per port, since cookies ignore ports */
const keyCookie = () => `ade_key_${port}`
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
/** The key a browser keeps as the cookie */
const cookieKey = (req) =>
	String(req.headers.cookie ?? '')
		.split(/;\s*/)
		.find((pair) => pair.startsWith(`${keyCookie()}=`))
		?.slice(keyCookie().length + 1)
/** The key a request shows, as a bearer or the cookie */
const keyIn = (req) => /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? cookieKey(req)
/**
 * Who sent a request, from how it arrived, never from a name it gives: the owner's key, as a bearer or the cookie, is
 * the owner anywhere. With invites on, an invite's key is its name, and nothing else gets in: no login, no localhost.
 * With them off, on Serve's listener, the login Tailscale names; on the main one, a request straight from this
 * machine, not through a proxy, is the owner. Anyone else is nobody: null.
 */
function whoSent(req, serve) {
	const given = keyIn(req)
	if (given && isOwnerKey(given)) return owner
	// An invite under the owner's name, the owner having taken it since, is nobody
	if (invitesOn) {
		const guest = given && guests.get(sha256(given))
		return guest && guest !== owner ? guest : null
	}
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
/**
 * Whether a request comes from an agent's command, on this machine, working for this server: a runner marks what its
 * agents run with ADE_AGENT_OF, the server they work for. Such a request reads but writes nothing, with the owner's key
 * or without, so an agent never speaks as a person. Asked once per connection; only Linux says whose a connection is.
 */
const agentConnections = new WeakMap()
function fromAgent(req) {
	const { socket } = req
	if (!loopback(socket.remoteAddress ?? '')) return false
	if (!agentConnections.has(socket)) agentConnections.set(socket, agentPeer(socket))
	return agentConnections.get(socket)
}
function agentPeer(socket) {
	const hex = (number) => `:${number.toString(16).toUpperCase().padStart(4, '0')}`
	let inode
	for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
		let text = ''
		try {
			text = readFileSync(table, 'utf8')
		} catch {
			continue
		}
		for (const line of text.split('\n').slice(1)) {
			const fields = line.trim().split(/\s+/)
			if (fields[1]?.endsWith(hex(socket.remotePort)) && fields[2]?.endsWith(hex(socket.localPort)))
				inode = fields[9]
		}
	}
	if (!inode || inode === '0') return false
	const link = `socket:[${inode}]`
	// Only a process marked as working for this server can make it an agent's, so only those have their sockets looked at
	return readdirSync('/proc').some((pid) => {
		if (!/^\d+$/.test(pid) || Number(pid) === process.pid) return false
		try {
			const marked = readFileSync(`/proc/${pid}/environ`, 'utf8')
				.split('\0')
				.find((pair) => pair.startsWith('ADE_AGENT_OF='))
				?.slice('ADE_AGENT_OF='.length)
			if (!marked || ![port, servePort].includes(Number(new URL(marked).port || 80))) return false
			return readdirSync(`/proc/${pid}/fd`).some((fd) => {
				try {
					return readlinkSync(`/proc/${pid}/fd/${fd}`) === link
				} catch {
					return false
				}
			})
		} catch {
			return false
		}
	})
}
const agentRefused =
	'An agent writes here only through its own tools, never as a person. Put what you have to say, images as `![](path)`, in your answer; to reach another thread, use the post tool.'
/**
 * The owner by a tailnet login alone, through Serve, with no owner key shown. Tailscale names a machine's user, not the
 * process, so an agent on that machine comes in with the same login: it reads as the owner and writes nothing.
 */
function ownerByLogin(req, serve) {
	const given = keyIn(req)
	return serve && !invitesOn && !(given && isOwnerKey(given)) && whoSent(req, serve) === owner
}
const loginRefused = `Through Tailscale your login only reads as the owner, since an agent on your device comes in with it too. To write, bring this device in once with the owner link, from Settings' People on a device that has it or \`ade link\` on the server's machine; the CLI takes ADE_OWNER_KEY. ${agentRefused}`
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
const nobody = (serve, req) =>
	invitesOn && cookieKey(req)
		? // Only a key that once opened the house becomes the cookie
			'Your invite to this house was taken back'
		: invitesOn
			? 'This house lets in only people with a key: open the invite link you were given, or, as its owner, the one `ade link` prints'
			: serve
				? 'Tailscale Serve named nobody: open it from a device logged in to the tailnet'
				: 'Who are you? Open the link `ade link` prints on the server, or send its owner key as a bearer'
// ── Docs and tasks ────────────────────────────────────────────────────────

const KIND = 'ade.message'
/** Whom the director picked for a message saved before it chose: `{message, to, picked}`, read as that message's own */
const ROUTE = 'ade.route'
/** A message its author took back before any agent read it: `{message}`; the message reads as `withdrawn` from then on */
const WITHDRAWAL = 'ade.withdrawal'
const WITHDRAWN = 'withdrawn'
/**
 * One step of a message's story, written in the commit that takes it: `{thread, entry, at, kind, …}`, `entry` the
 * message it's about. They go in a conversation of the thread's own, its `trail`, so reading messages never reads them;
 * the thread's trail reads them back (GET /api/threads/:id/trail).
 */
const TRAIL = 'ade.trail'
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
/** Who made each runner a guest made, by its name, kept after its key is revoked; one made by the owner isn't here */
const Makers = sessionDoc('ade.makers', () => ({}))
/** Each invite, by the name on it: `{key, at}`, `key` the SHA-256 of the key it gave */
const Invites = sessionDoc('ade.invites', () => ({}))
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
		/** A store from before bots had ids, converted: each bot name its older messages say, to the key it went under */
		aliases: null,
		/** The conversation its trail's steps go in, from its first; a fork starts its own */
		trail: null,
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
	/** @returns {{ key: string, text: string, images: any[], pick: any, page?: string, sent?: string }} */
	initial: () => ({ key: '', text: '', images: [], pick: null }),
})
const now = () => new Date().toISOString()
/**
 * Writes one step of the trail, inside the commit that takes it, starting the thread's trail conversation with its
 * first; `entry` may be undefined for a step of no message
 */
async function trailed(tx, threadId, entry, kind, data = {}) {
	const row = await tx.doc(Thread, threadId)
	if (!row.trail) {
		const anchor = await tx.createTask(Anchor, null, { ...own, conversationId: threadId })
		row.trail = (await tx.createConversation({ ownership: { kind: 'task', taskId: anchor } })).id
	}
	return tx.appendEntry(row.trail, {
		kind: TRAIL,
		data: {
			thread: threadId,
			...(entry === undefined ? {} : { entry }),
			at: Date.now(),
			kind,
			...data,
		},
	})
}
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
 * agent hasn't seen, up to the message that asked, in the commit that submits it: until then its position stays,
 * so a failed or stopped admission has nothing to give back. With `turn`, the Deliver of the agent named before it, it
 * starts once that answer has landed and takes it too, with any other agent's answer since; a person's newer message
 * asks on its own.
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
			const recipient = recipientOf(row, agent)
			const { note } = recipient
			// It reads only from its position, however long the thread
			const since = await messages(threadId, { after: readFrom(recipient) })
			/** Its turn comes after the answer before it, so it takes that answer and other agents' since, but no
			 * person's newer message, which asks it on its own */
			const waiting = new Set(row.unpicked ?? [])
			const answers = new Set(
				turn
					? since.filter((entry) => entry.id > upTo && byAgent(entry.data)).map((entry) => entry.id)
					: [],
			)
			const held = unseenIn(recipient, since).filter(
				(id) => (id <= upTo || answers.has(id)) && !waiting.has(id),
			)
			if (!held.length) return rt.commit(() => finished('completed', { held }), ctx)
			await prepare?.(threadId, agent, rt.signal)
			const given = new Set(held)
			const mine = await Promise.all(
				since
					.filter((entry) => given.has(entry.id))
					.map((entry) => skillCommand(row, entry, agent, rt.signal)),
			)
			const first = await firstWrote(threadId)
			const people = (upTo) =>
				[...first]
					.filter(([author, at]) => at <= upTo && keyOf(author) !== AGENT)
					.map(([author]) => author)
			/** One person's words come as typed; once a second has written, each person's come tagged, and the agent hears whose the untagged ones were */
			const plain = people(Math.max(...held)).length < 2
			const before = people(Math.min(...held) - 1)
			const joined =
				!plain && before.length === 1 && `[Every message above without a tag is ${before[0]}'s.]`
			const say = (entry) => said(entry, plain && person(row, entry))
			const told = catchUp ? await catchUp(threadId, mine, agent, say) : mine.map(say).join('\n\n')
			const text = [note, joined, told].filter(Boolean).join('\n\n')
			const images = mine.flatMap((entry) => entry.data.images ?? [])
			const content = images.length ? [...(text ? [{ type: 'text', text }] : []), ...images] : text
			const handle = await rt.conversation(agent, ctx)
			const entry = { kind: DELIVERY, data: { held } }
			const deliver = await deliverOf(threadId, id)
			await rt.commit(async (tx) => {
				// A message withdrawn while this read the thread is no longer unseen: read it again without
				const left = recipientOf(await tx.doc(Thread, threadId), agent)
				if (held.some((id) => !unseen(left, id)))
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
					...(deliver && { notify: { taskId: deliver, key: ANSWERED } }),
					whenBusy: steer ? 'steer' : 'followUp',
				})
				const row = await tx.doc(Thread, threadId)
				hand(recipientOf(row, agent), held, since)
				if (note && recipient.note === note) delete recipient.note
				await trailed(tx, threadId, Math.max(...held), 'started', {
					agent: await nameIn(tx, row, agent),
					held,
					...(deliver && { run: deliver }),
				})
				return finished('completed', { submission, held, ...(note ? { note } : {}) })
			}, ctx)
		},
	},
	abort: (task, rt, ctx) => rt.commit(() => finished('aborted'), ctx),
})

/** A person's `/skill:name` message as the agent reads it, expanded on its runner in its folder as pi does */
async function skillCommand(row, entry, agent, signal) {
	if (!expand || !entry.data.body?.startsWith('/skill:') || !person(row, entry)) return entry
	const { model, cwd } = await harness.snapshot(AgentDoc, agent, context)
	const runner = model.provider.replace(/^runner:/, '')
	const body = await expand(entry.data.body, runner, cwd, signal)
	return { ...entry, data: { ...entry.data, body } }
}

/** The Deliver that tells the thread what admission `admit` brings; it waits on it, so it's still waiting */
async function deliverOf(threadId, admit) {
	const waiting = await collect((cursor) =>
		storage.scanTasks(
			{ conversationId: threadId, kind: Deliver.definition.name, status: 'waiting' },
			100,
			cursor,
			context,
		),
	)
	return waiting.find((task) => /** @type {any} */ (task.input).admit === admit)?.id
}

/** The key a Deliver sleeps on until its submission settles */
const ANSWERED = 'answered'

/**
 * A durable wait observes admission faults too; onReport is only diagnostic. While the agent answers, Deliver sleeps
 * until Pi signals the submission settled, so crashes meanwhile don't count against it, however long the answer takes.
 */
const Deliver = defineTask({
	name: 'ade.deliver',
	version: 1,
	initial: () => ({ phase: 'wait' }),
	phases: {
		wait: ({ input: { admit } }, rt, ctx) => rt.commit(() => waiting([admit], 'tell'), ctx),
		async tell({ id, conversationId: threadId, input: { admit, agent, upTo } }, rt, ctx) {
			const [result] = /** @type {any[]} */ (await rt.outcomes([admit], ctx))
			const submitted = result.status === 'completed' ? result.result : null
			if (submitted && !submitted.submission) return rt.commit(() => finished(), ctx)
			const submission =
				submitted?.submission && (await harness.submission(submitted.submission, ctx))
			const now = submission && (await submission.status(ctx))
			if (now?.notify && now.status !== 'done' && now.status !== 'unanswered')
				return rt.commit(
					() => ({
						status: 'sleeping',
						signals: [SubmissionSettled.key(ANSWERED)],
						checkpoint: { phase: 'tell' },
					}),
					ctx,
				)
			const settled = submission
				? await submission.wait(ctx)
				: { id: admit, status: 'unanswered', reason: result.error?.detail?.reason ?? result.status }
			const told = await outcome(threadId, agent, settled, submitted?.held ?? [upTo])
			await rt.commit(
				async (tx) => (
					await tell(tx, threadId, agent, settled, submitted, told, upTo, id),
					finished()
				),
				ctx,
			)
		},
	},
	/** Pi's abort of the thread withdrew its input if still queued. */
	abort: ({ id, conversationId: threadId, input: { admit, agent, upTo } }, rt, ctx) =>
		rt.commit(async (tx) => {
			const submitted = /** @type {any} */ ((await tx.task(admit)).state.outcome?.result)
			const record = submitted?.submission && (await tx.submissionByRequest(agent, String(admit)))
			if (record && record.entry === undefined && record.reason !== WITHDRAWN)
				await restore(tx, threadId, agent, submitted)
			const held = submitted?.held ?? [upTo]
			if (held.length)
				await trailed(tx, threadId, Math.max(...held), 'stopped', {
					agent: await nameIn(tx, await tx.doc(Thread, threadId), agent),
					conversation: agent,
					held,
					run: id,
				})
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
				result.ok === true
					? { code: result.value.exitCode }
					: { error: errorLine(result.error, `shell ${id}`) }
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

/** A runner's calls show in no list; one ending may let an outdated runner update */
const runners = createRunners({ onChange: () => nudge() })
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

/** The read model's worker moves the write-ahead log into the database, off this thread; Pi's commits do it only
 * if the log grows far past where the worker keeps it, as when the worker is down, since doing it here stalls everything */
const storage = await openNodeSqliteStorage(file, { walAutoCheckpointPages: 100_000 })
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
/** The house as SQL tables, told of every commit from the moment Pi opens: tasks it resumes commit at once */
const read = createRead(file, harness)
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
/** Pi closed, then the SQL tables told of every commit it published, so the next start keeps them */
const close = () => read.stop(() => harness.close(context))
for (const signal of ['SIGINT', 'SIGTERM'])
	process.on(signal, () => {
		console.error(`stopped by ${signal}`)
		if (stopping) return process.exit(0)
		stopping = Promise.race([
			close(),
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
const heardAuthor = (entry, wrote = writers.get(entry.conversationId)) => {
	if (!wrote) return
	if (entry.kind === KIND && !byAgent(entry.data)) {
		const { author, stopped } = entry.data
		wrote.authors.add(author)
		if (!stopped) wrote.first.set(author, Math.min(wrote.first.get(author) ?? Infinity, entry.id))
	}
}
harness.observeCommits({
	advance: ({ changes }) => {
		for (const change of changes) {
			if (change.type === 'entry') {
				heardEntry(change.value)
				heardAuthor(change.value)
				facts?.delete(change.value.conversationId)
			}
			if (change.type === 'conversation' && !change.value.owner)
				records.set(change.value.id, change.value)
		}
	},
	end: () => {},
})

function setOffers(runner, offered) {
	Object.assign(runner, {
		offers: offered.offers ?? [],
		thinkingLevels: offered.thinkingLevels ?? {},
		metered: offered.metered ?? [],
		free: offered.free ?? [],
	})
}
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

/** Every thread, newest first */
const threadIds = () => [...placed.keys()].sort((a, b) => b - a)

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
	// A bot by its home, as a pick made before a rename holds it, else by name; what `to` leaves out, it runs as now
	const bot =
		to?.home !== undefined
			? await botAt?.(to.home)
			: typeof to?.name === 'string' && (await botAgent?.(to.name))
	if ((to?.home !== undefined || to?.name !== undefined) && !bot)
		throw new Error(
			`${to.name ?? to.home} is no bot: only bots have names, and a thread's agent has none`,
		)
	if (bot) to = { ...bot, ...to }
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
	if (clean.thinkingLevel) clean.thinkingLevel = await clamped(clean, clean.thinkingLevel)
	if (bot) Object.assign(clean, { name: bot.name, home: bot.home })
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
/** A level the model can use, as pi clamps one, so a level it can't use is never saved or shown; as asked for a model the server hasn't resolved */
const clamped = async (to, level) => {
	const model = to.model && (await known())[to.runner]?.models?.[to.model]
	return model && level ? clampThinkingLevel(model, level) : level
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
	// A forgotten bot's agent stays where it was, under the name it had
	const labels = typeof text === 'string' && agents ? ((await botLabels?.()) ?? {}) : {}
	const kept = Object.keys(agents ?? {}).find((key) => labels[key] === text)
	if (kept) return agentOf(agents[kept].conversation, kept)
	if (text === AGENT) throw new Error(`Thread ${threadId} has no agent yet`)
	const asked = typeof text === 'string' ? agentTo(text) : text
	const key = !command && (asked?.name === undefined ? AGENT : (await botAgent?.(asked.name))?.home)
	const agent = key && agents?.[key] ? await agentOf(agents[key].conversation, key) : null
	const resolved = await address(asked, command, signal, !agent?.thinkingLevel)
	if (!agent) return resolved
	// The agent is there already, so this switches it from this message on. What the ask leaves out stays as it was:
	// its thinking, as a runner alone resolves to pi's default thinking there, which no one asked for, and on the same
	// runner its folder.
	const { thinkingLevel, dir, ...model } = resolved
	const level = await clamped(
		resolved,
		asked?.thinkingLevel || (asked?.model && thinkingLevel) || agent.thinkingLevel || thinkingLevel,
	)
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
	const runner = agent?.model?.provider?.match(/^runner:(.+)$/)?.[1]
	if (!runner) return null
	const runners = tx ? await tx.doc(Runners) : (all ?? (await known()))
	const settings = {
		runner,
		model: agent.model.modelId,
		thinking: agent.thinkingLevel,
		folder: agent.cwd,
	}
	return placedTo(settings, runners, await whoIs(key ?? (await home(id))?.key))
}
/** An agent as the page shows it, from its `settings` as `ade_agents` has them: its folder relative to its runner's
 * first, among the `runners` as known, and `who` it is, a bot's `name` and `home`, as `whoIs` tells */
function placedTo({ runner, model, thinking, folder }, runners, who) {
	const rel = runners[runner] && folder ? path.relative(runners[runner].dir, folder) : ''
	const dir = rel.startsWith('..') ? folder : rel
	return {
		runner,
		model,
		...(thinking ? { thinkingLevel: thinking } : {}),
		...(dir ? { dir } : {}),
		...who,
	}
}
/** Who the agent under `key` in a thread is: nothing for the thread's own, a bot's `name` and `home`, or a bot's name
 * that was its key before bots had ids; `forgotten` unless that bot is one now. `names`, `{live, all}`, the bots' names
 * by home, those now and every one, saves reading them for each */
async function whoIs(key, names = undefined) {
	if (!key || key === AGENT) return {}
	if (!/^\d+$/.test(key)) return { name: key, forgotten: true }
	const { live = {}, all = {} } = names ?? {
		live: await homesOf?.(),
		all: await botLabels?.(),
	}
	return {
		name: all[key] ?? `bot ${key}`,
		home: Number(key),
		...(live[key] === undefined && { forgotten: true }),
	}
}

/** Whom asking an agent asks: a bot as it is now, which may be another runner or model than its agent here; else the agent */
const askable = async (key, conversation) =>
	(key !== AGENT && (await botAt?.(key))) || agentOf(conversation, key)

/** The agents in a thread as asking them asks them: bots as they are now, by their homes */
const agentsHere = async (threadId) =>
	(
		await Promise.all(
			Object.entries((await thread(threadId)).agents).map(([key, agent]) =>
				askable(key, agent.conversation),
			),
		)
	).filter(Boolean)

// ── Live work and statuses ────────────────────────────────────────────────

/** Until the agent's runner is online; moving it while it waits stops the wait and asks it again (`moveAgent`) */
async function reachable(agent, signal) {
	const { model } = await harness.snapshot(AgentDoc, agent, context)
	await runners.online(model?.provider?.replace(/^runner:/, ''), signal)
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
				const on = to?.runner
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
/** An agent answering or a `$ cmd`: work on a runner */
const runsOnRunner = (kind) => kind === Deliver.definition.name || kind === Shell.definition.name
/** What counts as a thread working: work on a runner, or a module's own */
const isWork = (kind) => runsOnRunner(kind) || moduleWork.includes(kind)

/** Whether a thread has work: an agent answering or waiting for its runner, a `$ cmd`, a module's own, like a pick */
const busy = async (threadId) => (await work()).some((job) => job.thread === threadId)

/** @returns {Promise<Agent[]>} */
async function agentsIn(row, busy, all, facts = undefined, names = undefined) {
	names ??= { live: (await homesOf?.()) ?? {}, all: (await botLabels?.()) ?? {} }
	return Promise.all(
		Object.entries(row.agents).map(async ([key, { conversation }]) => {
			const settings = facts?.agents.get(conversation)
			// No model there means Pi holds none in the agent's own conversation yet, as for a fork's: Pi's read finds it
			const to = !settings?.model
				? await agentOf(conversation, key, undefined, all)
				: settings.runner && placedTo(settings, all, await whoIs(key, names))
			const status = busiest(
				busy.filter((job) => job.conversation === conversation).map((job) => job.status),
			)
			const contextWindow = to && models.getModel(`runner:${to.runner}`, to.model)?.contextWindow
			return {
				name: to ? writtenTo(to) : ((await whoIs(key, names)).name ?? key),
				conversation,
				to,
				status,
				...(contextWindow && { contextWindow }),
			}
		}),
	)
}

// ── Thread writes: entries, delivery, outcomes ────────────────────────────

/** @returns {Promise<import("@earendil-works/pi-durable").TypedEntry<any>[]>} */
async function entries(id) {
	const handle = await harness.conversation(id, context)
	return handle
		? collect((cursor) => handle.entries({ order: 'ascending' }, 500, cursor, context))
		: []
}
/** A thread's messages with their picks, oldest first: every one, or a window read back from its end, as `newest` takes it */
const messages = async (id, window) => newest(await conversation(id), window)
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
/** Whom the thread's newest message that asked anyone asked, read back from its end until it's found */
async function lastAsked(id) {
	const handle = await conversation(id)
	const routes = new Map()
	let names = []
	read: for (let cursor; ;) {
		const page = await handle.entries({ order: 'descending' }, 200, cursor, context)
		for (const entry of page.items) {
			if (entry.kind === ROUTE || entry.kind === WITHDRAWAL) routed([entry], routes)
			const to = entry.kind === KIND && withRoute(entry, routes).data.to
			if (to) {
				names = to
				break read
			}
		}
		if (!(cursor = page.next)) break
	}
	const row = await thread(id)
	return Promise.all(
		names.map(async (name) => {
			const key = memberKey(row, name)
			if (row.agents[key]) return askable(key, row.agents[key].conversation)
			return /^\d+$/.test(name) ? botAt?.(name) : whom(id, name)
		}),
	)
}

/**
 * An agent's own answer, which it never reads back: its turn's last words, or what it posted to its asker
 * @param {{ data: any }} entry
 * @param {Recipient} recipient
 */
const ownAnswer = ({ data: message }, recipient) =>
	writtenBy(message) === recipient.conversation &&
	!message.from &&
	Boolean(message.answer || message.error || message.re || message.waitingOnPerson)

/**
 * Writes a message, inside the caller's commit, and gives each agent it asks a Deliver task with all it hasn't seen.
 * @param {Message} message
 */
async function post(tx, threadId, message, options = {}) {
	let by = message.author
	/** An agent writes from another thread, or as a bot in its own room (`member`), and works with its runner's rights */
	if (options.opener) by = `@${options.opener.runner}`
	else if (message.from || options.member) {
		const row = await tx.doc(Thread, message.from ?? threadId)
		const recipient = message.conversation && recipientOf(row, message.conversation)
		if (!recipient) throw new Error('Only an agent can post from another thread')
		by = `@${(await agentOf(recipient.conversation, nameOf(row, recipient.conversation), tx)).runner}`
	}
	await reach(message.to ?? [], by, await tx.doc(Runners))
	if (options.member || options.opener) message = { ...message, posted: true }
	const entry = await append(tx, threadId, message, options)
	/** A bot that opens a thread joins it after its first message, which it has said and so never reads back */
	if (options.opener) {
		const row = await tx.doc(Thread, threadId)
		const key = keyOf(storedTo(options.opener))
		row.agents[key] = await newAgent(tx, threadId, { after: entry.entry })
		await setUp(tx, row.agents[key].conversation, threadId, options.opener)
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
	{ steer = false, direct = false, unlessPaused = false, fired = undefined } = {},
) {
	const row = await tx.doc(Thread, threadId)
	// A solo thread's message, decided outside this commit, asks no one if the thread was paused meanwhile
	if (unlessPaused && row.paused) [to, message] = [undefined, { ...message, picked: PAUSED }]
	const names = (to ?? []).map(storedTo)
	const data = { createdAt: now(), ...message, ...(to ? { to: names } : {}) }
	/** Those it asks have something to read: this message, unless it's their own answer, or what they had before */
	const behind = {}
	for (const key of names.map(keyOf))
		if (row.agents[key])
			behind[key] =
				!ownAnswer({ data }, row.agents[key]) || (await waits(tx, threadId, row.agents[key]))
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
	await ask(tx, row, threadId, entry.id, to ?? [], { steer, behind })
	const pick =
		direct && directing
			? await directing(tx, threadId, entry.id, {
					steer,
					author: message.author,
					covers,
				})
			: undefined
	if (pick) {
		row.picks[message.author] = pick
		row.unpicked = [...new Set([...row.unpicked, ...covers, entry.id])]
	}
	if (message.scheduledTask)
		await trailed(tx, threadId, entry.id, 'fired', { task: message.scheduledTask, ...fired })
	// An answer is its run's last step, `answered` or `failed`, unless it asks someone in turn
	const answer = message.answer || message.error
	if (!answer || names.length)
		await trailed(tx, threadId, entry.id, 'posted', {
			author: message.author,
			to: (to ?? []).map(writtenTo),
			...(pick ? { direct: true } : {}),
			...(message.picked ? { picked: message.picked } : {}),
		})
	if (!answer && !pick && !names.length) await trailed(tx, threadId, entry.id, 'nobody')
	return { entry: entry.id, to: (to ?? []).map(writtenTo), ...(pick ? { pick } : {}) }
}

/** Each agent `to` names gets a Deliver task for all it hasn't seen up to `upTo`; with `turns`, one after another */
async function ask(tx, row, threadId, upTo, to, { steer, behind }) {
	let turn
	for (const one of to) {
		const key = keyOf(storedTo(one))
		// New, it hasn't seen any of the thread
		if (!row.agents[key]) {
			row.agents[key] = await newAgent(tx, threadId, { after: 0 })
			await setUp(tx, row.agents[key].conversation, threadId, one)
		} else {
			await reconfigure(tx, row.agents[key], one, threadId)
			if (!behind[key]) continue
		}
		const recipient = row.agents[key]
		const { conversation: agent, admission: after } = recipient
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
	{ to, picked, chose },
	{ steer = false, pick, covers = [] } = {},
) {
	const { data } = await tx.entry(messageId)
	const row = await tx.doc(Thread, threadId)
	row.picks ??= {}
	const over = row.picks[data.author] !== pick
	// The author's newer message took over: this one asks no one, and whatever took over reads it; or all it picked
	// for was withdrawn since
	const gone = ![messageId, ...covers].some((id) => row.unpicked?.includes(id))
	if (over || gone) [to, picked] = [[], undefined]
	if (!over) {
		delete row.picks[data.author]
		// Its messages are free to be read now, whoever it asks
		row.unpicked = (row.unpicked ?? []).filter((id) => id !== messageId && !covers.includes(id))
		// Paused while the chooser ran: it starts no reply
		if (row.paused && to.length) [to, picked] = [[], PAUSED]
	}
	try {
		await reach(to, data.author, await tx.doc(Runners))
	} catch (error) {
		;[to, picked] = [[], `Pick failed: ${errorLine(error, 'director')}`]
	}
	const behind = {}
	for (const key of to.map((one) => keyOf(storedTo(one))))
		if (row.agents[key]) behind[key] = await waits(tx, threadId, row.agents[key])
	await tx.appendEntry(threadId, {
		kind: ROUTE,
		data: { message: messageId, to: to.map(storedTo), ...(picked ? { picked } : {}) },
	})
	await ask(tx, row, threadId, messageId, to, { steer, behind })
	if (chose?.waited !== undefined)
		await trailed(tx, threadId, messageId, 'waited', {
			ms: chose.waited,
			...(chose.held ? { held: true } : {}),
		})
	await trailed(tx, threadId, messageId, 'picked', {
		to: to.map(writtenTo),
		...(picked ? { picked } : {}),
		...(over ? { over: true } : {}),
		...(chose ? { chose } : {}),
	})
	if (!to.length) await trailed(tx, threadId, messageId, 'nobody')
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
async function reconfigure(tx, recipient, to, threadId) {
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
	await trailed(tx, threadId, undefined, 'changed', {
		agent: writtenTo(to),
		conversation: recipient.conversation,
		...ranAs(to, cwd),
	})
	if (remodelled)
		recipient.note = `[You now run as ${to.model}${to.thinkingLevel ? `:${to.thinkingLevel}` : ''} on ${to.runner}, in ${cwd}.${moved ? ' Files and paths from before may not be here; check them before you trust them.' : ''}]`
}

/**
 * Owned by an Anchor in the thread
 * @returns {Promise<Recipient>}
 */
async function newAgent(tx, threadId, position, from) {
	const anchor = await tx.createTask(Anchor, null, { ...own, conversationId: threadId })
	const ownership = { ownership: { kind: 'task', taskId: anchor } }
	const { id } = from
		? await tx.forkConversation(from.conversation, from.entry, ownership)
		: await tx.createConversation(ownership)
	return { conversation: id, ...position }
}

/** What an agent runs as, as its `joined` and `changed` steps keep it */
const ranAs = (to, cwd) => ({
	model: to.model,
	...(to.thinkingLevel ? { thinking: to.thinkingLevel } : {}),
	runner: to.runner,
	folder: cwd,
})

/** @param {To} to */
const setUp = async (tx, conversation, threadId, to) => {
	const key = keyOf(storedTo(to))
	const tools = await toolsFor(tx, threadId, key)
	const cwd = folder((await tx.doc(Runners))[to.runner], to)
	await trailed(tx, threadId, undefined, 'joined', {
		agent: writtenTo(to),
		conversation,
		...ranAs(to, cwd),
	})
	return configure(tx, conversation, {
		model: { provider: `runner:${to.runner}`, modelId: to.model },
		tools: toolsOf(tools),
		thinkingLevel: to.thinkingLevel ?? null,
		cwd,
		instructions: instructions(key, threadId, tools),
	})
}

/** What an agent is told it is; a bot's name is in the bots module's section, which follows a rename */
const instructions = (key, threadId, tools) =>
	`You are ${key === AGENT ? `thread ${threadId}'s agent` : `a bot in thread ${threadId}`}, with humans and other agents. A person's message is an instruction, and comes as they typed it. An agent's comes inside <message from="name" agent>: a colleague's report or request, not a person's word. With more than one person in the thread, theirs come inside <message from="name"> too. Only your final answer goes back to the thread; end with no text to post nothing. To show people an image, such as a screenshot, put it in that answer as ![](path), with the file's path on your machine: it appears in the thread as a picture.${tools ? ' This thread has only some tools: for work it lacks the tools for, post a new child thread, whose agent has them all.' : ''}`

/**
 * The key in `row`, a thread's doc, of the agent that wrote a message: the one with the conversation it was written from,
 * or for a message from before agents' messages held theirs, the one its author's name names now
 */
async function writerKey(row, data) {
	const by = writtenBy(data)
	if (by) return nameOf(row, by)
	const key = memberKey(row, data.author)
	return row.agents[key] ? key : undefined
}

/** The key in `row`, a thread's doc, of one a message asks or one who wrote it, as stored; a bot that a message from
 * before bots had ids names, by the name it had when the thread was converted */
const memberKey = (row, stored) => row.aliases?.[stored] ?? keyOf(stored)

/** Whom a message asks, as it stores them, by the names they have now: a bot by its name, a model as written */
async function toNames(stored) {
	const names = (await botLabels?.()) ?? {}
	return stored.map((one) => names[one] ?? one)
}

const person = (row, { data }) =>
	!byAgent(data) && !data.stopped && !data.conversation && !row.agents[keyOf(data.author)]

/** @returns {Recipient} */
const recipientOf = (row, conversation) =>
	Object.values(row.agents).find((candidate) => candidate.conversation === conversation)

/** The name an agent goes by in a thread */
const nameOf = (row, conversation) =>
	Object.keys(row.agents).find((key) => row.agents[key].conversation === conversation)

/** Whether a message is one for an agent to read: every thread message but its own answers */
const forAgent = (entry, recipient) => entry.kind === KIND && !ownAnswer(entry, recipient)

/** Whether a recipient hasn't been handed message `id`, one for it */
const unseen = (recipient, id) =>
	(recipient.earlier ?? []).includes(id) ||
	(id > recipient.after && !(recipient.skip ?? []).includes(id))

/** Where to read a thread from to find all a recipient hasn't been handed */
const readFrom = (recipient) =>
	Math.min(recipient.after, ...(recipient.earlier ?? []).map((id) => id - 1))

/** The messages a recipient hasn't been handed among a thread's, read from its `readFrom`: ids, oldest first */
const unseenIn = (recipient, entries) =>
	entries
		.filter((entry) => forAgent(entry, recipient) && unseen(recipient, entry.id))
		.map(({ id }) => id)

/** Sets a recipient's list, or leaves it out when empty, so its row stays a few bytes */
function listed(recipient, name, ids) {
	if (ids.length) recipient[name] = [...new Set(ids)].sort((left, right) => left - right)
	else delete recipient[name]
}

/** A recipient handed `held`, read from `entries`: its position moves past them, and what it passed over stays unseen */
function hand(recipient, held, entries) {
	const given = new Set(held)
	const top = Math.max(recipient.after, ...held)
	const skip = recipient.skip ?? []
	const passed = entries
		.filter((entry) => entry.id > recipient.after && entry.id <= top && forAgent(entry, recipient))
		.map(({ id }) => id)
		.filter((id) => !skip.includes(id))
	listed(
		recipient,
		'earlier',
		[...(recipient.earlier ?? []), ...passed].filter((id) => !given.has(id)),
	)
	listed(
		recipient,
		'skip',
		skip.filter((id) => id > top),
	)
	recipient.after = top
}

/** Whether a recipient has anything to read; inside a commit, before its entries */
async function waits(tx, threadId, recipient) {
	if (recipient.earlier?.length) return true
	const found = await firstIn(
		(cursor) =>
			tx.scanEntries(
				{ conversationId: threadId, order: 'ascending', minEntryId: recipient.after + 1 },
				50,
				cursor,
			),
		(entry) => forAgent(entry, recipient) && unseen(recipient, entry.id),
	)
	return Boolean(found)
}

/** The position that leaves just `ids` unseen among `shown`, a thread's messages, oldest first, reaching back past them */
function positionOf(ids, shown, recipient) {
	const left = new Set(ids)
	const position = {
		after: shown.findLast((entry) => forAgent(entry, recipient) && !left.has(entry.id))?.id ?? 0,
	}
	listed(
		position,
		'earlier',
		ids.filter((id) => id <= position.after),
	)
	return position
}

/** An input Pi withdrew before it was placed: its messages are unseen again, and its note untold */
async function restore(tx, threadId, conversation, { held, note }) {
	const recipient = recipientOf(await tx.doc(Thread, threadId), conversation)
	listed(recipient, 'earlier', [...(recipient.earlier ?? []), ...held])
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
	const held = ids.size
		? (await messages(threadId, { after: Math.min(...ids) - 1 })).filter((entry) =>
				ids.has(entry.id),
			)
		: []
	/** A thread answers the thread that started it on its own; a post from anywhere else gets an answer only through `post` */
	const row = await thread(threadId)
	const { parent } = row
	const asks = held.filter((entry) => entry.data.from && !entry.data.re)
	const posts = asks.filter((entry) => entry.data.from === parent)
	const re = held
		.filter((entry) => !asks.includes(entry) || posts.includes(entry))
		.filter((entry) => entry.data.to?.some((stored) => memberKey(row, stored) === key))
		.map((entry) => entry.id)
	let failure
	if (!done) {
		const settings = settled.reason === 'model_error' && (await agentOf(agent, key))
		const detail =
			settled.detail?.message ??
			(typeof settled.detail === 'string' ? settled.detail : settled.reason)
		if (settings)
			failure = `gave no answer: ${plainError(detail, settings, 'run', threadId).message}`
		else {
			console.error(`thread ${threadId} run:`, settled.reason, settled.detail)
			failure = `gave no answer: ${errorLine(detail)}`
		}
	}
	const body = done
		? messageText((await commit((tx) => tx.entry(settled.answer)))?.model?.[0])
		: failure
	const { words, images } = done ? await shown(agent, body) : { words: body, images: null }
	if (done && !words.trim() && !images) return []
	const result = done
		? { answer: { conversation: agent, entry: settled.answer } }
		: { error: true, conversation: agent }
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
				body: words,
				...(images ? { images } : {}),
				...(to.length ? { to } : {}),
				...(re.length ? { re } : {}),
				...result,
			},
		},
	]
	if (posts.length && reply)
		return [
			...told,
			...(await reply(posts, threadId, agent, name, words, images)).map((answer) => ({
				...answer,
				steer: true,
			})),
		]
	return told
}

const SHOWN = /!\[[^\]]*\]\(\s*<?([^()<>\s]+)>?\s*\)/g
const SHOWN_TYPES = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.bmp': 'image/bmp',
}
let photon

/** True at each index of `body` that falls inside a fenced code block or an inline code span */
function codeMask(body) {
	const mask = new Array(body.length).fill(false)
	const mark = (re) => {
		for (const match of body.matchAll(re))
			for (let i = match.index; i < match.index + match[0].length; i++) mask[i] = true
	}
	mark(/```[\s\S]*?```/g)
	mark(/`[^`\n]+`/g)
	return mask
}

/**
 * What an answer shows: each `![](path)` to a file on its agent's machine, read through its runner and shrunk to what a
 * model takes, becomes one of the message's images, up to 8; the words keep the rest. One it can't show says why.
 */
async function shown(agent, body) {
	const coded = codeMask(body)
	const found = [...body.matchAll(SHOWN)].filter(
		(match) =>
			!/^[a-z][\w+.-]+:/i.test(match[1]) &&
			!coded.slice(match.index, match.index + match[0].length).includes(true),
	)
	if (!found.length) return { words: body, images: null }
	const doc = await harness.snapshot(AgentDoc, agent, context)
	const runner = doc?.model?.provider?.match(/^runner:(.+)$/)?.[1]
	const home = runner && (await known())[runner]?.home
	const env = runner && remoteEnv(runners, runner, doc.cwd)
	const images = []
	const said = new Map()
	for (const [whole, at] of found) {
		const file = home && /^~(?=\/|$)/.test(at) ? home + at.slice(1) : at
		const mimeType = SHOWN_TYPES[path.extname(file).toLowerCase()]
		const image = await (async () => {
			if (!env) return 'its runner is unknown'
			if (!mimeType) return 'not a png, jpeg, gif, webp or bmp'
			if (images.length === 8) return 'a message holds 8 images'
			const info = await env.fileInfo(file, context)
			if (info.ok !== true) return errorLine(info.error, 'show image')
			if (info.value.size > 64 * 1024 * 1024) return 'over 64 MB'
			const bytes = await env.readBinaryFile(file, context)
			if (bytes.ok !== true) return errorLine(bytes.error, 'show image')
			photon ??= createNodePhotonImages()
			const prepared = await (await photon).prepare(bytes.value, mimeType, DEFAULT_IMAGE_LIMITS)
			return prepared
				? { type: /** @type {const} */ ('image'), mimeType: prepared.mimeType, data: prepared.data }
				: "it doesn't decode, or can't be shrunk to fit"
		})().catch((error) => errorLine(error, 'show image'))
		if (typeof image !== 'string') images.push(image)
		said.set(whole, typeof image === 'string' ? `(couldn't show ${at}: ${image})` : '')
	}
	const words = body
		.replace(SHOWN, (whole) => said.get(whole) ?? whole)
		.replace(/\n{3,}/g, '\n\n')
		.trim()
	return { words, images: images.length ? images : null }
}

/** Posts what a settled input told; a submitted input Pi never placed gives its messages back */
async function tell(tx, threadId, agent, settled, submitted, told, upTo, run) {
	const posted = []
	for (const { thread, data, steer } of told)
		posted.push({ thread, ...(await append(tx, thread, data, { steer })) })
	if (submitted?.submission && settled.entry === undefined && settled.reason !== WITHDRAWN)
		await restore(tx, threadId, agent, submitted)
	const held = submitted?.held ?? [upTo]
	const answer = posted.find((one) => one.thread === threadId)?.entry
	const stopped = settled.reason === 'aborted' || settled.reason === WITHDRAWN
	await trailed(
		tx,
		threadId,
		Math.max(...held),
		settled.status === 'done' ? 'answered' : stopped ? 'stopped' : 'failed',
		{
			agent: await nameIn(tx, await tx.doc(Thread, threadId), agent),
			conversation: agent,
			held,
			run,
			...(answer === undefined ? {} : { answer }),
			...(settled.status === 'done' || stopped
				? {}
				: {
						reason:
							told.find((one) => one.thread === threadId)?.data.body ?? errorLine(settled.reason),
					}),
		},
	)
}

/** The name an agent's conversation goes by in a thread: a bot's, or the thread agent's model@runner */
async function nameIn(tx, row, conversation) {
	const key = Object.keys(row.agents).find((key) => row.agents[key].conversation === conversation)
	if (!key) return String(conversation)
	if (key !== AGENT) return (await whoIs(key)).name
	const agent = await agentOf(conversation, key, tx)
	return agent ? writtenTo(agent) : AGENT
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
	await commit((tx) => tell(tx, threadId, agent, settled, submitted, told, upTo, task.id))
}

// ── Read views: threads, lists, people ────────────────────────────────────

/** A thread's own status, or when idle, `done` or `error` for an answer its reader hasn't read in a thread they wrote in; with no reader, anyone's read counts */
async function status(id, row, busy, reader, facts = undefined) {
	if (facts ? facts.question : await openQuestion?.(id, row)) return 'blocked'
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
	const found = facts
		? !facts.said || [...seen].some((read) => read >= facts.said)
			? 'idle'
			: facts.failed
				? 'error'
				: 'done'
		: ((await back(id, KIND, said)) ?? 'idle')
	// An answer or failure is the reader's only where they wrote; in a thread agents keep among themselves, its asker got it
	return found !== 'idle' && !(await concerns(id, reader, facts)) ? 'idle' : found
}
/** Whether a thread's failures and answers are `reader`'s to read: they wrote there; with no reader, any person did. The sidebar's dots and the inbox both ask this. */
async function concerns(id, reader, facts = undefined) {
	const wrote = facts ? persons(facts.writers) : await authors(id)
	return reader ? wrote.includes(reader) : wrote.length > 0
}
/** People only, as the server names them: a bot speaking in its own room writes with no agent's mark, and older stores
 * hold names anyone could claim */
const persons = (names) => names.filter((name) => name === owner || name.startsWith('~'))

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
		wrote = { authors: new Set(), first: new Map(), ready: undefined }
		writers.set(id, wrote)
		const loading = wrote
		wrote.ready = (async () => {
			// A thread all in its newest, as most are, needs no read of its own
			const tail = await recent(id)
			for (const record of tail.whole ? tail.entries : await entries(id))
				heardAuthor(record, loading)
		})()
		wrote.ready.catch(() => writers.get(id) === loading && writers.delete(id))
	}
	await wrote.ready
	return persons([...wrote.authors])
}
/** When each one who isn't an agent first wrote in a thread, by name, a stop aside: a message id */
async function firstWrote(id) {
	await authors(id)
	return writers.get(id).first
}

/** `homes`, each bot's home thread → its name, the `runners` as known and the bots' `names` save reading them for every row of a list */
async function threadRow(
	id,
	reader,
	all,
	homes,
	runnersKnown,
	facts = undefined,
	names = undefined,
) {
	const { reads, hidden, dismissed: _, picks: __, trail: ___, ...row } = await thread(id)
	const busy = all.filter((job) => job.thread === id)
	const agents = await agentsIn(
		row,
		busy,
		runnersKnown,
		facts,
		names && { live: homes ?? (await homesOf?.()) ?? {}, all: names },
	)
	const rowStatus = await status(id, { ...row, reads }, busy, reader, facts)
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
		latest:
			(facts ? facts.latest : await back(id, KIND, (entry) => entry.kind === KIND && entry.id)) ||
			id,
		...(!hidden && familyField(id)),
		conversation: await conversationRecord(id),
	}
}
/** `[id, row]` for each of `ids`, the row null for a thread the list doesn't show: the open ones, or the archived */
const threadRows = async (ids, reader, archived = false, facts = undefined) => {
	const [busy, homes, runnersKnown, names] = await Promise.all([
		work(),
		homesOf?.() ?? {},
		known(),
		botLabels?.() ?? {},
	])
	return Promise.all(
		ids.map(async (id) => [
			id,
			placed.get(id)?.hidden === archived
				? await threadRow(id, reader, busy, homes, runnersKnown, facts?.get(id), names)
				: null,
		]),
	)
}
/** Each shown thread's row; the client works out families from `parent` and forks */
const threadList = async (reader, archived = false) =>
	(
		await threadRows(
			threadIds(),
			reader,
			archived,
			await read.exact((all) => listFacts(all, archived)),
		)
	).flatMap(([, row]) => row ?? [])
/**
 * What a list's rows read of each thread's messages and agents, from the read model's tables in a few queries, for
 * every thread but a fork, whose messages before it forked are its parent's: `latest`, the newest message; `said` and
 * `failed`, the newest answer, error or command and whether it failed; `writers`, who wrote there not as an agent;
 * `question`, whether a question waits; and its `agents`' settings by conversation
 */
function listFacts(all, archived) {
	const agents = new Map(
		all('select conversation_id, runner, model, thinking, folder from ade_agents').map(
			({ conversation_id, ...settings }) => [conversation_id, settings],
		),
	)
	const waiting = new Set(openQuestions?.(all))
	const rows = all(
		`with facts as (select threads.id,
			(select max(id) from ade_messages where thread_id = threads.id) as latest,
			max(
				coalesce((select max(id) from ade_messages where thread_id = threads.id and kind in ('answer', 'error')), 0),
				coalesce((select max(id) from ade_messages where thread_id = threads.id and command in ('ran', 'failed')), 0)
			) as said,
			(select json_group_array(distinct author) from ade_messages
				where thread_id = threads.id and kind in ('said', 'scheduled', 'stopped')) as writers
		from ade_threads threads where forked_from_id is null and archived = ?)
		select facts.*, (select kind = 'error' or command = 'failed' from ade_messages where id = facts.said) as failed from facts`,
		archived ? 1 : 0,
	)
	return new Map(
		rows.map(({ id, writers, failed, ...row }) => [
			id,
			{
				...row,
				failed: Boolean(failed),
				writers: JSON.parse(writers),
				question: waiting.has(id),
				agents,
			},
		]),
	)
}
/** Every thread's `listFacts`, read from the tables once they're made after a start; a thread's leave at its next
 * entry, and its status reads its entries from then on */
let facts
let filling
/** A thread's `listFacts` as the tables last said, if nothing was written there since */
async function factsOf(id) {
	if (!facts) {
		// Filled in the tables' own transaction, so no commit lands between their reading and the cache
		filling ??= read
			.exact((all) => (facts = new Map([...listFacts(all, false), ...listFacts(all, true)])))
			.finally(() => (filling = undefined))
		await filling
	}
	return facts?.get(id)
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
	const names = (await botLabels?.()) ?? {}
	const isGroup = Object.keys(row.agents).length > 1 || (await authors(threadId)).length > 1
	const byPerson = ({ data }) =>
		!byAgent(data) &&
		!data.from &&
		!data.scheduledTask &&
		!data.stopped &&
		!data.conversation &&
		!botSet.has(data.author)
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
			// Whom it asks by the names they have now, as the API takes them
			...(data.to && { data: { ...data, to: data.to.map((one) => names[one] ?? one) } }),
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
	return { ...row, people: who, entries: entries.map((entry) => addressed(id, entry)) }
}
/**
 * A thread's page with its newest `last` messages, the newest 50 unless it says, or those after `after` or before
 * `before`; every message only with `all`, which for a long thread is megabytes
 */
async function threadView(id, reader, { after, before, last, all } = {}) {
	const handle = await conversation(id)
	if (after === undefined && before === undefined) last ??= 50
	const {
		entries: raw,
		earlier,
		seed,
	} = all
		? { entries: (await newest(handle)).filter((entry) => !entry.data.withdrawn) }
		: await windowOf(handle, { after, before, last })
	return { ...(await threadPage(id, reader, raw, seed)), ...(earlier !== undefined && { earlier }) }
}
/**
 * A thread's trail: its steps oldest first, each `{id, entry?, at, kind, text, …}`. With `entry`, that message's story
 * only: its own steps and the runs that took it; else the newest `last` steps.
 */
async function trail(id, { entry = undefined, last = 200 } = {}) {
	await conversation(id)
	const kept = (await thread(id)).trail
	const handle = kept && (await harness.conversation(kept, context))
	const steps = []
	if (!handle) return steps
	for (let cursor; ;) {
		const page = await handle.entries(
			entry === undefined ? { order: 'descending' } : { order: 'ascending', minEntryId: entry },
			500,
			cursor,
			context,
		)
		for (const { id: at, kind, data } of page.items) {
			const step = /** @type {any} */ (data)
			if (
				kind === TRAIL &&
				(entry === undefined ||
					step.entry === entry ||
					step.answer === entry ||
					step.held?.includes(entry))
			)
				steps.push({ id: at, ...step, text: stepText(step) })
		}
		if (!(cursor = page.next) || (entry === undefined && steps.length >= last)) break
	}
	return entry === undefined ? steps.slice(0, last).reverse() : steps
}

/**
 * A thread's newest messages, read back from its end: those after `after`, before `before`, written since the time
 * `since`, or the newest `last` that `matches`, with their picks
 */
async function newest(
	handle,
	{ after = -1, before = undefined, since = '', last = Infinity, matches = (_) => true } = {},
) {
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
	const found = []
	const query = {
		order: /** @type {const} */ ('descending'),
		...(before !== undefined && { maxEntryId: /** @type {any} */ (before - 1) }),
	}
	// A message's pick or withdrawal comes after it, so reading back meets it first
	read: for (let cursor; found.length < last;) {
		const page = await handle.entries(query, 200, cursor, context)
		for (const entry of page.items) {
			if (entry.id <= after || (entry.kind === KIND && entry.data.createdAt < since)) break read
			if (entry.kind === ROUTE || entry.kind === WITHDRAWAL) routed([entry], routes)
			const message = entry.kind === KIND && withRoute(entry, routes)
			if (message && matches(message) && found.push(message) >= last) break read
		}
		if (!(cursor = page.next)) break
	}
	return found.reverse()
}

/** An agent's thread owns its conversation, through its Anchor */
async function home(conversationId) {
	const threadId = (await storage.conversation(conversationId, context))?.owner?.conversationId
	const row = threadId && (await thread(threadId))
	const key =
		row && Object.keys(row.agents).find((key) => row.agents[key].conversation === conversationId)
	if (!key) return null
	const name =
		key === AGENT ? writtenTo(await agentOf(conversationId, key)) : (await whoIs(key)).name
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
	const and = (to) => [...to, ...joining.filter((bot) => !to.some((one) => one.home === bot.home))]
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
	const bots = await Promise.all(
		mentioned(body, (await botNames?.()) ?? []).map((name) => whom(id, name)),
	)
	return bots.filter((bot) => !agents[bot.home])
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
	if (saved) return answerOf(saved.result)
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
			Object.assign(draft, { key: '', text: '', images: [], pick: null, sent: input.key })
			delete draft.page
		}
		return result
	})
	return answerOf(result)
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
 * Their pages hear it on `draft/<id>`; `page` names the one that saved, which ignores its own.
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
		delete draft.sent
		if (page) draft.page = page
		else delete draft.page
		return { draft: shownDraft(draft) }
	})
}
/** A pick as the composer keeps it, `{agent, bots}`: any small object, or null */
function pickOf(pick) {
	if (pick === null) return null
	if (typeof pick !== 'object' || Array.isArray(pick) || JSON.stringify(pick).length > 10000)
		throw new Error('pick is an object of at most 10 kB, or null')
	return pick
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
	await commit(async (tx) =>
		reconfigure(tx, (await tx.doc(Thread, threadId)).agents[key], to, threadId),
	)
	const { admission } = agents[key]
	if (was.runner !== runner && !runners.isOnline(was.runner) && admission)
		await askAgain(threadId, key, to, admission)
	touchThread(threadId)
	return { conversation: input.conversation, to }
}

/** A turn held up by the runner its agent left stops, as Stop would, and what it held is asked again where it runs now */
async function askAgain(threadId, key, to, { admit, deliver }) {
	const task = await harness.getTask(deliver, context)
	if (!task || task.state.status === 'terminal') return
	const agent = (await thread(threadId)).agents[key].conversation
	await harness.abortTask(admit, context)
	await (await harness.conversation(agent, context))?.abort(context)
	await harness.waitForTask(deliver, context)
	const held = /** @type {any} */ ((await harness.getTask(admit, context))?.state.outcome?.result)
		?.held
	await commit(async (tx) => {
		if (held) await restore(tx, threadId, agent, { held, note: undefined })
		const row = await tx.doc(Thread, threadId)
		const behind = { [key]: await waits(tx, threadId, row.agents[key]) }
		await ask(tx, row, threadId, /** @type {any} */ (task.input).upTo, [to], {
			steer: false,
			behind,
		})
	})
}

/** A post's answer as soon as its message is saved: with `direct`, the director's pick for it comes after, as its route */
const answerOf = ({ pick, ...result }) => (pick ? { ...result, direct: true } : result)

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
			if (unseen(recipient, messageId)) {
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
			listed(
				recipient,
				'earlier',
				[...(recipient.earlier ?? []), ...others].filter((id) => id !== messageId),
			)
			if (messageId > recipient.after)
				listed(recipient, 'skip', [...(recipient.skip ?? []), messageId])
		}
		row.unpicked = (row.unpicked ?? []).filter((id) => id !== messageId)
		await tx.appendEntry(threadId, { kind: WITHDRAWAL, data: { message: messageId } })
		await trailed(tx, threadId, messageId, 'withdrawn')
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
	await trailed(tx, id, undefined, 'created', { title, ...(parent === null ? {} : { parent }) })
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
	const placing = await checkoutOf(first.checkout, to, message)
	return once(requestId, 'create thread', async (tx) => {
		const draft = message && key !== undefined && (await tx.doc(Draft, draftOf(NEW, person), null))
		const id = await startThread(tx, title, parent, tools)
		if (!message) return { id }
		if (placing) to[placing.at] = await placing.place(tx, id, title)
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
					{ steer: first.steer === true },
				)
		if (draft && draft.key === key) {
			Object.assign(draft, { key: '', text: '', images: [], sent: key })
			delete draft.page
		}
		return { id, ...result }
	})
}

/** With `checkout: 'own'`, what puts the thread's agent, among `to`, in a checkout of its own: the checkouts module's */
async function checkoutOf(checkout, to, message) {
	if (checkout === undefined || checkout === 'main') return undefined
	if (checkout !== 'own') throw new Error("checkout is 'main' or 'own'")
	if (!ownCheckout) throw new Error('A checkout of its own needs the checkouts module on')
	const at = to.findIndex((one) => !one.name)
	if (!message || message.command || at < 0)
		throw new Error("A checkout of its own is for the thread's agent: ask a model@runner")
	return { at, place: await ownCheckout(to[at]) }
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

/**
 * Where an agent stood at `at`, by its `answer`: the thread messages up to `at` it still hasn't seen, and those it was
 * handed since, placed or still queued. Only its own conversation's few newest entries are read, not all it ever saw.
 * Its own answers among `shown`, the thread up to `at`, it skips: in the fork they're another conversation's.
 */
async function positionAt(agent, answer, at, shown) {
	const handle = await harness.conversation(answer.conversation, context)
	const since = await collect((cursor) =>
		handle.entries({ minEntryId: answer.entry + 1, order: 'ascending' }, 200, cursor, context),
	)
	const queued = (await harness.snapshot(InboxDoc, answer.conversation, context))?.items ?? []
	const handed = [...since, ...queued.map((item) => item.entry)]
		.filter((entry) => entry?.kind === DELIVERY)
		.flatMap((entry) => entry.data.held)
	const position = { after: Math.min(agent.after, at) }
	listed(
		position,
		'earlier',
		[...(agent.earlier ?? []), ...handed].filter((id) => id <= position.after),
	)
	listed(position, 'skip', [
		...(agent.skip ?? []).filter((id) => id > position.after && id <= at),
		...shown
			.filter(
				(entry) => entry.id > position.after && entry.kind === KIND && ownAnswer(entry, agent),
			)
			.map((entry) => entry.id),
	])
	return position
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
	if ((expected === undefined || row.title === expected) && row.title !== title) {
		await trailed(tx, id, undefined, 'renamed', { from: row.title, to: title })
		row.title = title
	}
	return { title: row.title }
}

async function setTools(id, { tools }) {
	await conversation(id)
	tools = toolList(tools)
	// A bot's home sets what the bot may use in every thread it's in
	const bot = ((await homesOf?.()) ?? {})[id]
	const ids = bot ? threadIds() : [id]
	return commit(async (tx) => {
		const row = await tx.doc(Thread, id)
		row.tools = tools
		for (const threadId of ids) {
			const { agents } = await tx.doc(Thread, threadId)
			for (const [key, { conversation }] of Object.entries(agents)) {
				if (threadId !== id && key !== String(id)) continue
				const allowed = await toolsFor(tx, threadId, key)
				await configure(tx, conversation, {
					tools: toolsOf(allowed),
					instructions: instructions(key, threadId, allowed),
				})
			}
		}
		await trailed(tx, id, undefined, 'tools', { tools })
		return { tools }
	})
}

/** What an agent in a thread may use: the thread's tools, narrowed for a bot by its home's */
async function toolsFor(tx, threadId, key) {
	const { tools } = await tx.doc(Thread, threadId)
	const home = /^\d+$/.test(key) && Number(key)
	return home && home !== threadId ? narrower(tools, (await tx.doc(Thread, home)).tools) : tools
}

/** Only what both lists allow */
function narrower(one, other) {
	if (!one || !other) return one ?? other
	const changes = (list) => list.every((tool) => /^[+-]/.test(tool))
	if (changes(one) && changes(other))
		return [...new Set([...one, ...other].filter((tool) => tool.startsWith('-')))]
	const all = registry
		.snapshot()
		.tools()
		.map(({ tool }) => tool.name)
	const allows = (list) => (changes(list) ? all.filter((name) => !list.includes(`-${name}`)) : list)
	return allows(one).filter((name) => allows(other).includes(name))
}

/** Pauses a thread, or resumes it: only @mentions and named recipients get an answer while it's paused */
async function setPaused(id, { paused }) {
	if (typeof paused !== 'boolean') throw new Error('paused is true or false')
	await conversation(id)
	return commit(async (tx) => {
		const row = await tx.doc(Thread, id)
		if (Boolean(row.paused) !== paused)
			await trailed(tx, id, undefined, paused ? 'paused' : 'resumed')
		row.paused = paused
		return { paused }
	})
}

/** Forks history, the agent and bots at `at`, but keeps the source's current thread-wide tools */
async function forkThread(id, { at, title }, person) {
	const handle = await conversation(id)
	const pick = (await harness.snapshot(Draft, draftOf(id, person), context))?.pick
	const source = await thread(id)
	const keys = Object.keys(source.agents)
	// Back from the fork point only until each of its agents' newest answer, given in the conversation it has now; one
	// that never answered hears the whole thread anew, so then it reads all of it
	const read = []
	const latest = {}
	for (let cursor; ;) {
		const page = await handle.entries(
			{ order: 'descending', maxEntryId: /** @type {any} */ (Number(at)) },
			200,
			cursor,
			context,
		)
		for (const entry of page.items) {
			read.push(entry)
			const message = /** @type {Message} */ (entry.data)
			const key =
				entry.kind === KIND && message.answer && nameOf(source, message.answer.conversation)
			if (key) latest[key] ??= message.answer
		}
		// and its place before it, so its own answers past that place are read too
		const reach = Math.min(...keys.map((key) => source.agents[key].after))
		if (keys.every((key) => latest[key]) && read.at(-1)?.id <= reach) break
		if (!(cursor = page.next)) break
	}
	// Picks made after the fork point stay behind with it
	const shown = routed(read.reverse())
	const answers = {}
	const asked = new Set()
	for (const { data } of shown) {
		// An answer from a conversation it doesn't have now, a fork's source's, counts as none
		const key = data.answer && nameOf(source, data.answer.conversation)
		if (key) answers[key] = data.answer
		for (const stored of data.to ?? []) asked.add(memberKey(source, stored))
	}
	/** Asked but not answered by then: made anew, as the source's is now */
	const fresh = await Promise.all(
		[...asked]
			.filter((key) => !answers[key] && source.agents[key])
			.map(async (key) => [key, await agentOf(source.agents[key].conversation, key)]),
	)
	const agents = await Promise.all(
		Object.entries(answers).map(async ([key, answer]) => ({
			key,
			answer,
			position: await positionAt(source.agents[key], answer, Number(at), shown),
		})),
	)
	const forkTitle = title?.trim() || `${source.title} (fork)`
	const fork = await handle.fork(
		/** @type {import("@earendil-works/pi-durable").EntryId} */ (Number(at)),
		{
			...ownerless,
			init: async (tx, forkId) => {
				Object.assign(await tx.doc(Thread, forkId), {
					tools: source.tools,
					aliases: source.aliases ?? null,
					memory: source.memory ?? null,
				})
				const row = {}
				for (const { key, answer, position } of agents) {
					row[key] = await newAgent(tx, forkId, position, answer)
					const allowed = await toolsFor(tx, forkId, key)
					await configure(tx, row[key].conversation, {
						tools: toolsOf(allowed),
						instructions: instructions(key, forkId, allowed),
					})
				}
				for (const [key, to] of fresh) {
					row[key] = await newAgent(
						tx,
						forkId,
						positionOf(
							shown.filter((entry) => forAgent(entry, source.agents[key])).map((entry) => entry.id),
							shown,
							source.agents[key],
						),
					)
					await setUp(tx, row[key].conversation, forkId, to)
				}
				Object.assign(await tx.doc(Thread, forkId), {
					title: forkTitle,
					createdAt: now(),
					agents: row,
				})
				await trailed(tx, forkId, undefined, 'forked', {
					from: id,
					at: Number(at),
					title: forkTitle,
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
/** The open threads but `except` with an agent working in `dir` on `runner`, or in a folder inside it */
async function workingIn(runner, dir, except) {
	const ids = new Set()
	for (const [conversation, id] of agentThreads) {
		if (id === except || ids.has(id) || (placed.get(id)?.hidden ?? true)) continue
		const agent = await harness.snapshot(AgentDoc, conversation, context)
		if (agent?.model?.provider !== `runner:${runner}` || !agent.cwd) continue
		const inside = path.relative(dir, agent.cwd)
		if (inside.startsWith('..') || path.isAbsolute(inside)) continue
		const row = await thread(id)
		if (Object.values(row.agents).some((member) => member.conversation === conversation))
			ids.add(id)
	}
	return [...ids]
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
	/** ade's database: the SQLite file everything is kept in */
	file,
	/** A thread's doc inside a commit, where a snapshot would wait for the commit itself */
	threadIn: (tx, id) => tx.doc(Thread, id),
	archiveIn,
	busy,
	work,
	isWork,
	familyOf: (id) => familyOf(id),
	statusOf: async (id, jobs, reader) =>
		status(id, await thread(id), jobs, reader, await factsOf(id)),
	factsOf,
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
	askable,
	workingIn,
	conversation,
	thread,
	home,
	threadList,
	threadRows,
	/** The threads a commit's change touches: their ids, `true` for all of them, or `false` */
	threadMatch: (change) => threadMatch(change),
	entries,
	messages,
	routed,
	shapeMessages,
	latestMessage,
	/** A document's value as stored, read without a commit: a thread's or an agent's by `id`, the house's without */
	snapshot: (doc, id) =>
		id === undefined ? harness.snapshot(doc, context) : harness.snapshot(doc, id, context),
	/** What a module's own model call spent, for the usage module to record; without it, nothing */
	spent: async (thread, purpose, reply) => {
		for (const hook of spentHooks)
			await hook(thread, purpose, reply).catch((error) => console.error(error))
	},
	/** With inbox on, a thread's open `ask_person` message, else undefined; inside a commit, before its writes, with its `tx` */
	openQuestion: (id, row, tx) => openQuestion?.(id, row, tx),
	lastAsked,
	recipients,
	/** A bot's instructions, by its home */
	instructionsOf: (home) => instructionsOf?.(home),
	botAgent: (name) => botAgent?.(name),
	botAt: (home) => botAt?.(home),
	writerKey,
	toNames,
	/** Every bot's name by its home, a forgotten one's too: `{[home]: name}` */
	botLabels: async () => (await botLabels?.()) ?? {},
	botNames: () => botNames?.() ?? [],
	/** Each bot's home: `{[thread]: name}` */
	homes: async () => (await homesOf?.()) ?? {},
	startThread,
	newAgent,
	setUp,
	setTitleIn,
	threadIds,
	conversations,
	/** `within` is a caller's own context, such as a hook's, so its cancellation ends the wait */
	waitForTask: (id, within = context) => harness.waitForTask(id, within),
	post,
	route,
	/** Writes one step of a thread's trail in the commit `tx`: `(tx, thread, entry, kind, data)` */
	trailed,
	trail,
	authors,
	afterCommit,
	abortTask: (id) => harness.abortTask(id, context),
	/** One task's latest record, or every task matching `query` (Pi's TaskQuery) */
	task: (id) => storage.task(id, context),
	tasks: (query) => collect((cursor) => storage.scanTasks(query, 200, cursor, context)),
	/** Delivers a signal to a sleeping task: Pi's `delivered`, `duplicate`, `closed` or `not_found` */
	signal: (taskId, kind, key, value) => harness.signal(taskId, kind, key, value, context),
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
/** `invites` in ade.json: only the owner key and invites' keys get in, the owner's own machine and tailnet logins not */
const invitesOn = settings.config.invites === true
/** Each invite's name by its key's SHA-256, kept here so a request asks no commit, and changed with the doc */
const guests = new Map()
const knowInvites = (all) => {
	guests.clear()
	for (const [name, { key }] of Object.entries(all)) guests.set(key, name)
}
knowInvites((await harness.snapshot(Invites, context)) ?? {})
/** `job(all)` on the read model's tables as of Pi's last commit or a beat before, `all(sql, ...params)` answering
 * rows; it waits while they're being made, and answers nothing if they couldn't be */
core.recent = read.recent
const modules = await load('server', core, settings)
// The prompt keeps its sections in this order, and a cached prompt survives up to its first change, so the sections
// that change most go last: a module's `volatility`, 0 unless it says otherwise
for (const module of modules.toSorted((a, b) => (a.volatility ?? 0) - (b.volatility ?? 0)))
	if (module.extension) registry.install(module.extension)
for (const extension of await leftovers(core)) registry.install(extension)
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
const botAt = hook('botAt')
const botLabels = hook('names')
const instructionsOf = hook('instructionsOf')
const botNames = hook('botNames')
const homesOf = hook('homesOf')
const expand = hook('expand')
const openQuestion = hook('openQuestion')
/** Each thread with an open question, from the read model's tables: `all(sql, ...params)` answers rows */
const openQuestions = hook('openQuestions')
const spentHooks = modules.flatMap((module) => module.spent ?? [])
compactAt = hook('compactAt')
/** An outside service's POST to /hooks/:id, on a listener of its own; none without a module that takes it */
const webhook = hook('webhook')
harnessed = undefined
const remembers = hook('remembers')
/** The checkouts module's: a thread's own checkout, planned before it starts and made before its agent runs */
const ownCheckout = hook('ownCheckout')
core.ownCheckout = ownCheckout
const prepare = hook('prepare')

// ── HTTP: input, routes, static files, runner script ──────────────────────

/** Pi's own cap on an image, in base64 */
const IMAGE_BYTES = 4.5 * 1024 * 1024
async function input(req) {
	let body = ''
	for await (const chunk of req) {
		body += chunk
		if (body.length > 8 * IMAGE_BYTES + 200000) throw new Error('Request too large')
	}
	try {
		return JSON.parse(body || '{}')
	} catch (cause) {
		throw new Error('The request body is not valid JSON.', { cause })
	}
}

/** Archives a thread inside the commit `tx`, ending what modules keep running in it; one may refuse by throwing */
async function archiveIn(tx, id) {
	for (const hook of archiving) await hook(tx, id)
	const row = await tx.doc(Thread, id)
	if (!row.hidden) await trailed(tx, id, undefined, 'archived')
	row.hidden = true
}

async function archiveThread(id, archived, requestKey) {
	await conversation(id)
	return once(scopedKey(`archive ${id}`, requestKey), `archive ${id}`, async (tx) => {
		if (archived) await archiveIn(tx, id)
		else {
			const row = await tx.doc(Thread, id)
			if (row.hidden) await trailed(tx, id, undefined, 'unarchived')
			row.hidden = false
		}
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
		client: version.client,
		/** The server's code changed since it started: a restart takes it up */
		stale: version.stale,
		/** The commit the server's checkout is on, when it runs from one; null for an install */
		commit: (await git('rev-parse', 'HEAD')) || null,
		/** The release an installed server runs, and the newer one staged for its next restart */
		release: release?.tag ?? null,
		staged: staged?.tag ?? null,
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
			invites: invitesOn,
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

const ownerOnly = (req, refusal) => {
	if (user(req) !== owner) throw Object.assign(new Error(refusal), { status: 403 })
}

/** @type {[RegExp, Function][]} */
const routes = /** @type {[string, Function][]} */ ([
	...Object.entries({
		'GET /api/server': (req) => serverInfo(user(req)),
		'POST /api/settings': async (req, _id, _url, res) => {
			// Settings name the owner and their logins, so only the owner changes them
			ownerOnly(req, 'Only the owner changes settings')
			const body = await input(req)
			const saved = await saveSettings(body)
			// With invites on only keys get in, so the browser that turned them on keeps the owner's
			if (body.invites === true) keepKey(req, res, ownerKey)
			return saved
		},
		/** The owner's key as a link, to bring another device in while invites are on */
		'POST /api/link': (req) => {
			ownerOnly(req, 'Only the owner has the owner link')
			return { link: `${origin(req)}/#key=${ownerKey}` }
		},
		'POST /api/restart': (req) => {
			ownerOnly(req, 'Only the owner restarts the server')
			return restartSoon('updating')
		},
		/** Stages the newest release, as arbe desktop's hourly check does, and restarts into it */
		'POST /api/update': async (req) => {
			ownerOnly(req, 'Only the owner updates the server')
			if (!release)
				throw Object.assign(new Error('this runs from your checkout; pull to update'), {
					status: 409,
				})
			await stageNewest()
			return {
				release: release.tag,
				staged: staged?.tag ?? null,
				...(staged && restartSoon(`updating to ${staged.tag}`)),
			}
		},
		'GET /api/runners': runnerList,
		// Anyone in the house adds a runner under a name nobody holds; a new key for a held name, which cuts off its
		// runner, only its maker gets. Its maker or the owner revokes it.
		'POST /api/runners': async (req) => {
			const body = await input(req)
			return mintKey(String(body.name ?? ''), origin(req), body.key, user(req))
		},
		'DELETE /api/runners/:name': (req, name, url) =>
			revoke(name, url.searchParams.get('key') ?? undefined, user(req)),
		'GET /api/invites': async (req) => {
			ownerOnly(req, 'Only the owner sees invites')
			const all = (await harness.snapshot(Invites, context)) ?? {}
			return { on: invitesOn, invites: Object.entries(all).map(([name, { at }]) => ({ name, at })) }
		},
		'POST /api/invites': async (req) => {
			ownerOnly(req, 'Only the owner invites')
			const body = await input(req)
			return invite(String(body.name ?? '').trim(), origin(req), body.key)
		},
		'DELETE /api/invites/:name': (req, name, url) => {
			ownerOnly(req, 'Only the owner takes an invite back')
			return uninvite(name, url.searchParams.get('key') ?? undefined)
		},
		'GET /api/runners/:name/available': async (req, name) => {
			if (!runners.isOnline(name)) throw new Error(`${name} is offline`)
			const { available, offered } = await runners.call(name, { op: 'available' }, {})
			if (offered) {
				await commit(async (tx) => {
					const runner = (await tx.doc(Runners))[name]
					if (runner) setOffers(runner, offered)
				})
				feed.touch('runners')
			}
			return available
		},
		'GET /api/changes': async (_req, _id, url) => {
			if (release) return { commits: release.notes.map((subject) => ({ subject, at: release.at })) }
			const since = url.searchParams.get('since')
			if (since !== null && !/^[\da-f]{7,40}$/.test(since)) return { commits: [] }
			const log = await git(
				'log',
				'--format=%cI%x09%s',
				...(since === null ? ['-n', '20', 'HEAD'] : [`${since}..HEAD`]),
			)
			const commits = log ? log.split('\n') : []
			return {
				commits: commits.map((line) => ({
					subject: line.slice(line.indexOf('\t') + 1),
					at: line.split('\t')[0],
				})),
			}
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
				all: url.searchParams.has('all'),
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
		'GET /api/threads/:id/images/:name': async (_req, id, url, res) =>
			serveImage(await conversation(id), url, res),
		'GET /api/threads/:id/trail': (req, id, url) =>
			trail(id, {
				entry: url.searchParams.has('entry') ? Number(url.searchParams.get('entry')) : undefined,
			}),
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
		'GET /api/read': (req, _, url) => read.serve(undefined, url.searchParams),
		'POST /api/read': async (req) => {
			ownerOnly(req, 'Only the owner remakes the SQL tables')
			return read.serve(undefined, new URLSearchParams(), await input(req))
		},
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
									(req, name, url) =>
										module.remove(name, url.searchParams.get('key') ?? undefined, user(req)),
								],
							]
						: []),
				],
	),
]).map(([key, handle]) => [
	new RegExp(`^${key.replace(':id', String.raw`(\d+)`).replace(':name', '([^/]+)')}$`),
	handle,
])

const version = await watchVersion(() => feed.touch('server'))

/** git in the server's own folder; '' when it isn't a checkout, git is missing or the command fails */
const git = (...args) =>
	new Promise((resolve) =>
		execFile('git', ['-C', import.meta.dirname, ...args], { timeout: 5000 }, (error, out) =>
			resolve(error ? '' : out.trim()),
		),
	)

/**
 * An installed ade, as arbe desktop keeps one, runs a release: a tag, named with its commit and notes in `.release`
 * beside bin.js. A newer one staged in the folder beside it, `<folder>.next`, takes over at the next restart, and the
 * one it replaced waits in `<folder>.old` until this one listens, for arbe desktop to go back to if it never does. A
 * checkout has neither and updates from its own files.
 */
const readRelease = (dir) => {
	try {
		const { tag, at, notes } = JSON.parse(readFileSync(path.join(dir, '.release'), 'utf8'))
		return {
			tag: String(tag),
			at: String(at ?? ''),
			notes: Array.isArray(notes) ? notes.map(String) : [],
		}
	} catch {
		return null
	}
}
const release = readRelease(import.meta.dirname)
const nextDir = `${import.meta.dirname}.next`
let staged = release && readRelease(nextDir)
if (release) {
	watchFiles(path.dirname(nextDir), (_event, name) => {
		if (name !== path.basename(nextDir)) return
		const now = readRelease(nextDir)
		if (now?.tag === staged?.tag) return
		staged = now
		feed.touch('server')
	}).unref()
}
/**
 * The newest release into `<folder>.next`, through the house.sh this release came with: arbe desktop keeps its own ade
 * in `<data>/arbe-desktop/ade`, and the same script checks the signature and whether the app is new enough
 */
const stageNewest = () =>
	new Promise((resolve, reject) =>
		execFile(
			'sh',
			[path.join(import.meta.dirname, 'apps', 'desktop', 'house.sh'), 'update'],
			{
				env: {
					...process.env,
					HOUSE_SCRIPT: '',
					XDG_DATA_HOME: path.dirname(path.dirname(import.meta.dirname)),
				},
				timeout: 10 * 60_000,
			},
			(error, _out, err) => {
				if (error)
					return reject(
						Object.assign(new Error(err.trim().split(/\n/).at(-1) || error.message), {
							status: 502,
						}),
					)
				staged = readRelease(nextDir)
				feed.touch('server')
				resolve(staged)
			},
		),
	)
/** Puts the staged release where this one is, for the restart to start it; this one waits beside it to be deleted */
const takeStaged = () => {
	if (!staged || readRelease(nextDir)?.tag !== staged.tag) return
	rmSync(`${import.meta.dirname}.old`, { recursive: true, force: true })
	renameSync(import.meta.dirname, `${import.meta.dirname}.old`)
	try {
		renameSync(nextDir, import.meta.dirname)
	} catch (error) {
		renameSync(`${import.meta.dirname}.old`, import.meta.dirname)
		throw error
	}
	console.log(`restart: from ${release.tag} to ${staged.tag}`)
}

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
	['diff', new URL('./libesm/', import.meta.resolve('diff/package.json'))],
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

/** Keeps a key as this browser's cookie, one its scripts can't read */
function keepKey(req, res, key) {
	const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''
	res.setHeader(
		'Set-Cookie',
		`${keyCookie()}=${key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${secure}`,
	)
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
		if (!sender) return send(res, 401, { error: nobody(serve, req) })
		senders.set(req, sender)
	}
	if (!['GET', 'HEAD'].includes(req.method) && fromAgent(req))
		return send(res, 403, { error: agentRefused })
	/** A browser brought in with the owner's key or an invite's keeps it as a cookie its scripts can't read */
	if (req.method === 'POST' && url.pathname === '/api/me') {
		const given = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
		const me = given && (isOwnerKey(given) ? owner : guests.get(sha256(given)))
		if (!me) return send(res, 403, { error: 'That key opens nothing here' })
		keepKey(req, res, given)
		return send(res, 201, { me })
	}
	if (!['GET', 'HEAD'].includes(req.method) && ownerByLogin(req, serve))
		return send(res, 403, { error: loginRefused, needs: 'owner-key' })
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
				res,
			)
			// A route that answered by itself, like an image's bytes
			if (res.headersSent) return
			// A body too big to hold comes as pieces, sent as they're made
			if (result?.[Symbol.asyncIterator]) {
				res.writeHead(200, { 'Content-Type': 'application/json' })
				return await pipeline(result, res).catch((error) =>
					console.error(`${key}: ${error.message}`),
				)
			}
			send(
				res,
				req.method === 'POST' ? 201 : 200,
				req.method !== 'GET' && result && typeof result === 'object' && !Array.isArray(result)
					? { ...result, seq: feed.seq(), boot: feed.boot() }
					: result,
			)
		} catch (error) {
			console.error(key, error)
			send(res, error.status ?? 400, { error: errorLine(error) })
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

// ── Feed views ────────────────────────────────────────────────────────────

async function runnerList() {
	const [all, last] = [await work(), await known()]
	const makers = (await harness.snapshot(Makers, context)) ?? {}
	return Object.keys(await keys()).map((name) => {
		const { models, offers, thinkingLevels, ...runner } = last[name] ?? {}
		const here = all.filter((job) => job.runner === name)
		/** Its agents' statuses, by row: a bot's name, or `provider/id@runner` whatever its thinking */
		const agents = {}
		for (const job of here)
			if (job.row) agents[job.row] = busiest([agents[job.row], job.status].filter(Boolean))
		return {
			name,
			...runner,
			...(lent?.name === name && { own: true }),
			/** The guest who made it; the owner's runners have none */
			...(makers[name] && { by: makers[name] }),
			offers: offers ?? [],
			models: Object.keys(models ?? {}),
			/** Each model's thinking levels, as pi cycles them: those it has run, then what it reports for its offers and default */
			thinkingLevels: {
				...Object.fromEntries(
					Object.entries(models ?? {}).map(([ref, model]) => [
						ref,
						getSupportedThinkingLevels(model),
					]),
				),
				...thinkingLevels,
			},
			online: runners.isOnline(name),
			calls: runners.working(name),
			status: busiest(here.map((job) => job.status)),
			agents,
			busy: new Set(here.filter((job) => job.status === 'working').map((job) => job.thread)).size,
			outdated: Boolean(runner.version) && runner.version !== bundle.version,
			/** Told to update, and gone to do it */
			updating: updating.has(name) && !runners.isOnline(name),
		}
	})
}

feed.define('runners', {
	keyOf: (row) => row.name,
	all: runnerList,
	match: (change) => {
		if (change.type === 'task') return isWork(change.value.kind) && runsOnRunner(change.value.kind)
		if (change.type === 'document')
			return [
				'ade.runners',
				'ade.keys',
				'ade.makers',
				'ade.lent',
				AgentDoc.definition.kind,
			].includes(change.record.kind)
		return false
	},
})

/** A launched runner whose version differs is asked to update once per connection, when it has no calls open, so nothing it's doing is cut off */
const outdated = new Set()
/** The names of runners told to update, until they connect again */
const updating = new Set()
function nudge() {
	for (const connection of outdated) {
		if (connection.phase !== 'online') outdated.delete(connection)
		else if (!runners.working(connection.name).length) {
			outdated.delete(connection)
			updating.add(connection.name)
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
		rows: (ids, viewer) => threadRows(ids, viewer, archived),
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

/** Your draft in a thread, or `new`: as `draftIn` reads it, with the `page` that saved it last, or the key it was `sent` under */
feed.define('draft/', {
	perViewer: true,
	keyOf: () => 'draft',
	all: async (viewer, param) => {
		const draft = await harness.snapshot(Draft, draftOf(param, viewer), context)
		return [
			{ key: 'draft', draft: draft && shownDraft(draft), page: draft?.page, sent: draft?.sent },
		]
	},
	match: (change, param, state) =>
		change.type === 'document' &&
		change.record.kind === 'ade.draft' &&
		change.record.key === draftOf(param, state.viewer),
})

/** A thread's trail, its newest steps, for the Director tab */
feed.define('trail/', {
	all: (_viewer, param) => trail(Number(param)),
	match: (change, param) =>
		change.type === 'entry' &&
		change.value.kind === TRAIL &&
		/** @type {any} */ (change.value.data).thread === Number(param),
})

feed.define('server', {
	perViewer: true,
	keyOf: () => 'server',
	all: async (viewer) => [{ key: 'server', ...(await serverInfo(viewer)) }],
	match: (change) =>
		(change.type === 'conversation' && !change.value.owner) ||
		(change.type === 'document' && change.record.kind === 'ade.keys'),
})

const committed = modules.flatMap((module) => module.committed ?? [])
const entryStored = modules.flatMap((module) => module.entryStored ?? [])
const documentStored = modules.flatMap((module) => module.documentStored ?? [])
const endedHooks = modules.flatMap((module) => module.ended ?? [])
/** Told when a runner comes online, `true`, or goes offline, `false` */
const runnerHooks = modules.flatMap((module) => module.runner ?? [])
const uninvitedHooks = modules.flatMap((module) => module.uninvited ?? [])
harness.observeCommits({
	advance: (publication) => {
		// A throw here would end Pi's telling us of commits at all: a module's trouble stays its own
		for (const hook of committed)
			try {
				hook(publication)
			} catch (error) {
				console.error(error)
			}
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

// Work resumes and modules start only now that every commit is heard: one stored before would never reach a feed or a module
for (const conv of await conversations()) {
	if (!conv.owner) {
		records.set(conv.id, conv)
		place(conv.id, await thread(conv.id), conv)
	}
}
for (const [name, runner] of Object.entries(await known())) provide(name, runner.models)
harness.resume()
read.start()
// The bots list and inbox read every thread's status: what the tables know of them is read once they're made, not on first ask
read
	.recent(() => true)
	.then(() => factsOf())
	.catch((error) => console.error(`the bots' and inbox's first read: ${error.message}`))
for (const module of modules) await module.start?.()

/** Messages a thread opens on: few, so it shows at once, with only their agents' turns */
const FIRST = 15

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
/**
 * What an agent does now, from its `pi.live`: whether it runs, the message it's writing, its tools with their
 * arguments, and the delivery it answers, its run's newest, a steer's once it steered
 */
async function liveOf(handle, { run, generation, tools = [] } = {}) {
	const recent =
		run || tools.length
			? (await handle.entries({ order: 'descending' }, 20, undefined, context)).items
			: []
	const calls = recent
		.flatMap((entry) => (entry.model?.[0]?.role === 'assistant' ? entry.model[0].content : []))
		.filter((block) => block.type === 'toolCall')
	const first = run?.first ?? 0
	const delivery =
		run &&
		(recent.find((entry) => entry.kind === DELIVERY && entry.id >= first) ??
			(await firstIn(
				(cursor) =>
					handle.entries({ minEntryId: first, order: 'descending' }, 100, cursor, context),
				(entry) => entry.kind === DELIVERY,
			)))
	return {
		run: Boolean(run),
		message: generation?.message ?? null,
		tools: tools.map(({ callId, name, status }) => ({
			callId,
			name,
			status,
			args: calls.find((call) => call.id === callId)?.arguments,
		})),
		...(delivery && { delivery: { id: delivery.id, held: delivery.data.held } }),
	}
}
/** An agent's entry as a page shows it, keyed by its agent */
const agentEntry = (
	agent,
	/** @type {import("@earendil-works/pi-durable").EntryRecord} */ { id, kind, model, data, head },
) => ({
	key: `${agent}/${id}`,
	agent,
	id,
	kind,
	model: model?.map(visible),
	data,
	head,
})
/** One of an agent's rows, by key: `<agent>/live`, `<agent>/cut`, or `<agent>/<entry>`, null if it shows none */
async function agentRow(key, lives) {
	const [agent, what] = key.split('/').map(Number)
	const handle = await harness.conversation(agent, context)
	if (!handle) return null
	if (key.endsWith('/live')) return { key, agent, live: await liveOf(handle, lives.get(agent)) }
	if (key.endsWith('/cut')) return { key, agent, cut: await cutOf(handle, agent) }
	const [entry] = (
		await handle.entries({ minEntryId: what, order: 'ascending' }, 1, undefined, context)
	).items
	return entry?.id === what && entry.kind !== 'pi.system' ? agentEntry(agent, entry) : null
}
/** An agent's live work, its cut, and its conversation newest first, back as far as `enough` says, then oldest first */
async function agentRows(agent, enough, live) {
	const handle = await harness.conversation(agent, context)
	if (!handle) return []
	const entries = []
	for (let cursor; ;) {
		const page = await handle.entries({ order: 'descending' }, 50, cursor, context)
		entries.push(...page.items)
		if (enough(entries) || !(cursor = page.next)) break
	}
	return [
		{ key: `${agent}/live`, agent, live: await liveOf(handle, live) },
		{ key: `${agent}/cut`, agent, cut: await cutOf(handle, agent) },
		...entries
			.reverse()
			.filter((entry) => entry.kind !== 'pi.system')
			.map((entry) => agentEntry(agent, entry)),
	]
}
/**
 * An agent's `pi.live` for a view to read, as Pi adopts each change: its streamed progress is stored, and so reaches
 * commit publications, only about a second later, too late for words coming in
 */
async function followLive(state, agent) {
	if (state.lives.has(agent)) return
	state.lives.set(agent, {})
	const watch = await harness.watchDoc(LiveDoc, agent, context)
	if (!watch) return
	if (state.dropped) return void watch.stop()
	state.watches.push(watch)
	state.lives.set(agent, watch.value)
	watch.start(async (call) => {
		if (call.kind !== 'value') return
		state.lives.set(agent, call.value)
		state.touch([`${agent}/live`])
	})
}
/**
 * A thread's agents, by conversation, which stays as an agent switches model or runner: each one's turns as far back
 * as the thread's newest page, or as message `?from=`, its newest compaction's cut, and what it does now
 */
feed.define('agents/', {
	keyOf: (row) => row.key,
	all: async (_viewer, param, query, state) => {
		const id = Number(param)
		const agents = placed.has(id)
			? Object.values((await thread(id))?.agents ?? {}).map((agent) => agent.conversation)
			: []
		state.agents = new Set(agents)
		state.lives ??= new Map()
		state.watches ??= []
		let from = Number(query.get('from'))
		if (!query.has('from')) {
			const { entries, earlier } = await windowOf(await conversation(id), { last: FIRST })
			from = earlier ? (entries[0]?.id ?? 0) : 0
		}
		return (
			await Promise.all(
				agents.map(async (agent) => {
					await followLive(state, agent)
					return agentRows(agent, covers(from), state.lives.get(agent))
				}),
			)
		).flat()
	},
	rows: (keys, _viewer, _param, _query, state) =>
		Promise.all(keys.map(async (key) => [key, await agentRow(key, state.lives)])),
	match: (change, param, state) => {
		if (change.type === 'document' && change.record.kind === 'ade.thread')
			return (
				change.conversationId === Number(param) &&
				Object.values(change.value?.agents ?? {}).some(
					(agent) => !state.agents.has(agent.conversation),
				)
			)
		if (change.type !== 'entry' || !state.agents.has(change.value.conversationId)) return false
		const { conversationId: agent, id, kind } = change.value
		return [
			`${agent}/${id}`,
			`${agent}/live`,
			...(kind === 'pi.compaction' ? [`${agent}/cut`] : []),
		]
	},
	drop: (state) => {
		state.dropped = true
		for (const watch of state.watches ?? []) void watch.stop()
	},
})
/**
 * A model message as a page shows it: without the provider's diagnostics, the signatures that let it check its own
 * thinking and the bytes of its images, which are most of a turn's bytes and nothing a person reads there; an image
 * someone sent is in the thread's message
 */
const visible = (message) => {
	const { diagnostics: _, ...shown } = message
	if (!Array.isArray(shown.content)) return shown
	return {
		...shown,
		content: shown.content.map(({ thinkingSignature: _, textSignature: __, data, ...block }) =>
			block.type === 'image' ? block : { ...block, ...(data !== undefined && { data }) },
		),
	}
}

// ── Runner keys ───────────────────────────────────────────────────────────

/**
 * A new key, `prefix` and 24 random bytes; with a caller's request key, made from it and the owner key instead, so a
 * retry gets the same key again without the store ever holding it
 */
const newKey = (prefix, requestKey, ...about) =>
	`${prefix}${(requestKey === undefined
		? randomBytes(24)
		: createHmac('sha256', ownerKey)
				.update(JSON.stringify([prefix, ...about, scopedKey('key', requestKey)]))
				.digest()
				.subarray(0, 24)
	).toString('base64url')}`
/**
 * A new key for a runner, replacing its old one, whose runner is cut off. A name is its maker's for good, revoked or
 * not: only they get it a key. A name the owner's runners had before makers were kept, the server's own among them, is
 * the owner's.
 */
async function mintKey(name, server, requestKey, by = owner) {
	if (!/^[\w.-]+$/.test(name))
		throw new Error('name the runner: letters, digits, dot, dash or underscore')
	if (process.env.HOST === '0.0.0.0' && loopback(new URL(server).hostname)) {
		const interfaces = os.networkInterfaces()
		const address = [...(interfaces.tailscale0 ?? []), ...Object.values(interfaces).flat()].find(
			(net) => net.family === 'IPv4' && !net.internal,
		)?.address
		if (address) server = server.replace(new URL(server).hostname, address)
	}
	const key = newKey('air_', requestKey, name, by)
	const replaced = await commit(async (tx) => {
		const [all, makers, seen, own] = [
			await tx.doc(Keys),
			await tx.doc(Makers),
			await tx.doc(Runners),
			await tx.doc(Lent),
		]
		const maker = makers[name] ?? (all[name] || seen[name] || own.name === name ? owner : by)
		if (maker !== by)
			throw Object.assign(
				new Error(
					`${name} is ${maker}'s runner; only ${maker} gives it a new key. Pick another name.`,
				),
				{ status: 403 },
			)
		const was = all[name]
		all[name] = sha256(key)
		// The owner's name can change, so a runner without a maker is theirs whatever they're called
		if (by !== owner) makers[name] = by
		return was !== all[name]
	})
	if (replaced) runners.kick(name, 4001, `${name}'s key was replaced`)
	return {
		name,
		key,
		ade: `ADE_KEY=${key} ade runner --server ${server} --name ${name}`,
		connect: `curl -fsSL ${server}/connect-runner | ADE_KEY=${key} sh -s -- --name ${name} --dir .`,
	}
}
async function revoke(name, requestKey, by = owner) {
	const result = await once(
		scopedKey(`revoke ${name}`, requestKey),
		`revoke ${name}`,
		async (tx) => {
			const [all, makers] = [await tx.doc(Keys), await tx.doc(Makers)]
			if (!all[name]) throw Object.assign(new Error(`No runner named ${name}`), { status: 404 })
			const maker = makers[name] ?? owner
			if (by !== owner && by !== maker)
				throw Object.assign(
					new Error(`Only ${maker === owner ? '' : `${maker} or `}the owner revokes ${name}`),
					{ status: 403 },
				)
			delete all[name]
			return { revoked: name }
		},
	)
	runners.kick(name, 4001, `${name} was revoked`)
	return result
}

// ── Invites ───────────────────────────────────────────────────────────────

/**
 * A key with a name on it, replacing that name's old one, whose sockets close; its link brings a browser in under the
 * name. A retry with the same request key gets the same key.
 */
async function invite(name, server, requestKey) {
	if (!/^[\w.-]{1,40}$/.test(name))
		throw new Error('name who you invite: letters, digits, dot, dash or underscore')
	if (name === owner) throw new Error(`${name} is the owner`)
	const key = newKey('aik_', requestKey, name)
	const replaced = await commit(async (tx) => {
		const all = await tx.doc(Invites)
		if (all[name]?.key === sha256(key)) return false
		all[name] = { key: sha256(key), at: new Date().toISOString() }
		return true
	})
	knowInvites((await harness.snapshot(Invites, context)) ?? {})
	if (replaced) closeSockets(name, `${name} was invited again`)
	return { name, key, link: `${server}/#key=${key}`, on: invitesOn }
}
/**
 * Puts someone out, from the next request on: their key opens nothing, their sockets close, their runners' keys go,
 * though the names stay theirs, and the scheduled tasks that run as them end
 */
async function uninvite(name, requestKey) {
	const result = await once(
		scopedKey(`uninvite ${name}`, requestKey),
		`uninvite ${name}`,
		async (tx) => {
			const all = await tx.doc(Invites)
			if (!all[name])
				throw Object.assign(new Error(`Nobody named ${name} is invited`), { status: 404 })
			delete all[name]
			const [keyed, makers] = [await tx.doc(Keys), await tx.doc(Makers)]
			const theirs = Object.keys(keyed).filter((runner) => makers[runner] === name)
			for (const runner of theirs) delete keyed[runner]
			return { uninvited: name, runners: theirs }
		},
	)
	knowInvites((await harness.snapshot(Invites, context)) ?? {})
	closeSockets(name, `${name}'s invite was taken back`)
	for (const runner of result.runners) runners.kick(runner, 4001, `${runner} was revoked`)
	for (const hook of uninvitedHooks) await hook(name)
	return result
}
const closeSockets = (name, why) => {
	for (const socket of wss.clients) if (personOf.get(socket) === name) socket.close(4001, why)
}

// ── Upgrade: sockets and runner connections ───────────────────────────────

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: true })
/** Whom each person's socket is, so taking an invite back closes theirs */
const personOf = new WeakMap()
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
	// A module's socket writes, the canvas's strokes; the feed's only reads
	if (taker && (fromAgent(req) || ownerByLogin(req, serve))) return refuse('403 Forbidden')
	const socket = await new Promise((resolve) => wss.handleUpgrade(req, raw, head, resolve))
	// Their invite may have gone while the socket opened
	if (sender && whoSent(req, serve) !== sender)
		return socket.close(4001, 'Your key opens nothing here now')
	if (sender) personOf.set(socket, sender)
	if (taker)
		return taker.connect(threadId && Number(threadId), socket, url, sender).catch((error) => {
			console.error(`${named} socket:`, error)
			socket.close(
				4004,
				Buffer.from(errorLine(error))
					.subarray(0, 119)
					.toString()
					.replace(/\uFFFD$/, ''),
			)
		})
	/** A runner's connection: once closed, by its socket or by a newer one for its name, it stops wherever it is */
	const connection =
		name &&
		runners.connection(name, (code, reason) =>
			code ? socket.close(code, reason) : socket.terminate(),
		)
	const close = () => {
		feed.disconnect(socket)
		if (connection && runners.disconnect(connection)) {
			console.log(`runner ${name} offline`)
			feed.touch(['runners', 'bots', 'threads', 'archived', 'thread'])
			for (const hook of runnerHooks) hook(name, false)
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
		})
		return
	}
	/** A runner shows its key before it counts, so nobody can take its name */
	const given = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
	const held = (await keys())[name]
	if (connection.phase === 'closed') return
	if (!given || held !== sha256(given)) {
		console.log(`runner ${name} turned away: ${given ? 'wrong or revoked key' : 'no key'}`)
		return socket.close(
			4001,
			given
				? `${name}'s key is wrong or was revoked. On the server's machine run\n  ade key ${name}\nthen run the line it prints here.`
				: `${name} needs a key. On the server's machine run\n  ade key ${name}\nthen run the line it prints here.`,
		)
	}
	runners.register(connection)
	updating.delete(name)
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
	// Its models come as a message, not in the URL, which a catalog of hundreds would overflow
	const offered = await runners
		.call(name, { op: 'models' }, { signal: AbortSignal.timeout(10_000) })
		.catch(() => null)
	if (offered)
		await commit(async (tx) => {
			const all = await tx.doc(Runners)
			if (connection.phase !== 'closed' && all[name]) setOffers(all[name], offered)
		})
	if (connection.phase === 'closed') return
	feed.touch(['runners', 'bots', 'threads', 'archived', 'thread'])
	for (const hook of runnerHooks) hook(name, true)
	socket.send(JSON.stringify({ op: 'ready' }))
	if (runner.version && runner.version !== bundle.version) {
		outdated.add(connection)
		nudge()
		feed.touch('runners')
	}
	console.log(
		[
			`runner ${name} online`,
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
	invites,
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
	if (invites !== undefined) {
		if (typeof invites !== 'boolean') throw new Error('invites is on or off: true or false')
		if (invites) next.invites = true
		else delete next.invites
	}
	if (bots !== undefined) {
		if (typeof bots.voice !== 'string') throw new Error('bots voice is text')
		put('bots', 'voice', bots.voice, bots.voice === DEFAULT_VOICE)
	}
	writeFileSync(settings.file, `${JSON.stringify(next, null, '\t')}\n`)
	return { saved: settings.file, ...restartSoon('settings saved') }
}
/**
 * A checkout whose lockfile moved since its last install gets one before it restarts, so new code doesn't start
 * against old packages; if the install fails, this server keeps running
 */
function installed() {
	const read = (file) => {
		try {
			return readFileSync(path.join(import.meta.dirname, file), 'utf8')
		} catch {
			return ''
		}
	}
	if (read('pnpm-lock.yaml') === read('node_modules/.pnpm/lock.yaml')) return true
	console.log('restart: the lockfile changed; running pnpm install first')
	return new Promise((resolve) =>
		execFile(
			'pnpm',
			['install', '--frozen-lockfile'],
			{ cwd: import.meta.dirname, timeout: 10 * 60_000 },
			(error, _out, err) => {
				if (error) console.error('restart: pnpm install failed, so this server keeps running', err)
				resolve(!error)
			},
		),
	)
}
/** Restarts once this request is answered; where the runtime can't restart in place, it stops */
function restartSoon(why) {
	const restarts = typeof process.execve === 'function'
	setTimeout(
		() => restart(why, restarts).catch((error) => (console.error(error), process.exit(1))),
		100,
	)
	return { restarts }
}
/**
 * Closes the store, so nothing in flight is lost, then starts again with the same port and environment, or stops.
 * In place: the same process, so its terminal, its process group and arbe desktop's house token stay.
 */
async function restart(why, again) {
	if (again && !release && !(await installed())) return
	console.log(
		`restart: ${again ? `${why}; restarting` : `${why}; stopped, start it again to take it up`}`,
	)
	// Waits for its runner, so the process after the restart isn't left a zombie it can't reap
	const runnerExit =
		lent?.kill && lent.exitCode === null && lent.signalCode === null
			? new Promise((resolve) => lent.once('exit', resolve))
			: undefined
	if (lent?.kill) lent.kill()
	await Promise.all([(stopping ??= close()), runnerExit])
	if (!again) process.exit(0)
	try {
		takeStaged()
	} catch (error) {
		console.error(`restart: couldn't take up ${staged?.tag}; the same release starts again`, error)
	}
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

const wrap = (items, width = 60) => {
	const lines = []
	for (const item of items) {
		const last = lines.at(-1)
		if (last && `${last}, ${item}`.length <= width) lines[lines.length - 1] = `${last}, ${item}`
		else lines.push(item)
	}
	return lines
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
				console.error('hook request:', error)
				refuse(res, error.status ?? 400, errorLine(error))
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
		// This release came up, so the one before it can go
		if (release) rmSync(`${import.meta.dirname}.old`, { recursive: true, force: true })
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
			console.log(`ade  ${urls.join('\n     ')}`)
			console.log()
			say('config', tilde(settings.file))
			say('data', tilde(file))
			if (envFile) say('env', tilde(envFile))
			say('serve', `http://127.0.0.1:${servePort}  (point tailscale serve here)`)
			if (hookPort)
				say('hooks', `http://127.0.0.1:${hookPort}/hooks/<task-id>  (point tailscale funnel here)`)
			const onNames = modules.map((module) => module.name)
			const offCount = off(false).length + off(true).length
			const offNote = offCount
				? `(${offCount} off${off(true).length ? `; defaults off: ${off(true).join(', ')}` : ''})`
				: ''
			const lines = onNames.length ? wrap(onNames) : ['none']
			if (offNote) lines[lines.length - 1] = `${lines.at(-1)} ${offNote}`
			say('modules', lines.join(',\n           '))
			console.log()
		}
		connectSelf(
			`http://${host === '0.0.0.0' ? '127.0.0.1' : addresses[0]}:${listening.port}`,
		).catch((error) => console.error(error))
	})
}
