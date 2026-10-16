export const PAGE_ELEMENT_SELECTOR = 'a,button,input,textarea,select,[role="button"],[contenteditable="true"],[role="textbox"],tr,[role="row"]';

// This function is serialized by chrome.scripting.executeScript, so it must be self-contained.
export function collectPageState(selector) {
  const keyFor = (el) => {
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type') || '';
    const name = el.getAttribute('name') || '';
    const aria = el.getAttribute('aria-label') || '';
    const text = (el.innerText || el.getAttribute('placeholder') || '').trim().slice(0, 120);
    return [tag, type, name, aria, text].join('|').slice(0, 400);
  };

  const elements = [...document.querySelectorAll(selector)].slice(0, 300).map((el, index) => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const field = [el.getAttribute('name'), el.id, el.getAttribute('aria-label'),
      el.getAttribute('autocomplete')].filter(Boolean).join(' ');
    const editable = (el instanceof HTMLInputElement &&
      ['text', 'email', 'search', 'url', 'tel'].includes(type || 'text')) ||
      el instanceof HTMLTextAreaElement ||
      (el instanceof HTMLElement && el.isContentEditable);
    const visible = editable && el.getClientRects().length > 0 &&
      !el.closest('[aria-hidden="true"]') &&
      getComputedStyle(el).visibility !== 'hidden';
    const sensitive = /password|passcode|verification|one.?time|otp|secret|token|api.?key|credit.?card|card.?number|cc[-_]|cvv|cvc|security.?code|social.?security|ssn/i.test(field);
    const currentValue = editable && visible && !sensitive
      ? String(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
        ? el.value : el.innerText || '') : null;
    return {
      index,
      key: keyFor(el),
      tag,
      text: (el.innerText || el.getAttribute('aria-label') ||
        el.getAttribute('placeholder') || '').trim().slice(0, 200),
      type: type || null,
      disabled: 'disabled' in el ? Boolean(el.disabled) : false,
      ...(currentValue !== null ? {
        value: currentValue.slice(0, 500),
        valueTruncated: currentValue.length > 500,
      } : {}),
    };
  });

  return {
    title: document.title,
    url: location.href,
    text: document.body?.innerText?.slice(0, 40_000) || '',
    elements,
  };
}
