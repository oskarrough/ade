/** MODULES=+bots: a bot is one name in many threads */
import {
	createThread,
	postEntry,
	answered,
	answers,
	api,
	call,
	check,
	conversationOf,
	done,
	quiet,
	say,
	scriptedRunner,
	server,
	text,
	until,
	view,
} from './lib.js'

/** The shared instruction every bot's prompt carries just before her own, until settings override it */
const voice =
	'Talk like a person in a chat with friends: lead with the answer, maybe a reaction or a reason, and stop. Everyone here already sees the thread, tool calls and posts; say only what\'s new. No headings, bold or bullets unless asked for a list, and no ids or mechanics unless someone must act on them. If you can check something, check it; if you can\'t, say you\'re guessing.\nWhen you hand work to another agent, keep the brief short: the goal, the boundaries and how to tell it\'s done, not the steps. Aim high and make it measurable ("make this 10x faster", "test it against the old version and close every gap"), not "optimize this".'
/** `voice`, as it reads once `prompt.laptop` has JSON-escaped its quotes */
const voiceInPrompt = JSON.stringify(voice).slice(1, -1)

await server({ MODULES: '+bots' })
/** Pi carries the system prompt in system messages: what each runner was last asked with */
const prompt = {}
const route = (runner) => (request) => {
	prompt[runner] = JSON.stringify(request.messages.filter((m) => m.role === 'system'))
	const last = request.messages.findLast((m) => m.role !== 'system')
	const t = text(last)
	if (last.role === 'toolResult') return say(`tool: ${t}`)
	if (t.includes('be a pirate')) return call('bot', { instructions: 'Answer like a pirate.' })
	if (t.includes('learn arr')) return call('bot', { append: 'Say arr.' })
	if (t.includes('make wren')) return call('bot', { name: 'wren', instructions: 'Review diffs.' })
	if (t.includes('ask wren'))
		return call('post', { to: 'wren', title: 'a diff', body: 'look at this' })
	if (t.includes('nudge wren')) return call('post', { title: 'again', body: '@wren look again' })
	if (t.includes('ask anyone')) return call('post', { title: 'anyone', body: 'look at this' })
	return say(`${runner}: ${t}`)
}
await scriptedRunner('laptop', route('laptop'))
await scriptedRunner('desk', route('desk'))
const bots = async () => (await api('GET', '/api/bots')).json

const made = await api('POST', '/api/bots', { name: 'bot1', to: 'echo/echo@laptop' })
const home = made.json.home
const homeRow = (await api('GET', '/api/threads')).json.find((t) => t.id === home)
await postEntry(home, 'who are you?', 'bot1')
let v = await answered(home)
check(
	made.status === 201 &&
		homeRow?.title === 'bot1' &&
		homeRow.tools === null &&
		v.agents.map((a) => a.name).join() === 'bot1' &&
		made.json.instructions === '' &&
		prompt.laptop.includes(voiceInPrompt),
	'one call makes bot1 and her home, with every tool; she starts with no instructions of her own but reads the shared voice until she writes them',
	JSON.stringify([made.json, homeRow, prompt.laptop]),
)

const regenerate = await api('POST', `/api/threads/${home}/auto-title`, {})
check(regenerate.status >= 400, 'a bot home refuses a generated title', JSON.stringify(regenerate))

// With instructions explicitly empty, a bot still starts with nothing, and asks the person who she is
const blank = await api('POST', '/api/bots', {
	name: 'blank',
	to: 'echo/echo@laptop',
	instructions: '',
})
await postEntry(blank.json.home, 'hi', 'blank')
await answered(blank.json.home)
check(
	blank.json.instructions === '' && prompt.laptop.includes("You're new"),
	'a bot made with nothing in her instructions still finds out who she is',
	JSON.stringify([blank.json, prompt.laptop]),
)

await postEntry(home, 'be a pirate', 'bot1')
v = await answered(home, 2)
const ownAt = (await api('GET', `/api/threads/${home}`)).json.agents[0].conversation
const rewrote = (await api('GET', `/api/conversations/${ownAt}`)).json.entries.find(
	(e) => e.kind === 'pi.tool-result' && e.model[0].toolName === 'bot',
)?.model[0].details
check(
	rewrote?.before?.instructions === '' && rewrote.before.model === 'echo/echo@laptop',
	'rewriting herself, her bot call keeps what she was before, so a thread can show old against new',
	JSON.stringify(rewrote),
)
await postEntry(home, 'learn arr', 'bot1')
v = await answered(home, 3)
check(
	(await bots()).find((b) => b.name === 'bot1')?.instructions === 'Answer like a pirate.\nSay arr.',
	'a lesson goes on the end of her instructions as one line, without resending them',
	JSON.stringify(await bots()),
)
const atHomeAlready = answers(v).at(-1).data.createdAt
check(
	(await bots()).find((b) => b.name === 'bot1')?.answeredAt === atHomeAlready,
	'answeredAt follows her latest answer so far, at home',
	JSON.stringify(await bots()),
)

const shed = await createThread('shed')
await postEntry(shed, 'build it?', 'bot1')
v = await answered(shed)
const bot1 = v.agents.find((a) => a.name === 'bot1')
const answeredAway = answers(v)[0]?.data.createdAt
check(
	(await bots()).find((b) => b.name === 'bot1')?.instructions ===
		'Answer like a pirate.\nSay arr.' &&
		bot1?.to.runner === 'laptop' &&
		answers(v)[0]?.data.author === 'bot1' &&
		prompt.laptop.includes(String.raw`Answer like a pirate.\nSay arr.`) &&
		prompt.laptop.includes(`${home} \\"bot1\\" (home)`),
	'at home she writes her own instructions; asked elsewhere, she joins with them and knows her home',
	JSON.stringify([await bots(), bot1, prompt.laptop]),
)
check(
	(await bots()).find((b) => b.name === 'bot1')?.answeredAt === answeredAway,
	'answeredAt follows her latest answer anywhere, not only her home',
	JSON.stringify(await bots()),
)

await postEntry(shed, 'be a pirate', 'bot1')
v = await answered(shed, 2)
check(
	/Only a bot can, in its home thread/.test(answers(v)[1]?.data.body),
	'away from home, her bot tool refuses',
	answers(v)[1]?.data.body,
)

const desk = await createThread('desk work')
await postEntry(desk, 'and here?', 'bot1=echo/echo@desk')
v = await answered(desk)
const porch = await createThread('porch')
await postEntry(porch, 'hi', 'bot1')
await answered(porch)
await api('POST', '/api/bots', { name: 'bot1', to: 'echo/echo@desk' })
const yard = await createThread('yard')
await postEntry(yard, 'hi', 'bot1')
const y = await answered(yard)
await postEntry(porch, 'still here?', 'bot1')
const p = await answered(porch, 2)
check(
	v.agents.find((a) => a.name === 'bot1')?.to.runner === 'desk' &&
		y.agents.find((a) => a.name === 'bot1')?.to.runner === 'desk' &&
		p.agents.find((a) => a.name === 'bot1')?.to.runner === 'desk' &&
		answers(p).at(-1)?.data.author === 'bot1' &&
		(await api('GET', `/api/threads/${shed}`)).json.agents.find((a) => a.name === 'bot1')?.to
			.runner === 'laptop',
	'bot1=model@runner gives one thread another model; a new model counts wherever she is asked by name next, in threads she was already in too',
	JSON.stringify([v.agents, y.agents, p.agents]),
)
await api('POST', '/api/bots', { name: 'bot1', to: 'echo/echo@laptop' })

await postEntry(home, 'make wren', 'bot1')
await answered(home, 3)
const wren = (await bots()).find((b) => b.name === 'wren')
const runnerName = await api('POST', '/api/bots', { name: 'desk', to: 'echo/echo@desk' })
const nameless = await api('POST', '/api/bots', { name: 'rex' })
check(
	wren?.instructions === 'Review diffs.' &&
		wren.to.runner === 'laptop' &&
		wren.home !== home &&
		runnerName.status === 400 &&
		/say what it runs as/.test(nameless.json.error),
	"a bot makes a bot with its own home, on her model; a runner's name is no bot's, and a new bot needs a model",
	JSON.stringify([await bots(), runnerName.json, nameless.json]),
)

await postEntry(home, 'ask wren', 'bot1')
await answered(home, 5)
const side = (await api('GET', '/api/threads')).json.find((t) => t.parent === home)
check(
	/The other bots? (is|are) .*\bwren\b/.test(prompt.laptop) &&
		side?.agents.map((a) => a.name).join() === 'wren' &&
		answers(await (await api('GET', `/api/threads/${side.id}`)).json)[0]?.data.author === 'wren',
	'a bot knows the other bots by name, and asks one with post',
	JSON.stringify([side, prompt.laptop]),
)
const [askedWren] = (await api('GET', `/api/threads/${wren.home}/bots?asked=${side.id}`)).json
check(
	askedWren?.thread === side.id &&
		askedWren.question?.data.author === 'bot1' &&
		askedWren.answer?.data.author === 'wren' &&
		askedWren.answer.data.re.includes(askedWren.question.id),
	"a bot's home reads the threads that asked her in one request: each one's question and her answer",
	JSON.stringify(askedWren),
)

// In her home, the composer asks her with her settings: a new runner there moves her, in place, and she is told
const atHome = (await api('GET', `/api/threads/${home}`)).json.agents[0]
await postEntry(home, 'where are you now?', { runner: 'desk', model: 'echo/echo', name: 'bot1' })
v = await answered(home, 6)
const own = (await api('GET', `/api/conversations/${atHome.conversation}`)).json.entries
const told = text(own.filter((e) => e.kind === 'ade.delivery').at(-1)?.model[0])
check(
	atHome.to.runner === 'laptop' &&
		v.agents.length === 1 &&
		v.agents[0].conversation === atHome.conversation &&
		v.agents[0].to.runner === 'desk' &&
		answers(v).at(-1).data.author === 'bot1' &&
		told.startsWith('[You now run as echo/echo on desk,'),
	'asked as another model, a bot switches in place like any agent, keeps her name and is told',
	JSON.stringify([atHome, v.agents, told]),
)

await postEntry(home, 'nudge wren', 'bot1')
await answered(home, 7)
// Wren's reply can land before or with the next message; wait for the answer to that one
const anyone = (await postEntry(home, 'ask anyone', 'bot1')).json.entry
await until(async () => answers(await view(home)).some((a) => a.data.re?.includes(anyone)))
await quiet()
v = await view(home)
const refused = answers(v).find((a) => a.data.re?.includes(anyone))
const again = (await api('GET', '/api/threads')).json.find(
	(t) => t.parent === home && t.title === 'again',
)
check(
	again?.agents.map((a) => a.name).join() === 'wren' &&
		answers(await (await api('GET', `/api/threads/${again.id}`)).json)[0]?.data.author === 'wren' &&
		refused?.data.body.includes('Say who should answer') &&
		!(await api('GET', '/api/threads')).json.some((t) => t.title === 'anyone'),
	'a new thread asks whom `to` names or the bots its body @mentions; with neither, post refuses',
	JSON.stringify([again, refused?.data.body]),
)

const hide = await api('POST', `/api/threads/${home}/archive`, { archived: true })
check(
	hide.status === 400 &&
		/bot1's home/.test(hide.json.error) &&
		(await api('GET', '/api/threads')).json.some((t) => t.id === home && !t.archived),
	"bot1's home can't be archived while she's a bot",
	JSON.stringify(hide.json),
)

const gone = await api('DELETE', '/api/bots/bot1')
await postEntry(shed, 'still there?', 'bot1')
v = await answered(shed, 3)
check(
	gone.status === 200 &&
		!(await bots()).some((b) => b.name === 'bot1') &&
		(await api('GET', '/api/threads/archived')).json.some((t) => t.id === home) &&
		answers(v)[2]?.data.author === 'bot1' &&
		JSON.parse(prompt.laptop).at(-1).sections?.bot === null,
	'forgetting bot1 archives her home and keeps every other thread: her agents stay, without her instructions',
	JSON.stringify([gone.json, answers(v)[2]?.data, prompt.laptop]),
)

// A thread's own agent works beside its bots, and reads them as agents
await postEntry(shed, 'what did bot1 say?', 'echo/echo@desk')
v = await answered(shed, 4)
const plain = v.agents.find((a) => !a.to.name)
const handed = (await api('GET', `/api/conversations/${plain?.conversation}`)).json.entries
	?.filter((e) => e.kind === 'ade.delivery')
	.map((e) => text(e.model[0]))
check(
	v.agents.map((a) => a.name).join() === 'bot1,echo@desk' &&
		answers(v).at(-1).data.author === 'echo@desk' &&
		handed?.[0].includes('\n\n<message from="bot1" agent>\nlaptop: build it?\n</message>'),
	"a thread holds one agent and any bots; the agent reads a bot's words marked as an agent's",
	JSON.stringify([v.agents, handed]),
)
const nameless2 = await postEntry(shed, 'hi', 'rex=echo/echo@desk')
check(
	nameless2.status === 400 && /only bots have names/.test(nameless2.json.error),
	'a name that is no bot is refused',
	JSON.stringify(nameless2.json),
)

const archived = await api('POST', `/api/threads/${home}/archive`, { archived: true })
check(
	archived.status === 201,
	'forgotten, her home archives like any thread',
	JSON.stringify(archived.json),
)
// Renamed, wren keeps her home, instructions and model, and every thread she's in knows her by the new name
const wrenBefore = (await bots()).find((b) => b.name === 'wren')
const sideAgent = (await api('GET', `/api/threads/${side.id}`)).json.agents[0]
const renamed = await api('POST', '/api/bots', { name: 'wren', rename: 'robin' })
const robin = (await bots()).find((b) => b.name === 'robin')
await postEntry(side.id, 'still you?', 'robin')
v = await answered(side.id, 2)
const titled = await api('POST', `/api/threads/${robin?.home}/title`, { title: 'somewhere' })
const oldName = await postEntry(side.id, 'hi', 'wren')
check(
	renamed.status === 201 &&
		!(await bots()).some((b) => b.name === 'wren') &&
		robin?.home === wrenBefore.home &&
		robin.instructions === wrenBefore.instructions &&
		JSON.stringify(robin.to) === JSON.stringify(wrenBefore.to) &&
		(await api('GET', '/api/threads')).json.find((t) => t.id === robin.home)?.title === 'robin' &&
		v?.agents.map((a) => `${a.name} ${a.conversation}`).join() ===
			`robin ${sideAgent.conversation}` &&
		answers(v).at(-1)?.data.author === 'robin' &&
		prompt.laptop.includes(`You are robin in thread ${side.id}`) &&
		titled.status === 400 &&
		oldName.status === 400,
	'a renamed bot keeps her home, instructions, model and conversations under the new name; her home shows it, and the old name asks no one',
	JSON.stringify([renamed.json, robin, v?.agents, titled.json, oldName.json]),
)
// A name changes hands: answers under it before were another bot's, so whoever takes it reads them
const heldFor = async (thread, name) =>
	(await conversationOf(await view(thread), name)).entries
		.filter((entry) => entry.kind === 'ade.delivery')
		.flatMap((entry) => entry.data.held)
for (const name of ['maple', 'pine'])
	await api('POST', '/api/bots', { name, to: 'echo/echo@laptop' })
const grove = await createThread('grove')
await postEntry(grove, 'start with maple', 'maple')
await answered(grove)
await postEntry(grove, 'pine only', 'pine')
v = await answered(grove, 2)
const oldPine = answers(v).at(-1)
await api('POST', '/api/bots', { name: 'pine', rename: 'birch' })
await api('POST', '/api/bots', { name: 'maple', rename: 'pine' })
await postEntry(grove, 'new pine now', 'pine')
v = await answered(grove, 3)
const newPine = answers(v).at(-1)
check(
	oldPine.data.author === 'pine' && (await heldFor(grove, 'pine')).includes(oldPine.id),
	"a bot renamed to a name another bot answered under here reads those answers, which aren't hers",
	JSON.stringify([oldPine, await heldFor(grove, 'pine')]),
)
await api('POST', '/api/bots', { name: 'pine', rename: 'oak' })
await api('POST', '/api/bots', { name: 'pine', to: 'echo/echo@laptop' })
await postEntry(grove, 'third pine here', 'pine')
await answered(grove, 4)
const third = await heldFor(grove, 'pine')
check(
	third.includes(oldPine.id) && third.includes(newPine.id),
	'a new bot taking a name other bots answered under here reads their answers',
	JSON.stringify([oldPine.id, newPine.id, third]),
)
done()
