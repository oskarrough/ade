/** MODULES=+search: every thread's messages, archived ones included, are found by their words, with the match marked,
 * as a person searches and as an agent's `search` tool answers; a message taken back is no longer found */
import {
	createThread,
	postEntry,
	answered,
	api,
	call,
	check,
	done,
	say,
	scriptedRunner,
	server,
	text,
	until,
} from './lib.js'

await server({ MODULES: '+search' })
await scriptedRunner('laptop', (request) => {
	const last = request.messages.findLast((m) => m.role !== 'system')
	if (last.role === 'toolResult') return say(text(last))
	return call('search', { query: 'sqlite storage' })
})
const echo = { runner: 'laptop', model: 'echo/echo' }
const write = async (id, body) => (await postEntry(id, body, null)).json.entry
const search = async (words) =>
	(await api('GET', `/api/search?q=${encodeURIComponent(words)}`)).json

const plans = await createThread('storage plans')
const decided = await write(plans, 'We decided on SQLite for storage: one user, one machine.')
await write(plans, 'Lunch at noon?')
const shelved = await createThread('old ideas')
await write(shelved, 'Maybe Postgres for storage one day.')
await api('POST', `/api/threads/${shelved}/archive`, { archived: true })

const found = await until(async () => {
	const rows = await search('decide sqlite')
	return rows.length && rows
})
check(
	found.length === 1 &&
		found[0].thread === plans &&
		found[0].title === 'storage plans' &&
		found[0].message === decided &&
		found[0].snippet.includes('\u0001decided\u0002') &&
		found[0].snippet.includes('\u0001SQLite\u0002') &&
		found[0].createdAt,
	'a search finds a message by its words in any form, with its thread, its id and the matches marked',
	JSON.stringify(found),
)

const storage = await search('storage')
check(
	storage.some((row) => row.thread === shelved && row.archived) &&
		storage.some((row) => row.thread === plans && !row.archived),
	"archived threads' messages are found too, and say so",
	JSON.stringify(storage),
)

check(
	(await search('"one machine"')).length === 1 && !(await search('"machine one"')).length,
	'quoted words match only as a phrase',
)
check((await search('stor')).length === 2, 'the last word matches as a prefix, as it is typed')

// A message its author takes back before anyone read it is no longer found
const regret = await write(plans, 'Actually, use flat files for storage.')
await until(async () => (await search('flat files')).length)
await api('POST', `/api/threads/${plans}/withdraw`, { entry: regret })
check(
	await until(async () => !(await search('flat files')).length),
	'a withdrawn message is no longer found',
)

const asking = await createThread('asking')
await postEntry(asking, 'where did we pick a store?', echo)
const answer = (await answered(asking)).entries.at(-1).data.body
check(
	answer.includes(`thread ${plans} "storage plans"`) &&
		answer.includes(`message ${decided}`) &&
		answer.includes('[SQLite]') &&
		answer.includes('[storage]'),
	"an agent's search tool answers the same matches as text",
	answer,
)

done()
