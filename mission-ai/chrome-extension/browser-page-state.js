export const PAGE_ELEMENT_SELECTOR =
  'a,button,input,textarea,select,[role="button"],[contenteditable="true"],[role="textbox"],tr,[role="row"]';

// This function is serialized by chrome.scripting.executeScript, so it must be self-contained.
export function collectPageState(selector) {
  const isVisible = (el) => {
    if (!el || el.closest('[hidden],[aria-hidden="true"]') || el.getClientRects().length === 0)
      return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  };
  const visibleText = (root, limit) => {
    const chunks = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let inspected = 0;
    let length = 0;
    while (walker.nextNode() && inspected++ < 10000 && length < limit) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (
        !parent ||
        parent.closest('script,style,noscript,template,[type="password"]') ||
        !isVisible(parent)
      )
        continue;
      const chunk = (node.nodeValue || '').replace(/\s+/g, ' ').trim();
      if (!chunk) continue;
      chunks.push(chunk.slice(0, limit - length));
      length += chunk.length + 1;
    }
    return chunks.join(' ').slice(0, limit);
  };
  const keyFor = (el, visible) => {
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type') || '';
    const name = visible ? el.getAttribute('name') || '' : '';
    const aria = visible ? el.getAttribute('aria-label') || '' : '';
    const text = visible
      ? (visibleText(el, 120) || el.getAttribute('placeholder') || '').trim().slice(0, 120)
      : '';
    return [tag, type, name, aria, text].join('|').slice(0, 400);
  };

  const elements = [...document.querySelectorAll(selector)].slice(0, 300).map((el, index) => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const field = [
      el.getAttribute('name'),
      el.id,
      el.getAttribute('aria-label'),
      el.getAttribute('autocomplete'),
    ]
      .filter(Boolean)
      .join(' ');
    const editable =
      (el instanceof HTMLInputElement &&
        ['text', 'email', 'search', 'url', 'tel'].includes(type || 'text')) ||
      el instanceof HTMLTextAreaElement ||
      (el instanceof HTMLElement && el.isContentEditable);
    const visible = isVisible(el);
    const sensitive =
      /password|passcode|verification|one.?time|otp|secret|token|api.?key|credit.?card|card.?number|cc[-_]|cvv|cvc|security.?code|social.?security|ssn/i.test(
        field,
      );
    const currentValue =
      editable && visible && !sensitive
        ? String(
            el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
              ? el.value
              : visibleText(el, 1000),
          )
        : null;
    return {
      index,
      key: keyFor(el, visible),
      tag,
      text: visible
        ? (
            visibleText(el, 200) ||
            el.getAttribute('aria-label') ||
            el.getAttribute('placeholder') ||
            ''
          )
            .trim()
            .slice(0, 200)
        : '',
      visible,
      type: type || null,
      disabled: 'disabled' in el ? Boolean(el.disabled) : false,
      ...(currentValue !== null
        ? {
            value: currentValue.slice(0, 500),
            valueTruncated: currentValue.length > 500,
          }
        : {}),
    };
  });

  return {
    title: document.title,
    url: location.href,
    text: document.body ? visibleText(document.body, 40_000) : '',
    elements,
  };
}
