import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'

/**
 * A message as a page gets it: each image by its address and size instead of its bytes, so the browser fetches it
 * when it scrolls into view, keeps it cached, and holds its place before it loads
 */
export function addressed(id, entry) {
	if (!entry.data.images) return entry
	const images = entry.data.images.map(({ mimeType, data }, at) => ({
		type: 'image',
		mimeType,
		url: `/api/threads/${id}/images/${entry.id}-${at}`,
		...sizeOf(`${id}/${entry.id}/${at}`, data),
	}))
	return { ...entry, data: { ...entry.data, images } }
}
/** Each image's width and height as a page shows it, read once from its first bytes */
const imageSizes = new Map()
function sizeOf(key, data) {
	if (!imageSizes.has(key)) {
		// 64 KB holds the header of nearly every image; a JPEG with a large preview before its frame needs it whole
		const size =
			imageSize(Buffer.from(data.slice(0, 1 << 16), 'base64')) ??
			(data.length > 1 << 16 ? imageSize(Buffer.from(data, 'base64')) : undefined) ??
			{}
		imageSizes.set(key, size)
	}
	return imageSizes.get(key)
}
/** A PNG, GIF, WebP, BMP or JPEG's width and height, turned as its EXIF orientation turns it; undefined if unreadable */
function imageSize(bytes) {
	const sized = (width, height) => (width > 0 && height > 0 ? { width, height } : undefined)
	const ascii = (at, text) => bytes.toString('latin1', at, at + text.length) === text
	if (bytes.length < 30) return undefined
	if (ascii(1, 'PNG')) return sized(bytes.readUInt32BE(16), bytes.readUInt32BE(20))
	if (ascii(0, 'GIF')) return sized(bytes.readUInt16LE(6), bytes.readUInt16LE(8))
	if (ascii(0, 'BM')) return sized(bytes.readInt32LE(18), Math.abs(bytes.readInt32LE(22)))
	if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) {
		if (ascii(12, 'VP8 '))
			return sized(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff)
		if (ascii(12, 'VP8L')) {
			const bits = bytes.readUInt32LE(21)
			return sized((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
		}
		if (ascii(12, 'VP8X')) return sized(bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1)
		return undefined
	}
	if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined
	let turned = false
	for (let at = 2; at + 9 < bytes.length;) {
		if (bytes[at] !== 0xff) return undefined
		const marker = bytes[at + 1]
		if (marker === 0xff) {
			at++
			continue
		}
		const length = bytes.readUInt16BE(at + 2)
		// APP1's EXIF orientation 5 to 8 turns the picture a quarter, so the page shows it the other way round
		if (marker === 0xe1 && ascii(at + 4, 'Exif\0'))
			turned = [5, 6, 7, 8].includes(orientation(bytes.subarray(at + 10, at + 2 + length)))
		if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
			const [height, width] = [bytes.readUInt16BE(at + 5), bytes.readUInt16BE(at + 7)]
			return turned ? sized(height, width) : sized(width, height)
		}
		at += 2 + length
	}
	return undefined
}
/** A TIFF block's orientation tag, 1 when it has none */
function orientation(tiff) {
	if (tiff.length < 8) return 1
	const little = tiff[0] === 0x49
	const u16 = (at) => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at))
	const directory = little ? tiff.readUInt32LE(4) : tiff.readUInt32BE(4)
	if (directory + 2 > tiff.length) return 1
	for (let entry = directory + 2, n = u16(directory); n-- && entry + 12 <= tiff.length; entry += 12)
		if (u16(entry) === 0x0112) return u16(entry + 8)
	return 1
}
/** Types a page may take as an image; any other is sent as bytes to download, never run */
const SHOWN_AS = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'])
/** One image of one message, its bytes, at the address `addressed` gives; a message never changes, so it caches for good */
export async function serveImage(handle, url, res) {
	const [, entryId, at] = /\/images\/(\d+)-(\d+)$/.exec(url.pathname) ?? []
	const entry = entryId
		? (
				await handle.entries(
					{
						order: 'ascending',
						minEntryId: /** @type {any} */ (Number(entryId)),
						maxEntryId: /** @type {any} */ (Number(entryId)),
					},
					1,
					undefined,
					context,
				)
			).items[0]
		: undefined
	const image =
		entry?.kind === 'ade.message' && /** @type {any} */ (entry.data).images?.[Number(at)]
	if (!image) throw Object.assign(new Error('No such image'), { status: 404 })
	const bytes = Buffer.from(image.data, 'base64')
	res.writeHead(200, {
		'Content-Type': SHOWN_AS.has(image.mimeType) ? image.mimeType : 'application/octet-stream',
		'Content-Length': bytes.length,
		'Cache-Control': 'private, max-age=31536000, immutable',
		'X-Content-Type-Options': 'nosniff',
		'Content-Security-Policy': 'sandbox',
	})
	res.end(bytes)
}
