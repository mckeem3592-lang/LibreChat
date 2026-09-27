const aliases = Object.freeze({
  chat: 'primary',
  primary: 'primary',
  code: 'coding',
  coding: 'coding',
  deep_reasoning: 'reasoning',
  reasoning: 'reasoning',
  research: 'research',
  computer_use: 'computer',
  computer: 'computer',
  image: 'image',
  document: 'primary',
});

export function normalizeTask(value) {
  const key = String(value || 'chat').trim().toLowerCase();
  return aliases[key] || 'primary';
}
