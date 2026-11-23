/**
 * A scheduled task's check: a script that runs before each of its runs, with no model, and decides whether the run asks
 * anyone. Off by default, and needs schedule: MODULES=+check.
 *
 * A check is a Code Mode script, run as the agent the run would ask, on its runner and with its tools. It reads `input`,
 * `{state, runs, now, event?}`, and calls `post(text)` to have this run ask, with `text` beside the task's instructions;
 * `done()` to end the task after this run; and `keep(value)` for the `state` its next run gets. Calling none of them is a
 * quiet run. It may not call `schedule`, so a check can't set tasks that set tasks.
 *
 * Each check is a CheckRun task of its own in that agent's conversation, background, so the agent never looks busy and
 * its transcript never shows it. Pi keeps it as it keeps any tool call: a restart replays the calls it finished and
 * hands a call it cut off back as interrupted, which fails the check rather than running anything twice. The scheduled
 * task waits on it and reads what it said (outcomeOf).
 *
 * post, done and keep are Code Mode's `globals`, which pi-durable marks internal: examples/61 pins them, so an upgrade
 * that breaks them fails `pnpm examples`.
 */
import { CodemodeSandbox } from '@earendil-works/pi-codemode'
import {
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	hook,
	NestedCallDoc,
	ToolTask,
} from '@earendil-works/pi-durable'
import { createCodemodeTool } from '@earendil-works/pi-durable/codemode'
import { finished } from '../util.js'

export const on = false

/** The tool a check's script runs through: Code Mode's own, callable only by a check */
const TOOL = 'scheduled_check'
/** How long a check may run */
const DEADLINE = 60_000
/** The longest script, kept state and posted text */
export const MOST = 16_384
/** How much of a check's output its run keeps */
const OUTPUT = 2000

/** What a check said: its post, whether it's done, and the state it kept; the CheckRun's own doc */
const Said = defineDoc({
	kind: 'ade.check-said',
	version: 1,
	scope: 'task',
	checkpointWhen: () => false,
	initial: () => ({}),
})

/** A check's script call is `check-<CheckRun id>/1`, and every call it makes is under it */
const callOf = (taskId) => `check-${taskId}`
const checkOf = (callId) => Number(/^check-(\d+)(?:\/|$)/.exec(callId ?? '')?.[1]) || undefined

/** A script's call to one of its own globals, written to its CheckRun's Said doc */
const global = (name, write) => ({
	name,
	execute: async (args, api, context) => {
		await api.commit(async (tx) => write(await tx.doc(Said, checkOf(api.callId)), args), context)
		return null
	},
})
const json = (value) => JSON.parse(JSON.stringify(value ?? null))
const sized = (value, what) => {
	if (JSON.stringify(value ?? null).length > MOST)
		throw new Error(`${what} is at most ${MOST} bytes`)
	return value
}

/**
 * The script's text with its deadline and `input` before it, and post, done and keep as plain functions: the script
 * needn't await them, as every call is awaited before it ends
 */
const source = (code, input) =>
	[
		`// @options: ${JSON.stringify({ timeout_ms: DEADLINE })}`,
		`const input = ${JSON.stringify(input)}`,
		'const said = []',
		'const post = (text) => void said.push(ade_post(text))',
		'const done = () => void said.push(ade_done())',
		'const keep = (value) => void said.push(ade_keep(value))',
		'const result = await (async () => {',
		code,
		'})()',
		'await Promise.all(said)',
		'return result',
	].join(String.fromCharCode(10))

/**
 * One check: starts its script as a nested tool call of its own, waits on it, and ends with what it said, `{post?,
 * done?, state?, output}`, or `{failed, output}`
 */
export const CheckRun = defineTask({
	name: 'ade.check',
	version: 1,
	initial: () => ({ phase: 'start' }),
	phases: {
		start: ({ id, input }, rt, ctx) =>
			rt.commit(async (tx) => {
				const call = {
					type: /** @type {const} */ ('toolCall'),
					id: `${callOf(id)}/1`,
					name: TOOL,
					arguments: { code: source(input.code, input.input) },
				}
				const tool = await tx.createTask(
					ToolTask,
					{ kind: 'nested', parent: id, parentCallId: callOf(id), key: '1', call },
					{ ownership: { kind: 'task', taskId: id } },
				)
				const slot = await tx.doc(NestedCallDoc, id, '1', null)
				slot.kind = 'nested'
				slot.taskId = tool
				return {
					status: 'waiting',
					on: [tool],
					policy: 'allSettled',
					checkpoint: { phase: 'read' },
				}
			}, ctx),
		read: ({ id }, rt, ctx) =>
			rt.commit(async (tx) => {
				const { result } = json(await tx.doc(NestedCallDoc, id, '1', null))
				const said = json(await tx.doc(Said, id))
				// What it printed comes back as one string, or a list when there's more than one part
				const parts = result?.structuredOutput ?? []
				const text = (typeof parts === 'string' ? [{ type: 'text', text: parts }] : [parts].flat())
					.flatMap((item) => (item?.type === 'text' ? [item.text] : []))
					.join('')
					.replace(/^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n/, '')
					.replace(/<\/?console_output>\n?/g, '')
				const calls = (result?.details?.calls ?? [])
					.map((call) => `${call.name} ${call.status}${call.error ? `: ${call.error}` : ''}`)
					.join('\n')
				const output = [text.trim(), calls].filter(Boolean).join('\n').slice(0, OUTPUT)
				if (!result || result.isError) {
					const error = /Script error:\n([^\n]*)/.exec(text)?.[1] ?? 'its script failed'
					return finished('completed', {
						failed: error.replace(/^Error: /, '').slice(0, 300),
						output: output.replace(/\n?Script error:[\s\S]*?(?=\n\w+ (ok|error)|$)/, ''),
					})
				}
				return finished('completed', { ...said, output })
			}, ctx),
	},
	abort: (_task, rt, ctx) => rt.commit(() => finished('aborted'), ctx),
})

/** What a finished CheckRun said, or why it failed */
export const outcomeOf = (record) => {
	const outcome = /** @type {any} */ (record?.state)?.outcome
	if (outcome?.status === 'completed') return outcome.result
	return { failed: outcome?.error?.message ?? 'its check ended without an answer', output: '' }
}

export function server(core) {
	if (!core.modulesOn.includes('schedule'))
		throw new Error('check needs schedule: MODULES=+check, without -schedule')
	const codemode = createCodemodeTool({
		sandbox: new CodemodeSandbox({ memoryLimitBytes: 64 * 1024 * 1024 }),
		globals: [
			global('ade_post', (doc, text) => {
				const said = String(text ?? '').trim()
				if (!said) throw new Error('post takes the text this run asks with')
				doc.post = sized(said, 'post')
			}),
			global('ade_done', (doc) => {
				doc.done = true
			}),
			global('ade_keep', (doc, value) => {
				doc.state = sized(json(value), 'keep')
			}),
		],
	})
	const { constrainedSampling: _, ...rest } = codemode
	const check = defineTool({
		...rest,
		name: TOOL,
		description: "A scheduled task's check; only a check runs it",
		callers: ['tools'],
		deferred: true,
	})
	return {
		extension: defineExtension({
			name: 'ade.check',
			tools: [check],
			tasks: [CheckRun],
			hooks: [
				hook(ToolTask, {
					beforeTool: (call) => {
						const parent = call.parent?.callId
						if (call.name === TOOL && !(parent && checkOf(parent) && !parent.includes('/')))
							return { block: 'Only a scheduled task runs its check' }
						if (call.name === 'schedule' && checkOf(parent))
							return { block: "A check can't schedule tasks" }
						return {}
					},
				}),
			],
		}),
	}
}
