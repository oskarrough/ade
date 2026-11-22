/** Agents draw on a thread's canvas through the server, with no browser open, and the drawing outlives a restart */
import { createThread, api, check, done, kill, owner, server } from './lib.js'

const env = { MODULES: '+canvas' }
let srv = await server(env)

const id = await createThread('sketch')
const canvas = `/api/threads/${id}/canvas`

const drawn = await api('POST', canvas, {
	actions: [
		{
			_type: 'create',
			shape: { _type: 'rectangle', shapeId: 'a', x: 0, y: 0, w: 200, h: 100, text: 'server' },
		},
		{
			_type: 'create',
			shape: { _type: 'rectangle', shapeId: 'b', x: 400, y: 0, w: 200, h: 100, text: 'runner' },
		},
		{ _type: 'create', shape: { _type: 'arrow', shapeId: 'ab', fromId: 'a', toId: 'b' } },
		{ _type: 'move', shapeId: 'b', x: 400, y: 200 },
		{ _type: 'align', shapeIds: ['a', 'b'], alignment: 'top' },
	],
})
check(drawn.status < 300, 'with no browser open, the server draws', JSON.stringify(drawn.json))
check(
	drawn.json.applied?.map((done) => (done.ok ? 'ok' : done.skipped)).join() ===
		'ok,ok,ok,ok,not one ade does',
	"an action ade doesn't do is skipped, and says why",
	JSON.stringify(drawn.json.applied),
)
const seen = (await api('POST', canvas, { look: {} })).json
check(
	seen.shapes?.map((shape) => shape.shapeId).join() === 'a,ab,b',
	'a look sees what was drawn',
	JSON.stringify(seen),
)

const shapes = async () => (await api('GET', canvas)).json.shapes
const has = (all) =>
	['a:server:0:0', 'b:runner:400:200', 'ab'].every((want) =>
		all.some((shape) =>
			[shape.id, shape.text, shape.x, shape.y]
				.filter((part) => part !== undefined)
				.join(':')
				.startsWith(want),
		),
	)
check(
	has(await shapes()),
	'the drawing is stored, the move included',
	JSON.stringify(await shapes()),
)
check(
	(await shapes()).length === 3 && (await shapes()).every((shape) => shape.by === owner),
	'each shape says who drew it',
	JSON.stringify(await shapes()),
)

await kill(srv)
srv = await server(env)
check(has(await shapes()), 'a restart keeps the drawing', JSON.stringify(await shapes()))

await kill(srv)
done()
