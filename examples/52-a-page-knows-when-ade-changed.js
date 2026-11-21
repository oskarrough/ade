/** An open page knows when a reload would bring it a newer ade: `GET /api/server` names what a reload gets as `client`, and a change to the client's files names `server` on every socket, so the page asks again and sees it differ */
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import WebSocket from 'ws'
import { api, base, check, done, repo, server, until } from './lib.js'

await server()
const before = (await api('GET', '/api/server')).json.client
check(
	typeof before === 'string' && before.length > 0,
	'the server names what a reload of the page gets',
	String(before),
)

const heard = []
const socket = new WebSocket(`${base.replace('http', 'ws')}/ws`)
socket.onmessage = ({ data }) => heard.push(JSON.parse(String(data)))
await new Promise((resolve) => (socket.onopen = resolve))

const file = path.join(repo, 'apps/client', `zz-example-${process.pid}.css`)
writeFileSync(file, '/* a change to the client */\n')
try {
	check(
		Boolean(await until(async () => heard.some((message) => message.changed?.includes('server')))),
		'changing a client file names `server` on the socket',
		JSON.stringify(heard),
	)
	const after = (await api('GET', '/api/server')).json.client
	check(after !== before, 'and the server then names another `client`', `${before} ${after}`)
} finally {
	rmSync(file, { force: true })
}

socket.close()
done()
