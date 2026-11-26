# Contributing to handlesapi-js

Thanks for helping. This is the TypeScript client for the [Handles API](https://handlesapi.com).

## Setup

```bash
git clone https://github.com/handlesapi/handlesapi-js.git
cd handlesapi-js
npm ci
npm run typecheck
npm test
```

Node 18 or newer. The package has no runtime dependencies; please keep it that way.

## How the code is organised

- `src/core.ts`, `src/client.ts`, `src/errors.ts` are hand-written: transport, retries, credit headers, pagination.
- `src/generated/` is produced from the OpenAPI spec by `scripts/generate.mjs`. Do not edit it by hand; change the generator and run `npm run generate`.
- `test/` runs against a mocked `fetch`, so tests need no API key and no network.

## Pull requests

- One change per pull request, with a test for behaviour changes.
- `npm run typecheck` and `npm test` must pass.
- If the API changed, regenerate from the latest [spec](https://github.com/handlesapi/openapi) and say so in the description.
- Add a line to `CHANGELOG.md` under Unreleased.

Bugs and ideas go in [issues](https://github.com/handlesapi/handlesapi-js/issues). For account or billing questions, email support@handlesapi.com.
