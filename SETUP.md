# WSF League Portal — Discord setup

The portal uses Discord to sign members in. The WSF invite link also provides public **approximate** member and online counts, so those counts do not require a bot token. The page refreshes them every 60 seconds; the website server caches Discord's response for 60 seconds to avoid unnecessary requests. Claim tickets require Discord sign-in and are saved in the Supabase `claim_tickets` table. In production, the server uses a Supabase secret key; keep it in the host's private environment settings and never place it in browser code or share it in chat. Automatic WSF MLS, MLS NEXT, and UCL scores need authorized MajorX XR-Board API access; MajorX currently denies automated reads from its public data endpoint. Once MajorX provides the licensed endpoint and integration details, the portal can refresh those scores daily.

## What you need

- A Discord account that can create an application in the [Discord Developer Portal](https://discord.com/developers/applications).
- A place to host this Node website so Discord can redirect members back to it. A `localhost` address only works when the website server is running on the same computer as the browser.

## 1. Create the Discord sign-in app

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and choose **New Application**.
2. Name it **WSF League Portal** (or another name you prefer).
3. Open **OAuth2** in the left menu. Copy the **Client ID** and **Client Secret**. Keep the secret private; do not post it in Discord or chat.
4. Under **Redirects**, add this exact address for local development: `http://localhost:3000/auth/callback`.
5. Once you have hosted the site, add the hosted callback too, in this format: `https://YOUR-SITE-DOMAIN/auth/callback`. It must exactly match the website’s `BASE_URL` plus `/auth/callback`.

The portal asks members to approve the `identify` and `guilds` permissions. It uses these to show their Discord profile and confirm that they belong to the WSF server.

## Staff desk and tickets

Members sign in with Discord to submit an item claim or a private support question. Staff sign in with the same Discord button; the server checks their Discord account against the private `staff_access` table. Staff can read/review claims, update claim status and private review notes, and answer support questions. Only the owner account can add or remove staff.

Before using the staff desk on Render:

1. In Supabase → SQL Editor, run the updated `supabase-setup.sql` file. It creates the staff and support tables and adds review fields to existing claim tickets.
2. In Render → the WSF service → Environment, add `WSF_OWNER_DISCORD_ID` with your Discord User ID (a long number, not your username), then save and redeploy.
3. In Discord, turn on User Settings → Advanced → Developer Mode. Right-click your own profile and choose **Copy User ID**. Paste that number into the Render setting. Do not put the Discord application secret in this field.
4. Open the website, sign in with the same Discord account, then choose **Staff**. The owner section lets you add staff using each person's Discord User ID and username.

The Discord User ID is a public account identifier, but the Render environment setting ensures only the account that signs in as that ID gets owner controls. Never grant owner access by sharing an application secret.

## 2. Add the values to the website

1. In this project folder, make a copy of `.env.example` named `.env`.
2. Paste your Client ID beside `DISCORD_CLIENT_ID=` and your Client Secret beside `DISCORD_CLIENT_SECRET=`.
3. Leave the provided `DISCORD_GUILD_ID` and `DISCORD_INVITE_CODE` as they are for the WSF server.
4. Replace `SESSION_SECRET` with a long private random string. Keep `.env` private; it is excluded from Git.
5. Set `BASE_URL` to the exact site address. For local testing, use `http://localhost:3000`. For a hosted site, use its HTTPS address.

You do not need a Discord bot for the public member and online counts or Discord sign-in.

## 3. Optional: add live server channels and member list

To show private guild details such as text channels and member profiles, create a bot in the same Developer Portal application, add it to the WSF server, and set `DISCORD_BOT_TOKEN` in `.env`. Enable the bot’s **Server Members Intent** in **Bot → Privileged Gateway Intents** if you want member-list access. Never put the bot token in browser code or share it publicly.

## Run locally

With Node.js 18 or newer installed, open a terminal in this folder and run `npm start`. Keep that terminal open while using the local site at `http://localhost:3000`. Open the site through this address (not by double-clicking `index.html`) so Discord sign-in and claim submission can use the server. Discord sign-in additionally needs the private `.env` values described above. Daily MajorX score updates remain off until an authorized XR-Board API endpoint and integration details are available.

For other people to use the site, it must be hosted on a public HTTPS address and the production callback address must be added under OAuth2 → Redirects. The current project uses in-memory sign-in sessions, so use a persistent session store before scaling to multiple server instances.

## Publish free with Render and Supabase

The project includes `render.yaml` for Render's free Node web service and stores claims in a Supabase Postgres table. The free web service sleeps after 15 minutes without visitors and can take about a minute to wake. Supabase may pause a free project after a week with very little database use; the stored claims remain there, but the database must be resumed before claims can be submitted again. These free tiers are suitable for trying the site, not guaranteed always-on service.

1. Put the project in a **private** GitHub repository. `.env` and `.private` are excluded by `.gitignore`; never upload either.
2. Create a free Supabase project. In its SQL Editor, run the contents of `supabase-setup.sql` to make a private claims table.
3. In Supabase, copy the **Project URL** and a server-only **secret API key** (`sb_secret_...`). Do not put the secret key in website code or send it in chat.
4. In Render, create a Blueprint from the private repository. The included `render.yaml` selects the free plan and asks for the Supabase URL/key and Discord Client ID/Secret. `SESSION_SECRET` is generated automatically.
5. After Render gives the site its HTTPS address, add `https://YOUR-RENDER-SITE/auth/callback` to the Discord app's OAuth2 Redirects and save.
6. Visit the Render address to use the public WSF site.

The project folder is not yet connected to a GitHub repository. Also, automatic MajorX scores remain unavailable until authorized XR-Board API access is provided.
