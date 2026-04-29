/**
 * One-time fixer for data/tournaments.json to match scraper normalization.
 *
 * Desired schema:
 * - title     = event name (e.g. "TBA Around the World")
 * - game_name = game name  (e.g. "Trek12")
 *
 * The scraper normalizes by swapping title/game_name for all tournaments
 * EXCEPT a small allowlist of IDs that are already "correct" without swapping.
 */
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '../data/tournaments.json');

const DONT_SWAP_TITLE_AND_GAME_FOR_IDS = new Set([
  '554868',
  '538858',
  '538885',
  '554870',
  '538888',
]);

function main() {
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (!data || typeof data !== 'object' || !Array.isArray(data.tournaments)) {
    throw new Error('Invalid data/tournaments.json');
  }

  let swapped = 0;
  for (const t of data.tournaments) {
    const id = String(t?.id ?? '');
    if (!id || DONT_SWAP_TITLE_AND_GAME_FOR_IDS.has(id)) continue;
    const a = t.title;
    const b = t.game_name;
    t.title = b ?? t.title;
    t.game_name = a ?? t.game_name;
    swapped++;
  }

  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  console.log(`Updated ${DATA_FILE}`);
  console.log(`Swapped title/game_name for ${swapped} tournaments`);
}

main();

