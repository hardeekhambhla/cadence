// Shared presets: video types (Canva-style "what are you making?"), lengths, looks, energy.
export const PRESETS = [
  { id: 'reel', name: 'Instagram Reel', ratio: '9:16', note: 'Reels · TikTok · Shorts', length: '30' },
  { id: 'story', name: 'Story', ratio: '9:16', note: 'Instagram · WhatsApp status', length: '15' },
  { id: 'post', name: 'Instagram Post', ratio: '4:5', note: 'Feed · tallest allowed', length: '30' },
  { id: 'square', name: 'Square', ratio: '1:1', note: 'Anywhere', length: '30' },
  { id: 'landscape', name: 'YouTube', ratio: '16:9', note: 'Landscape · TV · desktop', length: '60' },
];
export const LENGTHS = [['15', '15s'], ['30', '30s'], ['45', '45s'], ['60', '1 min'], ['full', 'Full song'], ['fit', 'Fit my clips']];
export const LOOKS = [
  ['none', 'Original'], ['cinematic', 'Cinematic'], ['vibrant', 'Vibrant'], ['summer', 'Summer'], ['winter', 'Winter'],
  ['moody', 'Moody'], ['vintage', 'Vintage'], ['soft', 'Soft'], ['noir', 'Noir'],
];
export const ENERGY = [['chill', 'Chill', 0.25], ['balanced', 'Balanced', 0.5], ['hype', 'Hype', 0.82]];
export const STYLES = [['cut', 'Clean cuts'], ['pulse', 'Beat pulse'], ['flash', 'Flash']];
