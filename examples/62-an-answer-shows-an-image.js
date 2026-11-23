/** An agent shows a person a picture: `![](path)` in its answer, to a file on its machine, arrives as one of the
 * message's images, as a person's would; one it can't show says why in its place */
import { copyFileSync } from 'node:fs'
import path from 'node:path'
import {
	answered,
	answers,
	check,
	createThread,
	dir,
	done,
	postEntry,
	repo,
	say,
	scriptedRunner,
	server,
	view,
} from './lib.js'

await server()
copyFileSync(path.join(repo, 'apps/client/icons/192.png'), path.join(dir, 'shot.png'))
await scriptedRunner('laptop', () =>
	say(
		`Here it is:\n\n![the icon](shot.png)\n\nand ![](${path.join(dir, 'gone.png')}) too. ` +
			'Also, the syntax is `![](path)`, and a miss reads `' +
			"(couldn't show path: …)" +
			'` in a code span.',
	),
)
const id = await createThread('show me')
await postEntry(id, 'show me the icon', 'echo/echo@laptop')
await answered(id)
const [answer] = answers(await view(id))
check(
	answer?.data.images?.length === 1 && answer.data.images[0].mimeType === 'image/png',
	'the answer carries the picture it showed',
	JSON.stringify(answer?.data.images?.map(({ mimeType, data }) => [mimeType, data.length])),
)
check(
	answer.data.body.startsWith('Here it is:') && !answer.data.body.includes('shot.png'),
	'and its words, without the path',
	answer.data.body,
)
check(
	answer.data.body.includes(`(couldn't show ${path.join(dir, 'gone.png')}:`),
	"one it can't show says why",
	answer.data.body,
)

check(
	answer.data.body.includes('`![](path)`') &&
		answer.data.body.includes("`(couldn't show path: …)`"),
	'but that syntax inside a code span stays plain text',
	answer.data.body,
)

done()
