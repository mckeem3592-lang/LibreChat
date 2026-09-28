const express = require('express');
const { createMissionControlProxy } = require('@librechat/api');
const { requireJwtAuth } = require('../middleware/');

const router = express.Router();
router.use(requireJwtAuth);
router.use(createMissionControlProxy({
  enabled: process.env.MISSION_AI_MANAGED_CHAT === 'true',
  ownerEmail: process.env.MISSION_AI_CONTROL_OWNER_EMAIL || '',
  chatOrigin: process.env.DOMAIN_CLIENT || '',
  gatewayURL: process.env.MISSION_AI_GATEWAY_URL || '',
  token: process.env.MISSION_AI_NATIVE_TOKEN || '',
  fetchImpl: fetch,
}));
module.exports = router;
