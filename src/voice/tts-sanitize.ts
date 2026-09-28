/**
 * Text clean-up between the LLM stream and TTS.
 *
 * stripLeadingAck: the relay speaks a filler ("Mhm.", "Okej.") before the LLM's answer, and
 * despite the prompt telling it not to, the model still opens ~2 in 12 replies with its own
 * acknowledgement - "Rozumiem. Rozumiem, może innym razem". When a filler was spoken, drop
 * those leading acknowledgements. Deliberately narrow: only standalone ack words followed by
 * punctuation, and never when "że"/"iż" follows ("Jasne, że tak" stays). "dobrze" and
 * "świetnie" are excluded - they too often start a real sentence.
 *
 * ttsClean: things TTS would read out badly - bracketed tags and emoji are dropped, a dash between numbers becomes
 * "do", any other dash a comma pause.
 */

// An ack followed by "że"/"iż" is part of a sentence ("Jasne, że tak", "Rozumiem, że…") - kept.
const LEADING_ACK = /^\s*(?:(?:m+h+m+|h+m+|o+k+e+j+|ok|jasne|rozumiem|dzień dobry)\s*[,.!…]+(?!\s*(?:że|iż)(?!\p{L}))\s*)+/iu;

export function stripLeadingAck(s: string): string {
  const out = s.replace(LEADING_ACK, "");
  if (out === s) return s;
  return out.charAt(0).toLocaleUpperCase("pl-PL") + out.slice(1);
}

/** Enough of the reply's head is buffered to decide on stripping (or the stream ended). */
export function headSettled(head: string): boolean {
  return head.length >= 24;
}

export function ttsClean(s: string): string {
  return s
    .replace(/\[[^\]\n]{0,30}\]/g, "") // bracketed stage directions/tags the model invents ("[KONIEC]")
    .replace(/\p{Extended_Pictographic}\uFE0F?/gu, "")
    .replace(/(\d)\s*[—–]\s*(\d)/g, "$1 do $2") // "9–17" is read "9 do 17", not "9, 17"
    .replace(/\s*[—–]\s*/g, ", ");
}
