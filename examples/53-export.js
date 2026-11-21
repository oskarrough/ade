/** MODULES=+bots,+export: every thread, archived ones and forks included, exports as Markdown and JSON read without ade */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	answered,
	api,
	check,
	done,
	owner,
	person,
	say,
	scriptedRunner,
	server,
	until,
	view,
} from './lib.js'

await server({ MODULES: '+bots,+export' })
await scriptedRunner('laptop', () => say('got it'))
const echo = { runner: 'laptop', model: 'echo/echo' }

const thread = async (title) => (await api('POST', '/api/threads', { title })).json.id

const source = await thread('plans')
await api('POST', `/api/threads/${source}/entries`, { body: 'hello there', to: echo })
await answered(source)
await api('POST', `/api/threads/${source}/entries`, { body: 'a second message' }, 'ana')
const sourceView = await answered(source, 2)

const fork = (await api('POST', `/api/threads/${source}/fork`, { at: sourceView.entries[0].id }))
	.json.id

const shelved = await thread('old business')
await api('POST', `/api/threads/${shelved}/entries`, { body: 'wrapping up', to: echo })
await answered(shelved)
await api('POST', `/api/threads/${shelved}/archive`, { archived: true })

await api('POST', '/api/bots', { name: 'ada', to: echo })
const home = (await api('GET', '/api/bots')).json.find((bot) => bot.name === 'ada').home
await api('POST', `/api/threads/${home}/entries`, { body: 'who are you?', to: 'ada' })
await answered(home)

const ran = await thread('a run')
await api('POST', `/api/threads/${ran}/entries`, {
	body: String.raw`$ printf "line one\nline two\n"`,
	to: echo,
})
await until(async () => (await view(ran)).entries.at(-1)?.data.shell)

const out = mkdtempSync(path.join(os.tmpdir(), 'ade-export-'))
const result = await api('GET', `/api/export?dir=${encodeURIComponent(out)}`)
check(
	result.status === 200 && result.json.dir === out,
	'export answers the folder it wrote, resolved',
	JSON.stringify(result),
)

const files = readdirSync(out)
const named = (id, ext) => files.find((f) => f.startsWith(`${id}-`) && f.endsWith(ext))
check(
	[source, fork, shelved, home, ran].every((id) => named(id, '.md') && named(id, '.json')),
	'a thread with a fork, an archived thread and a bot thread all come out, each as .md and .json',
	JSON.stringify(files),
)
check(
	result.json.written ===
		(await api('GET', '/api/threads')).json.length +
			(await api('GET', '/api/threads/archived')).json.length,
	'every thread is counted, open and archived',
	JSON.stringify(result.json),
)

const sourceMd = readFileSync(path.join(out, named(source, '.md')), 'utf8')
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
	readFileSync(named(home, '.md') && path.join(out, named(home, '.md')), 'utf8').startsWith(
		'# ada\n',
	),
	"a bot's home exports under the bot's name",
	named(home, '.md'),
)

const sourceJson = JSON.parse(readFileSync(path.join(out, named(source, '.json')), 'utf8'))
check(
	JSON.stringify(sourceJson) === JSON.stringify(sourceView.entries),
	"json is the thread's entries exactly as the API returns them",
	JSON.stringify([sourceJson, sourceView.entries]),
)

const runMd = readFileSync(path.join(out, named(ran, '.md')), 'utf8')
check(
	!runMd.includes('line one\nline two') && /exit 0 — line one line two/.test(runMd),
	"a run's shell result folds into one line instead of its own",
	runMd,
)

const missingDir = await api('GET', '/api/export')
check(missingDir.status >= 400, 'dir is required', JSON.stringify(missingDir))

rmSync(out, { recursive: true, force: true })
done()
