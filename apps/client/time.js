/** When things were said: a row's time on hover, and the quiet lines where a day changes or an hour passes */
import html from '@solidjs/html'
import { createSignal, Show } from 'solid-js'

/** One clock for every time on screen, a minute at a time */
const [minute, setMinute] = createSignal(Date.now())
setInterval(() => setMinute(Date.now()), 60_000)

const HOUR = 3_600_000
/** Midnight before `time`, local */
const dayOf = (time) => new Date(time).setHours(0, 0, 0, 0)
/** 14:32, whatever the locale's habit */
const clockOf = (time) =>
	new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

/** now, 4m, 2h today; before today, the clock time */
const ago = (time, now) => {
	const passed = Math.max(0, now - time)
	if (passed < 60_000) return 'now'
	if (passed < HOUR) return `${Math.floor(passed / 60_000)}m`
	if (dayOf(time) === dayOf(now)) return `${Math.floor(passed / HOUR)}h`
	return clockOf(time)
}

/** How far off a time ahead is: in 4m, in 2h today, else its weekday and clock time */
export const ahead = (time) => {
	const now = minute()
	const left = time - now
	if (left < 60_000) return 'in a moment'
	if (left < HOUR) return `in ${Math.round(left / 60_000)}m`
	if (dayOf(time) === dayOf(now)) return `in ${Math.round(left / HOUR)}h`
	return `${new Date(time).toLocaleDateString('en-GB', { weekday: 'short' })} at ${clockOf(time)}`
}

/** Today, Yesterday, or Tue 18 Nov, with the year when it isn't this one */
const dayLabel = (time, now) => {
	const days = Math.round((dayOf(now) - dayOf(time)) / (24 * HOUR))
	if (days === 0) return 'Today'
	if (days === 1) return 'Yesterday'
	const date = new Date(time)
	return date.toLocaleDateString('en-GB', {
		weekday: 'short',
		day: 'numeric',
		month: 'short',
		...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' }),
	})
}

/** Whether a message at `time` after one at `before` opens a new day, an hour later the same day, or neither */
export const breakOf = (before, time) =>
	before === undefined || time === undefined
		? undefined
		: dayOf(before) !== dayOf(time)
			? 'day'
			: time - before > HOUR
				? 'hour'
				: undefined

/** A row's time, shown under it while the pointer is on it; the full date and time on its own hover */
export const Stamp = (props) => html`
	<${Show} when=${() => props.time !== undefined}>
		<time
			class="stamp"
			datetime=${() => new Date(props.time).toISOString()}
			title=${() => new Date(props.time).toLocaleString()}
			>${() => ago(props.time, minute())}</time
		>
	<//>
`

/** Where a day changes, its name; where an hour passed the same day, the clock time */
export const Break = (props) => html`
	<li class="break mute" title=${() => new Date(props.time).toLocaleString()}>
		${() => (props.kind === 'day' ? dayLabel(props.time, minute()) : clockOf(props.time))}
	</li>
`
