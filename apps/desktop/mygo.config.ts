// @ts-nocheck: read by mygo, not by ade's checks, which have no Node types for .ts files
import { readFileSync } from 'node:fs'

/** The version is the newest section of CHANGELOG.md, which is also the release notes the update window shows. */
const version = /^## (\d+\.\d+\.\d+\S*)/m.exec(
	readFileSync(new URL('./CHANGELOG.md', import.meta.url), 'utf8'),
)?.[1]

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
