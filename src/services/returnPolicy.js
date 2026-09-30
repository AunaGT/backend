const { prisma } = require('../models/prisma')
const { normalizeReturnPolicy } = require('../modules/returns/domain')

async function getReturnPolicy(client, companyId) {
  const db = client || prisma
  const row = await db.systemSetting.findUnique({
    where: { company_id_key: { company_id: companyId, key: 'returns.policy' } },
    select: { value: true },
  })
  return normalizeReturnPolicy(row?.value)
}

module.exports = { getReturnPolicy }
