import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { collectPageState, PAGE_ELEMENT_SELECTOR } from './browser-page-state.js';

test('browser state reads visible draft fields and row without exposing credential values', () => {
  const dom = new JSDOM(`<!doctype html><title>Drafts</title><body>
    <input name="subjectbox" aria-label="Subject" value="Probe subject">
    <textarea aria-label="Message Body">Probe body</textarea>
    <input type="password" value="password-secret">
    <input type="text" autocomplete="one-time-code" value="otp-secret">
    <input type="text" autocomplete="cc-number" value="card-secret">
    <input type="hidden" value="hidden-secret">
    <div aria-hidden="true"><input type="text" value="concealed-secret"></div>
    <table><tr role="row"><td>Probe subject</td><td>Probe body</td></tr></table>
  </body>`, { url: 'https://mail.google.com/mail/u/0/#drafts' });
  const previous = {
    document: globalThis.document,
    location: globalThis.location,
    HTMLInputElement: globalThis.HTMLInputElement,
    HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
    HTMLElement: globalThis.HTMLElement,
    getComputedStyle: globalThis.getComputedStyle,
  };
  try {
    globalThis.document = dom.window.document;
    globalThis.location = dom.window.location;
    globalThis.HTMLInputElement = dom.window.HTMLInputElement;
    globalThis.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
    globalThis.HTMLElement = dom.window.HTMLElement;
    globalThis.getComputedStyle = dom.window.getComputedStyle;
    Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
      configurable: true,
      get() { return this.textContent; },
    });
    dom.window.HTMLElement.prototype.getClientRects = function getClientRects() {
      return this.closest('[aria-hidden="true"]') ? [] : [{}];
    };
    const page = collectPageState(PAGE_ELEMENT_SELECTOR);
    assert.equal(page.title, 'Drafts');
    assert.equal(page.url, 'https://mail.google.com/mail/u/0/#drafts');
    assert.equal(page.elements.find((item) => item.key.includes('subjectbox')).value, 'Probe subject');
    assert.equal(page.elements.find((item) => item.key.includes('Message Body')).value, 'Probe body');
    assert.ok(page.elements.some((item) => item.tag === 'tr' && item.text.includes('Probe subject')));
    assert.equal(JSON.stringify(page.elements).includes('password-secret'), false);
    assert.equal(JSON.stringify(page.elements).includes('otp-secret'), false);
    assert.equal(JSON.stringify(page.elements).includes('card-secret'), false);
    assert.equal(JSON.stringify(page.elements).includes('hidden-secret'), false);
    assert.equal(JSON.stringify(page.elements).includes('concealed-secret'), false);
  } finally {
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});
