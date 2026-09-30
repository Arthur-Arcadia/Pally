import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const excuses = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'excuses.json'), 'utf8'));
export const EXCUSE_CATEGORIES = [
  { id: 'leave', label: 'Leave', emoji: '🚪', description: 'I wanna go' },
  { id: 'decline', label: 'Decline', emoji: '✋', description: 'Not this time' },
  { id: 'cancel', label: 'Cancel', emoji: '📅', description: "Can't make it" },
  { id: 'blame', label: 'Blame', emoji: '👉', description: 'Not my fault' },
  { id: 'delay', label: 'Delay', emoji: '⏰', description: 'Maybe later' },
  { id: 'surprise', label: 'Surprise Me', emoji: '🎲', description: "I'm feeling lucky" },
];
export function getRandomExcuse(category = 'surprise', previousText) {
  if (!EXCUSE_CATEGORIES.some(item => item.id === category)) throw new Error('Unknown excuse category.');
  const pool = excuses.filter(item => (category === 'surprise' || item.category === category) && item.text !== previousText);
  return pool[Math.floor(Math.random() * pool.length)];
}
