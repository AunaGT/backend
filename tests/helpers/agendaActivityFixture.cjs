function activityInput(f, patch = {}) {
  const startsAt = f.individualInput?.startsAt || '2030-01-01T15:00:00.000Z'
  return {
    purpose: 'MEETING', title: 'Reunión QA', startsAt,
    endsAt: new Date(new Date(startsAt).getTime() + 3600000).toISOString(), timezone: 'America/Guatemala',
    organizerId: f.userId, userIds: [], providerIds: [], resourceIds: [], guests: [], productId: null,
    venue: { kind: 'BRANCH', name: '', address: '', references: '', url: '' }, estimatedAttendance: null,
    outboundMinutes: 0, setupMinutes: 0, teardownMinutes: 0, returnMinutes: 0, notes: '',
    idempotencyKey: require('node:crypto').randomUUID(), ...patch,
  }
}
module.exports = { activityInput }
