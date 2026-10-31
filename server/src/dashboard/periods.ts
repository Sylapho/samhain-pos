export const timeZone = 'Europe/Paris'
const paris = new Intl.DateTimeFormat('en-CA', {
  timeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
export const parisDay = (at: string | Date) => paris.format(new Date(at))
const hourFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone,
  hour: '2-digit',
  hourCycle: 'h23',
})
export const parisHour = (at: string) => Number(hourFormatter.format(new Date(at)))
export function validDay(day: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    Number.isFinite(Date.parse(day)) &&
    new Date(day).toISOString().slice(0, 10) === day
  )
}
// UTC is used only for calendar arithmetic, never as the boundary of a Paris trading day.
export function shiftDay(day: string, amount: number): string {
  if (!validDay(day)) throw new Error('FILTER')
  const d = new Date(`${day}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + amount)
  return d.toISOString().slice(0, 10)
}
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1
}
export function festivalDays(start: string) {
  if (!validDay(start) || new Date(`${start}T12:00:00Z`).getUTCDay() !== 4)
    throw new Error('DASHBOARD_FESTIVAL_START_DATE doit être un jeudi au format YYYY-MM-DD.')
  return ['Jeudi', 'Vendredi', 'Samedi', 'Dimanche'].map((label, i) => ({
    label,
    date: shiftDay(start, i),
  }))
}
export function defaultPeriod(start: string, now = new Date()) {
  const days = festivalDays(start)
  const today = parisDay(now)
  return today >= start && today <= days[3]!.date
    ? { from: today, to: today }
    : { from: start, to: days[3]!.date }
}
