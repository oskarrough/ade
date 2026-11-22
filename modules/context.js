/**
 * Gives each agent what pi reads in its folder before it starts, AGENTS.md and skills, found on the runner before every request,
 * and, as pi does, the folder itself, so paths and commands start there.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
	DefaultResourceLoader,
	stripFrontmatter,
	formatSkillsForPrompt,
	getAgentDir,
	SettingsManager,
} from '@earendil-works/pi-coding-agent'
import { defineExtension } from '@earendil-works/pi-durable'

export const on = true

export function server({ runners, known, reach, agentOf, folder }) {
	const read = (runner, cwd, conversationId, signal) =>
		runners.call(
			runner,
			{ op: 'context', dir: cwd },
			{ signal, key: `conversation ${conversationId}` },
		)
	const section = {
		key: 'project',
		tag: false,
		render: async ({ env, conversationId }, context) => {
			let runner = env?.id?.replace(/^runner:/, '')
			if (!runner) return undefined
			let cwd = env.cwd
			let found
			try {
				found = await read(runner, cwd, conversationId, context.abortSignal)
			} catch (error) {
				// Its agent moved off this runner while it was offline: the project where it runs now, so the turn
				// that goes on there keeps its instructions
				const to = error.moved && (await agentOf(conversationId))
				if (!to || to.runner === runner) throw error
				runner = to.runner
				cwd = folder((await known())[runner], to)
				found = await read(runner, cwd, conversationId, context.abortSignal)
			}
			const shown = `<cwd>\n${cwd}\n</cwd>`
			return found ? `${found}\n\n${shown}` : shown
		},
	}
	async function serve(threadId, query, body, by) {
		if (threadId !== undefined || body !== undefined)
			throw new Error('GET /api/context?runner=&dir= lists the skills in a folder')
		const name = query.get('runner')
		const runner = name && (await known())[name]
		if (!runner) throw new Error(`No runner named ${name}`)
		reach([{ runner: name }], by, await known())
		if (!runners.isOnline(name)) throw new Error(`${name} is offline`)
		const dir = path.resolve(runner.dir, query.get('dir') || '.')
		return { skills: await runners.call(name, { op: 'context', dir, skills: true }, {}) }
	}
	async function expand(text, runner, dir, signal) {
		if (!text.startsWith('/skill:')) return text
		return (await runners.call(runner, { op: 'context', dir, expand: text }, { signal })) ?? text
	}
	return {
		serve,
		expand,
		extension: defineExtension({ name: 'ade.context', sections: [section] }),
		/** AGENTS.md changes more than the other modules' sections, less than a bot's */
		volatility: 1,
	}
}

export function runner() {
	async function context({ dir, skills: list, expand }) {
		const loader = new DefaultResourceLoader({
			cwd: dir,
			agentDir: getAgentDir(),
			settingsManager: SettingsManager.create(dir),
			noExtensions: true,
			noPromptTemplates: true,
			noThemes: true,
		})
		await loader.reload()
		const all = loader.getSkills().skills
		if (list) return all.map(({ name, description }) => ({ name, description }))
		if (expand !== undefined) return skillCommand(expand, all)
		const files = loader
			.getAgentsFiles()
			.agentsFiles.map(
				({ path, content }) =>
					`<project_instructions path="${path}">\n${content}\n</project_instructions>`,
			)
		const shown = all.filter((skill) => !skill.disableModelInvocation)
		const skills = formatSkillsForPrompt(shown).trim()
		const parts = [
			files.length &&
				`<project_context>\nProject-specific instructions and guidelines:\n\n${files.join('\n\n')}\n</project_context>`,
			skills && `<skills>\n${skills}\n</skills>`,
		]
		return parts.filter(Boolean).join('\n\n') || null
	}
	return { call: context }
}

async function skillCommand(text, skills) {
	const space = text.indexOf(' ')
	const name = space === -1 ? text.slice(7) : text.slice(7, space)
	const args = space === -1 ? '' : text.slice(space + 1).trim()
	const skill = skills.find((skill) => skill.name === name)
	if (!skill) return null
	const body = stripFrontmatter(await readFile(skill.filePath, 'utf8')).trim()
	const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`
	return args ? `${block}\n\n${args}` : block
}
