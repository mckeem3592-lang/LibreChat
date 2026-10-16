import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { typeIntoPageElement } from './browser-type.js';

async function withPage(html, run) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, {
    url: 'https://mail.google.com/mail/u/0/#drafts',
  });
  const previous = Object.fromEntries(
    [
      'document',
      'location',
      'HTMLInputElement',
      'HTMLTextAreaElement',
      'HTMLElement',
      'Event',
      'getComputedStyle',
    ].map((key) => [key, globalThis[key]]),
  );
  try {
    for (const key of Object.keys(previous)) globalThis[key] = dom.window[key];
    dom.window.HTMLElement.prototype.getClientRects = function getClientRects() {
      return this.closest('[hidden],[aria-hidden="true"]') ? [] : [{}];
    };
    Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
      configurable: true,
      get() {
        return this.textContent;
      },
    });
    await run(dom.window);
  } finally {
    Object.assign(globalThis, previous);
    dom.window.close();
  }
}

test('typing into a visible subject reports retained DOM text', async () => {
  await withPage('<input aria-label="Subject" value="old">', async (window) => {
    const result = await typeIntoPageElement(
      0,
      'input|||Subject|',
      'new subject',
      window.location.href,
      'input',
    );
    assert.deepEqual(result, { typed: 0, length: 11, domRetained: true });
    assert.equal(window.document.querySelector('input').value, 'new subject');
  });
});

test('contenteditable uses native editing and rejects a field that reverts', async () => {
  await withPage(
    '<div contenteditable="true" aria-label="Message Body">old</div>',
    async (window) => {
      const el = window.document.querySelector('div');
      Object.defineProperty(el, 'isContentEditable', { value: true });
      let invoked = 0;
      window.document.execCommand = (command, _showUI, text) => {
        assert.equal(command, 'insertText');
        invoked += 1;
        el.textContent = text;
        return true;
      };
      const key = 'div|||Message Body|old';
      const result = await typeIntoPageElement(0, key, 'saved body', window.location.href, 'div');
      assert.equal(result.domRetained, true);
      assert.equal(invoked, 1);
      el.textContent = 'old';
      window.document.execCommand = (_command, _showUI, text) => {
        el.textContent = text;
        setTimeout(() => {
          el.textContent = 'old';
        }, 10);
        return true;
      };
      await assert.rejects(
        typeIntoPageElement(0, key, 'unsaved body', window.location.href, 'div'),
        /browser_text_not_retained/,
      );
    },
  );
});

test('hidden and credential fields are denied before typing', async () => {
  await withPage(
    '<input type="password" aria-label="Password"><input aria-label="Subject" hidden>',
    async (window) => {
      await assert.rejects(
        typeIntoPageElement(
          0,
          'input|password||Password|',
          'secret',
          window.location.href,
          'input',
        ),
        /field_type_denied/,
      );
      await assert.rejects(
        typeIntoPageElement(1, 'input|||Subject|', 'hidden', window.location.href, 'input'),
        /element_not_visible/,
      );
    },
  );
});
