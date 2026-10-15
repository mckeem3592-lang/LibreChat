import assert from 'node:assert/strict';
import test from 'node:test';
import { getEditedDocumentFilename, getEditedDocumentLink } from './editedDocumentLink.ts';

const origin = 'https://chat.example.test';
const id = '8e0282e0-5fb9-4cac-9917-ad44b89123e0';

test('recognizes only the owner-scoped edited-document route on the API origin', () => {
  const path = `/api/files/edited/${id}`;
  assert.deepEqual(getEditedDocumentLink(`${origin}${path}`, '/', origin), {
    url: `${origin}${path}`,
    fileId: id,
  });
  assert.deepEqual(getEditedDocumentLink(`/chat${path}`, '/chat/', origin), {
    url: `${origin}/chat${path}`,
    fileId: id,
  });
  for (const href of [
    `https://attacker.example${path}`,
    `${origin}${path}?redirect=1`,
    `${origin}${path}#fragment`,
    `${origin}/api/files/edited/not-a-uuid`,
    `${origin}/api/files/edited/${id}/extra`,
  ]) {
    assert.equal(getEditedDocumentLink(href, '/', origin), null, href);
  }
});

test('uses the server filename when it is a supported document', () => {
  assert.equal(
    getEditedDocumentFilename('attachment; filename="revised plan.docx"', 'application/pdf', id),
    'revised plan.docx',
  );
  assert.equal(
    getEditedDocumentFilename("attachment; filename*=UTF-8''final%20data.xlsx", undefined, id),
    'final data.xlsx',
  );
});

test('falls back to a safe document filename', () => {
  assert.equal(
    getEditedDocumentFilename('attachment; filename="../../malware.exe"', 'application/pdf', id),
    `edited-${id}.pdf`,
  );
  assert.equal(
    getEditedDocumentFilename(undefined, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', id),
    `edited-${id}.xlsx`,
  );
});
