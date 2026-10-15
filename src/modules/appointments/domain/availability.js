const { DateTime } = require('luxon')
const { occupiesSeat } = require('./states')
const { localChoices } = require('./time')
const { fail } = require('./validation')
const MINUTE = 60000
const ABSENCES = ['VACACIONES', 'INCAPACIDAD', 'PERMISO', 'ASUETO', 'AUSENTE']
const ms = value => new Date(value).getTime()
const dateKey = value => typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10)
const overlaps = (a, b) => a.start < b.end && b.start < a.end
const assigned = (session, type) => (session[type] || []).map(row => row[type === 'providers' ? 'provider_id' : 'resource_id'])
function sessionOccupies(session, bookings, now) {
  if(session.record_type==='ACTIVITY') return ['SCHEDULED','IN_PROGRESS'].includes(session.status)
    || (session.status==='COMPLETED'&&ms(session.occupied_until)>ms(now))
  return ['SCHEDULED', 'IN_PROGRESS'].includes(session.status) && (session.mode === 'GROUP' || bookings.some(b => b.session_id === session.id && occupiesSeat(b, now)))
}
function merge(intervals) {
  const out = []
  for (const item of intervals.sort((a, b) => a.start - b.start)) {
    const last = out.at(-1)
    if (last && last.end >= item.start) last.end = Math.max(last.end, item.end)
    else out.push({ ...item })
  }
  return out
}
function localInterval(day, from, to, zone) {
  const at = minute => {
    const local = day.plus({ days: minute === 1440 ? 1 : 0 }).toISODate() + 'T' + `${String(Math.floor(minute % 1440 / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
    return localChoices(local, zone).map(value => value.toMillis())
  }
  const starts = at(from), ends = at(to)
  // A recurring interval covers both folds; a nonexistent boundary offers no time.
  return starts.length && ends.length ? { start: Math.min(...starts), end: Math.max(...ends) } : null
}
function calendarWindows(calendar, branch, from, to) {
  if (!calendar) return []
  const base = calendar.inherit_branch ? branch : calendar
  if (!base) return []
  let windows = []
  for (let day = DateTime.fromMillis(from, { zone: base.timezone }).startOf('day').minus({ days: 2 }); day.toMillis() < to + 172800000; day = day.plus({ days: 1 })) {
    const key = day.toISODate()
    if ((base.valid_from && key < dateKey(base.valid_from)) || (base.valid_until && key > dateKey(base.valid_until))) continue
    for (const rule of base.rules || []) if (rule.weekday === day.weekday) {
      const interval = localInterval(day, rule.from_minute, rule.to_minute, base.timezone)
      if (interval) windows.push(interval)
    }
  }
  windows = merge(windows)
  for (const source of calendar === base ? [base] : [base, calendar]) {
    if (source.valid_from || source.valid_until) {
      const lower = source.valid_from ? DateTime.fromISO(dateKey(source.valid_from), { zone: source.timezone }).startOf('day').toMillis() : -Infinity
      const upper = source.valid_until ? DateTime.fromISO(dateKey(source.valid_until), { zone: source.timezone }).plus({ days: 1 }).startOf('day').toMillis() : Infinity
      windows = windows.map(w => ({ start: Math.max(w.start, lower), end: Math.min(w.end, upper) })).filter(w => w.end > w.start)
    }
    for (const exception of source.exceptions || []) {
      const day = DateTime.fromISO(dateKey(exception.local_date), { zone: source.timezone })
      const block = localInterval(day, exception.from_minute ?? 0, exception.to_minute ?? 1440, source.timezone)
      if (!block) continue
      windows = windows.flatMap(w => !overlaps(w, block) ? [w] : [
        { start: w.start, end: Math.min(w.end, block.start) }, { start: Math.max(w.start, block.end), end: w.end },
      ].filter(w => w.end > w.start))
    }
  }
  return windows
}
function computeSlots({ profile, calendars, providers, resources, sessions, bookings, absenceDates, from, to, now,
  providerIds = [], resourceIds = [], scheduleGroup = false, productId, busyAssignments=[],venue={kind:'BRANCH'},outboundMinutes=0,returnMinutes=0,exactStart,timezone='America/Guatemala',branchId }) {
  if (!profile.enabled) return []
  const configuredBranch=calendars.find(c=>c.owner_type==='branch')
  const manual=require('./servicePolicy').isManualService(profile,{providerIds,resourceIds})
  if(!configuredBranch&&venue.kind==='BRANCH'&&!manual) return []
  const branch=configuredBranch||{timezone,branch_id:branchId}
  const lower = ms(from), upper = ms(to), clock = ms(now)
  const branchWindows = calendarWindows(branch, branch, lower, upper)
  const windows = new Map()
  for (const entity of [...providers, ...resources]) {
    const calendar = calendars.find(c => c.provider_id === entity.id || c.resource_id === entity.id)
    let available = calendarWindows(calendar, branch, lower, upper)
    if (entity.employee_id) for (const absence of absenceDates.filter(a => a.employee_id === entity.employee_id && ABSENCES.includes(a.status))) {
      const day = DateTime.fromISO(dateKey(absence.work_date), { zone: calendar?.timezone || branch.timezone })
      const block = { start: day.startOf('day').toMillis(), end: day.plus({ days: 1 }).startOf('day').toMillis() }
      available = available.flatMap(w => !overlaps(w, block) ? [w] : [
        { start: w.start, end: Math.min(w.end, block.start) }, { start: Math.max(w.start, block.end), end: w.end },
      ].filter(w => w.end > w.start))
    }
    windows.set(entity.id, available)
  }
  const busy = new Map()
  for(const block of busyAssignments) for(const id of [...block.providerIds,...block.resourceIds]) {
    if(!busy.has(id)) busy.set(id,[])
    busy.get(id).push(block)
  }
  for (const s of sessions) if (sessionOccupies(s, bookings, now)) for (const id of [...assigned(s, 'providers'), ...assigned(s, 'resources')]) {
    if (!busy.has(id)) busy.set(id, [])
    busy.get(id).push({ start: ms(s.occupied_from), end: ms(s.occupied_until), sessionId: s.id })
  }
  const contains = (list, interval) => list.some(w => w.start <= interval.start && w.end >= interval.end)
  const free = (id, interval, exclude) => contains(windows.get(id) || [], interval) && !(busy.get(id) || []).some(w => w.sessionId !== exclude && overlaps(w, interval))
  function pick(candidates, selected, required, interval, exclude) {
    if (selected.length) return selected.every(id => candidates.some(c => c.id === id) && free(id, interval, exclude)) ? selected : null
    if (!required) return []
    const first = [...candidates].sort((a, b) => a.id.localeCompare(b.id)).find(c => free(c.id, interval, exclude))
    return first ? [first.id] : null
  }
  function slot(start, end, occupied, session = null) {
    if (start < lower || start >= upper || start < clock + profile.leadMinutes * MINUTE || start > DateTime.fromMillis(clock, { zone: branch.timezone }).plus({ days: profile.horizonDays }).toMillis()) return null
    if (configuredBranch&&venue.kind==='BRANCH'&&!contains(branchWindows, occupied)) return null
    const ps = pick(providers, session ? assigned(session, 'providers') : providerIds, profile.requiresProvider, occupied, session?.id)
    const rs = pick(resources, session ? assigned(session, 'resources') : resourceIds, profile.requiresResource, occupied, session?.id)
    if (!ps || !rs) return null
    if (session && (providerIds.some(id => !ps.includes(id)) || resourceIds.some(id => !rs.includes(id)))) return null
    const capacity = Math.min(session?.capacity || profile.capacity, ...rs.map(id => resources.find(r => r.id === id)?.person_capacity ?? Infinity))
    const remaining = capacity - (session ? bookings.filter(b => b.session_id === session.id && occupiesSeat(b, now)).length : 0)
    if (remaining <= 0) return null
    return { startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(), timezone: branch.timezone,
      providerIds: ps, resourceIds: rs, sessionId: session?.id || null, remaining }
  }
  const out = []
  if (profile.mode === 'GROUP' && !scheduleGroup) {
    for (const s of sessions) if (s.record_type!=='ACTIVITY'&&s.mode === 'GROUP' && s.status === 'SCHEDULED' && s.branch_id === branch.branch_id && (!productId || s.product_id === productId)
      && (s.venue?.kind||'BRANCH')===venue.kind && (venue.kind==='BRANCH'||['address','url','name'].every(key=>(s.venue?.[key]||'')===(venue[key]||'')))) {
      const value = slot(ms(s.starts_at), ms(s.ends_at), { start: ms(s.occupied_from), end: ms(s.occupied_until) }, s)
      if (value) out.push(value)
    }
  } else if(exactStart){
    const start=ms(exactStart),end=start+profile.durationMinutes*MINUTE
    const value=slot(start,end,{start:start-(profile.beforeMinutes+outboundMinutes)*MINUTE,end:end+(profile.afterMinutes+returnMinutes)*MINUTE})
    if(value)out.push(value)
  } else if(!manual&&profile.schedulingStyle!=='WORK') {
    for (let day = DateTime.fromMillis(lower, { zone: branch.timezone }).startOf('day'); day.toMillis() < upper; day = day.plus({ days: 1 })) {
      for (let minute = 0; minute < 1440; minute += profile.intervalMinutes) {
        const local = day.toISODate() + 'T' + `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
        for (const instant of localChoices(local, branch.timezone)) {
          const start = instant.toMillis(), end = start + profile.durationMinutes * MINUTE
          const value = slot(start, end, { start: start - (profile.beforeMinutes+outboundMinutes) * MINUTE, end: end + (profile.afterMinutes+returnMinutes) * MINUTE })
          if (value) out.push(value)
        }
      }
    }
  }
  if (out.length > 2000) fail(400, 'RANGE_TOO_LARGE', 'Hay demasiados horarios; selecciona un período menor')
  return out.sort((a, b) => a.startsAt.localeCompare(b.startsAt))
}
module.exports = { computeSlots, sessionOccupies, calendarWindows, overlaps, ABSENCES, assigned }
