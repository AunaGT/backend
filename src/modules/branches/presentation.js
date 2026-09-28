exports.branchState = (branch) => !branch.active ? 'inactive' : branch.operational_status === 'MAINTENANCE' ? 'maintenance' : 'operating'
