/* red-flags.js — code-level safety gate for the AI coach (pure, no IO).

   Scans an athlete's free-text intake for ACUTE / serious signals that should
   SHORT-CIRCUIT plan generation into a "see a professional" response — and it
   fires regardless of what the model says (ai-coach-design.md §6.2). It is
   deliberately CONSERVATIVE: only genuinely serious signals, so a routine niggle
   ("tight hamstring, a bit sore") still flows through the normal
   None → Monitor → Modify → Stop gate without a false stop.

   It normalises curly quotes, matches on word boundaries, and suppresses a match
   that is negated in the few words before it ("no chest pain", "denies numbness")
   so a clean bill of health doesn't trip a false stop.

   This is a v1 keyword classifier intended for review by a qualified
   professional (physio) — see ai-coach-design.md §6 + §12. It gives training
   guidance support only; it is NOT medical advice and does not diagnose. */

const CATEGORIES = [
  { key: 'acute_pain', label: 'acute or severe pain',
    terms: ['sharp pain', 'severe pain', 'sudden pain', 'stabbing pain', 'excruciating', "can't walk", 'cannot walk', "can't bear weight", 'cannot bear weight', 'heard a pop', 'felt a pop', 'heard a snap', 'felt a snap'] },
  { key: 'suspected_tear', label: 'a suspected tear or rupture',
    terms: ['torn', 'tore my', 'rupture', 'ruptured', 'grade 2 tear', 'grade 3 tear', 'grade ii tear', 'grade iii tear', 'complete tear', 'full thickness', 'popped', 'felt it go', 'felt something go', 'felt a pull'] },
  { key: 'neuro', label: 'possible nerve symptoms',
    terms: ['numbness', 'tingling', 'pins and needles', 'loss of sensation', 'foot drop', 'radiating pain', 'shooting pain', "can't feel my", 'cannot feel my', 'leg went dead', 'legs went dead', 'dead leg'] },
  { key: 'cardiac', label: 'possible heart or breathing symptoms',
    terms: ['chest pain', 'chest tightness', 'palpitations', 'shortness of breath', "can't breathe", 'cannot breathe', 'fainted', 'passed out', 'blacked out'] },
  { key: 'head', label: 'a possible head injury',
    terms: ['concussion', 'head injury', 'hit my head', 'blurred vision', 'vision changes', 'memory loss', 'saw stars', 'knocked out', 'dazed'] },
  { key: 'bone', label: 'a possible fracture',
    terms: ['stress fracture', 'fracture', 'fractured', 'broken bone'] },
  { key: 'red_s', label: 'low-energy-availability / disordered-eating signals',
    terms: ['not eating', 'restricting food', 'restricting calories', 'disordered eating', 'lost my period', 'missed my period', 'periods stopped', 'period stopped', 'stopped getting my period', 'amenorrhea', 'amenorrhoea', 'red-s', 'reds', 'binge eating', 'purging', 'making myself sick', 'laxative', 'skipping meals', 'barely eat', 'barely eating', 'undereating', 'under-eating', 'not eating enough'] },
  { key: 'infection', label: 'signs of infection',
    terms: ['fever', 'hot to touch', 'red and swollen', 'infected', 'pus'] },
  { key: 'mental_health', label: 'a mental-health crisis',
    terms: ['kill myself', 'suicidal', 'suicide', 'end my life', 'want to die', 'self-harm', 'self harm', 'harm myself', 'hurt myself', 'no reason to live'] },
];

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Normalise curly quotes to straight so "can't" (smart) matches "can't" (straight).
const normalizeQuotes = s => s.replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"');
// Global, word-boundary matcher. Apostrophes count as part of a word so "can't"
// matches; the trailing boundary is a lookahead so we don't consume it.
const phraseReG = phrase => new RegExp(`(^|[^a-z0-9'])(${escapeRe(phrase.toLowerCase())})(?=[^a-z0-9']|$)`, 'gi');

// A match is suppressed if one of the ~3 words immediately before it negates it.
const NEGATORS = new Set(['no', 'not', 'non', 'without', 'never', 'denies', 'denied', 'deny', 'free', 'zero', 'negative', 'nil', 'none']);
function negatedBefore(hay, idx) {
  const words = hay.slice(Math.max(0, idx - 40), idx).split(/[^a-z']+/i).filter(Boolean);
  return words.slice(-3).some(w => NEGATORS.has(w) || w.endsWith("n't"));
}

export const RED_FLAG_ADVICE =
  'Some of what you described may need a qualified professional rather than a training plan. ' +
  'SAH Elite gives training guidance, not medical advice — please see a doctor or physiotherapist before we build or continue your plan. ' +
  'If symptoms are severe or sudden (for example chest pain, numbness, a suspected tear, or a head injury), seek urgent care now. ' +
  'If you are struggling with how you feel, please talk to someone you trust or a crisis line in your country.';

/* scanRedFlags(text) -> { flagged, matches: [{term, category, label}], categories: [key], advice }
   `text` is the athlete's free-text intake (goals/injuries/etc.). Non-string or
   empty input is simply not flagged. */
export function scanRedFlags(text) {
  const matches = [];
  if (typeof text === 'string' && text.trim()) {
    const hay = normalizeQuotes(text).toLowerCase();
    for (const cat of CATEGORIES) {
      for (const term of cat.terms) {
        const re = phraseReG(term);
        let m;
        while ((m = re.exec(hay)) !== null) {
          const phraseIdx = m.index + m[1].length;     // start of the actual phrase
          if (!negatedBefore(hay, phraseIdx)) { matches.push({ term, category: cat.key, label: cat.label }); break; }
        }
      }
    }
  }
  const categories = [...new Set(matches.map(m => m.category))];
  return { flagged: matches.length > 0, matches, categories, advice: matches.length ? RED_FLAG_ADVICE : '' };
}

// Public list of what the gate screens for (e.g. to show in a disclaimer / docs).
export const RED_FLAG_CATEGORIES = CATEGORIES.map(c => ({ key: c.key, label: c.label }));
