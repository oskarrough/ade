/** `pnpm fuzz [3m]`: Bombadil clicks, types and reloads its way around a fresh try.js server for that long, holding the
 * client to scripts/fuzz-spec.js, then says "nothing broke" or names the broken property with the command that replays it.
 * The run's log, trace, the scratch server's folder and its output (server.log) go in .work/fuzz/<time>/; try.js keeps
 * provider keys away, so no paid model is reachable. It runs one headless Chrome at the lowest priority, so the machine stays usable meanwhile: CHROME
 * if set, else Playwright's newest Chromium, else whatever is on PATH. Not chrome-headless-shell: lighter, but it stalled
 * within a minute here, as Bombadil's manual warns it may.
 * Exits 0 when nothing broke, 1 when a property broke, 2 when Bombadil itself failed. */
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const repo = path.resolve(import.meta.dirname, '..')
const limit = process.argv[2] ?? '3m'
const folder = path.join(repo, '.work/fuzz', new Date().toISOString().replace(/[:.]/g, '-'))
mkdirSync(folder, { recursive: true })

const env = { ...process.env }
for (const name of ['MODULES', 'SERVE_PORT', 'ADE_SERVER']) delete env[name]
// try.js passes its server's own lines on only when asked
const serverEnv = { ...env, VERBOSE: '1' }
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

const server = spawn('nice', ['-n', '19', process.execPath, path.join(repo, 'scripts/try.js')], {
	cwd: folder,
	env: serverEnv,
	stdio: ['ignore', 'pipe', 'pipe'],
})
const serverLog = createWriteStream(path.join(folder, 'server.log'))
server.stdout.pipe(serverLog)
server.stderr.pipe(serverLog)
const stop = () => server.exitCode === null && server.kill()
process.on('exit', stop)
const address = await new Promise((resolve, reject) => {
	let out = ''
	server.stdout.on('data', (chunk) => {
		out += chunk
		const found = out.match(/^ade at (http:\/\/[^/\s]+)/m)
		if (found) resolve(found[1])
	})
	server.on('exit', () => reject(new Error(`try.js stopped before it was up:\n${out}`)))
})

console.log(`fuzzing ${address} for ${limit}; log and trace in ${path.relative(repo, folder)}/`)
const trace = path.join(folder, 'trace')
const log = createWriteStream(path.join(folder, 'log'))
const bombadil = spawn(
	'nice',
	[
		'-n',
		'19',
		path.join(repo, 'node_modules/.bin/bombadil'),
		'browser',
		'test',
		`${address}/`,
		path.join(repo, 'scripts/fuzz-spec.js'),
		'--headless',
		'--no-sandbox',
		'--exit-on-violation',
		`--time-limit=${limit}`,
		`--output-path=${trace}`,
	],
	{ env, stdio: ['ignore', 'pipe', 'pipe'] },
)
let report = ''
for (const stream of [bombadil.stdout, bombadil.stderr])
	stream.on('data', (chunk) => {
		log.write(chunk)
		report += chunk
	})
const code = await new Promise((resolve) => bombadil.on('exit', resolve))
stop()

// Its log is one line per action; what's left over is the verdict
const verdict = report
	.split('\n')
	.filter((line) => !/^\d\d:\d\d\.\d{3} |bombadil_browser::instrumentation/.test(line))
	.join('\n')
	.replace(/\n{3,}/g, '\n\n')
	.trim()
if (code === 0) console.log(`nothing broke in ${limit}`)
else if (code === 2 && /was violated/.test(report)) {
	console.log(verdict)
	console.log(
		`\nThe replay needs a try.js server like this one: start it with node scripts/try.js and put its address in place of ${address}.`,
	)
} else console.log(`Bombadil itself failed (exit ${code}):\n${verdict}`)
process.exit(code === 0 ? 0 : code === 2 && /was violated/.test(report) ? 1 : 2)
