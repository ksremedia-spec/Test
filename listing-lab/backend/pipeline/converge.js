/**
 * Listing Lab — is this job still getting anywhere?
 *
 * WHY THIS EXISTS
 * A rejected attempt is retried with the judge's own violations fed back to the
 * generator, and that works: on 26 Aug 2026 a bedroom failed its first attempt
 * (a leaning mirror removed, a nightstand invented, a lamp moved), was told so,
 * and came back clean on the second.
 *
 * But retrying only helps when the failure is variable. The same day, an empty
 * room offered a declutter it should never have been offered took the same
 * cabinet on every single attempt. Three generations, three identical
 * complaints, one refund. A fourth and a fifth would have been three and four
 * more.
 *
 * Kyle, who pays for those generations and whose customers want photographs
 * rather than credits, asked the right question: why not just keep trying? The
 * answer is that "keep trying" is only worth money while something is CHANGING.
 * So the ceiling went up — more chances on the winnable ones — and this decides
 * when to stop early, so none of that budget is spent proving the same point
 * twice.
 *
 * THE RULE
 * Two consecutive attempts that fail in exactly the same way are not bad luck.
 * Stop. Partial progress — three complaints down to one — is progress, and keeps
 * going.
 *
 * Comparing them is the fiddly part, because the judge writes prose and never
 * writes it twice the same way:
 *
 *   "The dark brown wooden cabinet against the blue wall near the wide opening
 *    was removed in the candidate image."
 *   "In Image 1, a dark brown wooden cabinet sits against the blue wall near the
 *    archway opening, but in Image 2, this cabinet has been removed."
 *
 * Those are one complaint. String equality says they are two. So each violation
 * is reduced to the content words that carry its meaning, and two are treated as
 * the same complaint when those sets substantially overlap.
 */

/**
 * Words that appear in nearly every violation and therefore distinguish none of
 * them. Dropping them is what stops "the ... in image 2 ... has been removed"
 * from making two unrelated complaints look alike.
 */
const NOISE = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'in', 'on', 'at', 'to', 'from', 'by',
  'is', 'are', 'was', 'were', 'be', 'been', 'has', 'have', 'had', 'this', 'that',
  'these', 'those', 'it', 'its', 'which', 'with', 'for', 'as', 'not', 'no',
  'image', 'images', 'candidate', 'original', 'photo', 'photograph', 'result',
  'before', 'after', 'edit', 'output', 'version', 'one', 'two', 'both',
  'appears', 'appear', 'seems', 'seem', 'visible', 'present', 'missing',
  'however', 'while', 'whereas', 'also', 'still', 'now', 'there',
]);

/**
 * The content words of one violation, as a set.
 *
 * Bracketed check names — "[keep_list_all_present]" — are kept and split, because
 * WHICH check fired is one of the most reliable signals of what went wrong, far
 * more stable than the sentence the model wrote around it.
 */
function signature(violation) {
  return new Set(
    String(violation || '')
      .toLowerCase()
      .replace(/[\[\]_]/g, ' ')       // check names become ordinary words
      .replace(/[^a-z0-9\s]/g, ' ')   // punctuation carries no meaning here
      .split(/\s+/)
      .filter(w => w.length > 2 && !NOISE.has(w))
  );
}

/** How alike two sets are: shared words over total distinct words. */
function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * 0.5 — half the distinctive words in common.
 *
 * Set from the pair of real violations quoted at the top of this file, which
 * share "dark brown wooden cabinet blue wall opening removed" across two quite
 * different sentences, against unrelated pairs from the same run ("a new white
 * light switch panel was added", "the black office chair at the bottom left edge
 * was removed") which share almost nothing. There is comfortable daylight
 * between the two cases; this sits in it.
 */
const SAME_COMPLAINT = 0.5;

/** Is this one complaint we have already seen in the list? */
function alreadySaid(violation, others) {
  const sig = signature(violation);
  return others.some(o => overlap(sig, signature(o)) >= SAME_COMPLAINT);
}

/**
 * Did this attempt fail in exactly the same way as the one before it?
 *
 * Both directions matter. Same complaints in a different order is the same
 * failure; the same complaints PLUS a new one is not — something changed, even
 * if it changed for the worse, and the generator is still responding to feedback.
 * A shorter list is progress and keeps going.
 */
function sameFailure(previous, current) {
  const prev = (previous || []).filter(Boolean);
  const curr = (current || []).filter(Boolean);
  if (!prev.length || !curr.length) return false;
  if (prev.length !== curr.length) return false;
  return curr.every(v => alreadySaid(v, prev)) && prev.every(v => alreadySaid(v, curr));
}

/**
 * A DIFFERENT kind of hopeless: not the whole failure repeating, but one
 * complaint that WILL NOT DIE. The set-equality rule above keeps going as long
 * as anything changes — so a frame can fail att1 [coffee table removed, doorway
 * altered], att2 [coffee table removed, exposure off], att3 [coffee table
 * removed, chair moved] and never trip it, because the set is different every
 * time. Meanwhile the coffee table has been erased on every attempt despite
 * being told each round to keep it. That is the systematic declutter failure,
 * and burning two more generations on it just refunds slower and costs more.
 *
 * So: if a single complaint has appeared, un-fixed, in each of the last
 * `threshold` attempts, the generator cannot fix it and we stop. Threshold 3
 * means three full attempts of feedback got nowhere — winnable frames are given
 * their chances first; only the truly stuck are cut short.
 */
function persistentComplaint(history, threshold = 3) {
  const recent = (history || []).slice(-threshold).filter(list => Array.isArray(list) && list.length);
  if (recent.length < threshold) return null;
  const newest = recent[recent.length - 1];
  for (const cand of newest) {
    const sig = signature(cand);
    if (recent.every(list => list.some(v => overlap(sig, signature(v)) >= SAME_COMPLAINT))) return cand;
  }
  return null;
}

module.exports = { sameFailure, signature, overlap, alreadySaid, SAME_COMPLAINT, persistentComplaint };
