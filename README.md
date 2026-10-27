# nashp Extractor ticker

Complete ticker frontend and shared Extractor backend source, extracted without changing nashp.com.

## Run the isolated demo

Serve this folder (for example, `python3 -m http.server 8767`) and open `http://localhost:8767`. It uses a small synthetic fixture, not your saved archive. No frontend packages or build step.

## Included code

- `src/ticker.html`, `src/ticker.css`, `src/ticker.js`: homepage display, styling, connection normalization/ranking, last-known fallback, viewport-paused animation and one bounded retry. Set `window.NASHP_EXTRACTOR_ENDPOINT` before loading to use your own endpoint.
- `src/shared-ticker.js`: shared entry/page fetch cache and ticker variant; only load when using `.site-connection-ticker-track`.
- `blot/connection-widgets.html`: related homepage connection widgets.
- `blot/Extractor.html`: complete Extractor page source (Blot renders the surrounding page).
- `worker/worker.js`: full shared Worker, including archive storage, parsing/classification, connection definitions, packages, summaries, optional YouTube and existing webhook integration. These shared routes are retained to avoid silently dropping backend dependencies; not all are required just to display the ticker.

## Backend setup

The source is a local backend snapshot, not a claim that it matches the currently deployed revision. Do not deploy over the existing live Worker. The example config uses a different Worker name for safety.

Use Cloudflare Wrangler with `worker/wrangler.jsonc`. Provision the Durable Object migration and AI binding shown in that config. Supply `REEDER_FEED_URL` as a secret; the original feed address is deliberately excluded. Optional YouTube OAuth and Stripe integrations need their corresponding environment values. Never commit `.dev.vars`, OAuth tokens, signing secrets, saved feed data, or local account configuration. The scheduled refresh is preserved from the backend config.

The default CORS origins remain nashp.com/www.nashp.com. Review `ALLOWED_ORIGINS` and `corsHeaders` before hosting elsewhere. Update the public Worker URL in the optional shared variant and Blot templates if self-hosting. The complete site shell, starship, mascot, blog content, and unrelated site templates are not dependencies of the standalone ticker and are not copied.

The ticker still displays five topic labels; connection widgets retain three links per topic. The Latest Links list keeps its independent pagination. No images required; demo loads Electrolize from Google Fonts with sans-serif fallback. No license has been assigned.
