// Serialized by chrome.scripting.executeScript. Keep this function self-contained.
export async function typeIntoPageElement(elementIndex, elementKey, text, expectedUrl, selector) {
  if (location.href !== expectedUrl) throw new Error('browser_snapshot_stale');
  const el = [...document.querySelectorAll(selector)].slice(0, 300)[elementIndex];
  if (
    !(
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      (el instanceof HTMLElement && el.isContentEditable)
    )
  ) {
    throw new Error('element_not_text_input');
  }
  const keyFor = (node) => {
    const tag = node.tagName.toLowerCase();
    const type = node.getAttribute('type') || '';
    const name = node.getAttribute('name') || '';
    const aria = node.getAttribute('aria-label') || '';
    const visible = (node.innerText || node.getAttribute('placeholder') || '').trim().slice(0, 120);
    return [tag, type, name, aria, visible].join('|').slice(0, 400);
  };
  if (keyFor(el) !== elementKey) throw new Error('browser_element_stale');
  const field = [
    el.getAttribute('name'),
    el.id,
    el.getAttribute('aria-label'),
    el.getAttribute('autocomplete'),
  ]
    .filter(Boolean)
    .join(' ');
  if (
    el.closest('[aria-hidden="true"]') ||
    el.getClientRects().length === 0 ||
    getComputedStyle(el).visibility === 'hidden' ||
    getComputedStyle(el).display === 'none'
  ) {
    throw new Error('element_not_visible');
  }
  if (
    el instanceof HTMLInputElement &&
    !['text', 'email', 'search', 'url', 'tel'].includes(el.type || 'text')
  ) {
    throw new Error('field_type_denied');
  }
  if (
    /password|passcode|verification|one.?time|otp|secret|token|api.?key|credit.?card|card.?number|cc[-_]|cvv|cvc|security.?code|social.?security|ssn/i.test(
      field,
    ) ||
    el.closest('[type="password"],[autocomplete*="password"]')
  ) {
    throw new Error('credential_field_denied');
  }
  if (el.disabled || el.readOnly) throw new Error('element_not_editable');

  el.focus();
  if (
    el.isContentEditable &&
    !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
  ) {
    const selection = document.getSelection();
    if (!selection) throw new Error('browser_native_typing_unavailable');
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    if (!document.execCommand('insertText', false, text)) {
      throw new Error('browser_native_typing_failed');
    }
  } else {
    const prototype =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (!setter) throw new Error('browser_native_typing_unavailable');
    setter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true, inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  await new Promise((resolve) => setTimeout(resolve, 350));
  const retained =
    el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
      ? el.value
      : el.innerText || el.textContent || '';
  if (!el.isConnected || retained !== text) throw new Error('browser_text_not_retained');
  return { typed: elementIndex, length: text.length, domRetained: true };
}
