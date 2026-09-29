const express = require('express');
const { createProjectHandlers, createManagedToolOwnerGuard } = require('@librechat/api');
const requireJwtAuth = require('~/server/middleware/requireJwtAuth');
const db = require('~/models');

const router = express.Router();
const handlers = createProjectHandlers({
  listChatProjects: db.listChatProjects,
  createChatProject: db.createChatProject,
  getChatProject: db.getChatProject,
  updateChatProject: db.updateChatProject,
  deleteChatProject: db.deleteChatProject,
  assignConversationToProject: db.assignConversationToProject,
});

router.use(requireJwtAuth);
router.use(createManagedToolOwnerGuard({
  enabled: process.env.MISSION_AI_MANAGED_CHAT === 'true',
  toolsEnabled: process.env.MISSION_AI_MANAGED_TOOLS === 'true',
  ownerEmail: process.env.MISSION_AI_CONTROL_OWNER_EMAIL,
}));

router.get('/', handlers.listProjects);
router.post('/', handlers.createProject);
router.put('/conversations/:conversationId', handlers.assignConversationToProject);
router.get('/:projectId', handlers.getProject);
router.patch('/:projectId', handlers.updateProject);
router.delete('/:projectId', handlers.deleteProject);

module.exports = router;
