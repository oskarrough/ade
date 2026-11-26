/**
 * When a scheduled task runs, worked out the same on the server and in the form: `{at}` once, `{at, every}` every so
 * often from its first run, `{times, days?, timeZone}` at clock times on chosen weekdays, by that zone's wall clock.
 */

export const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

const formats = {}
/** The moment the day holding `ms` began on `timeZone`'s clock */
export function midnight(ms, timeZone) {
	const at = wall(ms, timeZone)
	return instant(at.year, at.month, at.day, 0, 0, timeZone)
}

/**
 * What a wall clock in `timeZone` reads at `ms`
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, second: number }}
 */
function wall(ms, timeZone) {
	formats[timeZone] ??= new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: 'numeric',
		day: 'numeric',
		hour: 'numeric',
		minute: 'numeric',
		second: 'numeric',
	})
	const parts = Object.fromEntries(
		formats[timeZone].formatToParts(ms).map((part) => [part.type, Number(part.value)]),
	)
	return /** @type {any} */ ({ ...parts, month: parts.month - 1 })
}

/**
 * The moment a wall clock in `timeZone` reads that date and time: the first of two when the clock falls back, and in a
 * spring-forward gap the moment as far past the gap as the time was into it (02:30 → 03:30)
 */
export function instant(year, month, day, hour, minute, timeZone) {
	const guess = Date.UTC(year, month, day, hour, minute)
	const offset = (ms) => {
		const at = wall(ms, timeZone)
		return Date.UTC(at.year, at.month, at.day, at.hour, at.minute, at.second) - ms + (ms % 1000)
	}
	// The offsets a day either side, the one before any change of the day first
	const [before, after] = [guess - offset(guess - 86_400_000), guess - offset(guess + 86_400_000)]
	const reads = (ms) => ms + offset(ms) === guess
	return reads(before) && reads(after) ? Math.min(before, after) : reads(after) ? after : before
}

/** `09:00` → [9, 0], or undefined if it isn't a clock time */
export function clockTime(text) {
	const match = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim())
	if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return undefined
	return [Number(match[1]), Number(match[2])]
}

/** A schedule's first run after `after`, or undefined when it has none by time */
export function nextRun(schedule, after) {
	if (schedule.times) {
		const now = wall(after, schedule.timeZone)
		const times = schedule.times.map(clockTime).filter(Boolean)
		for (let days = 0; days <= 8; days++) {
			const date = new Date(Date.UTC(now.year, now.month, now.day + days))
			if (schedule.days && !schedule.days.includes(date.getUTCDay())) continue
			const runs = times
				.map(([hour, minute]) =>
					instant(
						date.getUTCFullYear(),
						date.getUTCMonth(),
						date.getUTCDate(),
						hour,
						minute,
						schedule.timeZone,
					),
				)
				.filter((run) => run > after)
			if (runs.length) return Math.min(...runs)
		}
		return undefined
	}
	if (schedule.at === undefined) return undefined
	if (schedule.at > after || !schedule.every) return schedule.at > after ? schedule.at : undefined
	return schedule.at + (Math.floor((after - schedule.at) / schedule.every) + 1) * schedule.every
}

/** Its next `count` runs after `after` */
export function runsAfter(schedule, after, count) {
	const runs = []
	for (let run = nextRun(schedule, after); run !== undefined && runs.length < count;)
		run = nextRun(schedule, runs[runs.push(run) - 1])
	return runs
}

/** A clock schedule's last run before `before` */
export function lastRun(schedule, before) {
	let run = nextRun(schedule, before - 8 * 86_400_000)
	let last = run
	while (run !== undefined && run < before) [last, run] = [run, nextRun(schedule, run)]
	return last
}

const UNITS = /** @type {[number, string][]} */ ([
	[86_400_000, 'd'],
	[3_600_000, 'h'],
	[60_000, 'm'],
	[1000, 's'],
])
/** `5m`, `1h30m` from milliseconds */
export const span = (ms) => {
	let text = ''
	for (const [size, unit] of UNITS)
		if (ms >= size) [text, ms] = [`${text}${Math.floor(ms / size)}${unit}`, ms % size]
	return text
}
