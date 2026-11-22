/** MODULES=+bots,+export: every thread, archived ones and forks included, exports as Markdown and JSON read without ade */
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
	createThread,
	postEntry,
	answered,
	api,
	base,
	check,
	done,
	owner,
	person,
	repo,
	say,
	scriptedRunner,
	server,
	until,
	view,
} from './lib.js'

await server({ MODULES: '+bots,+export' })
await scriptedRunner('laptop', () => say('got it'))
const echo = { runner: 'laptop', model: 'echo/echo' }

const source = await createThread('plans')
await postEntry(source, 'hello there', echo)
await answered(source)
await postEntry(source, 'a second message', undefined, 'ana')
const sourceView = await answered(source, 2)

const fork = (await api('POST', `/api/threads/${source}/fork`, { at: sourceView.entries[0].id }))
	.json.id

const shelved = await createThread('old business')
await postEntry(shelved, 'wrapping up', echo)
await answered(shelved)
await api('POST', `/api/threads/${shelved}/archive`, { archived: true })

await api('POST', '/api/bots', { name: 'bot1', to: echo })
const home = (await api('GET', '/api/bots')).json.find((bot) => bot.name === 'bot1').home
await postEntry(home, 'who are you?', 'bot1')
await answered(home)

const ran = await createThread('a run')
await postEntry(ran, String.raw`$ printf "line one\nline two\n"`, echo)
await until(async () => (await view(ran)).entries.at(-1)?.data.shell)

// Nothing is written on the server: a plain GET, so it reaches a server anywhere, not only its own machine
const result = await api('GET', '/api/export')
check(
	result.status === 200 && !result.json.dir,
	'export writes nothing itself: a plain read',
	JSON.stringify(result),
)

const { files } = result.json
const named = (id, ext) => Object.keys(files).find((f) => f.startsWith(`${id}-`) && f.endsWith(ext))
check(
	[source, fork, shelved, home, ran].every((id) => named(id, '.md') && named(id, '.json')),
	'a thread with a fork, an archived thread and a bot thread all come out, each as .md and .json',
	JSON.stringify(Object.keys(files)),
)
check(
	Object.keys(files).length / 2 ===
		(await api('GET', '/api/threads')).json.length +
			(await api('GET', '/api/threads/archived')).json.length,
	'every thread is counted, open and archived',
	JSON.stringify(Object.keys(files)),
)

const sourceMd = files[named(source, '.md')]
check(
	sourceMd.startsWith('# plans\n') &&
		sourceMd.includes('People: ') &&
		sourceMd.includes(person('ana')) &&
		sourceMd.includes(`**${owner}** · `) &&
		sourceMd.includes('hello there') &&
		sourceMd.includes(`**${person('ana')}**`) &&
		sourceMd.includes('a second message'),
	'markdown has the title, people, and each message as "**author** · time" with its body',
	sourceMd,
)

check(
	files[named(home, '.md')].startsWith('# bot1\n'),
	"a bot's home exports under the bot's name",
	named(home, '.md'),
)

check(
	JSON.stringify(JSON.parse(files[named(source, '.json')])) === JSON.stringify(sourceView.entries),
	"json is the thread's entries exactly as the API returns them",
	JSON.stringify([files[named(source, '.json')], sourceView.entries]),
)

const runMd = files[named(ran, '.md')]
check(
	!runMd.includes('line one\nline two') && /exit 0 — line one line two/.test(runMd),
	"a run's shell result folds into one line instead of its own",
	runMd,
)

// The CLI fetches the same files over HTTP and writes them locally
const outDir = mkdtempSync(path.join(os.tmpdir(), 'ade-export-'))
const cli = await promisify(execFile)(
	process.execPath,
	['cli.js', '--server', base, 'export', outDir],
	{ cwd: repo },
)
const written = readdirSync(outDir)
const matches = written.every(
	(name) => readFileSync(path.join(outDir, name), 'utf8') === files[name],
)
check(
	cli.stdout.includes(`wrote ${Object.keys(files).length} files to ${outDir}`) &&
		written.length === Object.keys(files).length &&
		matches,
	'the CLI writes every file it fetched, unchanged, to the folder it names',
	JSON.stringify([cli.stdout, written]),
)
rmSync(outDir, { recursive: true, force: true })

done()
