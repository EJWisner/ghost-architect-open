// src/modes/audit/keyPersonRisk.js
//
// Key-Person Risk — Inheritance Audit analyzer #2
//
// Author concentration from git history. Bus-factor estimate. % of code
// touched by top 1 / 3 / 5 contributors. Last-commit recency per author.
//
// Implementation approach:
//   - Shells out to `git log --numstat` against the codebase root
//   - Parses author + lines-changed per commit
//   - Aggregates by author email (with display-name fallback)
//   - Computes percentage of lines touched per author
//   - Flags authors whose last commit is >180 days old as potentially
//     departed
//
// Output shape:
//   {
//     totalAuthors: number,
//     topContributors: {
//       authorEmail: string,        // hashed for the report; never raw
//       authorDisplay: string,      // first-initial + surname or pseudonym
//       linesChangedTotal: number,
//       linesChangedPct: number,
//       commitsTotal: number,
//       firstCommitAt: string,      // ISO date
//       lastCommitAt: string,       // ISO date
//       likelyDeparted: boolean,    // last commit > 180 days ago
//     }[],
//     busFactorEstimate: number,    // how many authors account for 80% of code
//     concentrationRisk: 'low' | 'medium' | 'high',
//     callouts: string[],           // e.g. "70% of code touched by one author
//                                   // whose last commit was 9 months ago"
//   }
//
// v1 implementation is a STUB. Real git log parsing arrives in the next pass.
//
// Privacy note: author emails are HASHED in the report. Buyers see only
// pseudonymous handles ("Author A", "Author B"). Raw emails never make it
// into PDF output.

export async function runKeyPersonRisk(codebaseContext, options = {}) {
  return {
    totalAuthors: 0,
    topContributors: [],
    busFactorEstimate: 0,
    concentrationRisk: 'unknown',
    callouts: [],
    _stub: true,
  };
}
