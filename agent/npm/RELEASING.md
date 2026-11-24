# Releasing deplace-kit

This folder is the npm package of the agent kit. Its code is built from `agent/src/kit` by `agent/scripts/build-npm.mjs`, which npm runs before every pack and publish. This file isn't part of the package.

Before any release, `npm run check:npm -w agent` packs the package, installs it into an empty project, serves it to an MCP client and starts it through npx. It must end with "ready to publish".

## The first version, by hand

npm can only trust a release workflow for a package that already exists, so 0.1.0 goes up from your own machine:

```
npm login
npm run check:npm -w agent
cd agent/npm
npm publish
```

`npm login` signs you in through the browser. Afterwards the package is at https://www.npmjs.com/package/deplace-kit.

## Trust the release workflow

On npmjs.com, open deplace-kit → Settings → Trusted publishing, choose GitHub Actions, and enter `KAMEVETRICS` as the organization or user, `deplace` as the repository and `release-kit.yml` as the workflow filename. Leave the environment empty. npm drops a trusted publisher that hasn't published within two days of being saved, so add it when the next release is ready.

## Every release after that

1. Raise the version in `agent/npm/package.json` and `agent/src/kit/version.ts`; the build refuses the two when they differ. Update the pinned version in the README here and in `docs/connect-your-agent.md`.
2. Commit and push to main.
3. Tag the commit and push the tag: `git tag kit-v0.1.1`, then `git push origin kit-v0.1.1`. The workflow checks that the tag matches the version, typechecks and tests the kit, runs the package check and publishes with provenance.
