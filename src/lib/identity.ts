const NAME_KEY = 'sw-username';
const MAX_NAME_LENGTH = 24;

const ADJECTIVES = [
  'Swift', 'Quiet', 'Brave', 'Lucky', 'Calm', 'Wild', 'Bright', 'Noble',
  'Cosmic', 'Hidden', 'Sunny', 'Frost', 'Amber', 'Silver', 'Rapid', 'Bold',
];

const ANIMALS = [
  'Fox', 'Owl', 'Wolf', 'Bear', 'Hawk', 'Otter', 'Lynx', 'Panda',
  'Tiger', 'Koala', 'Raven', 'Seal', 'Moose', 'Heron', 'Cobra', 'Drake',
];

export function randomUsername(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  const n = Math.floor(10 + Math.random() * 90);
  return `${adj}${animal}${n}`;
}

export function sanitizeUsername(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
}

export function getStoredUsername(): string {
  const stored = sanitizeUsername(localStorage.getItem(NAME_KEY) || '');
  if (stored.length >= 2) return stored;
  const generated = randomUsername();
  localStorage.setItem(NAME_KEY, generated);
  return generated;
}

export function saveUsername(value: string): string {
  const next = sanitizeUsername(value);
  if (next.length < 2) return getStoredUsername();
  localStorage.setItem(NAME_KEY, next);
  return next;
}

export const USERNAME_MAX = MAX_NAME_LENGTH;
