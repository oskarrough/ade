/** A runner without Haiku or Luna writes memory with the thread's own model and thinking. A writer that answers instead
 * of writing the line is asked again, and if it still doesn't, nothing is kept: the line waits, and zoom opens the message. */
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import {
	createThread,
	postEntry,
	answered,
	api,
	check,
	done,
	linesOf,
	localRunner,
	say,
	server,
	text,
	until,
} from './lib.js'

await server({ MODULES: '+memory' })
const requests = []
const script = fauxProvider({
	provider: 'google',
	models: [{ id: 'thread-model', reasoning: true }],
})
script.setResponses(
	Array.from({ length: 20 }, () => (context, options) => {
		const input = text(context.messages.findLast((message) => message.role === 'user'))
		if (!input.includes('<input>')) return say('ok')
		requests.push({ thinking: options?.reasoning })
		if (input.includes('Conversation Title Pending') || requests.length > 2)
			return say('Conversation Title Pending')
		return say(
			requests.length === 1
				? "I can't write that line: no messages reached me. Paste them and I'll compress them."
				: 'oskar: Keep the orchard gate locked.',
		)
	}),
)
const models = createModels()
models.setProvider(script.provider)
await localRunner('google-only', {
	models,
	resolve: (pattern) => {
		if (pattern !== 'google/thread-model') throw new Error(`No such model: ${pattern}`)
		return { model: script.getModel() }
	},
	echo: undefined,
	model: 'google/thread-model',
})
const id = await createThread('memory without the small models')
await api('POST', `/api/threads/${id}/memory`, { on: true })
await postEntry(id, 'hi', {
	runner: 'google-only',
	model: 'google/thread-model',
	thinkingLevel: 'high',
})
await answered(id)
await postEntry(id, 'Keep the orchard gate locked. '.repeat(40), null)
await api('GET', `/api/threads/${id}/memory`)
const written = await until(async () =>
	(await linesOf(id)).find(
		(line) => line.l === 0 && line.i === 2 && line.text.includes('orchard gate'),
	),
)
check(Boolean(written), "a runner without Haiku or Luna writes memory on the thread's model")
check(
	requests.length === 2 && requests.every((request) => request.thinking === 'high'),
	'memory keeps the thread’s thinking level',
)
check(
	!(await linesOf(id)).some((line) => line.text.includes('Paste them')),
	'a writer’s answer to the request never becomes a line',
)

await postEntry(id, 'Water the plum tree on Sundays. '.repeat(40), null)
await api('GET', `/api/threads/${id}/memory`)
await until(async () => requests.length >= 4)
const view = await until(async () => {
	const { lines } = (await api('GET', `/api/threads/${id}/memory`)).json
	return lines.at(-1)?.text.includes('not summarized yet') && lines
})
check(
	Boolean(view) && !(await linesOf(id)).some((line) => line.text.includes('Title Pending')),
	'a placeholder the writer gives twice is never kept: the line waits, not written',
	JSON.stringify(await linesOf(id)),
)
const zoomed = (await api('GET', `/api/threads/${id}/memory?zoom=3,1`)).json
check(
	zoomed.message?.includes('Water the plum tree'),
	'zoom opens the message the missing line stands for',
)
done()
