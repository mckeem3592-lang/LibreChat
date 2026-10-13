const express = require('express');
const { logger } = require('@librechat/data-schemas');
const {
  createManagedResumeConfigGuard,
  projectManagedResumeParameters,
  createManagedProjectGuard,
  createMessageFilterPii,
  reportLocatorTraversalFailure,
  generateCheckAccess,
  skipAgentCheck,
  applyResumeContext,
  applyResumeModelParameters,
  GenerationJobManager,
  getSafeErrorMetadata,
} = require('@librechat/api');
const { PermissionTypes, Permissions, PermissionBits } = require('librechat-data-provider');
const {
  moderateText,
  // validateModel,
  validateConvoAccess,
  buildEndpointOption,
  canAccessAgentFromBody,
} = require('~/server/middleware');
const { initializeClient } = require('~/server/services/Endpoints/agents');
const guardSubagentThreadTurn = require('~/server/middleware/validate/subagentThreadTurn');
const AgentController = require('~/server/controllers/agents/request');
const ResumeController = require('~/server/controllers/agents/resume');
const addTitle = require('~/server/services/Endpoints/agents/title');
const { getFiles, getRoleByName, getChatProject } = require('~/models');

const router = express.Router();

const checkAgentAccess = generateCheckAccess({
  permissionType: PermissionTypes.AGENTS,
  permissions: [Permissions.USE],
  skipCheck: skipAgentCheck,
  getRoleByName,
});
const checkAgentResourceAccess = canAccessAgentFromBody({
  requiredPermission: PermissionBits.VIEW,
});

/**
 * Replay the paused turn's graph-determining config onto a resume request BEFORE the
 * rest of the chain (PII filter, agent-access, buildEndpointOption) reads it. The client
 * can't reliably re-send the ephemeral-agent config after a reload/cross-session, so the
 * server restores it from the pending action — the resume then rebuilds the SAME
 * agent/graph the run paused on (and a crafted resume can't swap the tool set). No-op for
 * every non-resume route.
 */
const restoreResumeContext = async (req, res, next) => {
  if (req.path !== '/resume') {
    return next();
  }
  try {
    const streamId = req.body?.conversationId;
    if (streamId) {
      const job = await GenerationJobManager.getJob(streamId);
      if (process.env.MISSION_AI_MANAGED_CHAT === 'true' &&
          (process.env.MISSION_AI_MANAGED_TOOLS === 'true' ||
           process.env.MISSION_AI_GITHUB_EDITOR === 'true') &&
          (!job || job.metadata?.userId !== req.user?.id ||
           (job.metadata?.tenantId != null && job.metadata.tenantId !== req.user?.tenantId))) {
        return res.status(403).json({ error: { code: 'managed_tools_denied' } });
      }
      const resumeContext = job?.metadata?.pendingAction?.resumeContext;
      if (process.env.MISSION_AI_MANAGED_CHAT === 'true' &&
          (process.env.MISSION_AI_MANAGED_TOOLS === 'true' ||
           process.env.MISSION_AI_GITHUB_EDITOR === 'true') && !resumeContext) {
        return res.status(403).json({ error: { code: 'managed_tools_denied' } });
      }
      applyResumeContext(req.body, resumeContext);
      // Replay the paused turn's resolved model parameters. Ephemeral agents derive these
      // (temperature, max tokens, custom endpoint params) from the request body, which the
      // resume payload omits — without this the continuation runs with defaults. They're
      // scattered top-level fields (folded into model_parameters by buildOptions' rest
      // spread), not part of the RESUME_CONTEXT_KEYS allowlist, so merge them back here.
      // Generation params are authoritative, but routing, graph identity, and resume-action
      // fields remain owned by the restored context/request envelope.
      const managed = process.env.MISSION_AI_MANAGED_CHAT === 'true' &&
        (process.env.MISSION_AI_MANAGED_TOOLS === 'true' ||
         process.env.MISSION_AI_GITHUB_EDITOR === 'true');
      applyResumeModelParameters(req.body, managed
        ? projectManagedResumeParameters(resumeContext?.model_parameters)
        : resumeContext?.model_parameters);
    }
  } catch (err) {
    logger.warn('[agents/chat] Failed to restore resume context', getSafeErrorMetadata(err));
    if (process.env.MISSION_AI_MANAGED_CHAT === 'true' &&
        (process.env.MISSION_AI_MANAGED_TOOLS === 'true' ||
         process.env.MISSION_AI_GITHUB_EDITOR === 'true')) {
      return res.status(403).json({ error: { code: 'managed_tools_denied' } });
    }
  }
  next();
};

router.use(restoreResumeContext);
router.use(createManagedResumeConfigGuard({
  enabled: process.env.MISSION_AI_MANAGED_CHAT === 'true',
  toolsEnabled: process.env.MISSION_AI_MANAGED_TOOLS === 'true',
  ownerEmail: process.env.MISSION_AI_CONTROL_OWNER_EMAIL,
  gatewayURL: process.env.MISSION_AI_GATEWAY_URL,
  nativeToken: process.env.MISSION_AI_NATIVE_TOKEN,
  toolToken: process.env.MISSION_AI_TOOL_TOKEN,
  titleConvo: process.env.TITLE_CONVO,
}));
router.use(createManagedProjectGuard({
  enabled: process.env.MISSION_AI_MANAGED_CHAT === 'true',
  toolsEnabled: process.env.MISSION_AI_MANAGED_TOOLS === 'true',
  ownerEmail: process.env.MISSION_AI_CONTROL_OWNER_EMAIL,
  projectOwned: async (userId, projectId) => (await getChatProject(userId, projectId)) != null,
}));
router.use(
  createMessageFilterPii({
    onTraversalFailure: reportLocatorTraversalFailure,
    getConfig: (req) => req.config?.messageFilter?.pii,
    getFilters: (req) => req.config?.filters,
    getFiles,
  }),
);
router.use(moderateText);
router.use(checkAgentAccess);
router.use(checkAgentResourceAccess);
router.use(validateConvoAccess);
router.use(guardSubagentThreadTurn);
router.use(buildEndpointOption);

const controller = async (req, res, next) => {
  await AgentController(req, res, next, initializeClient, addTitle);
};

const resumeController = async (req, res, next) => {
  await ResumeController(req, res, next, initializeClient, addTitle);
};

/**
 * @route POST /resume
 * @desc Resume a generation paused for human-in-the-loop review (tool approval or
 *       ask-user answer). Shares this router's middleware so the agent/endpoint are
 *       reconstructed from the request exactly like a normal turn. Declared before
 *       `/:endpoint` so it is not captured as an ephemeral endpoint name.
 * @access Private
 * @returns {void}
 */
router.post('/resume', resumeController);

/**
 * @route POST / (regular endpoint)
 * @desc Chat with an assistant
 * @access Public
 * @param {express.Request} req - The request object, containing the request data.
 * @param {express.Response} res - The response object, used to send back a response.
 * @returns {void}
 */
router.post('/', controller);

/**
 * @route POST /:endpoint (ephemeral agents)
 * @desc Chat with an assistant
 * @access Public
 * @param {express.Request} req - The request object, containing the request data.
 * @param {express.Response} res - The response object, used to send back a response.
 * @returns {void}
 */
router.post('/:endpoint', controller);

module.exports = router;
