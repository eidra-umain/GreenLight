# GreenLight — Claude Code Instructions

## Release process

When asked to release a new version (e.g. "release 0.7.4"):

1. **Review changes** — `git log` since last release to understand what changed
2. **Update CHANGELOG.md** — add a new block at the top following the existing format:
   - Version header with date: `## [0.7.4] - YYYY-MM-DD`
   - One-line summary of the release theme
   - `### Added` section for new user-facing features (one bullet each, bold name + description)
   - `### Changed` / `### Fixed` sections only for changes users will notice (new CLI flags, behavior changes, bugs that affected test runs)
   - Do NOT include internal refactors, code quality changes, or implementation details
3. **Update README.md** — if new CLI flags, config options, or user-facing features were added
3b. **Update docs/internal_architecture.md** — if any changes touched the element tree, page stability flow, map testing, or other internals documented there
4. **Build** — `npm run build` (must succeed)
5. **Run tests** — `npx vitest run` (must pass)
6. Do not add "co-authored by claude" to commit messages
7. **Commit 1: code changes** — stage everything EXCEPT `package.json`:
   ```
   git add CHANGELOG.md README.md src/ tests/ ...
   git commit -m "{one-line summary of changes}"
   ```
8. **Update version** in `package.json`
9. **Commit 2: version bump** — stage only `package.json`:
   ```
   git add package.json
   git commit -m "v{VERSION}"
   ```
10. **Tag** — `git tag v{VERSION}`
11. **Push** — `git push && git push --tags`
12. **Publish** — tell the user to run `npm publish --access public` (cannot be run from sandbox)

Always confirm with the user before steps 10 and 11 (push and publish).
