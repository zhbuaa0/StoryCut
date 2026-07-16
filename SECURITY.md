# Security and privacy

StoryCut is an early prototype. Do not submit sensitive, confidential, regulated, or personally identifying material.

## Public demo policy

Use synthetic or explicitly cleared transcripts, screenshots, and footage in public demos. Before publishing:

1. Remove names, email addresses, account identifiers, file paths, faces, voices, and location metadata unless consent is documented.
2. Do not commit `.env`, API keys, SSH keys, raw footage, private transcripts, exports, browser data, or local build artifacts.
3. Run `npm test` and `npm run privacy-check`.
4. Review `git diff --cached` before pushing.

## Data handling in v0.1

- The local analyzer runs on the server process without saving the transcript.
- GPT mode sends the supplied transcript to the OpenAI API only when a server-side `OPENAI_API_KEY` is configured and the user selects GPT-5.6.
- The prototype has no database, analytics, cookies, user accounts, or third-party browser scripts.
- Export happens locally in the browser.

## Reporting a vulnerability

Please open a GitHub issue containing only non-sensitive reproduction steps. Do not place credentials, private media, or personal data in an issue.
