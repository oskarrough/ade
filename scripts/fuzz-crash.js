/** `pnpm fuzz --crash [--seed n] [--kills 100]`: holds ade to "a restart or a crash loses nothing". A scratch house with
 * the echo bot `echo/try@bot` on a real runner and bots bot1 and bot2 is kept busy, slow turns, side questions, scheduled
 * tasks, some with a check that runs a command first, drafts being typed, forks, while the server is killed with SIGKILL at random moments and started again on the
 * same store. After every restart it checks nothing that was there is gone, no message landed twice, no turn was answered
 * twice, no task ran twice (a checked one included) and every draft is what was last saved; every 20 kills, and at the end, it lets the house settle
 * and checks every message was answered, or failed with an error, and every task that came due ran once, or its
 * check finished it.
 * It prints "nothing broke" or the first violation, with the seed that replays the same moves; the timing is the
 * machine's, so a replay comes close rather than exact. The store, its log and the runner's folder stay in
 * .work/fuzz/crash-<time>/. Exits 0 when nothing broke, 1 on a violation. */
import { spawn } from 'node:child_process'
import { mkdirSync, openSync } from 'node:fs'
import path from 'node:path'

const repo = path.resolve(import.meta.dirname, '..')
const flag = (name, fallback) => {
	const at = process.argv.indexOf(`--${name}`)
	return at > 0 ? Number(process.argv[at + 1]) : fallback
}
const seed = flag('seed', Math.floor(Math.random() * 2 ** 31))
const kills = flag('kills', 100)
const settleEvery = 20
const folder = path.join(
	repo,
	'.work/fuzz',
	`crash-${new Date().toISOString().replace(/[:.]/g, '-')}`,
)
const dir = path.join(folder, 'folder')
const home = path.join(folder, 'home')
mkdirSync(dir, { recursive: true })
mkdirSync(home, { recursive: true })

/** mulberry32: the same seed makes the same moves */
let state = seed >>> 0
const random = () => {
	state = (state + 0x6d2b79f5) >>> 0
	let t = state
	t = Math.imul(t ^ (t >>> 15), t | 1)
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = (list) => list[Math.floor(random() * list.length)]
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// No paid model, no shell settings: the scratch house sees only what this sets
const env = { ...process.env }
for (const name of Object.keys(env))
	if (
		/_API_KEY$|_TOKEN(_FILE)?$|^(ANTHROPIC|AWS|AZURE|GOOGLE|GCLOUD)_/.test(name) ||
		['MODULES', 'SERVE_PORT', 'ADE_SERVER', 'ADE_KEY', 'ADE_LENT', 'DIRECTOR_MODEL'].includes(name)
	)
		delete env[name]
const port = 20000 + Math.floor(Math.random() * 20000)
const base = `http://127.0.0.1:${port}`
const modules = '+bots,+director,+schedule,+check'
const children = new Set()
process.on('exit', () => {
	for (const child of children)
		try {
			process.kill(-child.pid, 'SIGKILL')
		} catch {}
})
process.on('SIGINT', () => process.exit(130))

const log = openSync(path.join(folder, 'output'), 'a')
const launch = (file, args, extra) => {
	const child = spawn(process.execPath, [path.join(repo, file), ...args], {
		cwd: folder,
		detached: true,
		stdio: ['ignore', log, log],
		env: {
			...env,
			PORT: String(port),
			SERVE_PORT: String(port + 1),
			HOST: '127.0.0.1',
			DB_PATH: path.join(folder, 'store.sqlite'),
			XDG_CONFIG_HOME: folder,
			MODULES: modules,
			DIRECTOR_MODEL: 'echo/try@bot',
			...extra,
		},
	})
	children.add(child)
	child.on('exit', () => children.delete(child))
	return child
}

/** A request with a deadline, so one cut off by a kill fails instead of hanging */
async function api(method, route, body) {
	const response = await fetch(`${base}${route}`, {
		method,
		headers: { 'content-type': 'application/json' },
		body: body && JSON.stringify(body),
		signal: AbortSignal.timeout(10000),
	})
	const json = await response.json()
	if (response.status >= 400)
		throw Object.assign(new Error(JSON.stringify(json)), { status: response.status })
	return json
}

let server
let boots = 0
async function up() {
	server = launch('server.js', ['--no-runner'])
	boots++
	const end = Date.now() + 20000
	while (Date.now() < end) {
		if (server.exitCode !== null) break
		if (await api('GET', '/api/server').catch(() => null)) return
		await sleep(50)
	}
	throw new Violation(`the server didn't come back after kill ${boots - 1}`)
}
const down = () =>
	new Promise((resolve) => {
		if (server.exitCode !== null || server.signalCode !== null) return resolve(undefined)
		server.once('exit', resolve)
		process.kill(server.pid, 'SIGKILL')
	})

class Violation extends Error {}

// ── What the fuzzer did, and what it expects ───────────────────────────────

let n = 0
/** Keyed writes not yet acknowledged: sent again after each restart until one is */
const pending = new Map()
/** Person messages by body: {thread, acked} */
const sent = new Map()
/** Threads made with a first message, by title: {acked, id?} */
const made = new Map()
/** Person tasks: key → {due, id?} */
const tasks = new Map()
/** Person tasks with a check, which may post or not: key → {due, id?} */
const checks = new Map()
/** Drafts per thread: {key, text, could}, `could` what the store may hold, as `key:text` or 'null' */
const drafts = new Map()
/** Every entry ever read, by thread: id → body */
const seen = new Map()
const forks = []
let owner, A, G

function keyed(key, method, route, body, then) {
	const job = { method, route, body, then }
	pending.set(key, job)
	return send(key, job)
}
const send = (key, job) =>
	api(job.method, job.route, job.body).then(
		(json) => {
			if (pending.get(key) !== job) return
			pending.delete(key)
			job.then?.(json)
		},
		() => {},
	)

const say = (thread, body, to) => {
	const key = `k${++n}`
	sent.set(body, { thread, acked: false })
	return keyed(key, 'POST', `/api/threads/${thread}/entries`, { body, to, key }, () => {
		sent.get(body).acked = true
	})
}

/** @type {[number, () => unknown][]} */
const moves = [
	[5, () => say(A, `m${++n}`, 'echo/try@bot')],
	[1, () => say(A, `slow m${++n}`, 'echo/try@bot')],
	[2, () => say(A, `post m${++n}`, 'echo/try@bot')],
	[1, () => say(A, `think m${++n}`, 'echo/try@bot')],
	[2, () => say(A, `schedule 2s remind m${++n}`, 'echo/try@bot')],
	[3, () => say(G, `m${++n}`, pick(['bot1', 'bot2']))],
	[
		2,
		() => {
			const key = `t${++n}`
			const due = Date.now() + 1000 + Math.floor(random() * 3000)
			tasks.set(key, { due, instructions: `task m${n}` })
			return keyed(
				key,
				'POST',
				'/api/schedule',
				{ thread: A, instructions: `task m${n}`, at: due, key },
				(json) => (tasks.get(key).id = json.id),
			)
		},
	],
	[
		1,
		() => {
			const key = `c${++n}`
			const due = Date.now() + 500 + Math.floor(random() * 2000)
			checks.set(key, { due })
			return keyed(
				key,
				'POST',
				'/api/schedule',
				{
					thread: A,
					instructions: `checked m${n}`,
					at: due,
					key,
					check: String.raw`const r = await tools.bash({ command: 'sleep 0.3; echo ok' }); post('found ' + r.output.trim())`,
				},
				(json) => (checks.get(key).id = json.id),
			)
		},
	],
	[
		1,
		() => {
			const title = `new m${++n}`
			const key = `n${n}`
			made.set(title, { acked: false })
			sent.set(title, { thread: undefined, acked: false })
			return keyed(
				key,
				'POST',
				'/api/threads',
				{ title, key, body: title, to: 'echo/try@bot' },
				(json) => {
					made.get(title).acked = true
					sent.get(title).acked = true
				},
			)
		},
	],
	[6, () => type(pick([A, G]))],
	[2, () => sendDraft(pick([A, G]))],
	[
		1,
		() => {
			const ids = [...(seen.get(A)?.keys() ?? [])]
			if (!ids.length) return
			const at = pick(ids)
			return api('POST', `/api/threads/${A}/fork`, { at }).then(
				(json) => forks.push({ id: json.id, at }),
				() => {},
			)
		},
	],
	[
		2,
		() => {
			if (!forks.length) return
			return say(pick(forks).id, `m${++n}`, 'echo/try@bot')
		},
	],
]
const weight = moves.reduce((sum, [w]) => sum + w, 0)
function move() {
	let r = random() * weight
	for (const [w, act] of moves) if ((r -= w) < 0) return act()
}

/** Typing: the text grows, saved as a page saves it */
function type(thread) {
	let draft = drafts.get(thread)
	if (draft?.busy) return
	if (!draft || draft.sending) {
		draft = { key: `d${++n}`, text: '', could: draft?.could ?? new Set(['null']) }
		drafts.set(thread, draft)
	}
	const text = `${draft.text}${draft.text ? ' ' : ''}w${++n}`
	draft.text = text
	draft.could.add(`${draft.key}:${text}`)
	draft.busy = true
	return api('POST', `/api/threads/${thread}/draft`, { key: draft.key, text, page: 'fuzz' }).then(
		() => {
			if (drafts.get(thread) === draft) draft.could = new Set([`${draft.key}:${text}`])
			draft.busy = false
		},
		() => (draft.busy = false),
	)
}
function sendDraft(thread) {
	const draft = drafts.get(thread)
	if (!draft || draft.sending || draft.busy || !draft.text) return
	draft.sending = true
	draft.could.add('null')
	sent.set(draft.text, { thread, acked: false })
	const body = draft.text
	return keyed(
		draft.key,
		'POST',
		`/api/threads/${thread}/entries`,
		{ body, to: thread === A ? 'echo/try@bot' : 'bot1', key: draft.key },
		() => {
			sent.get(body).acked = true
			if (drafts.get(thread) === draft) draft.could = new Set(['null'])
		},
	)
}

// ── Checks ──────────────────────────────────────────────────────────────────

const views = async () => {
	const list = await api('GET', '/api/threads')
	const all = new Map()
	for (const row of list)
		all.set(row.id, { row, ...(await api('GET', `/api/threads/${row.id}?last=100000`)) })
	return all
}

/** What holds at every moment, right after a restart */
async function safe(when) {
	const all = await views()
	const fail = (what) => {
		throw new Violation(`${when}: ${what}`)
	}
	for (const [thread, bodies] of seen) {
		const view = all.get(thread)
		if (!view) fail(`thread ${thread} is gone`)
		const now = new Map(view.entries.map((entry) => [entry.id, entry.data.body]))
		for (const [id, body] of bodies)
			if (now.get(id) !== body)
				fail(
					`thread ${thread} lost message ${id} "${body.slice(0, 60)}"${now.has(id) ? `, now "${now.get(id).slice(0, 60)}"` : ''}`,
				)
	}
	const answered = new Map()
	const failed = new Set()
	const copied = new Map()
	const fired = new Map()
	for (const [thread, view] of all) {
		const bodies = new Map()
		for (const entry of view.entries) {
			const { data } = entry
			if (data.author === owner && !data.scheduledTask && !data.stopped) {
				const count = (bodies.get(data.body) ?? 0) + 1
				bodies.set(data.body, count)
				if (count > 1) fail(`thread ${thread} has "${data.body}" twice`)
			}
			// A failed delivery gives its messages back to ride with the next one, so only an answer counts once
			if (data.error) for (const id of data.re ?? []) failed.add(`${data.from ?? thread}/${id}`)
			if (data.answer)
				for (const id of data.re ?? []) {
					const key = `${data.from ?? thread}/${id}`
					if (answered.has(key))
						fail(
							`thread ${thread}: message ${id} answered twice, by ${answered.get(key)} and ${entry.id}`,
						)
					answered.set(key, entry.id)
				}
			if (data.answer) {
				const key = `${thread}/${data.answer.conversation}/${data.answer.entry}`
				if (copied.has(key))
					fail(`thread ${thread}: one answer posted twice, as ${copied.get(key)} and ${entry.id}`)
				copied.set(key, entry.id)
			}
			if (data.scheduledTask) {
				// A fork copies the messages before it, ids and all
				const key = `${data.scheduledTask}`
				if (fired.has(key) && !fired.get(key).endsWith(`/${entry.id}`))
					fail(`task ${key} ran twice, posting ${fired.get(key)} and ${thread}/${entry.id}`)
				fired.set(key, `${thread}/${entry.id}`)
			}
		}
		for (const [body, { thread: at, acked }] of sent)
			if (at === thread && acked && !bodies.has(body))
				fail(`thread ${thread} lost "${body}", which was accepted`)
	}
	const reminders = [...all.values()].flatMap((view) =>
		view.entries.filter(
			(entry) => entry.data.scheduledTask && /^remind m\d+$/.test(entry.data.body),
		),
	)
	const once = new Map()
	for (const entry of reminders) {
		if (once.has(entry.data.body) && once.get(entry.data.body) !== entry.id)
			fail(`the agent's task "${entry.data.body}" ran twice`)
		once.set(entry.data.body, entry.id)
	}
	const titles = new Map()
	// Auto-title renames it, so a new thread is known by its first message
	const first = (view) => view.entries[0]?.data.body
	for (const [, view] of all) titles.set(first(view), (titles.get(first(view)) ?? 0) + 1)
	for (const [title, { acked }] of made) {
		if ((titles.get(title) ?? 0) > 1) fail(`"${title}" was made twice`)
		if (acked && !titles.get(title)) fail(`"${title}" was accepted, and is gone`)
		const view = [...all.values()].find((v) => first(v) === title)
		if (view) sent.get(title).thread = view.row.id
	}
	for (const [thread, draft] of drafts) {
		const { draft: now } = await api('GET', `/api/threads/${thread}/draft`)
		const held = now && now.text ? `${now.key}:${now.text}` : 'null'
		if (!draft.could.has(held))
			fail(`thread ${thread}'s draft is ${held}, expected one of ${[...draft.could].join(' | ')}`)
	}
	for (const fork of forks) {
		const view = all.get(fork.id)
		if (!view) fail(`fork ${fork.id} is gone`)
		const source = all
			.get(A)
			.entries.filter((entry) => entry.id <= fork.at)
			.map((entry) => entry.data.body)
		const copy = view.entries.slice(0, source.length).map((entry) => entry.data.body)
		if (JSON.stringify(copy) !== JSON.stringify(source))
			fail(`fork ${fork.id} of ${A} at ${fork.at} doesn't start with its messages`)
	}
	for (const [thread, view] of all) {
		const bodies = seen.get(thread) ?? new Map()
		for (const entry of view.entries) bodies.set(entry.id, entry.data.body)
		seen.set(thread, bodies)
	}
	return { all, answered, failed, fired }
}

/** After a quiet spell: nothing stuck, everything answered or failed, every task due ran */
async function settle(when) {
	for (const [key, job] of pending) await send(key, job)
	if (pending.size)
		throw new Violation(`${when}: ${[...pending.keys()].join(', ')} never got through`)
	// Stuck is busy with nothing new for half a minute; a backlog of slow turns can take longer than that to clear
	let all
	let newest = 0
	let moved = Date.now()
	while (Date.now() - moved < 30000) {
		all = await views()
		const busy = [...all.values()].filter((view) => view.row.busy || view.row.status === 'working')
		const listed = new Set((await api('GET', '/api/schedule')).map((task) => task.id))
		const due =
			[...tasks.values(), ...checks.values()].some((task) => task.due > Date.now() - 1000) ||
			[...checks.values()].some((task) => listed.has(task.id))
		if (!busy.length && !due) break
		const latest = Math.max(...[...all.values()].map((view) => view.entries.at(-1)?.id ?? 0))
		if (latest > newest) [newest, moved] = [latest, Date.now()]
		await sleep(250)
	}
	const fail = (what) => {
		throw new Violation(`${when}: ${what}`)
	}
	const stuck = [...all.values()].filter((view) => view.row.busy || view.row.status === 'working')
	if (stuck.length)
		fail(
			`stuck, nothing new for 30s: ${stuck.map((view) => `${view.row.id} ${view.row.status}`).join(', ')}; runners ${JSON.stringify(await api('GET', '/api/runners'))}`,
		)
	const { answered, failed, fired } = await safe(when)
	for (const [thread, view] of all) {
		// A fork starts idle: what its source hadn't answered yet stays unanswered there
		const copied = forks.find((fork) => fork.id === thread)?.at ?? 0
		for (const entry of view.entries) {
			const { data } = entry
			if (!data.to?.length || data.answer || data.error || entry.id <= copied) continue
			if (data.from && !data.re && data.from !== view.row.parent) continue
			if (!answered.has(`${thread}/${entry.id}`) && !failed.has(`${thread}/${entry.id}`))
				fail(`thread ${thread}: message ${entry.id} "${data.body.slice(0, 40)}" was never answered`)
		}
	}
	// A checked one-off ends once its check is done: posted, or its check failed with the command cut off
	const live = new Set((await api('GET', '/api/schedule')).map((task) => task.id))
	for (const [key, task] of checks)
		if (task.due < Date.now() - 1000 && task.id !== undefined && live.has(task.id))
			fail(
				`checked task ${task.id} (${key}), due ${Math.round((Date.now() - task.due) / 1000)}s ago, never finished`,
			)
	for (const [key, task] of tasks)
		if (task.due < Date.now() - 1000 && !fired.has(String(task.id)))
			fail(
				`task ${task.id} (${key}), due ${Math.round((Date.now() - task.due) / 1000)}s ago, never ran`,
			)
}

// ── The run ─────────────────────────────────────────────────────────────────

const started = Date.now()
console.log(
	`crashing ${base} ${kills} times, seed ${seed}; store and log in ${path.relative(repo, folder)}/`,
)
let kill = 0
try {
	await up()
	owner = (await api('GET', '/api/server')).me
	const { key } = await api('POST', '/api/runners', { name: 'bot' })
	launch('runner.js', ['--server', base, '--name', 'bot', '--dir', dir], {
		HOME: home,
		ADE_KEY: key,
	})
	while (
		!(await api('GET', '/api/runners')).some((runner) => runner.name === 'bot' && runner.online)
	)
		await sleep(50)
	for (const name of ['bot1', 'bot2'])
		await api('POST', '/api/bots', { name, to: 'echo/try@bot', instructions: `You are ${name}.` })
	A = (await api('POST', '/api/threads', { title: 'busy' })).id
	G = (await api('POST', '/api/threads', { title: 'group' })).id
	await api('POST', `/api/threads/${A}/entries`, { body: 'look around', to: 'echo/try@bot' })
	await api('POST', `/api/threads/${G}/entries`, { body: 'hello both', to: 'bot1' })
	await settle('before the first kill')

	for (kill = 1; kill <= kills; kill++) {
		for (const [key, job] of pending) send(key, job)
		const moving = Array.from({ length: 1 + Math.floor(random() * 4) }, move)
		const wait = 30 + Math.floor(random() * 900)
		const typing = setInterval(() => random() < 0.5 && type(pick([A, G])), 150)
		await sleep(wait)
		clearInterval(typing)
		await down()
		await Promise.allSettled(moving)
		await up()
		await safe(`after kill ${kill}`)
		if (kill % settleEvery === 0 || kill === kills) await settle(`settling after kill ${kill}`)
		if (kill % 10 === 0) console.log(`${kill} kills, ${Math.round((Date.now() - started) / 1000)}s`)
	}
	console.log(`nothing broke in ${kills} kills (${Math.round((Date.now() - started) / 1000)}s)`)
	process.exit(0)
} catch (error) {
	if (!(error instanceof Violation)) throw error
	console.log(error.message)
	console.log(`seed ${seed}; replay: pnpm fuzz --crash --seed ${seed} --kills ${kill}`)
	console.log(`store and log: ${path.relative(repo, folder)}/`)
	process.exit(1)
}
