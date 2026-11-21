/** A runner without Haiku or Luna writes memory with the thread's own model and thinking. */
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import {
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
		return say('oskar: Keep the orchard gate locked.')
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
const id = (await api('POST', '/api/threads', { title: 'memory without the small models' })).json.id
await api('POST', `/api/threads/${id}/memory`, { on: true })
await api('POST', `/api/threads/${id}/entries`, {
	body: 'hi',
	to: { runner: 'google-only', model: 'google/thread-model', thinkingLevel: 'high' },
})
await answered(id)
await api('POST', `/api/threads/${id}/entries`, {
	body: 'Keep the orchard gate locked. '.repeat(40),
	to: null,
})
await api('GET', `/api/threads/${id}/memory`)
const written = await until(async () =>
	(await linesOf(id)).find(
		(line) => line.l === 0 && line.i === 2 && line.text.includes('orchard gate'),
	),
)
check(Boolean(written), "a runner without Haiku or Luna writes memory on the thread's model")
check(
	requests.length === 1 && requests[0].thinking === 'high',
	'memory keeps the thread’s thinking level',
)
done()
