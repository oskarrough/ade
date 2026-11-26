/** Opening the catalog picks up a Pi provider installed since the runner connected. */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
	answered,
	answers,
	api,
	check,
	createThread,
	dir,
	done,
	postEntry,
	runner,
	until,
	server,
} from './lib.js'

await server()
const agentDir = path.join(dir, 'pi')
mkdirSync(agentDir)
await runner('desk', { env: { PI_CODING_AGENT_DIR: agentDir } })
const available = async () => (await api('GET', '/api/runners/desk/available')).json
const ref = 'installed/neon'
check(!(await available()).includes(ref), 'the provider is not installed yet')
mkdirSync(path.join(agentDir, 'extensions'))
writeFileSync(
	path.join(agentDir, 'extensions', 'installed.js'),
	`import { fauxProvider, fauxAssistantMessage } from ${JSON.stringify(import.meta.resolve('@earendil-works/pi-ai/providers/faux'))}
import {watch, writeFileSync} from 'node:fs'
export default function(pi) {
 const faux = fauxProvider({provider: 'installed', models: [{id: 'neon'}]})
 faux.setResponses([async () => {
 await new Promise(resolve => {
 const watcher = watch(${JSON.stringify(dir)}, (_, file) => {
 if (file === 'release') {watcher.close(); resolve()}
 })
 writeFileSync(${JSON.stringify(path.join(dir, 'working'))}, '')
 })
 return fauxAssistantMessage('newly installed')
 }])
 pi.registerProvider(faux.provider)
}`,
)
writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ enabledModels: [ref] }))
const listed = (await available()).includes(ref)
check(listed, 'the next catalog request finds the installed provider')
if (!listed) done()
check(
	(await api('GET', '/api/runners')).json.find((row) => row.name === 'desk').offers.includes(ref),
	'the picker offers the newly enabled model',
)
const id = await createThread('new provider')
await postEntry(id, 'hello', { runner: 'desk', model: ref })
const working = await until(async () => existsSync(path.join(dir, 'working')))
check(working, 'the installed provider is streaming')
if (!working) done()
writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ enabledModels: ['echo/try'] }))
await available()
check(
	(await api('GET', '/api/runners')).json.find((row) => row.name === 'desk').offers.join() ===
		'echo/try',
	'changing just the enabled models refreshes the picker',
)
writeFileSync(path.join(dir, 'release'), '')
check(
	answers(await answered(id)).at(-1)?.data.body === 'newly installed',
	'the active provider finishes its answer across the refresh',
)
done()
