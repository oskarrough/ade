/** `pnpm perf`: how fast ade reads Oskar's real store, numbers only, to run before and after a change.
 * It copies ~/.local/share/ade/ade.sqlite (or DB_PATH) into .work/perf/, never touching the live one, starts a scratch
 * server on the copy with --no-runner and its own config (the live ade.json's modules plus inbox), and prints three tables:
 *   server  each read the client makes, timed cold and warm, with the SQLite rows and statements it took and its size; a post to the
 *           biggest thread while scripted runs and list reads go on
 *   socket  what one page open on the biggest thread hears per minute while three scripted runs happen: socket
 *           messages, and the list fetches they set off
 *   client  that page in agent-browser: time to a usable sidebar and to the open thread, Solid's [CODE] warnings
 *           (HUGE_FAN_IN apart), and the JS heap after load
 * `pnpm perf --why` adds, under each server row, the statements that took longest, with their rows.
 * Rows and statements are counted by wrapping node:sqlite's StatementSync in the server: this file, loaded with
 * `--import`, does that when ADE_PERF_HOOK is set, and answers its counts over the fork's IPC channel. */
import { StatementSync } from 'node:sqlite'

if (process.env.ADE_PERF_HOOK) hook()
else await measure()

/** In the server: count what each statement hands back, by its SQL */
function hook() {
	let rows = 0
	let statements = 0
	const bySql = new Map()
	for (const method of /** @type {const} */ (['all', 'get'])) {
		const original = StatementSync.prototype[method]
		StatementSync.prototype[method] = function (...args) {
			const begun = performance.now()
			const result = original.apply(this, args)
			const took = performance.now() - begun
			const read = method === 'all' ? result.length : result ? 1 : 0
			rows += read
			statements++
			const sql = this.sourceSQL.replace(/\s+/g, ' ').trim()
			const seen = bySql.get(sql) ?? { rows: 0, statements: 0, ms: 0 }
			seen.ms += took
			seen.rows += read
			seen.statements++
			bySql.set(sql, seen)
			return result
		}
	}
	process.on('message', (message) => {
		if (message !== 'take') return
		const top = [...bySql].sort((a, b) => b[1].ms - a[1].ms).slice(0, 4)
		process.send?.({ rows, statements, top })
		rows = statements = 0
		bySql.clear()
	})
}

async function measure() {
	const { DatabaseSync, backup } = await import('node:sqlite')
	const { fork, execFile } = await import('node:child_process')
	const { promisify } = await import('node:util')
	const fs = await import('node:fs')
	const os = await import('node:os')
	const path = await import('node:path')

	const why = process.argv.includes('--why')
	const repo = path.resolve(import.meta.dirname, '..')
	const work = path.join(repo, '.work', 'perf')
	const live =
		process.env.DB_PATH ||
		path.join(
			process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
			'ade',
			'ade.sqlite',
		)
	const copy = path.join(work, 'ade.sqlite')
	const config = path.join(work, 'config')
	const folder = path.join(work, 'folder')
	const user = 'Oskar'
	const session = 'ade-perf'
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
	const run = promisify(execFile)
	const browser = async (...args) =>
		(
			await run('agent-browser', ['--session', session, ...args], { maxBuffer: 64 << 20 })
		).stdout.trim()
	const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

	// ── The copy, its config, and its biggest thread ──
	for (const name of [
		'ade.sqlite',
		'ade.sqlite-wal',
		'ade.sqlite-shm',
		'ade.sqlite.lock',
		'ade.log',
	])
		fs.rmSync(path.join(work, name), { force: true })
	fs.mkdirSync(path.join(config, 'ade'), { recursive: true })
	fs.mkdirSync(folder, { recursive: true })
	const source = new DatabaseSync(live, { readOnly: true })
	await backup(source, copy)
	source.close()
	const liveConfig = path.join(
		process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
		'ade',
		'ade.json',
	)
	fs.writeFileSync(
		path.join(config, 'ade', 'ade.json'),
		fs.existsSync(liveConfig) ? fs.readFileSync(liveConfig) : '{}',
	)
	const store = new DatabaseSync(copy, { readOnly: true })
	const size = store.prepare('select count(*) as n from entries').get()?.n
	const biggest = /** @type {{id: number, n: number}} */ (
		store
			.prepare(
				`select conversation_id as id, count(*) as n from entries
				 where json_extract(record, '$.kind') = 'ade.message' group by 1 order by 2 desc limit 1`,
			)
			.get()
	)
	store.close()

	// ── The scratch server, counting its reads ──
	const env = {
		...process.env,
		DB_PATH: copy,
		XDG_CONFIG_HOME: config,
		PORT: '0',
		HOST: '127.0.0.1',
		MODULES: '+inbox,+bots,-web-search',
	}
	const started = performance.now()
	const server = fork(path.join(repo, 'server.js'), ['--no-runner'], {
		cwd: work,
		env: { ...env, ADE_PERF_HOOK: '1' },
		execArgv: ['--import', import.meta.filename],
		silent: true,
	})
	const children = [server]
	const stop = () => children.forEach((child) => child.exitCode === null && child.kill())
	process.on('exit', stop)
	process.on('SIGINT', () => process.exit(130))
	let output = ''
	server.stderr?.on('data', (chunk) => (output += chunk))
	const base = await new Promise((resolve, reject) => {
		server.stdout?.on('data', (chunk) => {
			output += chunk
			const port = /http:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1]
			if (port) resolve(`http://127.0.0.1:${port}`)
		})
		server.once('exit', (code) => reject(new Error(`server exited ${code}:\n${output}`)))
	})
	const api = async (method, route, body) => {
		const response = await fetch(base + route, {
			method,
			headers: { 'content-type': 'application/json', 'x-user': user },
			body: body && JSON.stringify(body),
		})
		const json = await response.json()
		if (!response.ok) throw new Error(`${method} ${route}: ${JSON.stringify(json)}`)
		return json
	}
	while (
		!(await fetch(`${base}/api/server`).then(
			(response) => response.ok,
			() => false,
		))
	)
		await sleep(50)
	const startup = Math.round(performance.now() - started)
	/** @returns {Promise<{rows: number, statements: number, top: [string, {rows: number, statements: number, ms: number}][]}>} */
	const take = () =>
		new Promise((resolve) => {
			server.once('message', resolve)
			server.send('take')
		})

	// ── Server: each read the client makes ──
	const big = biggest.id
	const reads = [
		['threads', '/api/threads'],
		['archived', '/api/threads/archived'],
		['bots', '/api/bots'],
		['runners', '/api/runners'],
		['inbox', '/api/inbox'],
		[`thread ${big}`, `/api/threads/${big}`],
		[`thread ${big} ?last=50`, `/api/threads/${big}?last=50`],
		[`memory ${big}`, `/api/threads/${big}/memory?room=50`],
		[`recap ${big}`, `/api/threads/${big}/recap`],
	]
	const serverRows = []
	await take()
	for (const [label, route] of reads) {
		const times = []
		let counted, size
		for (let round = 0; round < 4; round++) {
			const begun = performance.now()
			size = JSON.stringify(await api('GET', route)).length
			times.push(performance.now() - begun)
			counted = await take()
		}
		serverRows.push({
			label,
			first: times[0],
			warm: median(times.slice(1)),
			rows: counted.rows,
			statements: counted.statements,
			size,
			top: counted.top,
		})
	}

	// ── Client: the page opened on the biggest thread ──
	const init = path.join(work, 'init.js')
	fs.writeFileSync(
		init,
		`${fs.readFileSync(path.join(repo, 'scripts', 'page-spy.js'), 'utf8')}
{
	const marks = (window['marks'] = {})
	const check = () => {
		const now = Math.round(performance.now())
		if (!marks.sidebar && document.querySelector('nav.thread-list ul:not(.new-rows):not(.bots) li')) marks.sidebar = now
		if (!marks.thread && document.querySelector('ul[aria-label="Messages"] > li:not(.mute):not(.room)')) marks.thread = now
		if (marks.sidebar && marks.thread) observer.disconnect()
	}
	const observer = new MutationObserver(check)
	observer.observe(document, { childList: true, subtree: true })
	/** Each socket message's size, beside page-spy's first 160 characters */
	const sizes = (window['sizes'] = [])
	const Socket = window.WebSocket
	window.WebSocket = new Proxy(Socket, {
		construct(target, args) {
			const socket = Reflect.construct(target, args)
			socket.addEventListener('message', (event) => sizes.push(String(event.data).length))
			return socket
		},
	})
}
`,
	)
	await browser('close').catch(() => {})
	await browser('--init-script', init, 'open', `${base}/?thread=${big}&user=${user}`)
	const marks = JSON.parse(
		JSON.parse(
			await browser(
				'eval',
				`new Promise((resolve) => { const timer = setInterval(() => { if (marks.sidebar && marks.thread) { clearInterval(timer); resolve(JSON.stringify(marks)) } }, 50); setTimeout(() => resolve(JSON.stringify(marks)), 10000) })`,
			),
		),
	)
	await sleep(2000)
	/** From a click on its row, in a page already open on a new thread, to its newest messages on screen */
	await browser('open', `${base}/?user=${user}`)
	await browser('wait', 'nav.thread-list li')
	await sleep(500)
	const opened = JSON.parse(
		JSON.parse(
			await browser(
				'eval',
				`new Promise((resolve) => {
					const link = [...document.querySelectorAll('nav a.row')].find((a) => new URL(a.href).searchParams.get('thread') === '${big}')
					const heard = sizes.length
					const said = spy.socket.length
					const begun = performance.now()
					link.click()
					const check = () => {
						const rows = document.querySelectorAll('ul[aria-label="Messages"] > li:not(.mute):not(.room)')
						if (!rows.length) return requestAnimationFrame(check)
						const shown = performance.now() - begun
						requestAnimationFrame(() => setTimeout(() => resolve(JSON.stringify({
							shown,
							painted: performance.now() - begun,
							rows: document.querySelectorAll('ul[aria-label="Messages"] li').length,
							bytes: sizes.slice(heard).reduce((sum, size) => sum + size, 0),
							heard: spy.socket.slice(said).map((line) => Number(line.split(' ')[0]) - begun),
						}))))
					}
					check()
				})`,
			),
		),
	)
	const heap = Number(await browser('eval', 'performance.memory.usedJSHeapSize'))
	const console = await browser('console')
	/** Each warning once: its own line, not the help lines under it that name its code again */
	const codes =
		console.match(/^\[(?:warning|error)\] \[[A-Z][A-Z_]+\]/gm)?.map((line) => line.split(' ')[1]) ??
		[]
	const fanIn = codes.filter((code) => code === '[HUGE_FAN_IN]').length

	// ── Socket and a post under load: three scripted runs while the page watches ──
	const { key } = await api('POST', '/api/runners', { name: 'perf' })
	const runner = fork(
		path.join(repo, 'runner.js'),
		['--server', base, '--name', 'perf', '--dir', folder],
		{ cwd: folder, env: { ...env, ADE_KEY: key, HOME: work }, silent: true },
	)
	children.push(runner)
	while (!(await api('GET', '/api/runners')).find((row) => row.name === 'perf')?.online)
		await sleep(100)
	const spied = async () => JSON.parse(JSON.parse(await browser('eval', 'JSON.stringify(spy)')))
	const lists = /^\d+ \/api\/(threads|threads\/archived|runners|bots|inbox)(\?|$)/
	const before = await spied()
	const window = performance.now()
	const threads = []
	for (let index = 0; index < 3; index++) {
		const { id } = await api('POST', '/api/threads', { title: `perf ${index}` })
		threads.push(id)
		await api('POST', `/api/threads/${id}/entries`, {
			body: 'slow look around',
			to: { runner: 'perf', model: 'echo/try' },
		})
	}
	const posts = []
	let reading = true
	const load = (async () => {
		while (reading) await api('GET', '/api/threads')
	})()
	for (let index = 0; index < 5; index++) {
		const begun = performance.now()
		await api('POST', `/api/threads/${big}/entries`, { body: `perf ${index}`, to: null })
		posts.push(performance.now() - begun)
	}
	reading = false
	await load
	const settled = async () =>
		(await Promise.all(threads.map((id) => api('GET', `/api/threads/${id}`)))).every(
			(thread) => thread.status !== 'working',
		)
	while (!(await settled())) await sleep(200)
	await sleep(1000)
	const minutes = (performance.now() - window) / 60000
	const after = await spied()
	const heard = after.socket.length - before.socket.length
	const fetched = after.fetches.slice(before.fetches.length).filter((line) => lists.test(line))
	await browser('close').catch(() => {})
	await take()
	stop()

	// ── The tables ──
	const ms = (value) => `${Math.round(value)}`
	const table = (head, body) => {
		const all = [head, ...body]
		const widths = head.map((_, column) =>
			Math.max(...all.map((row) => String(row[column]).length)),
		)
		return all
			.map((row) =>
				row
					.map((cell, column) =>
						column ? String(cell).padStart(widths[column]) : String(cell).padEnd(widths[column]),
					)
					.join('  '),
			)
			.join('\n')
	}
	const out = [
		`store: ${size} entries, biggest thread ${big} with ${biggest.n} messages; server up in ${startup} ms`,
		'',
		table(
			['server', 'first ms', 'warm ms', 'rows', 'statements', 'KB'],
			serverRows.map((row) => [
				row.label,
				ms(row.first),
				ms(row.warm),
				row.rows,
				row.statements,
				Math.round(row.size / 1024),
			]),
		),
		`post to ${big} under load: median ${ms(median(posts))} ms, worst ${ms(Math.max(...posts))} ms`,
	]
	if (why)
		for (const row of serverRows) {
			out.push('', `${row.label}:`)
			for (const [sql, seen] of row.top)
				out.push(
					`  ${seen.ms.toFixed(1)} ms, ${seen.rows} rows in ${seen.statements}× ${sql.slice(0, 120)}`,
				)
		}
	const perMinute = (count) => (count / minutes).toFixed(0)
	const byList = Object.entries(
		Object.groupBy(fetched, (line) => line.split(' ')[1].replace(/\?.*/, '')),
	).map(([route, lines]) => `${route.replace('/api/', '')} ${perMinute(lines?.length ?? 0)}`)
	out.push(
		'',
		table(
			['socket, per minute', 'count'],
			[
				['messages', perMinute(heard)],
				['list fetches', perMinute(fetched.length)],
			],
		),
		`  ${byList.join(', ') || 'no list fetches'} (over ${(minutes * 60).toFixed(0)} s)`,
		'',
		table(
			['client', 'value'],
			[
				['sidebar ms', marks.sidebar ?? 'never'],
				[`thread ${big} ms`, marks.thread ?? 'never'],
				[`click to ${big}'s first page ms`, Math.round(opened.heard[0] ?? Number.NaN)],
				[`click to its last socket message ms`, Math.round(opened.heard.at(-1) ?? Number.NaN)],
				[`click to ${big} shown ms`, Math.round(opened.shown)],
				[`click to ${big} painted ms`, Math.round(opened.painted)],
				[`  rows rendered`, opened.rows],
				[`  socket KB`, (opened.bytes / 1024).toFixed(0)],
				['[CODE] warnings', codes.length - fanIn],
				['HUGE_FAN_IN', fanIn],
				['heap MB', (heap / 2 ** 20).toFixed(1)],
			],
		),
	)
	process.stdout.write(`${out.join('\n')}\n`)
	process.exit(0)
}
