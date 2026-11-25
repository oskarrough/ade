import { createHash } from 'node:crypto'
import { watch as watchFiles } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * What a reload of the page would get, as a short hash: the client's files as they are now, and the server's own code as
 * it started. A page compares it with the one it loaded with, so it knows when it is behind; a change to the client's
 * files names `server` on every socket.
 */
const hashOf = async (dir, recursive, pattern = /\.\w+$/) => {
	const names = (await readdir(dir, { recursive })).filter((name) => pattern.test(name)).sort()
	const hash = createHash('sha256')
	for (const name of names)
		hash.update(name).update(await readFile(path.join(dir, name)).catch(() => ''))
	return hash.digest('hex')
}
const clientDir = path.join(import.meta.dirname, 'apps/client')
const modulesDir = path.join(import.meta.dirname, 'modules')
/** The server's, runner's and CLI's code: the top folder's .js files and modules/ */
const serverCodeNow = async () =>
	createHash('sha256')
		.update(await hashOf(import.meta.dirname, false, /\.js$/))
		.update(await hashOf(modulesDir, true, /\.js$/))
		.digest('hex')

export async function watchVersion(changed) {
	const serverCode = await serverCodeNow()
	/** Whether the server's code changed since it started, so only a restart takes it up */
	const version = { client: '', stale: false }
	let rehashingServer
	const serverChanged = (_event, name) => {
		if (!String(name).endsWith('.js')) return
		clearTimeout(rehashingServer)
		rehashingServer = setTimeout(async () => {
			const now = (await serverCodeNow()) !== serverCode
			if (now === version.stale) return
			version.stale = now
			changed()
		}, 150)
	}
	watchFiles(import.meta.dirname, serverChanged).unref()
	watchFiles(modulesDir, { recursive: true }, serverChanged).unref()
	const clientVersion = async () =>
		createHash('sha256')
			.update(serverCode)
			.update(await hashOf(clientDir, true))
			.digest('hex')
			.slice(0, 12)
	version.client = await clientVersion()
	let rehashing
	/** Unref'd, so watching never keeps a stopping server alive */
	watchFiles(clientDir, { recursive: true }, () => {
		clearTimeout(rehashing)
		rehashing = setTimeout(async () => {
			const now = await clientVersion()
			if (now === version.client) return
			version.client = now
			changed()
		}, 150)
	}).unref()
	return version
}
