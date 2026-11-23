// @ts-nocheck: read by mygo, not by ade's checks, which have no Node types for .ts files
import { readFileSync } from 'node:fs'

/**
 * The version is the newest section of CHANGELOG.md, which is also the release notes the update window shows. A build
 * made anywhere but GitHub Actions says `-local` after it, in Settings, and counts as older than the release itself.
 */
const released = /^## (\d+\.\d+\.\d+\S*)/m.exec(
	readFileSync(new URL('./CHANGELOG.md', import.meta.url), 'utf8'),
)?.[1]
const version = process.env.GITHUB_ACTIONS ? released : `${released}-local`

export default {
	name: 'arbe desktop',
	slug: 'arbe-desktop',
	identifier: 'run.arbe.desktop',
	version,
	updates: {
		/** The secret half signs releases and stays out of the repo; see README.md */
		publicKey: '0IOUbgQBfrOBWn+70aFQIM2KcbLbWm/nZBzKTYg8vVg=',
		github: 'oskarrough/ade',
		tagPrefix: 'desktop-v',
	},
}
