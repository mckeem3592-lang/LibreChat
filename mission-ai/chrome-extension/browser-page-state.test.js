import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { collectPageState, PAGE_ELEMENT_SELECTOR } from './browser-page-state.js';
import { typeIntoPageElement } from './browser-type.js';

test('browser state reads visible draft fields and row without exposing credential values', async () => {
  const dom = new JSDOM(
    `<!doctype html><title>Drafts</title><body>
    <input name="subjectbox" aria-label="Subject" value="Probe subject">
    <textarea aria-label="Message Body">Probe body</textarea>
    <input type="password" value="password-secret">
    <input type="text" autocomplete="one-time-code" value="otp-secret">
    <input type="text" autocomplete="cc-number" value="card-secret">
    <input type="hidden" value="hidden-secret">
    <div aria-hidden="true"><input type="text" value="concealed-secret"></div>
    <div aria-hidden="true">Concealed private row</div>
    <button aria-label="Public action"><span aria-hidden="true">Hidden button text</span>Show</button>
    <div contenteditable="true" aria-label="Editor"><span aria-hidden="true">Hidden edit text</span>Visible edit text</div>
    <table><tr role="row"><td>Probe subject</td><td>Probe body</td></tr></table>
  </body>`,
    { url: 'https://mail.google.com/mail/u/0/#drafts' },
  );
  const previous = {
    document: globalThis.document,
    location: globalThis.location,
    HTMLInputElement: globalThis.HTMLInputElement,
    HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
    HTMLElement: globalThis.HTMLElement,
    getComputedStyle: globalThis.getComputedStyle,
    NodeFilter: globalThis.NodeFilter,
  };
  try {
    globalThis.document = dom.window.document;
    globalThis.location = dom.window.location;
    globalThis.HTMLInputElement = dom.window.HTMLInputElement;
    globalThis.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
    globalThis.HTMLElement = dom.window.HTMLElement;
    globalThis.getComputedStyle = dom.window.getComputedStyle;
    globalThis.NodeFilter = dom.window.NodeFilter;
    Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
      configurable: true,
      get() {
        return this.textContent;
      },
    });
    dom.window.HTMLElement.prototype.getClientRects = function getClientRects() {
      return this.closest('[aria-hidden="true"]') ? [] : [{}];
    };
    const page = collectPageState(PAGE_ELEMENT_SELECTOR);
    assert.equal(page.title, 'Drafts');
    assert.equal(page.url, 'https://mail.google.com/mail/u/0/#drafts');
    assert.equal(
      page.elements.find((item) => item.key.includes('subjectbox')).value,
      'Probe subject',
    );
    assert.equal(
      page.elements.find((item) => item.key.includes('Message Body')).value,
      'Probe body',
    );
    assert.ok(
      page.elements.some((item) => item.tag === 'tr' && item.text.includes('Probe subject')),
    );
    assert.equal(JSON.stringify(page.elements).includes('password-secret'), false);
    assert.equal(JSON.stringify(page.elements).includes('otp-secret'), false);
    assert.equal(JSON.stringify(page.elements).includes('card-secret'), false);
    assert.equal(JSON.stringify(page.elements).includes('hidden-secret'), false);
    assert.equal(JSON.stringify(page.elements).includes('concealed-secret'), false);
    assert.equal(JSON.stringify(page).includes('Concealed private row'), false);
    assert.equal(JSON.stringify(page).includes('Hidden button text'), false);
    assert.equal(JSON.stringify(page).includes('Hidden edit text'), false);
    assert.ok(page.text.includes('Show'));
    const editor = dom.window.document.querySelector('[contenteditable="true"]');
    Object.defineProperty(editor, 'isContentEditable', { value: true });
    dom.window.document.execCommand = (_command, _showUI, value) => {
      editor.textContent = value;
      return true;
    };
    const editorSnapshot = page.elements.find((item) => item.key.includes('Editor'));
    const typed = await typeIntoPageElement(
      editorSnapshot.index,
      editorSnapshot.key,
      'Edited',
      dom.window.location.href,
      PAGE_ELEMENT_SELECTOR,
    );
    assert.equal(typed.domRetained, true);
  } finally {
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});
