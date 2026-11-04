# Recipe box — Data and API contract

## Data model

### Recipe

- `title`: text, required.
- `minutes`: a whole number, how long it takes.

## Endpoints

### GET /

Returns the home page as HTML.

### GET /health

Returns status 200 and `{"ok": true}`, so the host knows the app is up.

### GET /recipes

Returns every recipe as a JSON array. The recipes are in `data/recipes.json`.

## Rules

Only GET requests are answered. Everything else returns 404.
