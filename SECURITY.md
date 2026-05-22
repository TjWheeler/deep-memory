# Security Policy

## Reporting a Vulnerability

**Please do not report security issues through public GitHub issues, discussions, or pull requests.**

We prefer that you report vulnerabilities through GitHub's private vulnerability reporting:

1. Go to the **Security** tab of this repository.
2. Click **Report a vulnerability**.
3. Fill in the form.

If you cannot use GitHub's reporting flow, email **security@utaba.ai** instead.

### What to include

To help us triage quickly, please include as much of the following as you can:

- The affected package(s) and version(s).
- A description of the issue and its impact.
- Steps to reproduce, or a minimal proof-of-concept.
- Any suggested mitigation, if you have one.

## Response Process

- **Acknowledgement:** within 3 business days of receipt.
- **Initial assessment:** within 10 business days — confirming whether the report is in scope and the severity.
- **Fix and release:** timeline depends on severity and complexity. We will keep you updated.
- **Credit:** we are happy to credit reporters in the release notes and advisory unless you prefer to remain anonymous.

## Coordinated Disclosure

We follow a **90-day coordinated disclosure** model. We ask that you keep the issue confidential until a fix has shipped, or 90 days have passed since your report — whichever comes first. If we need more time, we will discuss it with you before that window closes.

## Supported Versions

Until we reach `1.0.0`, only the **most recent minor release** of each package receives security fixes. Pin minor versions in your dependency manifests and update regularly.

After `1.0.0`, this policy will be updated to cover an explicit window of supported minor releases.

## Scope

In scope:

- All packages published under the `@utaba/deep-memory*` npm scope.
- The source code in this repository.

Out of scope:

- Issues in third-party dependencies — please report those upstream. We are still interested in hearing about them so we can update or pin around them.
- Issues that require a compromised local machine, npm account, or developer credentials.
- Denial of service through resource exhaustion in user-supplied inputs (graph size, embedding batch size, etc.) — these are configuration concerns, not vulnerabilities.

## Questions

For non-security questions about the project, please use GitHub Discussions or open a regular issue.
