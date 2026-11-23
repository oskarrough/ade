/** `pnpm fuzz [3m] [--repeat N] [-- <Bombadil flags>]`: Bombadil clicks, types and reloads its way around a fresh try.js
 * server for that long, holding the client to scripts/fuzz-spec.js, then says "nothing broke", or tells what broke on one
 * screen, the broken property, the last actions and the server's last lines, with a replay command that runs as is.
 * `--repeat N` runs again, one after another, until one breaks. `pnpm fuzz --replay <trace>` replays a run's trace against
 * a fresh try.js. Flags after `--` go to `bombadil browser test`, `--width 390 --height 844` say, and are checked against
 * its own list before anything starts.
 * One run per machine at a time: a second refuses at once and names the first. Each run's log, trace, the scratch
 * server's folder and its stamped output (server.log) go in .work/fuzz/<time>/; try.js keeps provider keys away, so no
 * paid model is reachable. It runs one headless Chrome at the lowest priority, so the machine stays usable meanwhile:
 * CHROME if set, else Playwright's newest Chromium, else whatever is on PATH. Not chrome-headless-shell: lighter, but it
 * stalled within a minute here, as Bombadil's manual warns it may.
 * Exits 0 when nothing broke, 1 when a property broke, 2 when Bombadil or the setup failed. */
import { execFileSync, spawn } from 'node:child_process'
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

const repo = path.resolve(import.meta.dirname, '..')
const bombadilBin = path.join(repo, 'node_modules/.bin/bombadil')
const spec = path.join(repo, 'scripts/fuzz-spec.js')
const fail = (message) => {
	console.error(`pnpm fuzz: ${message}`)
	process.exit(2)
}

// Everything is checked before a server or a browser starts
const args = process.argv.slice(2)
const dash = args.indexOf('--')
const own = dash < 0 ? args : args.slice(0, dash)
const extra = dash < 0 ? [] : args.slice(dash + 1)
let limit = '3m'
let repeat = 1
let replay = null
for (let i = 0; i < own.length; i++) {
	const arg = own[i]
	if (arg === '--repeat') repeat = Number(own[++i])
	else if (arg === '--replay') replay = path.resolve(own[++i] ?? '')
	else if (/^\d+[smhd]$/.test(arg)) limit = arg
	else
		fail(
			`${JSON.stringify(arg)} isn't something it takes: a time like 3m, --repeat N, --replay <trace>, or Bombadil's own flags after --`,
		)
}
if (!Number.isInteger(repeat) || repeat < 1) fail('--repeat takes a whole number, 1 or more')
if (replay && !existsSync(replay)) fail(`there's no trace at ${replay}`)
if (replay && repeat > 1) fail('--replay plays one trace once; leave out --repeat')
if (!existsSync(bombadilBin))
	fail('Bombadil isn’t installed here: run pnpm install --frozen-lockfile')

/** Bombadil's flags, read off its own help, so a wrong one fails here rather than after the server is up */
const ours = [
	'--time-limit',
	'--output-path',
	'--output-path-overwrite',
	'--reproduce',
	'--exit-on-violation',
	'--headless',
	'--no-sandbox',
]
if (extra.length) {
	const help = execFileSync(bombadilBin, ['browser', 'test', '--help'], { encoding: 'utf8' })
	const takes = new Map(
		[...help.matchAll(/^\s+(?:-\w, )?(--[\w-]+)( <)?/gm)].map(([, name, value]) => [name, !!value]),
	)
	for (let i = 0; i < extra.length; i++) {
		const [name, inline] = extra[i].split(/=(.*)/s)
		if (!takes.has(name)) fail(`Bombadil has no ${name}; bombadil browser test --help lists them`)
		if (ours.includes(name)) fail(`${name} is pnpm fuzz's to set`)
		const value = takes.get(name) ? (inline ?? extra[++i]) : undefined
		if (takes.get(name) && value === undefined) fail(`${name} needs a value`)
		// Its origin and match patterns take http, https, file or *, nothing else: not chrome-error, not about
		if (name === '--allow-url' && !/^(https?|file|\*):\/\//.test(value) && /:\/\//.test(value))
			fail(`--allow-url ${value}: Bombadil matches only http, https, file and * schemes`)
	}
}

// One run per machine: two headless Chromes slow each other and every worker's machine down
const lockFile = path.join(tmpdir(), 'ade-fuzz.lock')
const alive = (pid) => {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return error.code === 'EPERM'
	}
}
const lock = () => {
	try {
		const fd = openSync(lockFile, 'wx')
		writeSync(fd, JSON.stringify({ pid: process.pid, cwd: process.cwd(), since: new Date() }))
		return true
	} catch (error) {
		if (error.code !== 'EEXIST') throw error
	}
	let holder = {}
	try {
		holder = JSON.parse(readFileSync(lockFile, 'utf8'))
	} catch {}
	if (holder.pid && alive(holder.pid))
		fail(
			`another fuzz run holds this machine: pid ${holder.pid}, in ${holder.cwd}, since ${holder.since}. Wait for it to end.`,
		)
	rmSync(lockFile, { force: true })
	return lock()
}
lock()

const groups = new Set()
const stopAll = () => {
	for (const child of groups)
		try {
			process.kill(-child.pid, 'SIGTERM')
		} catch {}
}
process.on('exit', () => {
	stopAll()
	try {
		if (JSON.parse(readFileSync(lockFile, 'utf8')).pid === process.pid) rmSync(lockFile)
	} catch {}
})
process.on('SIGINT', () => process.exit(130))
process.on('SIGTERM', () => process.exit(143))

const exits = new WeakMap()
/** Starts a child in its own process group, at the lowest priority, and lets it go only once it has exited */
const start = (file, childArgs, options) => {
	const child = spawn('nice', ['-n', '19', file, ...childArgs], {
		...options,
		detached: true,
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	groups.add(child)
	exits.set(
		child,
		new Promise((resolve) =>
			child.on('exit', (code) => {
				groups.delete(child)
				resolve(code)
			}),
		),
	)
	return child
}
/** @param {import('node:child_process').ChildProcess} child @returns {Promise<number | null>} */
const exited = (child) => exits.get(child)
const stop = async (child) => {
	if (child.exitCode === null && child.signalCode === null)
		try {
			process.kill(-child.pid, 'SIGTERM')
		} catch {}
	await exited(child)
}

const env = { ...process.env }
for (const name of ['MODULES', 'SERVE_PORT', 'ADE_SERVER', 'VERBOSE']) delete env[name]
const playwright = path.join(homedir(), '.cache/ms-playwright')
const chromium =
	!env.CHROME &&
	existsSync(playwright) &&
	readdirSync(playwright)
		.filter((name) => /^chromium-\d+$/.test(name))
		.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
		.map((name) => path.join(playwright, name, 'chrome-linux64/chrome'))
		.find((file) => existsSync(file))
if (chromium) env.CHROME = chromium

const width = Math.min(process.stdout.columns || 120, 160)
const clip = (line) => (line.length > width ? `${line.slice(0, width - 1)}…` : line)
const shown = (file) => (file.startsWith(repo) ? path.relative(repo, file) : file)

/** One run: a fresh try.js, then Bombadil against it until the limit, a broken property, or the replay's end */
const run = async (number) => {
	const stamp = new Date().toISOString().replace(/[:.]/g, '-')
	const folder = path.join(repo, '.work/fuzz', number ? `${stamp}-${number}` : stamp)
	mkdirSync(folder, { recursive: true })
	const server = start(process.execPath, [path.join(repo, 'scripts/try.js')], {
		cwd: folder,
		env,
	})
	// try.js says its address once the server, its runner and bots are up; it's the only line it prints when all is well
	let printed = ''
	const address = await new Promise((resolve) => {
		server.stdout.on('data', (chunk) => {
			printed += chunk
			const found = printed.match(/^ade at (http:\/\/[^/\s]+)/m)
			if (found) resolve(found[1])
		})
		server.stderr.on('data', (chunk) => (printed += chunk))
		exited(server).then(() => resolve(null))
	})
	if (!address) fail(`try.js stopped before it was up:\n${printed.trim()}`)

	const trace = path.join(folder, 'trace')
	const log = createWriteStream(path.join(folder, 'log'))
	console.log(
		replay
			? `replaying ${shown(replay)} on ${address}; log and trace in ${shown(folder)}/`
			: `${number ? `run ${number} of ${repeat}: ` : ''}fuzzing ${address} for ${limit}; log and trace in ${shown(folder)}/`,
	)
	const bombadil = start(
		bombadilBin,
		[
			'browser',
			'test',
			`${address}/`,
			spec,
			'--headless',
			'--no-sandbox',
			...(replay ? ['--reproduce', replay] : ['--exit-on-violation', `--time-limit=${limit}`]),
			`--output-path=${trace}`,
			...extra,
		],
		{ env },
	)
	// Its actions come stamped from its own start; read against the clock, they line up with server.log's
	let report = ''
	let zero
	const actions = []
	for (const stream of [bombadil.stdout, bombadil.stderr])
		stream.on('data', (chunk) => {
			log.write(chunk)
			report += chunk
			for (const [, minutes, seconds, what] of String(chunk).matchAll(
				/^(\d\d):(\d\d\.\d{3}) (.*)$/gm,
			)) {
				const at = Number(minutes) * 60_000 + Number(seconds) * 1000
				zero ??= Date.now() - at
				actions.push(`${new Date(zero + at).toISOString().slice(11, 23)} ${what}`)
			}
		})
	const code = await exited(bombadil)
	await stop(server)
	await new Promise((resolve) => log.end(resolve))

	const violated = /was violated/.test(report)
	if (code === 0 && !violated) {
		console.log(replay ? 'the replay broke nothing' : `nothing broke in ${limit}`)
		return true
	}
	// The verdict is what's left of Bombadil's output once its action lines and its own advice are gone
	const verdict = report
		.split('\n')
		.filter((line) => !/^\d\d:\d\d\.\d{3} |bombadil_browser::instrumentation/.test(line))
		.join('\n')
		.replace(
			/\n*(Test finished|Reproduction finished|Inspect the test results|Reproduce this test)[^]*$/,
			'',
		)
		.replace(/\n{3,}/g, '\n\n')
		.trim()
		.split('\n')
	const serverLines = readFileSync(path.join(folder, 'server.log'), 'utf8').trim().split('\n')
	const replayCommand = `pnpm fuzz --replay ${replay ?? trace}${extra.length ? ` -- ${extra.join(' ')}` : ''}`
	console.log(
		[
			'',
			violated ? 'what broke' : `Bombadil itself failed (exit ${code})`,
			...verdict.slice(0, 24).map((line) => `  ${line}`),
			...(verdict.length > 24
				? [`  … ${verdict.length - 24} more lines in ${shown(folder)}/log`]
				: []),
			'',
			`the browser's last actions, of ${actions.length}`,
			...(actions.length ? actions.slice(-6) : ['(none: it stopped before acting)']).map(
				(line) => `  ${clip(line)}`,
			),
			'',
			"the server's last lines",
			...serverLines.slice(-4).map((line) => `  ${clip(line)}`),
			'',
			`replay: ${replayCommand}`,
			`step through it: ${bombadilBin} browser inspect ${trace}`,
		].join('\n'),
	)
	return violated ? false : null
}

for (let number = 1; number <= repeat; number++) {
	const outcome = await run(repeat > 1 ? number : 0)
	if (outcome === null) process.exit(2)
	if (outcome === false) process.exit(1)
}
process.exit(0)
