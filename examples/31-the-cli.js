/** The CLI asks a thread's agent, in a new thread or an old one, and prints its answers as they land */
import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { promisify } from 'node:util'
import {
	createThread,
	postEntry,
	api,
	base,
	check,
	dir,
	done,
	owner,
	repo,
	runner,
	server,
	until,
	view,
} from './lib.js'

const output = (...args) =>
	promisify(execFile)(process.execPath, ['cli.js', '--server', base, ...args], {
		cwd: repo,
		timeout: 8000,
	})
const cli = async (...args) => (await output(...args)).stdout

{
	const { stdout } = await promisify(execFile)(process.execPath, ['runner.js', '--help'], {
		cwd: repo,
		timeout: 8000,
	})
	check(
		[
			'server',
			'name',
			'dir',
			'discover-dirs',
			'owner',
			'allow',
			'read-only',
			'key',
			'key-file',
			'help',
		].every((option) => stdout.includes(`--${option}`)),
		'runner --help prints its options without connecting',
		stdout,
	)
}

// Auto-title would rename the threads this lists by name
await server({ MODULES: '-auto-title' })
const laptop = await runner('laptop')
await runner('desk')

const { stdout: first, stderr: chatter } = await output('post', '--to', 'echo/echo@laptop', 'hello')
check(!chatter, 'a new thread id and its answers go to stdout, not stderr', chatter)
const id = /thread (\d+)/.exec(first)?.[1]
check(
	id && first.includes('echo:off@laptop') && first.includes('echo@laptop heard: hello'),
	'post starts a thread and prints the answer',
	first,
)

const captured = await output('post', '--to', 'nobody', '--no-wait', 'captured by a script')
check(
	/^thread \d+\n$/.test(captured.stdout) && !captured.stderr,
	'post --no-wait leaves the new thread id on stdout for scripts',
	JSON.stringify(captured),
)

const silent = await output('post', 'no one named')
check(
	/^thread \d+\n$/.test(silent.stdout) && /nobody/i.test(silent.stderr),
	'a post with no --to that asks nobody says so',
	JSON.stringify(silent),
)

const before404 = (await api('GET', '/api/threads')).json.length
const missing = await output('post', '--to', 'echo/echo@attic', 'anyone up there?').catch(
	(error) => error,
)
check(
	/No runner named attic/.test(missing.stderr) &&
		/laptop/.test(missing.stderr) &&
		/desk/.test(missing.stderr) &&
		!/thread \d+/.test(missing.stdout),
	"asking a runner that isn't there names the ones that are",
	JSON.stringify(missing),
)
check(
	(await api('GET', '/api/threads')).json.length === before404,
	'and the failed post leaves no empty thread in the list',
)

const both = await cli(
	'post',
	'--thread',
	id,
	'--to',
	'echo/echo@laptop',
	'--to',
	'echo/echo@desk',
	'both of you',
).catch((error) => error.stderr)
check(/one agent/.test(both), 'two models in one message are refused: a thread has one agent', both)

const again = await cli('post', '--thread', id, 'and again')
check(/#\d+ echo:off@laptop\n/.test(again), 'no --to asks whom the thread last asked', again)

const shell = await cli('post', '--thread', id, '--to', 'echo/echo@desk', '$ echo from-desk')
check(
	shell.includes('from-desk'),
	'a $ command runs on the runner named and prints its output',
	shell,
)

const threads = await cli('threads')
check(
	threads.includes(`#${id} hello`) && threads.includes('echo:off@laptop'),
	'threads lists it with its agents',
	threads,
)
const whole = (await view(id)).entries
const tail = (await api('GET', `/api/threads/${id}?last=2`)).json.entries
const afterSecond = (await api('GET', `/api/threads/${id}?after=${whole[1].id}`)).json.entries
check(
	whole.length > 3 &&
		JSON.stringify(tail) === JSON.stringify(whole.slice(-2)) &&
		JSON.stringify(afterSecond) === JSON.stringify(whole.slice(2)),
	'a thread reads back from its end: ?last=n its newest n messages, ?after=id those after one',
	JSON.stringify([whole.length, tail.length, afterSecond.length]),
)
const read = await cli('read', id, '--last', '1')
check(
	read.includes('from-desk') && !read.includes('hello'),
	'read --last 1 prints only the last message',
	read,
)
const before = (await view(id)).entries.at(-1).id
await cli('post', '--thread', id, '--to', 'echo/echo@laptop', '--no-wait', 'later please')
const waited = await cli('wait', id, '--after', String(before))
const after = await cli('read', id, '--after', String(before))
check(
	waited.includes('later please') && /heard:[\s\S]*\nlater please/.test(waited) && waited === after,
	'post --no-wait returns at once; wait prints what landed once the agents are idle, read --after the same',
	JSON.stringify([waited, after]),
)

// Far behind 210 newer messages, the ask that wait prints after is still found
const busy = await createThread('busy')
await cli('post', '--thread', String(busy), '--to', 'echo/echo@laptop', 'the old ask')
for (let k = 0; k < 210; k++) await postEntry(busy, `note ${k}`, null)
const behind = await cli('wait', String(busy))
check(
	!/→[^\n]*\nthe old ask/.test(behind) &&
		behind.includes('heard: the old ask') &&
		behind.includes('note 209'),
	'wait finds the newest ask however far back it is, and prints only what came after it',
	behind.slice(0, 300),
)

const runners = await cli('runners')
check(
	runners.includes('laptop online') && runners.includes('desk online'),
	'runners lists both',
	runners,
)
const asAgent = await promisify(execFile)(
	process.execPath,
	['cli.js', '--server', base, 'post', '--to', 'echo/echo@laptop', 'from an agent shell'],
	{
		cwd: repo,
		timeout: 8000,
		env: {
			...process.env,
			PI_SESSION_ID: 'sess-1',
			PI_MODEL: 'claude-opus-4-5',
			PI_REASONING_LEVEL: 'high',
		},
	},
).then(({ stdout, stderr }) => stdout + stderr)
const fromShell = (await view(/thread (\d+)/.exec(asAgent)?.[1])).entries?.[0]?.data
check(
	fromShell?.author === owner && fromShell.body === 'from an agent shell',
	"the CLI writes as whoever the server takes it for: on the server's machine, the owner, even from an agent's shell",
	asAgent,
)

const named = await cli('post', '--to', 'reviewer=echo/echo@desk', 'review this').catch(
	(error) => error.stderr,
)
check(
	/only bots have names/.test(named),
	"--to can't name a thread's agent: only bots have names",
	named,
)
const reply = await cli('post', '--thread', id, '--to', id, 'by number')
check(
	/#\d+ echo:off@laptop\n/.test(reply),
	"--to with the thread's number reaches its agent",
	reply,
)
const nobody = await cli('post', '--thread', id, '--to', 'nobody', 'just a note')
check(!nobody, '--to nobody posts without waiting for an answer', nobody)

mkdirSync(`${dir}/review`)
const options = await cli(
	'post',
	'--to',
	'echo/echo@desk',
	'--thinking',
	'low',
	'--dir',
	'review',
	'with options',
)
const optionsId = /thread (\d+)/.exec(options)?.[1]
const asked = optionsId && (await view(optionsId)).agents[0]?.to
check(
	asked?.thinkingLevel === 'low' && asked?.dir === 'review',
	'--thinking and --dir still set a model@runner',
	JSON.stringify(asked),
)

/** A stop posts no answer, so waiting must end on the thread's status alone. */
laptop.kill()
check(
	await until(
		async () => !(await api('GET', '/api/runners')).json.find((r) => r.name === 'laptop').online,
	),
	'laptop goes offline',
)
const stopped = await createThread('stop a CLI delivery')
const pending = cli(
	'post',
	'--thread',
	String(stopped),
	'--to',
	'echo/echo@laptop',
	'wait for stop',
).then(
	(output) => ({ output }),
	(error) => ({ error: error.message }),
)
check(
	await until(async () => (await view(stopped)).status === 'blocked'),
	'CLI waits for the offline runner',
)
await cli('stop', String(stopped))
const result = await pending
check(
	!('error' in result),
	'stopping a delivery ends the CLI wait without an answer',
	JSON.stringify(result),
)
check(
	(await view(stopped)).entries.map((entry) => entry.data.body).join() === 'wait for stop,stopped',
	'a stopped delivery posts no answer, only who stopped it',
	JSON.stringify((await view(stopped)).entries.map((entry) => entry.data.body)),
)
done()
