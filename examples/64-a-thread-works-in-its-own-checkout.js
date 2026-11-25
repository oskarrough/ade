/** Two threads in one repo each work in a checkout of their own, apart from each other and from the folder; archiving
 * removes a clean one, keeping its branch, and keeps one with uncommitted changes */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { answered, answers, api, check, dir, done, runner, server, until } from './lib.js'

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

const own = async (title, body) =>
	(
		await api('POST', '/api/threads', {
			title,
			body,
			to: { runner: 'here', model: 'echo/try' },
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

done()
