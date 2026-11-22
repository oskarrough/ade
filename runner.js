import WebSocket from 'ws'
import {
	appendFileSync,
	chmodSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { clampThinkingLevel } from '@earendil-works/pi-ai/models'
import {
	createAgentSessionServices,
	resolveCliModel,
	resolveModelScopeWithDiagnostics,
	SettingsManager,
} from '@earendil-works/pi-coding-agent'
import { dataDir, load } from './modules.js'
import { runnerBundle, serveRunner } from './remote.js'

// Prefer the installed pi's default; an internal path change must not stop the runner.
const { DEFAULT_THINKING_LEVEL } = await import(
	new URL('./core/defaults.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href
).catch(() => ({ DEFAULT_THINKING_LEVEL: 'medium' }))

const { values: args } = parseArgs({
	options: {
		server: {
			type: 'string',
			default: process.env.ADE_SERVER || 'http://localhost:3000',
		},
		name: { type: 'string' },
		dir: { type: 'string', multiple: true, default: [process.cwd()] },
		'discover-dirs': { type: 'boolean', default: false },
		owner: { type: 'string', default: '' },
		'read-only': { type: 'boolean', default: false },
		allow: { type: 'string', multiple: true, default: [] },
		key: { type: 'string' },
		'key-file': { type: 'string' },
		help: { type: 'boolean', short: 'h' },
	},
})
if (args.help) {
	console.log(`ade runner [options]

  On the server's machine, \`ade runner\` alone connects this folder, named after it.
  Elsewhere, \`ade key <name>\` on the server's machine prints the line to run here.

  --server url      server to dial (ADE_SERVER or http://localhost:3000)
  --name name       runner's name, how threads address it (this folder's name)
  --dir folder      folder threads start in (current folder); repeat to suggest more
  --discover-dirs   offer git and jj checkouts beneath the folders
  --owner login     take work only from this person and those allowed: the owner by their
                    login on the server's machine, a friend by their tailnet login
  --allow name      also take work from this person or @runner; repeat for more
  --read-only       refuse writes and commands
  --key key         runner key (else the one saved for its name, then ADE_KEY)
  --key-file file   read the saved key here instead of ~/.config/ade/key.<name>
  -h, --help        print these options`)
	process.exit(0)
}
const roots = [...new Set(args.dir.map((dir) => path.resolve(dir)))]
const dir = roots[0]
const server = new URL(args.server).origin
/** Named after its folder, as a runner's name is a word: anything else becomes a dash */
const name =
	args.name ||
	path.basename(dir).replace(/[^\w.-]+/g, '-') ||
	os.hostname().replace(/[^\w.-]+/g, '-')
/** A word as a shell reads it back: quoted when it holds anything but plain characters */
const quoted = (word) =>
	/^[\w@%+=:,./~-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
/** The `ade runner` that starts this one again, with its flags but never its key, `more` in place of those it names */
const again = (...more) => {
	const kept = []
	const flags = process.argv.slice(2)
	for (let index = 0; index < flags.length; index++) {
		const [flag, value] = flags[index].split('=')
		if (![...more, '--key'].includes(flag)) kept.push(flags[index])
		else if (value === undefined) index++
	}
	return ['ade runner', ...[...kept, ...more].map(quoted)].join(' ')
}
const stop = (message) => {
	console.log(message)
	process.exit(1)
}
const config = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'ade')
const keyFile = args['key-file'] || path.join(config, `key.${name}`)
const lent = Boolean(process.env.ADE_LENT)
const inherited = process.env.ADE_KEY
// Agents' commands inherit this process's environment: they get neither the key nor the mark of the server's own runner
delete process.env.ADE_KEY
delete process.env.ADE_LENT
/** A saved key, with the folder it was saved for; the connect-runner script saves the key alone */
const saved = (() => {
	try {
		const text = readFileSync(keyFile, 'utf8').trim()
		return text.startsWith('{') ? JSON.parse(text) : { key: text }
	} catch {
		return undefined
	}
})()
/**
 * The keys to try, in turn: one given by flag or file alone; else the one saved for this name, then ADE_KEY, which an
 * agent's shell inherits from its own runner. The server's own runner has only the key the server gave it.
 */
const keys = lent
	? [inherited]
	: args.key
		? [args.key]
		: args['key-file']
			? [saved?.key]
			: [saved?.key, inherited]
const tried = keys.filter(Boolean)
args.key = tried.shift() ?? ''
// A name taken from the folder belongs to the folder its key was saved in; another folder by that name is another runner
if (!args.name && saved?.dir && saved.dir !== dir && args.key === saved.key)
	stop(
		`${name} is the runner for ${saved.dir}. Give this folder its own name:\n  ${again('--name', `${name}-2`)}`,
	)
/** Its terminal's lines, kept beside the server's store; the server's own runner prints into the server's log */
const logFile = path.join(dataDir(), `runner.${name}.log`)
if (!lent) {
	mkdirSync(dataDir(), { recursive: true })
	// Only its owner reads it: it can hold what agents ran and printed
	appendFileSync(logFile, '', { mode: 0o600 })
	chmodSync(logFile, 0o600)
	for (const method of /** @type {const} */ (['log', 'error'])) {
		const print = console[method]
		console[method] = (...parts) => {
			print(...parts)
			appendFileSync(logFile, `${new Date().toISOString()} ${parts.join(' ')}\n`)
		}
	}
}

/** Before it dials: the server answers, nobody else holds the name, and on the server's machine it makes its own key */
async function ready() {
	const list = await fetch(`${server}/api/runners`)
		.then(async (res) => ({ ok: res.ok, json: await res.json().catch(() => []) }))
		.catch(() =>
			stop(
				`No ade server answers at ${server}. Start one with \`ade\`, or name yours:\n  ${again('--server', 'http://<host>:3000')}`,
			),
		)
	const holder = list.ok && list.json.find((runner) => runner.name === name)
	if (holder?.online)
		stop(
			`A runner named ${name} is already online${holder.dir ? `, in ${holder.dir}` : ''}. Give this one its own name:\n  ${again('--name', `${name}-2`)}`,
		)
	taken = holder
	if (!args.key) await mint()
}
/** A runner by this name, holding a key, when this one started */
let taken
/**
 * A key of its own, which only the server's owner gets: on the server's machine that's whoever runs this. A name that
 * holds a key is another machine's or folder's, offline for now: it takes that over only when named on purpose.
 */
async function mint() {
	if (taken && !args.name)
		stop(
			`A runner named ${name} already exists${taken.dir ? `, in ${taken.dir}` : ''}, offline for now. Give this one its own name:\n  ${again('--name', `${name}-2`)}\nor take its name over, which replaces its key:\n  ${again('--name', name)}`,
		)
	if (taken) console.log(`This replaces ${name}'s key: the runner that had it can't connect again.`)
	const res = await fetch(`${server}/api/runners`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ name }),
	}).catch(() => undefined)
	if (!res?.ok)
		stop(
			`${name} needs a key, and only the server's owner can make one. On the server's machine run\n  ade key ${name}\nthen run the line it prints here.`,
		)
	args.key = (await res.json()).key
	save()
}
/** The key that got in, kept for its name and folder, so next time `ade runner` alone does */
const save = () => {
	if (lent || args['key-file']) return
	mkdirSync(config, { recursive: true })
	writeFileSync(keyFile, JSON.stringify({ key: args.key, dir }), { mode: 0o600 })
}

/** pi's own models and logins, as pi reads them, with the providers its extensions add, such as claude-code */
const { modelRuntime: models, diagnostics } = await createAgentSessionServices({ cwd: dir })
for (const diagnostic of diagnostics)
	if (diagnostic.type === 'error') console.log(`pi: ${diagnostic.message}`)
const echo = fauxProvider({ provider: 'echo', models: [{ id: 'echo' }, { id: 'try' }] })
models.registerNativeProvider(echo.provider)

/** What `pi --model pattern` runs */
function resolve(pattern) {
	const settings = SettingsManager.create(dir)
	const asked = pattern
		? { cliModel: pattern }
		: { cliProvider: settings.getDefaultProvider(), cliModel: settings.getDefaultModel() }
	const found = resolveCliModel({ ...asked, modelRuntime: models })
	if (!found.model) throw new Error(found.error ?? `${name} has no default model in pi; name one`)
	return {
		model: found.model,
		...(found.thinkingLevel ? { thinkingLevel: found.thinkingLevel } : {}),
		defaultThinkingLevel: clampThinkingLevel(
			found.model,
			settings.getModelThinkingLevel(found.model.provider, found.model.id) ??
				settings.getDefaultThinkingLevel() ??
				DEFAULT_THINKING_LEVEL,
		),
	}
}
const defaultModel = () => {
	try {
		const { model, thinkingLevel, defaultThinkingLevel } = resolve('')
		return {
			model: `${model.provider}/${model.id}`,
			thinkingLevel: thinkingLevel ?? defaultThinkingLevel,
		}
	} catch (error) {
		return { error: error.message }
	}
}

/** Sent to the server, which asks a runner its updater started to update when the server's differs */
const { version } = await runnerBundle(import.meta.dirname).catch(() => ({ version: '' }))

const modules = await load('runner', { name, server, dir })

function folders() {
	const found = []
	const list = (at) => {
		try {
			return readdirSync(at, { withFileTypes: true })
		} catch {
			return []
		}
	}
	const scan = (at, depth) => {
		for (const item of list(at)) {
			if (!item.isDirectory() || item.name.startsWith('.') || item.name === 'node_modules') continue
			const sub = path.join(at, item.name)
			if (list(sub).some((entry) => entry.name === '.git' || entry.name === '.jj')) found.push(sub)
			else if (depth > 1) scan(sub, depth - 1)
		}
	}
	if (args['discover-dirs']) for (const root of roots) scan(root, 2)
	return [...new Set([...roots, ...found.sort()])].slice(0, 500)
}

let warnedOffers = false

/**
 * Which models are billed per token: their provider is logged in with an API key rather than a subscription's OAuth,
 * and pi lists a cost above zero. Sent as those providers, and their models that cost nothing, which are few.
 */
async function billing() {
	const available = await models.getAvailable().catch(() => [])
	const auths = Object.fromEntries(
		await Promise.all(
			[...new Set(available.map(({ provider }) => provider))].map(async (provider) => [
				provider,
				(await models.checkAuth(provider).catch(() => undefined))?.type,
			]),
		),
	)
	const keyed = available.filter(({ provider }) => auths[provider] === 'api_key')
	const paid = (model) => Object.values(model.cost ?? {}).some((cost) => cost > 0)
	return {
		metered: [...new Set(keyed.filter(paid).map(({ provider }) => provider))],
		free: keyed.filter((model) => !paid(model)).map((model) => `${model.provider}/${model.id}`),
	}
}

async function connect() {
	const { model, thinkingLevel, error } = defaultModel()
	const query = new URLSearchParams({
		runner: name,
		owner: args.owner,
		host: os.hostname(),
		home: os.homedir(),
		dir,
		model: model ?? '',
		thinkingLevel: thinkingLevel ?? '',
		modelError: error ?? '',
		version,
		...(args['read-only'] ? { readOnly: '1' } : {}),
	})
	if (error) {
		const loggedIn = (await models.getAvailable().catch(() => [])).some(
			({ provider }) => provider !== 'echo',
		)
		console.log(
			loggedIn
				? `pi's default model doesn't resolve: ${error}`
				: "pi isn't logged in, so only echo answers: install pi (`npm i -g @earendil-works/pi-coding-agent`), run `pi`, then `/login`.",
		)
	}
	let offered = []
	try {
		const { scopedModels } = await resolveModelScopeWithDiagnostics(
			SettingsManager.create(dir).getEnabledModels() ?? [],
			models,
		)
		offered = [...new Set(scopedModels.map(({ model }) => `${model.provider}/${model.id}`))]
	} catch (error) {
		if (!warnedOffers) console.error(`${name}: couldn't list models: ${error.message}`)
		warnedOffers = true
	}
	for (const ref of offered) query.append('offer', ref)
	const { metered, free } = await billing()
	for (const provider of metered) query.append('metered', provider)
	for (const ref of free) query.append('free', ref)
	for (const who of args.allow) query.append('allow', who)
	for (const folder of folders()) query.append('folder', folder)
	const socket = new WebSocket(`${server.replace(/^http/, 'ws')}/ws?${query}`, {
		headers: { authorization: `Bearer ${args.key}` },
	})
	const runner = serveRunner({
		name,
		dir,
		models,
		resolve,
		echo,
		ops: {
			...Object.fromEntries(
				modules.filter((module) => module.call).map((module) => [module.name, module.call]),
			),
			/** Every model pi is logged in for, beyond the scoped ones it offers first */
			available: async () => [
				...new Set((await models.getAvailable()).map((model) => `${model.provider}/${model.id}`)),
			],
		},
		readOnly: args['read-only'],
		send: (text) => socket.readyState === WebSocket.OPEN && socket.send(text),
		onTell: (message) =>
			message.op === 'update'
				? update()
				: modules.find((module) => module.name === message.op)?.told?.(message),
	})
	const from = args.owner ? [args.owner, ...args.allow].join(', ') : ''
	let shown = false
	const online = () => {
		save()
		// The server's own runner: the server already printed its row
		if (lent) return
		if (shown) return console.log(`${name} back online`)
		shown = true
		const home = (file) =>
			file.startsWith(os.homedir()) ? `~${file.slice(os.homedir().length)}` : file
		console.log(
			[
				`${name} is online${args['read-only'] ? ', read-only' : ''}`,
				`  server  ${server}`,
				...roots.map((root, index) => `  ${index ? '      ' : 'folder'}  ${home(root)}`),
				...(from ? [`  works for  ${from}`] : []),
				`  log     ${home(logFile)}`,
				'Ctrl+C to stop',
			].join('\n'),
		)
	}
	socket.onmessage = ({ data }) =>
		JSON.parse(String(data)).op === 'ready' ? online() : runner.receive(data)
	socket.onclose = ({ code, reason }) => {
		runner.stopAll()
		for (const module of modules) module.disconnected?.()
		if (code === 4001) {
			// A key turned away before it ever got in: the next one, then on the server's machine a new one, once
			if (!shown && !lent && tried.length) {
				args.key = tried.shift()
				return connect()
			}
			if (!shown && !lent && !remade) {
				remade = true
				return mint().then(connect)
			}
			stop(String(reason))
		}
		console.log(`disconnected from ${server}; retrying…`)
		setTimeout(connect, 2000)
	}
	socket.onerror = () => {}
}

let warned = false
let remade = false
function update() {
	if (process.env.ADE_LAUNCHER === '1') {
		console.log(`${name}: the server runs a newer runner; updating…`)
		process.exit(75)
	}
	if (!warned)
		console.log(
			`${name}: the server runs a newer runner; to update, Ctrl+C and run again:\n  ${again()}`,
		)
	warned = true
}

await ready()
connect()
