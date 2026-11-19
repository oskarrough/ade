/**
 * Refreshes apps/client/canvas/agent from tldraw's agent starter kit: the JSON schema of the actions the server offers
 * agents with `canvas_act`, made from the kit's own schemas, and its licence.
 *
 *   git clone https://github.com/tldraw/agent-template <upstream>
 *   npm i --prefix <tools> typescript tldraw@<ours> zod@4 react@<ours> react-dom@<ours>
 *   node scripts/vendor-canvas-agent.js <upstream> <tools>
 *
 * Then read the diff, and bump UPSTREAM in canvas/agent/README.md.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [upstream, tools] = process.argv.slice(2).map((dir) => path.resolve(dir))
if (!upstream || !tools) throw new Error('usage: vendor-canvas-agent.js <upstream> <tools>')
const ts = createRequire(path.join(tools, 'x.js'))('typescript')
const repo = path.resolve(import.meta.dirname, '..')
const out = path.join(repo, 'apps/client/canvas/agent')

/** The kit files ported beside the schemas, so what they import resolves */
export const FILES = [
	'shared/types/ids-schema.ts',
	'shared/format/FocusedColor.ts',
	'shared/format/FocusedFill.ts',
	'shared/format/FocusedFontSize.ts',
	'shared/format/convertFocusedShapeToTldrawShape.ts',
	'shared/format/convertTldrawShapeToFocusedShape.ts',
	'shared/format/convertTldrawShapeToBlurryShape.ts',
	'shared/format/convertTldrawShapesToPeripheralShapes.ts',
	'client/AgentHelpers.ts',
	'client/agent/managers/BaseAgentManager.ts',
	'client/agent/managers/AgentLintManager.ts',
	'client/actions/AgentActionUtil.ts',
	...[
		'Create',
		'Update',
		'Delete',
		'Move',
		'Label',
		'Resize',
		'Rotate',
		'Align',
		'Distribute',
		'Stack',
		'Place',
		'BringToFront',
		'SendToBack',
		'Pen',
	].map((name) => `client/actions/${name}ActionUtil.ts`),
]
const SCHEMA_FILES = [
	'shared/format/FocusedGeoShapeType.ts',
	'shared/format/FocusedShape.ts',
	'shared/schema/AgentActionSchemas.ts',
]
/** The actions agents get, those that need no layout, by their `_type`, and the schema each has upstream */
export const ACTIONS = {
	create: 'CreateAction',
	update: 'UpdateAction',
	delete: 'DeleteAction',
	move: 'MoveAction',
	label: 'LabelAction',
}

/** One file as plain JS, for Node: imports of types alone go */
function port(file) {
	const source = readFileSync(path.join(upstream, file), 'utf8')
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ESNext,
			verbatimModuleSyntax: false,
			useDefineForClassFields: true,
		},
	})
	return outputText.replace(/from '(\.[^']*)'/g, "from '$1.js'")
}

const scratch = path.join(tools, 'ported')
rmSync(scratch, { recursive: true, force: true })
mkdirSync(scratch, { recursive: true })
mkdirSync(out, { recursive: true })
writeFileSync(path.join(scratch, 'package.json'), '{"type":"module"}')
for (const file of [...FILES, ...SCHEMA_FILES]) {
	const js = file.replace(/\.ts$/, '.js')
	mkdirSync(path.dirname(path.join(scratch, js)), { recursive: true })
	writeFileSync(path.join(scratch, js), port(file))
}
cpSync(path.join(upstream, 'LICENSE.md'), path.join(out, 'LICENSE.md'))

// The schema, from the same files in Node, where tldraw and zod are <tools>' own
const schemas = await import(
	pathToFileURL(path.join(scratch, 'shared/schema/AgentActionSchemas.js')).href
)
const { z } = await import(
	pathToFileURL(createRequire(path.join(tools, 'x.js')).resolve('zod')).href
)
const union = z.union(Object.values(ACTIONS).map((name) => schemas[name]))
const schema = z.toJSONSchema(union, {
	override: ({ jsonSchema }) => {
		delete jsonSchema._systemPromptCategory
	},
})
delete schema.$schema
writeFileSync(path.join(out, 'actions.schema.json'), `${JSON.stringify(schema, null, '\t')}\n`)
const commit = execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], {
	encoding: 'utf8',
}).trim()
console.log(`wrote the schema of ${Object.keys(ACTIONS).length} actions from ${commit}`)
process.exit(0)
