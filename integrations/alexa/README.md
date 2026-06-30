# Calling aura from Alexa

Drive a durable aura/Claude Code session by voice:

- **"アレクサ、オーラに `<なんとか>` って伝えて"** → injects that text into the
  session's Claude Code prompt and acks immediately.
- **"アレクサ、オーラに 返事は？"** → reads Claude's last message aloud.

It is two-phase on purpose: Claude Code takes minutes, Alexa wants an answer in
seconds, so "send" returns right away and you fetch the reply on a later
utterance (or just read it on the phone).

```
Echo  →  Alexa cloud  →  Cloudflare Worker (this dir)  →  Cloudflare Access
                                                              ↓
                                                        cloudflared
                                                              ↓
                                                     aura-server :8787  →  tmux
```

## Server endpoints this relies on

Added to aura-server (see `server/internal/input` and `server/internal/replies`):

| Method | Path                            | Purpose                                   |
| ------ | ------------------------------- | ----------------------------------------- |
| POST   | `/sessions/{id}/input`          | `{"text":"..."}` → `tmux send-keys` + Enter |
| GET    | `/sessions/{id}/last-reply`     | cached last assistant message (from Stop hook) |

Both are behind the existing `AURA_TOKEN` bearer auth. `last-reply` is populated
by the Stop hook you already wire up for mobile read-aloud — no extra Claude
config needed beyond `aura-server setup-hooks`.

Quick local sanity check (no Alexa needed):

```sh
curl -X POST localhost:8787/sessions/default/input \
  -H "Authorization: Bearer $AURA_TOKEN" \
  -d '{"text":"echo hello from alexa path"}'
# ...wait for the turn to finish, then:
curl localhost:8787/sessions/default/last-reply -H "Authorization: Bearer $AURA_TOKEN"
```

## 1. Expose aura with a Cloudflare Tunnel (+ Access)

On the home desktop:

```sh
cloudflared tunnel login
cloudflared tunnel create aura
# Route a hostname to the local server:
cloudflared tunnel route dns aura aura.example.com
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: aura
credentials-file: /home/you/.cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: aura.example.com
    service: http://localhost:8787
  - service: http_status:404
```

Run it as a service: `sudo cloudflared service install` (or a systemd unit
alongside `aura-server.service`).

**Lock it down with Access** (so only the Worker can reach aura, not the whole
internet): in the Cloudflare Zero Trust dashboard create an **Access
application** for `aura.example.com`, then a **Service Token**, and a policy that
allows that service token (Include → Service Token → the one you made). Copy the
Client ID/Secret for step 3.

## 2. Deploy the Worker

```sh
cd integrations/alexa/worker
npm install
npx wrangler deploy
```

Set secrets (don't commit them):

```sh
npx wrangler secret put AURA_BASE_URL        # https://aura.example.com
npx wrangler secret put AURA_TOKEN           # same token aura-server uses
npx wrangler secret put ALEXA_SKILL_ID       # filled in after step 3
npx wrangler secret put CF_ACCESS_CLIENT_ID      # from the Access service token
npx wrangler secret put CF_ACCESS_CLIENT_SECRET
```

`wrangler deploy` prints the Worker URL — that's your skill endpoint
(`https://aura-alexa.<subdomain>.workers.dev`).

## 3. Create the Alexa skill (developer.amazon.com → Alexa → Skills)

1. **Create Skill** → Custom model → **Provision your own** (host = your own
   endpoint, _not_ Alexa-hosted).
2. **Invocation name**: `オーラ` (or whatever; must match the interaction model).
3. **JSON Editor**: paste `interaction-model.ja-JP.json`, Save & Build.
4. **Endpoint** → HTTPS → paste the Worker URL. For the SSL cert option pick
   _"My development endpoint is a sub-domain of a domain that has a wildcard
   certificate from a certificate authority"_ (workers.dev qualifies).
5. Copy the **Skill ID** (`amzn1.ask.skill.…`) and set it as the Worker's
   `ALEXA_SKILL_ID` secret, then redeploy. This is what stops anyone else's
   skill (or a random POST) from driving your session.
6. **Test** tab → set stage to _Development_. Personal use needs **no
   certification** — your own Echo devices, signed into the same Amazon account,
   can use it immediately.

## Security note — read this

The endpoint can type into a live Claude Code session, so an unauthenticated POST
would be remote keystroke injection. The Worker rejects anything that isn't a
genuine, current request from **your** skill: it verifies Alexa's request
signature + cert chain, checks the timestamp (replay window 150s), and matches
the `applicationId` (`src/alexa-verify.ts`). Cloudflare Access in front of aura
is the second layer. Don't disable either. The bearer token alone is not enough,
because Alexa can't send custom headers on the request to your endpoint.

## Want Claude's reply pushed to you (no second utterance)?

Out of scope here, but the hook → Hub plumbing already exists. Either keep using
the mobile notification/read-aloud, or add an Alexa **Proactive Events** sender
fired from a Stop hook. Say the word and I'll wire it up.
```
