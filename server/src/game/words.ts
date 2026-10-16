import { randomInt } from 'node:crypto';

/** Common, concrete, easy-to-draw words. Lowercase ASCII; spaces allowed. */
export const WORDS: readonly string[] = [
  // animals
  'cat', 'dog', 'fish', 'bird', 'horse', 'cow', 'pig', 'sheep', 'duck', 'frog',
  'snake', 'turtle', 'rabbit', 'mouse', 'lion', 'tiger', 'elephant', 'giraffe', 'monkey', 'bear',
  'penguin', 'owl', 'spider', 'butterfly', 'bee', 'snail', 'octopus', 'shark', 'whale', 'crab',
  // food
  'apple', 'banana', 'pizza', 'cake', 'ice cream', 'bread', 'cheese', 'egg', 'carrot', 'grapes',
  'cherry', 'lemon', 'pear', 'watermelon', 'cookie', 'donut', 'burger', 'hot dog', 'popcorn', 'candy',
  // home & objects
  'house', 'door', 'window', 'chair', 'table', 'bed', 'lamp', 'clock', 'key', 'cup',
  'spoon', 'fork', 'knife', 'book', 'pencil', 'scissors', 'umbrella', 'glasses', 'hat', 'shoe',
  'sock', 'shirt', 'bottle', 'candle', 'balloon', 'gift', 'camera', 'phone', 'television', 'ladder',
  'hammer', 'toothbrush', 'bucket', 'kite', 'ball', 'drum', 'guitar', 'piano', 'bell', 'crown',
  // nature & places
  'sun', 'moon', 'star', 'cloud', 'rain', 'rainbow', 'snowman', 'tree', 'flower', 'leaf',
  'mountain', 'volcano', 'island', 'beach', 'river', 'fire', 'lightning', 'cactus', 'mushroom', 'bridge',
  'castle', 'tent', 'igloo', 'lighthouse', 'pyramid',
  // transport
  'car', 'bus', 'train', 'boat', 'ship', 'airplane', 'rocket', 'bicycle', 'truck', 'helicopter',
  'tractor', 'skateboard',
  // people & body
  'eye', 'nose', 'ear', 'hand', 'foot', 'tooth', 'smile', 'ghost', 'robot', 'pirate',
  'king', 'angel', 'alien', 'dragon', 'mermaid',
  // misc
  'heart', 'anchor', 'sword', 'shield', 'map', 'flag', 'trophy', 'magnet', 'diamond', 'treasure',
];

/** Picks `count` distinct words, avoiding `exclude` while enough alternatives remain. */
export function pickWords(count: number, exclude: ReadonlySet<string>, list: readonly string[] = WORDS): string[] {
  let pool = list.filter((w) => !exclude.has(w));
  if (pool.length < count) pool = [...list];
  const picked: string[] = [];
  while (picked.length < count && pool.length > 0) {
    picked.push(pool.splice(randomInt(pool.length), 1)[0]!);
  }
  return picked;
}
