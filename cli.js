/** The API from a terminal */
import { agentTo } from './util.js'
import { defaultTitle } from './apps/client/title.js'
import { parseArgs } from 'node:util'
import { on, once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import WebSocket from 'ws'
import { ownerKeyHere } from './modules.js'

const usage = `ade [--server url] <command>

  You write as whoever the server takes you for: the owner on its own machine, by the key beside its
  store, your login through tailscale serve, or the owner anywhere with ADE_OWNER_KEY set to the key
  \`link\` shows.

  post <message>   post to a new thread, or --thread N, and print the answers as they land
                   --to agent    model@runner, a runner, a bot's name, or nobody; repeat for bots
                                 (left out: whom the thread last asked)
                   --thinking t  how hard they think: off, minimal, low, medium, high, xhigh, max
                   --dir d       a folder inside the runner's
                                 --thinking and --dir require a model@runner, not a bot's name
                   --title t     the new thread's title (the message's start by default)
                   --steer       join the answer being written
                   --no-wait     post and return
                   A message starting with "$ " runs a command on the runner.
  threads          every thread, with its status and agents
  read <thread>    a thread's newest 50 messages, or its --last N, those --after id, or --all
  trail <thread>   what happened in it, step by step, or only to one --message id
  wait <thread>    wait until its agents are done, then print the answers to the latest ask, or all --after id
  runners          every runner holding a key: online, offline, outdated or updating, its machine,
                   runner version and models. An outdated runner updates itself once it's idle
  update           the owner, on a house that runs a release: fetch the newest, restart into it and
                   say which one came up. A checkout updates with a pull
  key <name>       a new key for the runner of that name, replacing its old one, and the line that
                   connects it; the name is yours to pick, and threads address that machine by it
  revoke <runner>  take its key away: it goes offline and leaves the list
  stop <thread>    stop its agents and commands
  link             on the server's machine: a link that brings a browser in as the owner
  invite <name>    a key with their name on it, as a link that brings their browser in as them;
                   inviting again replaces it. It opens the house only with "invites": true in ade.json
  uninvite <name>  take the invite back: its key opens nothing from the next request
  invites          whether invites are on, and who holds one
  import <runner> [session]
                   with pi-sessions on: list the pi sessions in the runner's folder (--dir for another),
                   or start a new thread from one, by id or path, and print "thread N"; --title names it
  export <dir>     with export on: fetch every thread, archived ones included, and write each as
                   Markdown and JSON into <dir>, resolved against this shell's folder`

/** @template {import("node:util").ParseArgsOptionsConfig} T
 * @param {T} options */
const parse = (options) => {
	try {
		return parseArgs({ allowPositionals: true, options })
	} catch (error) {
		console.error(`${error.message}\n\n${usage}`)
		process.exit(1)
	}
}
const {
	values: flags,
	positionals: [command, ...rest],
} = parse({
	server: {
		type: 'string',
		default: process.env.ADE_SERVER || 'http://127.0.0.1:3000',
	},
	thread: { type: 'string' },
	to: { type: 'string', multiple: true },
	thinking: { type: 'string' },
	dir: { type: 'string' },
	title: { type: 'string' },
	steer: { type: 'boolean' },
	'no-wait': { type: 'boolean' },
	last: { type: 'string' },
	all: { type: 'boolean' },
	after: { type: 'string' },
	message: { type: 'string' },
	help: { type: 'boolean', short: 'h' },
})

/** The owner's key: ADE_OWNER_KEY when given; on the server's own machine, the one beside its store, which a house
 * with invites on needs even there */
const local = /^https?:\/\/(localhost|127\.[\d.]+|\[::1\])(:\d+)?(\/|$)/.test(flags.server)
const ownerKey = process.env.ADE_OWNER_KEY || (local ? ownerKeyHere() : '')
const auth = ownerKey ? { authorization: `Bearer ${ownerKey}` } : {}
const socketTo = () => new WebSocket(`${flags.server.replace(/^http/, 'ws')}/ws`, { headers: auth })

async function api(method, route, body) {
	const res = await fetch(flags.server + route, {
		method,
		headers: { 'content-type': 'application/json', ...auth },
		body: body && JSON.stringify(body),
	})
	const json = await res.json()
	if (!res.ok) throw new Error(json.error ?? res.statusText)
	return json
}

function agent(name) {
	if (!flags.thinking && !flags.dir) return name
	if (!name.includes('@'))
		throw new Error('--thinking and --dir require a model@runner, not a bot name')
	return {
		...agentTo(name),
		...(flags.thinking ? { thinkingLevel: flags.thinking } : {}),
		...(flags.dir ? { dir: flags.dir } : {}),
	}
}

function show({ id, data: message }) {
	const shell =
		message.shell &&
		[
			message.shell.stdout,
			message.shell.stderr,
			message.shell.error,
			message.shell.code ? `exit ${message.shell.code}` : '',
		]
			.filter(Boolean)
			.join('\n')
	console.log(
		`#${id} ${message.author}${message.to ? ` → ${message.to.join(', ')}` : ''}${message.from ? ` (from thread ${message.from})` : ''}\n${message.body}${shell ? `\n${shell}` : ''}\n`,
	)
}

/** Reads `thread/<id>` on the feed until its row reaches `minSeq` with `busy: false`, handing `onFrame` the row and the messages each frame brings */
async function waitThread(frames, id, minSeq, onFrame = (_row, _messages) => {}) {
	let row = null
	for (;;) {
		const next = await frames.next()
		if (next.done) throw new Error('Server disconnected while waiting')
		const frame = JSON.parse(String(next.value[0]))
		if (frame.view !== `thread/${id}`) continue
		const put = frame.put ?? []
		row = put.find((item) => item.key === 'thread')?.row ?? row
		if (row)
			onFrame(
				row,
				put.filter((item) => typeof item.key === 'number').map((item) => item.row),
			)
		if (frame.seq >= minSeq && row && !row.busy) return row
	}
}

async function post() {
	const body = rest.join(' ')
	if (!body) throw new Error('post what?')
	const fresh = !flags.thread
	const id = fresh
		? (await api('POST', '/api/threads', { title: flags.title ?? defaultTitle(body) })).id
		: Number(flags.thread)
	const seen = (await api('GET', `/api/threads/${id}?last=1`)).entries.at(-1)?.id ?? 0
	const to = flags.to && (flags.to.includes('nobody') ? null : flags.to.map(agent))
	/** Subscribe before posting so even an immediate answer can't slip between the post and the wait */
	const socket = flags['no-wait'] ? null : socketTo()
	const frames = socket && on(socket, 'message', { close: ['close'] })
	try {
		if (socket) {
			await once(socket, 'open')
			socket.send(JSON.stringify({ sub: `thread/${id}` }))
		}
		const posted = await api('POST', `/api/threads/${id}/entries`, {
			body,
			...(flags.to ? { to } : {}),
			...(flags.steer ? { steer: true } : {}),
			key: crypto.randomUUID(),
		}).catch(async (error) => {
			// A new thread that never got its message isn't worth keeping
			if (fresh) await api('POST', `/api/threads/${id}/archive`, { archived: true }).catch(() => {})
			if (error.message.startsWith('No runner named ')) {
				const names = (await api('GET', '/api/runners')).map((runner) => runner.name)
				error.message += names.length
					? `. Runners: ${names.join(', ')}`
					: '. No runner has connected yet'
			}
			throw error
		})
		if (fresh) console.log(`thread ${id}`)
		const asked = posted.command || posted.to?.length
		if (!asked && !flags.to)
			console.error('Asked nobody: name a model@runner, a runner or a bot with --to')
		if (flags['no-wait'] || !asked) return
		let last = posted.entry ?? seen
		let waiting = ''
		/** Each message once, as the feed brings it: a pick re-sends one already shown */
		const shows = (messages) => {
			for (const entry of messages.sort((one, other) => one.id - other.id))
				if (entry.id > last) {
					show(entry)
					last = entry.id
				}
		}
		socket.send(JSON.stringify({ sync: `thread/${id}`, seq: posted.seq }))
		await waitThread(frames, id, posted.seq, (row, messages) => {
			const blocked = (row.agents ?? [])
				.filter((agent) => agent.status === 'blocked')
				.map((agent) => agent.to?.runner)
			if (blocked.join() !== waiting && (waiting = blocked.join()))
				console.error(`waiting for ${waiting}, offline…`)
			shows(messages)
		})
		shows((await api('GET', `/api/threads/${id}?after=${last}`)).entries)
	} finally {
		await frames?.return()
		socket?.close()
	}
}

async function lastAsk(id) {
	for (let last = 50; ; last *= 2) {
		const { entries } = await api('GET', `/api/threads/${id}?last=${last}`)
		const asked = entries.findLast((entry) => entry.data.to?.length)
		if (asked) return asked.id
		if (entries.length < last) return 0
	}
}

const commands = {
	post,
	async threads() {
		for (const thread of await api('GET', '/api/threads'))
			console.log(
				`#${thread.id} ${thread.title}  ${thread.status}${thread.agents.length ? `  ${thread.agents.map((agent) => agent.name).join(', ')}` : ''}${thread.parent ? `  child of #${thread.parent}` : ''}`,
			)
	},
	async read() {
		const query = [
			flags.after !== undefined && `after=${Number(flags.after)}`,
			flags.last !== undefined && `last=${Number(flags.last)}`,
			flags.all && 'all',
		].filter(Boolean)
		const { entries } = await api('GET', `/api/threads/${Number(rest[0])}?${query.join('&')}`)
		for (const entry of entries.slice(-(Number(flags.last) || entries.length))) show(entry)
	},
	async trail() {
		const message = flags.message === undefined ? '' : `?entry=${Number(flags.message)}`
		for (const step of await api('GET', `/api/threads/${Number(rest[0])}/trail${message}`))
			console.log(
				`${new Date(step.at).toLocaleTimeString()}  ${step.entry === undefined ? '' : `#${step.entry} `}${step.text}`,
			)
	},
	async wait() {
		const id = Number(rest[0])
		const socket = socketTo()
		const frames = on(socket, 'message', { close: ['close'] })
		try {
			await once(socket, 'open')
			socket.send(JSON.stringify({ sub: `thread/${id}` }))
			await waitThread(frames, id, 0)
			// What came after the newest message that asked someone
			const after = flags.after ? Number(flags.after) : await lastAsk(id)
			;(await api('GET', `/api/threads/${id}?after=${after}`)).entries.forEach(show)
		} finally {
			await frames.return()
			socket.close()
		}
	},
	async runners() {
		for (const runner of await api('GET', '/api/runners')) {
			const state = [
				runner.updating ? 'updating' : runner.online ? 'online' : 'offline',
				runner.outdated && !runner.updating && 'outdated',
				runner.busy && `busy in ${runner.busy}`,
			]
				.filter(Boolean)
				.join(', ')
			console.log(
				!runner.dir
					? `${runner.name} waiting for it to dial in`
					: `${runner.name} ${state}  on ${runner.host || 'an unknown machine'}  runner ${runner.version || 'unknown'}  ${runner.dir}${runner.readOnly ? ' (read-only)' : ''}  default ${runner.model || `none${runner.modelError ? `: ${runner.modelError}` : ''}`}`,
			)
			for (const folder of (runner.folders ?? []).slice(1)) console.log(`  folder ${folder}`)
			for (const model of runner.offers) console.log(`  ${model}@${runner.name}`)
		}
	},
	/** The newest release, and the server restarted into it; the socket closing is the restart starting */
	async update() {
		const { release } = await api('GET', '/api/server')
		if (!release) return console.log('this runs from your checkout; pull to update')
		console.log(`on ${release}; looking for a newer release…`)
		const socket = socketTo()
		await once(socket, 'open')
		const closed = once(socket, 'close')
		const { staged, restarts } = await api('POST', '/api/update').catch((error) => {
			socket.close()
			throw error
		})
		if (!staged) {
			socket.close()
			return console.log(`${release} is the newest release`)
		}
		if (!restarts)
			return console.log(`${staged} is ready; the server stopped, start it again to run it`)
		console.log(`restarting into ${staged}…`)
		await closed
		for (let tries = 0; ; tries++) {
			const now = await api('GET', '/api/server').catch(() => null)
			if (now?.release === staged) return console.log(`now on ${staged}`)
			if (now) throw new Error(`${staged} didn't come up; back on ${now.release}`)
			if (tries === 240) throw new Error(`the server isn't back after two minutes`)
			await new Promise((resolve) => setTimeout(resolve, 500))
		}
	},
	async key() {
		const name = rest[0]
		if (!name)
			throw new Error(
				'ade key <name>: name the runner, as threads will address it, like\n  ade key laptop',
			)
		const had = (await api('GET', '/api/runners')).find((runner) => runner.name === name)
		const { key, ade, connect } = await api('POST', '/api/runners', { name })
		console.log(
			`${had ? `This replaces ${name}'s key: ${name}${had.online ? ' is cut off and' : ''} stays offline until it connects with the line below.` : `A key for the new runner ${name}.`}\n\nOn the runner's machine, in the folder agents should start in:\n  ${ade}\nwithout ade installed there:\n  ${connect}\nOn this machine, \`ade runner --name ${name}\` alone does it.\n\nADE_KEY=${key}`,
		)
	},
	async revoke() {
		await api('DELETE', `/api/runners/${encodeURIComponent(rest[0] ?? '')}`)
		console.log(`${rest[0]} revoked`)
	},
	stop: () => api('POST', `/api/threads/${Number(rest[0])}/stop`),
	/** The owner's key, from beside this machine's store, in a link's fragment: the page trades it for a cookie and drops it */
	async link() {
		const key = ownerKeyHere()
		if (!key) throw new Error('No owner key here: run this on the server’s machine')
		console.log(`${flags.server}/#key=${key}`)
	},
	/** A key with a name on it, as a link that brings their browser in */
	async invite() {
		const name = rest[0]
		if (!name)
			throw new Error('ade invite <name>: who you invite, as their messages will be signed')
		const { link, on } = await api('POST', '/api/invites', { name })
		console.log(
			`${name} can use every runner in this house, yours included, and their agents run as you there; start a runner with --owner to keep it to yourself.\n\nSend ${name} this link; it brings their browser in as ${name}:\n  ${link}\nIf they reach this house at another address, put the same #key=… after that one.${on ? '' : '\n\nInvites are off, so it opens nothing yet: set "invites": true in ade.json and restart. Then only keys get in, yours included: open the link `ade link` prints.'}`,
		)
	},
	async uninvite() {
		await api('DELETE', `/api/invites/${encodeURIComponent(rest[0] ?? '')}`)
		console.log(`${rest[0]}'s invite is taken back`)
	},
	async invites() {
		const { on, invites } = await api('GET', '/api/invites')
		console.log(`Invites are ${on ? 'on' : 'off'}.`)
		for (const { name, at } of invites)
			console.log(`  ${name}  invited ${at.slice(0, 16).replace('T', ' ')}`)
	},
	async import() {
		const [runner, session] = rest
		if (!runner) throw new Error('import from which runner?')
		if (!session) {
			const query = new URLSearchParams({ runner, ...(flags.dir ? { dir: flags.dir } : {}) })
			for (const found of await api('GET', `/api/pi-sessions?${query}`))
				console.log(
					`${found.id}  ${found.modified.slice(0, 16).replace('T', ' ')}  ${found.messageCount} messages  ${found.name ?? found.firstMessage.slice(0, 60)}`,
				)
			return
		}
		const { id } = await api('POST', '/api/pi-sessions', {
			runner,
			session,
			...(flags.dir ? { dir: flags.dir } : {}),
			...(flags.title ? { title: flags.title } : {}),
		})
		console.log(`thread ${id}`)
	},
	async export() {
		if (!rest[0]) throw new Error('export to which folder?')
		const { files } = await api('GET', '/api/export')
		const dir = path.resolve(rest[0])
		await mkdir(dir, { recursive: true })
		const names = Object.keys(files)
		await Promise.all(names.map((name) => writeFile(path.join(dir, name), files[name])))
		console.log(`wrote ${names.length} file${names.length === 1 ? '' : 's'} to ${dir}`)
	},
}

if (flags.help || !commands[command]) {
	console.log(usage)
	process.exit(flags.help ? 0 : 1)
}
await commands[command]().catch((error) => {
	console.error(error.message)
	process.exit(1)
})
