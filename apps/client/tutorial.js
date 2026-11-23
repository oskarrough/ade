/** The story's buttons use the same server and picker as the chat. */
import { loadShed } from './tutorial-shed.js'
import { defaultTitle } from './title.js'
import html from '@solidjs/html'
import { Portal } from '@solidjs/web'
import { onSettled, Show, snapshot } from 'solid-js'
import {
	api,
	bots,
	current,
	createThread,
	entries,
	fork,
	openThread,
	runners,
	saveBot,
} from './server.js'
import { choose, pick, toFor } from './composer.js'
import { ConnectRunner } from './runner.js'
import { report } from './notice.js'
import { Memory } from './agent-memory.js'

export function Tutorial(props) {
	onSettled(() => {
		const stage = document.getElementById('stage')
		const sections = new IntersectionObserver(
			(list) => {
				for (const entry of list)
					if (entry.isIntersecting) stage.dataset.focus = entry.target.getAttribute('data-focus')
			},
			{ rootMargin: '-45% 0px -45% 0px' },
		)
		document.querySelectorAll('.page > section').forEach((section) => sections.observe(section))
		const buttons = [...document.querySelectorAll('[data-try]')]
		const run = async (event) => {
			const button = event.currentTarget
			if (matchMedia('(max-width: 1000px)').matches) stage.scrollIntoView({ behavior: 'smooth' })
			button.disabled = true
			try {
				await TRIES[button.dataset.try]()
			} catch (error) {
				report(error)
			} finally {
				button.disabled = false
			}
		}
		buttons.forEach((button) => button.addEventListener('click', run))
		return () => {
			sections.disconnect()
			buttons.forEach((button) => button.removeEventListener('click', run))
		}
	})
	return html`
		<${Show} when=${() => props.story}
			><${Portal} mount=${document.getElementById('memory')}><${Memory} /><//
		><//>
		<${Portal} mount=${document.getElementById('connect-runner')}
			><${ConnectRunner} name="laptop"
		/><//>
	`
}

const providerOf = (model) => model.split('/')[0]
/** Online runners with a model, the server's own last: a machine you connected shows where work happens, and its work outlives a server restart */
const online = () =>
	runners
		.filter((runner) => runner.online && toFor(runner).model)
		.sort((a, b) => Number(Boolean(a.own)) - Number(Boolean(b.own)))
/** Written with its provider, exactly as the runner lists it, so it can't resolve to another provider's login */
const named = (to) => `${to.model}@${to.runner}`
/** The model you picked in the composer, here or for a new thread, while its runner is online; a bot's pick isn't one */
const picked = (thread = current()) => {
	const mine = [pick(thread), pick(null)].find((one) => one && !one.held)
	const to = mine?.agent
	return to && !to.name && runners.some((runner) => runner.online && runner.name === to.runner)
		? to
		: undefined
}
/** The model a try asks: yours, else the first online runner's, the server's own last */
const chosen = (thread = current()) => picked(thread) ?? defaults()[0]
/** Two models to ask: yours if you picked one, then small ones the online runners offer (Haiku, Luna, Sonnet or Terra),
 * on another runner and from another provider if possible, then the model the thread is on to fill up. `anthropic/…` is
 * never picked from the list: its login can be expired. */
const smallTwo = () => {
	const small = online().flatMap((runner) =>
		(runner.offers ?? [])
			.filter((model) => /haiku|luna|sonnet|terra/.test(model) && providerOf(model) !== 'anthropic')
			.map((model) => ({ ...toFor(runner), model })),
	)
	const one = picked() ?? small[0] ?? defaults()[0]
	if (!one) return []
	const others = small.filter((option) => named(option) !== named(one))
	const elsewhere = (option) => option.runner !== one.runner
	const otherProvider = (option) => providerOf(option.model) !== providerOf(one.model)
	const two =
		others.find((option) => elsewhere(option) && otherProvider(option)) ??
		others.find(elsewhere) ??
		others.find(otherProvider) ??
		others[0] ??
		defaults()[0]
	return [one, two]
}
const defaults = () => online().map((runner) => toFor(runner))
async function ask(body, to, was = current()) {
	if (!to) throw new Error('Pick a model first.')
	choose(to)
	const id = was ?? (await createThread(defaultTitle(body)))
	await api(`/api/threads/${id}/entries`, { body, to: snapshot(to) })
}

const fresh = () => openThread(null)
/** The walkthrough's bot: made once, then asked again in its home */
const DIARIST = 'scribe'
const TRIES = {
	hands: () => {
		const to = chosen()
		fresh()
		return ask("Which file in this folder is biggest? Look, don't guess. One line.", to, null)
	},
	friend: async () => {
		const id = current() ?? (await api('/api/threads', { title: 'A thread for two' })).id
		if (!current()) openThread(id)
		const link = new URL(location.pathname, location.origin)
		link.searchParams.set('thread', id)
		await navigator.clipboard.writeText(link.href)
		report(
			/^(localhost|127(?:\.\d+){3}|\[::1\])$/.test(location.hostname)
				? `Copied ${link.href}. It opens only on this machine: for a friend, run tailscale serve on the server's serve port and send its address.`
				: `Copied ${link.href}`,
		)
	},
	slow: () => {
		const to = chosen()
		fresh()
		return ask(
			'Count from 1 to 20 in your shell, one number a second: run `for i in $(seq 1 20); do echo $i; sleep 1; done`. Then say how far you got, in one line.',
			to,
			null,
		)
	},
	fork: () => {
		const first = (entries[current()] ?? []).find((entry) => entry.data.answer)
		if (!first) throw new Error('Ask something first: a fork starts from a message.')
		return fork(current(), first.id)
	},
	shed: () => loadShed(api, openThread),
	recall: () => {
		if (!current()) throw new Error('Load the example thread first.')
		return ask(
			'What is the gate code now, what colour is the shed, and how long are the rafters? Say which message you found each in.',
			chosen(),
		)
	},
	bot: async () => {
		const name = DIARIST
		const to = chosen()
		if (!to) throw new Error('Pick a model first.')
		const home =
			bots.find((bot) => bot.name === name)?.home ??
			(await saveBot(name, { to: { ...snapshot(to), name: undefined } })).home
		openThread(home)
		await api(`/api/threads/${home}/entries`, {
			body: 'You\'re new here. You keep a diary of this house, here in your home: one short entry a day about what happened in its threads. Write that into your instructions with your bot tool. Then schedule a task at times ["09:00"] whose instructions tell you to write the day\'s entry; never a second one. Tell me what you did in two lines.',
			to: name,
		})
	},
	inbox: () => {
		const to = chosen()
		fresh()
		return ask(
			"Ask me with ask_person which colour the shed should be, then end your turn. Don't guess, and don't ask anything else.",
			to,
			null,
		)
	},
	talk: () => {
		const [one, two] = smallTwo()
		fresh()
		if (!one) throw new Error('Pick a model first.')
		return ask(
			`With your post tool, start two threads at once: one asking ${named(one)}, one asking ${named(two)}, which machine and folder it is in, in one line. Wait for both answers, then tell me in two lines.`,
			one,
			null,
		)
	},
}
