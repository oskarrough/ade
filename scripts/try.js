/** A scratch ade to click through: its own store and port, a real runner `bot` with a scripted echo model, and one thread it has already answered.
 * The bots and director modules are on, with three bots, bot1, bot2 and bot3, that answer at once, each naming itself, its
 * persona and what it was shown last, so who answered and what they saw read off the reply. Send to one by name (`--to bot1`).
 * The director picks too: in a thread of bots, a message naming no one goes to whoever's persona it mentions (review,
 * engineer, design), else nobody.
 * `node scripts/try.js &`, open the address it prints, stop it with the `kill` line it prints. Every server it starts goes with it.
 * The bot's model, echo/try, thinks, writes, reads, edits and runs a command in its folder, then answers in markdown.
 * A message with "post" in it makes it post to a new thread too, or to a bot it names; "slow" makes the command take five seconds, to watch live work, and passes on to the thread it posts to.
 * With MODULES=+inbox, a message starting "ask " makes it ask you the rest with `ask_person`. */
import { api, base, hookPort, runner, server, servePort, shellEnv } from '../examples/lib.js'
import { personas } from '../echo.js'

// MODULES=+web-search layers changes on top of this script's own modules.
const modules = ['+bots,+director', shellEnv.MODULES].filter(Boolean).join(',')
await server({ MODULES: modules, DIRECTOR_MODEL: 'echo/try@bot' })
await runner('bot', {
	dir: process.cwd(),
	env: { MODULES: modules },
})

for (const name of Object.keys(personas))
	await api('POST', '/api/bots', {
		name,
		to: 'echo/try@bot',
		instructions: `You are ${personas[name]}.`,
	})
const { json: thread } = await api('POST', '/api/threads', { title: 'try me' })
await api('POST', `/api/threads/${thread.id}/entries`, {
	body: 'look around',
	to: { runner: 'bot', model: 'echo/try' },
})

console.log(`ade at ${base}/?thread=${thread.id}
serve http://127.0.0.1:${servePort} (people come in by Tailscale-User-Login)${hookPort ? `\nhooks http://127.0.0.1:${hookPort}/hooks/<task id> (outside events, with hooks on)` : ''}
the bot works in ${process.cwd()}; send to echo/try@bot, "post" or "slow" in a message for more
bots: ${Object.keys(personas).join(', ')}; from a terminal: export ADE_SERVER=${base}; node cli.js post --to bot1 hi
stop: kill ${process.pid}`)
