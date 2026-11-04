# Recipe box — Technical requirements

## Stack

- Node.js 22 with `node:http`: a real server with no framework to learn first.
- `node:test`: the built-in test runner.
- Render's free tier for hosting: it runs a Node server with no setup.

## Architecture

`src/app.js` answers each request. `src/server.js` starts it on the port in `PORT`, or 3000.

## Hosting

Render runs `npm start` and sets `PORT`. Every push to `main` redeploys.

## Conventions

- One branch per milestone: `feat/skeleton`, `feat/recipes`.
- Conventional Commits, such as `feat(web): add home page`.

## Commands

- `npm start` runs the app.
- `npm run build` checks the code parses.
- `npm test` runs the tests.
