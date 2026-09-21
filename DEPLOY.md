# Deploying evensplit

The app needs somewhere that runs a Node process and a Postgres database. It
boots with nothing but `DATABASE_URL`; migrations run on startup and the demo
data seeds itself, so a fresh deploy has something to look at immediately.

## Render — one click, with one prerequisite

Render's free tier allows **one** Postgres database per account, so this
blueprint does not try to create one. It expects you to point it at a database
you already have; this app keeps to its own schema (`DB_SCHEMA=evensplit`), so
sharing a database with other apps collides with nothing — not even the
migration bookkeeping.

1. Open the existing database in the Render dashboard and copy its
   **Internal Database URL**.
2. **New → Blueprint**, pick the `evensplit` repository.
3. When Render prompts for `DATABASE_URL`, paste that URL.
4. **Apply**.

If you do have a spare database allowance, adding a `databases:` block to
`render.yaml` and wiring `DATABASE_URL` with `fromDatabase` works too.

## Railway

1. Sign in at [railway.app](https://railway.app) with GitHub.
2. **New Project → Deploy from GitHub repo →** `evensplit`.
3. In the project, **New → Database → PostgreSQL**.
4. Open the app service → **Variables** → add `DATABASE_URL` with the value
   `${{Postgres.DATABASE_URL}}` (Railway substitutes the real one).
5. **Settings → Networking → Generate Domain**.

Railway builds from the `Dockerfile` automatically.

## Fly.io

Needs the CLI, and a card on file even for the free allowance.

```bash
fly launch --no-deploy          # keeps the fly.toml in this repo
fly postgres create
fly postgres attach <db-name>
fly deploy
```

`fly.toml` is already set up, including the health check.

## Notes for this app

Nothing to configure beyond the database.

Free tiers change; check the current terms on whichever host you pick. A free
instance that has been idle usually sleeps and takes a few seconds to wake on
the next request — fine for a demo, worth knowing before you send the link to
someone.

## Checking it worked

```bash
curl https://<your-url>/healthz      # {"ok":true}
```

Then open the root URL. The demo data is already there.
