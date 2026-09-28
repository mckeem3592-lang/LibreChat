// Private deployment wiring. The launcher supplies secrets and removes them before app startup.
'use strict';
const path = require('node:path');
const { createRequire } = require('node:module');
const appRequire = createRequire(path.resolve(__dirname, '../../api/package.json'));

async function main() {
  const mongoose = appRequire('mongoose');
  try {
    const bcrypt = appRequire('bcryptjs');
    const { bootstrapMissionAiOwner } = appRequire('@librechat/api');
    const { createModels } = appRequire('@librechat/data-schemas');
    const { User } = createModels(mongoose);
    const result = await bootstrapMissionAiOwner({
      env: process.env,
      hashPassword: (password) => bcrypt.hash(password, 10),
      comparePassword: (password, hash) => bcrypt.compare(password, hash),
      randomId: () => new mongoose.Types.ObjectId().toHexString(),
      now: () => new Date(),
      transaction: async (work) => {
        // Called only after the core validates the explicit flag, URI and private credentials.
        await mongoose.connect(process.env.MONGO_URI, {
          serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000,
          maxPoolSize: 2, autoCreate: false, autoIndex: false,
        });
        if (mongoose.connection.db.databaseName !== 'MissionAIChatTest') throw new Error('wrong_database');
        const control = mongoose.connection.db.collection('mission_ai_bootstrap');
        const session = await mongoose.startSession();
        try {
          return await session.withTransaction(() => work({
            lockSingleton: () => control.findOneAndUpdate({ _id: 'owner-v1' }, {
              $inc: { revision: 1 }, $setOnInsert: { version: 1 },
            }, { session, upsert: true, returnDocument: 'after' }),
            countUsers: () => User.collection.countDocuments({}, { session }),
            findOwner: async (id) => {
              const owner = await User.collection.findOne({ _id: new mongoose.Types.ObjectId(id) }, {
                session, projection: { email: 1, password: 1, provider: 1, role: 1,
                  emailVerified: 1, expiresAt: 1, tenantId: 1 },
              });
              return owner ? { ...owner, id: owner._id.toString() } : null;
            },
            createOwner: async ({ id, ...owner }) => {
              // Existing schema supplies safe defaults; password is already a bcrypt hash.
              await new User({ _id: new mongoose.Types.ObjectId(id), ...owner }).save({ session });
            },
            finishClaim: async (claim) => {
              await control.updateOne({ _id: 'owner-v1' }, { $set: claim }, { session });
            },
          }), { readPreference: 'primary', readConcern: { level: 'snapshot' },
            writeConcern: { w: 'majority' }, maxCommitTimeMS: 5000 });
        } finally { await session.endSession(); }
      },
    });
    console.log(JSON.stringify(result));
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

main().catch(() => {
  // Never print driver errors, validation inputs, user documents, URIs, or secrets.
  console.error(JSON.stringify({ status: 'failed', code: 'owner_bootstrap_failed' }));
  process.exitCode = 1;
});
