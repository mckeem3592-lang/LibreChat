import { createProjectHandlers } from './handlers';
const id = '0123456789abcdef01234567';
function fixture() {
  const methods = {
    listChatProjects: jest.fn().mockResolvedValue({ projects: [] }),
    createChatProject: jest.fn().mockResolvedValue({ id, name: 'Project' }),
    getChatProject: jest.fn().mockResolvedValue(null),
    updateChatProject: jest.fn().mockResolvedValue(null),
    deleteChatProject: jest.fn().mockResolvedValue({ deletedCount: 0 }),
    assignConversationToProject: jest.fn().mockResolvedValue(null),
  };
  const handlers = createProjectHandlers(methods);
  const request = { user: { id: 'owner-id' }, params: { projectId: id, conversationId: 'convo-id' },
    body: { name: 'Project', description: 'Context', projectId: id }, query: {} };
  const response = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  return { methods, handlers, request, response };
}
test('project reads and mutations consistently pass the authenticated owner to the repository', async () => {
  const f = fixture();
  for (const action of ['getProject', 'updateProject', 'deleteProject'] as const) {
    await f.handlers[action](f.request as never, f.response as never);
    const method = { getProject: f.methods.getChatProject, updateProject: f.methods.updateChatProject,
      deleteProject: f.methods.deleteChatProject }[action];
    expect(method.mock.calls[0].slice(0, 2)).toEqual(['owner-id', id]);
    expect(f.response.status).toHaveBeenLastCalledWith(404);
  }
  await f.handlers.assignConversationToProject(f.request as never, f.response as never);
  expect(f.methods.assignConversationToProject).toHaveBeenCalledWith('owner-id', 'convo-id', id);
});
test('invalid project IDs are rejected before repository access', async () => {
  const f = fixture(); f.request.params.projectId = '../other';
  await f.handlers.getProject(f.request as never, f.response as never);
  expect(f.response.status).toHaveBeenCalledWith(404); expect(f.methods.getChatProject).not.toHaveBeenCalled();
});
test('creating a project uses the signed-in owner rather than any submitted identity', async () => {
  const f = fixture();
  await f.handlers.createProject({ ...f.request, body: { name: ' Project ', description: 'Context', user: 'other' } } as never, f.response as never);
  expect(f.methods.createChatProject).toHaveBeenCalledWith('owner-id', { name: 'Project', description: 'Context' });
  expect(f.response.status).toHaveBeenCalledWith(201);
});
