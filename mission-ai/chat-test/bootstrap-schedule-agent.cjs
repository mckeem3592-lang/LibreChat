// Provisions one read-only agent target for the owner's scheduled prompts.
// This runs only behind MISSION_AI_MANAGED_SCHEDULES=true in start.sh.
'use strict';

const path = require('node:path');
const { createRequire } = require('node:module');
const appRequire = createRequire(path.resolve(__dirname, '../../api/package.json'));

const AGENT_NAME = 'Mission AI Scheduled Tasks';
const AGENT_INSTRUCTIONS =
  "Complete the owner's scheduled prompt. Report what you actually did and any unmet requirement. Do not claim a tool action occurred unless its result confirms it.";

const SAFE_BOOTSTRAP_ERRORS = new Set([
  'invalid_schedule_bootstrap_settings',
  'wrong_database',
  'owner_identity_unavailable',
  'agent_viewer_role_unavailable',
  'schedule_agent_changed',
  'schedule_agent_acl_changed',
  'schedule_agent_acl_scope_changed',
]);
let bootstrapStage = 'settings';

function bootstrapFailureCode(error) {
  return SAFE_BOOTSTRAP_ERRORS.has(error?.message)
    ? error.message
    : 'schedule_agent_bootstrap_failed';
}

function expectedAgent(id, owner) {
  return {
    id,
    name: AGENT_NAME,
    description: 'Owner-only target for scheduled prompts',
    instructions: AGENT_INSTRUCTIONS,
    provider: 'MissionAIClaudeCached',
    model: 'claude-sonnet-5-5',
    author: owner._id,
    ...(owner.tenantId ? { tenantId: owner.tenantId } : {}),
    tools: [],
    skills_enabled: false,
    edges: [],
    agent_ids: [],
    actions: [],
    mcpServerNames: [],
  };
}

function isPinnedAgent(agent, expected) {
  return (
    agent.id === expected.id &&
    agent.author?.toString() === expected.author.toString() &&
    (agent.tenantId || '') === (expected.tenantId || '') &&
    agent.provider === expected.provider &&
    agent.model === expected.model &&
    agent.instructions === expected.instructions &&
    Array.isArray(agent.tools) &&
    agent.tools.length === 0 &&
    agent.skills_enabled === false &&
    (agent.skills?.length ?? 0) === 0 &&
    (agent.edges?.length ?? 0) === 0 &&
    (agent.agent_ids?.length ?? 0) === 0 &&
    (agent.actions?.length ?? 0) === 0 &&
    (agent.mcpServerNames?.length ?? 0) === 0 &&
    agent.subagents == null &&
    agent.tool_options == null &&
    (agent.tool_kwargs?.length ?? 0) === 0 &&
    agent.stateful_code_sessions !== true &&
    !agent.code_environment_id
  );
}

function newOwnerAcl(aclQuery, tenantId, roleId, ownerId, principalModel, viewPermission) {
  const { tenantId: _tenantQuery, ...identity } = aclQuery;
  return {
    ...identity,
    ...(tenantId ? { tenantId } : {}),
    principalModel,
    permBits: viewPermission,
    roleId,
    grantedBy: ownerId,
    grantedAt: new Date(),
  };
}

async function main() {
  if (process.env.MISSION_AI_MANAGED_SCHEDULES !== 'true') return;
  bootstrapStage = 'settings';
  const id = process.env.MISSION_AI_SCHEDULE_AGENT_ID || '';
  const email = (
    process.env.MISSION_AI_CONTROL_OWNER_EMAIL ||
    process.env.MISSION_AI_OWNER_EMAIL ||
    ''
  )
    .trim()
    .toLowerCase();
  if (!/^agent_[A-Za-z0-9_-]{1,200}$/.test(id) || !email || !process.env.MONGO_URI) {
    throw new Error('invalid_schedule_bootstrap_settings');
  }
  const mongoose = appRequire('mongoose');
  const { createModels, runAsSystem } = appRequire('@librechat/data-schemas');
  const { AccessRoleIds, PrincipalType, PrincipalModel, ResourceType, PermissionBits } =
    appRequire('librechat-data-provider');
  const { User, Agent, AccessRole, AclEntry } = createModels(mongoose);
  try {
    bootstrapStage = 'connect';
    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
      maxPoolSize: 2,
      autoCreate: false,
      autoIndex: false,
    });
    if (mongoose.connection.db.databaseName !== 'MissionAIChatTest') {
      throw new Error('wrong_database');
    }
    bootstrapStage = 'session';
    const session = await mongoose.startSession();
    try {
      bootstrapStage = 'transaction';
      const result = await runAsSystem(() =>
        session.withTransaction(
          async () => {
            bootstrapStage = 'marker';
            await mongoose.connection.db
              .collection('mission_ai_bootstrap')
              .findOneAndUpdate(
                { _id: 'schedule-agent-v1' },
                { $inc: { revision: 1 }, $setOnInsert: { version: 1 } },
                { upsert: true, session },
              );
            bootstrapStage = 'owner';
            const owners = await User.find({ email }).limit(2).session(session).lean();
            if (owners.length !== 1 || owners[0].emailVerified !== true) {
              throw new Error('owner_identity_unavailable');
            }
            const owner = owners[0];
            const tenantId = owner.tenantId || undefined;
            const tenantQuery = tenantId ? { tenantId } : { tenantId: { $exists: false } };
            bootstrapStage = 'viewer_role';
            const role = await AccessRole.findOne({
              accessRoleId: AccessRoleIds.AGENT_VIEWER,
              resourceType: ResourceType.AGENT,
              ...tenantQuery,
            })
              .session(session)
              .lean();
            if (!role || role.permBits !== PermissionBits.VIEW) {
              throw new Error('agent_viewer_role_unavailable');
            }
            const expected = expectedAgent(id, owner);
            bootstrapStage = 'agent_read';
            let agent = await Agent.findOne({ id }).session(session).lean();
            let status = 'verified';
            if (!agent) {
              bootstrapStage = 'agent_create';
              const [created] = await Agent.create(
                [
                  {
                    ...expected,
                    versions: [{ ...expected, createdAt: new Date(), updatedAt: new Date() }],
                  },
                ],
                { session },
              );
              agent = created.toObject();
              status = 'created';
            }
            bootstrapStage = 'agent_verify';
            if (!isPinnedAgent(agent, expected)) {
              throw new Error('schedule_agent_changed');
            }
            const aclQuery = {
              principalType: PrincipalType.USER,
              principalId: owner._id,
              resourceType: ResourceType.AGENT,
              resourceId: agent._id,
              ...tenantQuery,
            };
            bootstrapStage = 'acl_read';
            const existingAcl = await AclEntry.findOne(aclQuery).session(session).lean();
            if (
              existingAcl &&
              (existingAcl.permBits !== PermissionBits.VIEW ||
                existingAcl.roleId?.toString() !== role._id.toString() ||
                existingAcl.expiredAt)
            ) {
              throw new Error('schedule_agent_acl_changed');
            }
            if (!existingAcl) {
              bootstrapStage = 'acl_create';
              await AclEntry.create(
                [
                  newOwnerAcl(aclQuery, tenantId, role._id, owner._id,
                    PrincipalModel.USER, PermissionBits.VIEW),
                ],
                { session },
              );
            }
            bootstrapStage = 'acl_count';
            const aclCount = await AclEntry.countDocuments({
              resourceType: ResourceType.AGENT,
              resourceId: agent._id,
            }).session(session);
            if (aclCount !== 1) {
              throw new Error('schedule_agent_acl_scope_changed');
            }
            bootstrapStage = 'commit';
            return { status, agent: id };
          },
          {
            readPreference: 'primary',
            readConcern: { level: 'snapshot' },
            writeConcern: { w: 'majority' },
            maxCommitTimeMS: 5000,
          },
        ),
      );
      console.log(JSON.stringify(result));
    } finally {
      await session.endSession();
    }
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((error) => {
    // Keep credentials, emails, IDs, and database details out of deployment logs.
    console.error(JSON.stringify({ status: 'failed', code: bootstrapFailureCode(error),
      stage: bootstrapStage }));
    process.exitCode = 1;
  });
}

module.exports = { expectedAgent, isPinnedAgent, newOwnerAcl, bootstrapFailureCode, main };
