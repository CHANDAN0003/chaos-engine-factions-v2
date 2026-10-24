# CHAOS ENGINE V2 — Faction Wars

Live Twitch chat powers a competition between Team Chaos and Team Hero. Builds directly on V1; Twitch OAuth and EventSub chat subscriptions are preserved.

## Quick start (Windows/macOS/Linux)

1. Install Node.js 20+.
2. Copy `.env.example` to `.env` and set `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, and `TWITCH_REDIRECT_URI=http://localhost:3000/auth/callback`.
3. Run `npm install`, then `npm start`, then visit http://localhost:3000.
4. Click **Connect Twitch** and authorize your broadcaster account. App must be a Confidential client.
5. Keep `TWITCH_REDIRECT_URI` identical to the Twitch Developer Console callback URL. If port 3000 is in use, stop the other process or change PORT and callback URL together.

## Chat commands

| Command | Who | Behavior |
| --- | --- | --- |
| `!chaos` | unassigned viewer | Joins Chaos until server restarts |
| `!hero` | unassigned viewer | Joins Hero until server restarts |
| `!power` or `!charge` | faction member | Adds 12 energy to their faction (one action / 12 sec / viewer) |
| `!dragon`, `!trap` | Chaos member | Votes in 20-second faction round |
| `!heal`, `!shield` | Hero member | Votes in 20-second faction round |

Faction energy reaches 100 → automatically spends 100 energy and triggers a dragon (Chaos) or 10-second shield (Hero). Event ID deduplication prevents processing duplicates in the game client. Each successful contribution also earns one faction point, with a 10-point bonus for a trigger.

## Streamer controls

Authenticated broadcaster can start timed faction rounds, start legacy voting rounds, and pause/resume power generation. The local simulator is only shown to an authenticated broadcaster and only available when `NODE_ENV` is not `production`.

## Current limitations and next steps

- Faction membership, power, scores, votes, and OAuth sessions are memory-only; restarting the server resets these.
- Energy meter is server authoritative, but game physics (player movement, damage, shield) remain in the browser. Multiple game clients do not share exact positions or HP.
- Only the broadcaster authenticated in OAuth can manage the game. Do not expose local server publicly without production deployment security work (HTTPS, reverse proxy, rate limits, CSRF protections, durable OAuth/session storage).
- No real Twitch credentials are bundled. Live EventSub connection must be tested with your channel.
- Core mechanics currently use simple Canvas/emoji art; next iteration can add sprite assets, animations, OBS-ready overlay, and server-authoritative combat.
- `!power` works while a faction round is running; timed rounds and power charging are independent.
