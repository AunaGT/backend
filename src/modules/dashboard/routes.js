/**
 * Copyright (c) 2026 Diego Patzán. All Rights Reserved.
 * 
 * This source code is licensed under a Proprietary License.
 * Unauthorized copying, modification, distribution, or use of this file,
 * via any medium, is strictly prohibited without express written permission.
 * 
 * For licensing inquiries: GitHub @dpatzan2
 */

const { Router } = require('express');
const { Auth, hasPermission } = require('../../middlewares/autenticacion');
const Dashboard = require('./controller');

const router = Router();

// GET /api/dashboard/stats - Obtener estadísticas del dashboard
router.get('/stats', Auth, hasPermission('analytics.view'), Dashboard.getStats);

module.exports = router;
