// Fixed gameplay vocabulary; descriptions are about play, not personal identity.
export const WORD_GROUPS = [
  ['supportive', 'strategic', 'funny', 'creative', 'patient', 'adaptable', 'encouraging'],
  ['reckless', 'distracted', 'hesitant', 'energetic', 'supportive', 'strategic', 'lucky'],
  ['impatient', 'overconfident', 'chaotic', 'cautious', 'funny', 'creative', 'adventurous'],
];
export const WORDS = [...new Set(WORD_GROUPS.flat())];
export const wordLabel = word => word[0].toUpperCase() + word.slice(1);
const phrases = {
  supportive: 'supportive when a teammate needs a hand', strategic: 'strategic with every tiny advantage',
  funny: 'funny even when the mission goes sideways', creative: 'creative with unexpected obstacles',
  patient: 'patient through the longest loading screens', adaptable: 'adaptable when the plan changes',
  encouraging: 'encouraging after a spectacular team wipe', reckless: 'reckless around mysterious red buttons',
  distracted: 'distracted by every shiny side quest', hesitant: 'hesitant at the boss-room door',
  energetic: 'energetic enough to power the respawn screen', lucky: 'lucky when the dice escape gravity',
  impatient: 'impatient with doors that open too slowly', overconfident: 'overconfident before checking the health bar',
  chaotic: 'chaotic when the plan meets reality', cautious: 'cautious around suspicious treasure chests',
  adventurous: 'adventurous on every detour',
};
const titles = {
  supportive: 'The Team’s Emergency Lighthouse', strategic: 'The Pocket-Sized Grandmaster',
  funny: 'The Respawn Comedy Club', creative: 'The Improvised Strategy Department',
  patient: 'The Unshakeable Quest Captain', adaptable: 'The Walking Backup Plan',
  encouraging: 'The Portable Pep-Talk Machine', reckless: 'The Red-Button Expedition Leader',
  distracted: 'The Side Quest Magnet', hesitant: 'The Boss-Door Philosopher',
  energetic: 'The Human Loading Screen Skip', lucky: 'The Fortune Cookie Champion',
  impatient: 'The Fast-Forward Adventurer', overconfident: 'The One-HP Victory Announcer',
  chaotic: 'The Accidental Fireworks Director', cautious: 'The Seatbelt-equipped Explorer',
  adventurous: 'The Side Quest Navigator',
};

export function portraitText(input) {
  const words = WORDS.filter(word => input.includes(word));
  if (!words.length) return {
    title: 'The Unwritten Legend',
    sentence: 'No traits were submitted this time. This player’s next adventure is still a blank page.',
  };
  let title = titles[words[0]];
  if (words.includes('strategic') && words.includes('chaotic')) title = 'The Strategist with a Confetti Cannon';
  else if (words.includes('patient') && words.includes('impatient')) title = 'The Zen Master of Fast Forward';
  else if (words.includes('lucky') && words.includes('adventurous')) title = 'The Accidental Expedition Leader';
  const parts = words.map(word => phrases[word]);
  const joined = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  return { title, sentence: `In the team's eyes, this player is ${joined}. Together, these traits turn an ordinary mission into a story worth retelling.` };
}
