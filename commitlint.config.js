// Commitlint configuration (see .commitlintrc.yml history — migrated to JS so the
// `ignores` predicate below can be expressed; YAML cannot hold functions).
//
// The `ignores` list holds shapes this repository's OWN history contains, and
// nothing else:
//
//   - the release/version-bump commit: `release-it` is configured to commit
//     `v${version}` (see .release-it.yml), a shape that carries no type at all,
//     and earlier manual bumps used `chore: version x.y.z`. The `v${version}`
//     shape needs the exemption to satisfy `type-enum`; the `chore: version`
//     one keeps its exemption so the bumps already in this repository's history
//     keep passing unchanged.
//   - the subject of a squash-merged pull request: GitHub takes the subject from
//     the PR title and appends the PR number, so the subject reads "Ensure
//     staged checks run reliably (#35)". `type-empty` and `subject-empty` reject
//     that shape, so exempt it as well — but only that shape: a subject with no
//     `type:` prefix that ends in a PR reference. A subject that does declare a
//     type (`note: …`) is still judged by `type-enum`, and an untyped subject
//     without a PR reference is still rejected.
//
// Nothing else is exempt. In particular there is NO exemption for the automated
// "land" commits the platform's follow-up lane writes on a pull request branch
// (`chore(<lane>): land <files>`): an `ignores` entry for that shape waives
// EVERY rule for it — the body-length limit included — the hole a review
// rejected. `chore` is an allowed type below instead, so the land commit
// carries a type the policy allows AND is judged by the full rule set, exactly
// like a hand-written commit.
//
// `chore` is allowed because the follow-up lane chooses that type itself and
// reads no setting from this repository: refusing it would block every
// automated follow-up commit at the husky hook and fail CI's "Lint commit"
// step on the branch's own history. Every other rule — the 200-character body
// line limit, the subject rules, the header pattern — still applies to it.

// The header pattern of the parser this config runs under
// (conventional-changelog-conventionalcommits): `type`, optional `(scope)`,
// optional `!`, then ": ". A subject that does not match it is prose, not a
// Conventional-Commits header.
const TYPED_SUBJECT = /^\w*(?:\(.*\))?!?: /;
// GitHub appends the pull request number to the subject of a squash-merge.
const PR_REFERENCE = /\(#\d+\)$/;

module.exports = {
    extends: ['@commitlint/config-conventional'],
    ignores: [
        (message) => /^v\d+\.\d+\.\d+\b/.test(message),
        (message) => /^chore: version \d+\.\d+\.\d+\b/.test(message),
        // The subject of a squash-merged pull request: the PR title plus "(#35)".
        (message) => {
            const subject = message.split('\n')[0].trim();
            return !TYPED_SUBJECT.test(subject) && PR_REFERENCE.test(subject);
        },
    ],
    rules: {
        'body-max-line-length': [2, 'always', 200],
        'type-enum': [
            2,
            'always',
            [
                'build',
                'chore',
                'ci',
                'docs',
                'enhance',
                'feat',
                'fix',
                'perf',
                'refactor',
                'remodel',
                'revert',
                'style',
                'test',
                'vcs',
            ],
        ],
    },
};
