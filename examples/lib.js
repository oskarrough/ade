/** What every example shares */
import WebSocket from 'ws'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createModels } from '@earendil-works/pi-ai/models'
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { messageText as text, serveRunner } from '../remote.js'

/** The shell's ade settings stay out of every server and runner an example starts: a dev shell's MODULES=+director routes posts with no `to` to nobody. `shellEnv` keeps what was there, so a script like try.js can still layer its own MODULES on top. */
export const shellEnv = {}
for (const name of [
	'MODULES',
	'MEMORY_MODEL',
	'SEARCH_URL',
	'STATUS',
	'ADE_KEY',
	'ADE_LENT',
	'ADE_SERVER',
]) {
	shellEnv[name] = process.env[name]
	delete process.env[name]
}

export const repo = path.resolve(import.meta.dirname, '..')
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The first server asks for port 0 and says which it got; later ones, restarts, keep it, and Serve's listener's */
export let base
let port = 0
export let servePort = 0
/** The owner, as the server names them: whoever asks from its own machine */
export let owner
/** A friend as the server names them, coming in through Tailscale Serve as `name@github` */
export const person = (name) => `~${name}+github`

/** Its on-disk path, case as stored, since a shell's `pwd` prints that and macOS's temp folder sits behind a symlink */
const tmp = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'ade-example-')))
export const configDir = path.join(tmp, 'ade')
mkdirSync(configDir)
export const db = path.join(tmp, 'store.sqlite')
export const dir = path.join(tmp, 'folder')
mkdirSync(dir)
/** Runners get a home of their own, so no pi logins; 11-real-model gives them the real one */
export const home = path.join(tmp, 'home')
mkdirSync(home)

const procs = new Set()
process.on('exit', () => {
	// Disposable stores need no graceful shutdown; don't orphan a server waiting on a task.
	for (const child of procs) {
		try {
			process.kill(-child.pid, 'SIGKILL')
		} catch (error) {
			if (error.code !== 'ESRCH') throw error
		}
	}
	rmSync(tmp, { recursive: true, force: true })
})
process.on('SIGINT', () => process.exit(130))
process.on('SIGTERM', () => process.exit(143))

/** Servers and runners use the example's own store and XDG config, never the person's settings. */
export function start(file, args = [], env = {}, cwd = tmp) {
	return command(process.execPath, [path.resolve(repo, file), ...args], {
		cwd,
		env: {
			...process.env,
			PORT: String(port),
			SERVE_PORT: String(servePort),
			HOST: '127.0.0.1',
			DB_PATH: db,
			XDG_CONFIG_HOME: tmp,
			...env,
		},
	})
}

/** Own the whole process group until the example exits, even if its leader exits first. */
export function command(file, args = [], options = {}) {
	const child = spawn(file, args, {
		...options,
		detached: true,
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	child.stdout.on(
		'data',
		(chunk) => process.env.VERBOSE && process.stdout.write(`[${file}] ${chunk}`),
	)
	child.stderr.on('data', (chunk) => process.stdout.write(`[${file} err] ${chunk}`))
	procs.add(child)
	return child
}

export async function server(env = {}, { cwd, args = ['--no-runner'] } = {}) {
	const child = start('server.js', args, env, cwd)
	if (!port) {
		let printed = ''
		child.stdout.on('data', (chunk) => {
			printed += chunk
			port ||= Number(/ade +http:\/\/127\.0\.0\.1:(\d+)/.exec(printed)?.[1])
			servePort ||= Number(/serve +http:\/\/127\.0\.0\.1:(\d+)/.exec(printed)?.[1])
		})
		await until(async () => port && servePort)
		base = `http://127.0.0.1:${port}`
	}
	await until(() => api('GET', '/api/server').then((response) => response.status === 200))
	owner ??= (await api('GET', '/api/server')).json.me
	return child
}

export async function runner(name, { args = [], env = {}, wait = true, dir: folder = dir } = {}) {
	const child = start('runner.js', ['--server', base, '--name', name, '--dir', folder, ...args], {
		HOME: home,
		ADE_KEY: await keyFor(name),
		...env,
	})
	if (wait)
		await new Promise((resolve, reject) => {
			let output = ''
			const ready = (chunk) => {
				output += chunk
				if (!output.includes(`${name} online at`)) return
				child.stdout.off('data', ready)
				child.off('exit', exited)
				resolve(undefined)
			}
			const exited = (code) => {
				child.stdout.off('data', ready)
				reject(new Error(`${name} exited before connecting: ${code}`))
			}
			child.stdout.on('data', ready)
			child.once('exit', exited)
		})
	return child
}

export const keyFor = async (name) => (await api('POST', '/api/runners', { name })).json.key

/** A request from the owner, on the server's own machine; `as` a friend's name, from them through Tailscale Serve */
export async function api(method, route, body, as = undefined) {
	const res = await fetch(`http://127.0.0.1:${as ? servePort : port}${route}`, {
		method,
		headers: {
			'content-type': 'application/json',
			...(as && { 'tailscale-user-login': `${as}@github` }),
		},
		body: body && JSON.stringify(body),
	})
	return { status: res.status, json: await res.json() }
}
export const view = async (id) => (await api('GET', `/api/threads/${id}`)).json
/** An agent's own conversation, found by its name or by `provider/id@runner`, whatever it thinks */
export const conversationOf = async (thread, name) =>
	(
		await api(
			'GET',
			`/api/conversations/${thread.agents.find((agent) => agent.name === name || `${agent.to?.model}@${agent.to?.runner}` === name)?.conversation}`,
		)
	).json
/** A thread's memory lines, from its raw Pi conversation */
export const linesOf = async (id) =>
	(await api('GET', `/api/conversations/${id}`)).json.entries
		.filter((entry) => entry.kind === 'ade.line')
		.map((entry) => ({ id: entry.id, ...entry.data }))
export const answers = (thread) => thread.entries.filter((entry) => entry.data.answer)
export const brief = (thread) =>
	JSON.stringify(
		thread?.entries.map((entry) => [entry.id, entry.data.author, entry.data.body.slice(0, 40)]),
	)
export { text }

export async function until(fn, ms = 8000, every = 100) {
	const end = Date.now() + ms
	while (Date.now() < end) {
		const result = await fn().catch(() => null)
		if (result) return result
		await sleep(every)
	}
	return null
}

export const kill = (child, signal = 'SIGTERM') =>
	new Promise((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) return resolve(undefined)
		child.once('exit', () => resolve(undefined))
		child.kill(signal)
	})

/** Every thread settled: no agent working or waiting for a runner, so nothing more will land until someone asks */
export const quiet = (ms) =>
	until(
		async () =>
			(await api('GET', '/api/threads')).json.every(
				(thread) => !['working', 'blocked'].includes(thread.status),
			),
		ms,
	)

/** One thread settled, `blocked` counting as settled when the runner it waits for is away */
export const settled = (id, { blocked = false, ms } = {}) =>
	until(async () => {
		const thread = await view(id)
		return thread.status !== 'working' && (blocked || thread.status !== 'blocked') ? thread : null
	}, ms)

/** A runner's row says it's online */
export const online = (name, ms) =>
	until(
		() =>
			api('GET', '/api/runners').then((response) =>
				response.json.some((runner) => runner.name === name && runner.online),
			),
		ms,
	)

export const answered = (id, count = 1, ms) =>
	until(async () => {
		const thread = await view(id)
		return answers(thread).length >= count && !['working', 'blocked'].includes(thread.status)
			? thread
			: null
	}, ms)

let failed = 0
/** @param {unknown} [extra] */
export function check(ok, what, extra = '') {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : ` ${extra}`}`)
	if (!ok) failed++
}
export function done() {
	console.log(failed ? `${failed} failed` : 'all ok')
	process.exit(failed ? 1 : 0)
}

/** A runner in this process, reconnecting like runner.js, serving `models` as `serveRunner` does */
export async function localRunner(
	name,
	{
		models,
		resolve,
		echo,
		onTell = undefined,
		model = '',
		query = [],
		readOnly = false,
		ops = undefined,
	},
) {
	let socket,
		closing = false
	const key = await keyFor(name)
	const connect = () => {
		socket = new WebSocket(
			`ws://127.0.0.1:${port}/ws?${new URLSearchParams([['runner', name], ['dir', dir], ['model', model], ...query, ...(readOnly ? [['readOnly', '1']] : [])])}`,
			{ headers: { authorization: `Bearer ${key}` } },
		)
		const runner = serveRunner({
			name,
			dir,
			models,
			resolve,
			echo,
			readOnly,
			ops,
			send: (text) => socket.readyState === WebSocket.OPEN && socket.send(text),
			onTell: (message) => {
				if (message.op !== 'ready') onTell?.(message)
			},
		})
		socket.onmessage = ({ data }) => runner.receive(data)
		socket.onclose = () => {
			runner.stopAll()
			if (!closing) setTimeout(connect, 300)
		}
		socket.onerror = () => {}
	}
	connect()
	await until(() =>
		api('GET', '/api/runners').then((response) =>
			response.json.some((runner) => runner.name === name && runner.online),
		),
	)
	return {
		close: () => {
			closing = true
			socket.close()
		},
	}
}

/** A local runner whose only model, echo/echo, answers route(request) */
export async function scriptedRunner(
	name,
	route,
	{ onTell, model = {}, query, readOnly, ops } = {},
) {
	const script = fauxProvider({
		provider: 'echo',
		models: [{ id: 'echo', ...model }],
		tokensPerSecond: 200,
	})
	script.setResponses(Array.from({ length: 2000 }, () => route))
	const models = createModels()
	models.setProvider(script.provider)
	return localRunner(name, {
		models,
		resolve: () => ({ model: script.getModel() }),
		echo: script,
		onTell,
		model: 'echo/echo',
		query,
		readOnly,
		ops,
	})
}

export const say = (text) => fauxAssistantMessage([fauxText(text)])
export const call = (name, args) =>
	fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' })
