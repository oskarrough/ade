/** A runner without Haiku or Luna writes memory with the thread's own model and thinking, and a writer that answers
 * instead of writing the line is asked again rather than remembered. */
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
done()
