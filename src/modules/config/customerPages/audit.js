async function audit(tx, scope, action, templateId, revision, designHash) {
  await tx.portalAudit.create({
    data: {
      company_id: scope.companyId,
      actor_id: scope.actorId,
      action,
      template_id: templateId,
      revision,
      design_hash: designHash || null,
    },
  });
}
module.exports = { audit };
