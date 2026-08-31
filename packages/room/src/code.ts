// A room code somebody can read aloud.
//
// Nineteen lines, and it was nineteen identical lines in five games — the only
// textual difference between two of the copies was the word "four" against the
// word "six", in a comment.

/**
 * Thirty-two unambiguous characters: no O or 0, no I or 1, so a code survives
 * being read off a screen down a phone. 256 % 32 === 0, so the byte-to-character
 * map below is free of bias.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/**
 * A fresh room code.
 *
 * Wanted in two places, which is why it is neither the worker's nor the room's:
 * a started room can never be replayed, so a rematch is a second room, and the
 * room itself has to name it. Clients each minting one would be as many rooms
 * as there are clients.
 */
export function makeCode(length = 4): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length]
  return out
}
