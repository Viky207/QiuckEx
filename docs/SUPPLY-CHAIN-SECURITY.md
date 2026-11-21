# Supply Chain Security

This document describes how release artifacts are built, pinned, inventoried, attested, and promoted, and how operators verify each of those properties. It covers:

- Pinned GitHub Actions (immutable commit SHAs)
- Signed SBOMs for backend container images
- Build provenance attestations for release artifacts
- The protected `production` environment approval gate

All commands below assume the GitHub CLI (`gh`) is installed and authenticated, and that you are working from a checkout of this repository.

---

## 1. Pinned GitHub Actions

Every external `uses:` reference in `.github/workflows/` and composite actions must be pinned to a full 40-character commit SHA. A readable version comment is retained on the same line so reviewers can see the intended release.

```yaml
- uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
```

Mutable references (`@v4`, `@main`, `@latest`, branch names, or short SHAs) are rejected by the checker.

### 1.1 Checking for mutable references

Run the checker locally before opening a pull request:

```bash
./scripts/check-pinned-actions.sh
```

The same check runs in CI and fails the build if any external `uses:` reference is not SHA-pinned or is missing its version comment. Local `uses: ./path` references are exempt.

### 1.2 Resolving a SHA for a new or updated action

1. Identify the exact release tag you intend to use (for example `v4.2.2`).
2. Resolve the tag to its commit SHA:

   ```bash
   gh api repos/actions/checkout/git/ref/tags/v4.2.2 --jq '.object.sha'
   ```

   If the tag is annotated, the returned object is a tag object; dereference it to the commit:

   ```bash
   gh api repos/actions/checkout/git/tags/<tag-sha> --jq '.object.sha'
   ```

   Alternatively, use the GitHub UI: open the tag, copy the full commit SHA shown in the commit header.

3. Update the workflow line with the full SHA and a trailing comment naming the version:

   ```yaml
   - uses: actions/checkout@<full-40-char-sha> # v4.2.2
   ```

4. Run `./scripts/check-pinned-actions.sh` and confirm it passes.

### 1.3 Bumping an existing pinned action

1. Choose the new release tag.
2. Resolve its commit SHA using the steps in 1.2.
3. Replace the SHA and update the version comment in every workflow that references the action. Search first so you do not miss a reference:

   ```bash
   grep -rn "actions/checkout@" .github/
   ```

4. Run the checker and the workflow lint/test jobs.
5. In the pull request description, record the old and new SHAs and the upstream release notes link so reviewers can confirm the change is intentional.

### 1.4 Review guidance

- Reviewers must confirm the SHA matches the claimed version tag (compare against the upstream repository).
- Do not approve a change that introduces a mutable reference, even temporarily.
- Dependabot (or equivalent) may open SHA-bump pull requests; treat them like any other change and verify the SHA before merging.

---

## 2. Signed SBOMs for backend container images

Each release image is accompanied by a Software Bill of Materials (SBOM) that lists direct and transitive packages. The SBOM is generated during the release workflow, signed, and attached to the image by its immutable digest (not by tag).

### 2.1 Locating the SBOM for an image

1. Resolve the image tag to its immutable digest:

   ```bash
   docker buildx imagetools inspect ghcr.io/<owner>/<repo>/backend:<tag> \
     --format '{{json .Manifest.Digest}}'
   ```

   Or, if the image is already pulled locally:

   ```bash
   docker inspect --format '{{index .RepoDigests 0}}' ghcr.io/<owner>/<repo>/backend:<tag>
   ```

2. List the attestations/SBOMs attached to that digest:

   ```bash
   gh attestation ls \
     --repo <owner>/<repo> \
     --predicate-type https://spdx.dev/Document \
     --limit 100
   ```

   The output includes the subject digest; match it against the digest from step 1.

### 2.2 Retrieving and verifying the SBOM

Download the SBOM attestation for the digest and verify its signature against the repository's attestation identity:

```bash
gh attestation verify \
  oci://ghcr.io/<owner>/<repo>/backend@sha256:<digest> \
  --repo <owner>/<repo> \
  --predicate-type https://spdx.dev/Document
```

A successful verification prints the attestation details and exits `0`. A non-zero exit means the SBOM is missing, the signature does not validate, or the digest does not match — treat this as a release integrity failure and do not promote the image.

To extract the SBOM document for offline inspection:

```bash
gh attestation download \
  oci://ghcr.io/<owner>/<repo>/backend@sha256:<digest> \
  --repo <owner>/<repo> \
  --predicate-type https://spdx.dev/Document \
  --output-dir ./sbom
```

The downloaded bundle contains the signed attestation; the SBOM payload lists direct and transitive packages.

### 2.3 Retention

SBOMs are retained with the release artifact for the lifetime of the release. Do not delete attestations for a published release; if a release is withdrawn, record the reason in the release notes rather than removing the SBOM.

---

## 3. Build provenance attestations

Release images and contract artifacts carry build provenance attestations generated by the release workflow using GitHub artifact attestations. Each attestation identifies the source repository, commit, workflow, and artifact digest.

### 3.1 Verifying an image

```bash
gh attestation verify \
  oci://ghcr.io/<owner>/<repo>/backend@sha256:<digest> \
  --repo <owner>/<repo>
```

### 3.2 Verifying a contract artifact

```bash
gh attestation verify <path-to-artifact> \
  --repo <owner>/<repo>
```

For artifacts produced by a specific workflow, constrain the check:

```bash
gh attestation verify <path-to-artifact> \
  --repo <owner>/<repo> \
  --signer-workflow <owner>/<repo>/.github/workflows/release.yml
```

### 3.3 What a successful verification proves

A passing `gh attestation verify` confirms that:

- the artifact digest matches the attested subject,
- the attestation was signed by this repository's workflow identity,
- the recorded source commit and workflow match the expected release.

### 3.4 Promotion gate

Verification runs in the release workflow **before** promotion. If verification fails, the promotion job does not run and the release is blocked. Operators performing a manual promotion must run the verification commands above and record the result in the release checklist. Never promote an artifact whose provenance cannot be verified.

---

## 4. Protected `production` environment

Production promotion is gated by a repository environment named `production` that requires reviewer approval and holds environment-scoped secrets. Staging is a separate environment and remains independently deployable without production approval.

### 4.1 Configuring the `production` environment

1. In the repository, go to **Settings → Environments → New environment** and name it `production`.
2. Under **Deployment protection rules**, enable **Required reviewers** and add at least one reviewer (or team). Optionally set a wait timer.
3. Under **Deployment branches and tags**, restrict deployments to the protected branch (for example `main`) and release tags.
4. Under **Environment secrets**, add the secrets used only by production deploys (for example registry credentials and deploy tokens). These secrets are scoped to `production` and are not available to other jobs or environments.

### 4.2 Workflow requirements

Deploy jobs that target production must reference the environment:

```yaml
jobs:
  deploy-production:
    environment:
      name: production
      url: https://<production-url>
    steps:
      - run: ./deploy.sh
        env:
          DEPLOY_TOKEN: ${{ secrets.DEPLOY_TOKEN }}
```

Because the job declares `environment: production`, GitHub holds the job until a required reviewer approves it. Environment-scoped secrets are not exposed to the job until approval is granted.

### 4.3 Staging independence

The staging deploy job must reference the `staging` environment (or no protected environment) and must not depend on the production approval job. Staging deploys proceed on successful CI without waiting for production reviewers. Keep staging and production secrets in their respective environments; do not share production secrets with staging.

### 4.4 Operational notes

- Approvals are recorded in the deployment history for audit.
- Removing a required reviewer weakens the gate; treat such changes as security-relevant and require review.
- Rotate environment-scoped secrets through **Settings → Environments → production → Environment secrets**; never commit secret values to the repository or print them in workflow logs.
- If a deploy job can read a production secret without an approval, the environment is misconfigured — fix the environment configuration before the next release.

---

## 5. Release checklist (summary)

1. All workflows pass `./scripts/check-pinned-actions.sh`.
2. Release image digest recorded; SBOM attached and verifiable via `gh attestation verify`.
3. Provenance attestations verify for the image and contract artifacts.
4. Promotion to `production` approved by a required reviewer; staging deployed independently.
5. Verification results recorded in the release notes or checklist.