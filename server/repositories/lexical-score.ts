const TERM_SEPARATOR = /[\s,，。；;、：:！!？?（）()《》“”"'‘’【】]+/u;
/** Default share of a term's character pairs below which a partial match is treated as noise. */
export const DEFAULT_MINIMUM_PAIR_COVERAGE = 0.4;

function hanPairs(term: string) {
  const pairs = new Set<string>();
  for (const run of term.match(/\p{Script=Han}{2,}/gu) ?? []) {
    const characters = Array.from(run);
    for (let index = 0; index < characters.length - 1; index += 1) pairs.add(characters[index]! + characters[index + 1]!);
  }
  return [...pairs];
}

/**
 * Lexical relevance of `text` to `query`, in [0, 1], that works for Chinese.
 *
 * Chinese has no spaces, so a whole sentence is one term and never appears
 * verbatim in a passage. Each term therefore scores 1 when it occurs as
 * written and otherwise by the share of its overlapping character pairs that
 * occur, so a paraphrased or partially quoted query still finds its passage.
 * Terms whose pair coverage falls below `minimumPairCoverage` count as no match,
 * so a query with nothing relevant does not surface passages that merely share
 * common words. Sources with their own relevance priors (a curated, subject
 * scoped standards corpus) can use a lower floor than open-ended uploads.
 * The result is the mean over terms; an empty query keeps the old neutral 0.01.
 */
export function lexicalScore(query: string, text: string, minimumPairCoverage = DEFAULT_MINIMUM_PAIR_COVERAGE) {
  const terms = query.normalize("NFKC").toLocaleLowerCase().split(TERM_SEPARATOR).filter(Boolean);
  if (!terms.length) return 0.01;
  const haystack = text.normalize("NFKC").toLocaleLowerCase();
  const total = terms.reduce((sum, term) => {
    if (haystack.includes(term)) return sum + 1;
    const pairs = hanPairs(term);
    if (!pairs.length) return sum;
    const coverage = pairs.filter((pair) => haystack.includes(pair)).length / pairs.length;
    return coverage >= minimumPairCoverage ? sum + coverage : sum;
  }, 0);
  return total / terms.length;
}
