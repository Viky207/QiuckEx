# Contributing

Thanks for contributing! Please read this guide before opening a pull request.

## Getting started

1. Fork the repository and create a feature branch.
2. Install dependencies and run the existing test suite locally.
3. Make focused changes that address a single issue.
4. Open a pull request describing the change and linking the issue.

## Code style

- Follow the existing patterns, naming, and module structure.
- Keep changes surgical; avoid unrelated refactors.
- Do not commit secrets, signing material, or unnecessary personal data.

## Tests

- Add focused automated coverage for any changed behavior, including the relevant failure or boundary case.
- Preserve existing public contracts unless a deliberate migration is included.

## Contract budget regression tests

The contract test suite includes budget regression cases that exercise worst-case call paths under the declared limits (CPU instructions and storage growth). These tests are reproducible and run in contract CI.

- Exceeding a declared budget limit fails the CI job.
- Budget thresholds are checked into the repository alongside the tests.
- **Changing a budget threshold requires an explicit review note** in the pull request explaining why the limit changed and what worst-case input justifies the new value. Threshold changes without a review note should be rejected.

## Pull requests

- Keep the description clear and reference the issue number.
- Ensure CI passes, including the contract budget regression job.
- Respond to review feedback promptly.
