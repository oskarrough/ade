/** Two threads in one repo each work in a checkout of their own, apart from each other and from the folder; archiving
 * removes a clean one, keeping its branch, and keeps one with uncommitted changes or a fork still working in it. A folder
 * reached through a symlink gets one too. */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { answered, answers, api, check, dir, done, runner, server, until, view } from './lib.js'

const git = (...args) =>
	execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@b', ...args], {
		cwd: dir,
		encoding: 'utf8',
	})
git('init', '-q')
writeFileSync(`${dir}/notes.txt`, 'hello\n')
git('add', '.')
git('commit', '-qm', 'Start')

await server({ MODULES: '+checkouts' })
await runner('here')

const own = async (title, body, folder = undefined) =>
	(
		await api('POST', '/api/threads', {
			title,
			body,
			to: { runner: 'here', model: 'echo/try', ...(folder ? { dir: folder } : {}) },
			checkout: 'own',
		})
	).json.id
const said = async (id, count = 1) => answers(await answered(id, count)).at(-1)?.data.body ?? ''
const commit =
	'git add -A && git -c user.name=a -c user.email=a@b commit -qm mine && echo committed'

const [first, second] = await Promise.all([
	own('First', 'shell sleep 0.5; echo first >> notes.txt; pwd; cat notes.txt'),
	own('Second', 'shell sleep 0.5; echo second >> notes.txt; pwd; cat notes.txt'),
])
const [one, two] = await Promise.all([said(first), said(second)])
check(
	one.includes(`checkouts/folder/${first}-first`) && !one.includes('second'),
	"a thread works in its own checkout, named after it, and doesn't see another's edit",
	one,
)
check(
	two.includes(`checkouts/folder/${second}-second`) && !two.includes('first'),
	'so does the other, at the same time',
	two,
)
check(readFileSync(`${dir}/notes.txt`, 'utf8') === 'hello\n', 'the folder itself is untouched')

const checkout = async (id) => (await api('GET', `/api/threads/${id}/checkouts`)).json
check(
	(await checkout(first)).parent.endsWith(' Start'),
	'its details say the revision it started from',
)

await api('POST', `/api/threads/${first}/entries`, {
	body: `shell ${commit}`,
	to: { runner: 'here', model: 'echo/try' },
})
await said(first, 2)
const { path: clean } = await checkout(first)
const { path: dirty } = await checkout(second)
for (const id of [first, second])
	await api('POST', `/api/threads/${id}/archive`, { archived: true })
await until(async () =>
	['removed', 'kept'].includes((await checkout(first)).state) &&
	['removed', 'kept'].includes((await checkout(second)).state)
		? true
		: null,
)
check(
	(await checkout(first)).state === 'removed' &&
		!existsSync(clean) &&
		git('log', '-1', '--format=%s', `ade/${first}-first`).trim() === 'mine',
	'archiving removes a clean checkout and keeps its branch',
)
const kept = await checkout(second)
check(
	kept.state === 'kept' && kept.note.includes('uncommitted') && existsSync(dirty),
	'and keeps one with uncommitted changes, saying why',
	JSON.stringify(kept),
)

const third = await own('Third', 'shell pwd')
await said(third)
const forkedAt = answers(await answered(third)).at(-1)
const fork = (await api('POST', `/api/threads/${third}/fork`, { at: forkedAt.id })).json.id
const { path: shared } = await checkout(third)
await api('POST', `/api/threads/${third}/archive`, { archived: true })
await until(async () => (['removed', 'kept'].includes((await checkout(third)).state) ? true : null))
const sharedNow = await checkout(third)
check(
	sharedNow.state === 'kept' && sharedNow.note.includes(`thread ${fork}`) && existsSync(shared),
	'and keeps a clean one a fork of the thread still works in, saying which',
	JSON.stringify(sharedNow),
)
await api('POST', `/api/threads/${fork}/entries`, {
	body: 'write your notes',
	to: { runner: 'here', model: 'echo/try' },
})
await said(fork, 2)
check(
	existsSync(path.join(shared, 'notes.md')),
	'where the fork carries on',
	JSON.stringify((await view(fork)).entries.at(-1).data),
)

const link = path.join(path.dirname(dir), 'linked')
symlinkSync(dir, link)
const linked = await own('Linked', 'shell pwd', link)
const viaLink = await said(linked)
check(
	viaLink.includes(`checkouts/folder/${linked}-linked`),
	'a folder reached through a symlink works in a checkout of its own too',
	viaLink,
)

done()
