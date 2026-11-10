# Knowledge and providers

New screens: History, People, Repairs, Evidence. Connections now includes Slack,
Mastodon, Spotify, Shopify Storefront and Home Assistant. All model calls remain
GPT-6 Luna. Adapters are not connected accounts until authorization succeeds.

## History

SQLite FTS5 indexes every retained local message, including history older than
the recent 1,000-message listing. Startup backfills legacy messages, and database
triggers synchronize inserts, edits and deletes. This covers this app's history,
not ChatGPT or other applications.

Meaning search uses up to two Luna calls: expand the query into up to 12 related
phrases, then rank up to 10 IDs from 20 indexed candidates. Usage counts against
the existing budget. This is semantic query expansion/ranking over a full-text
index, **not a vector embedding index**; recall depends on bounded candidates.
No additional embedding model was introduced. Results retain message IDs and
timestamps. Changed/deleted sources and concurrent forgetting invalidate stale
results. Raw history remains retained by default when forgetting saved claims;
the existing include-source-messages option removes known source messages and
their index entries when explicitly requested.

## People and groups

Reviewed nodes hold name, type, aliases, context, source IDs and revision history.
Directed relationships have their own sources. Sources must be existing message
or memory IDs, or `user` for a direct reviewed entry. Updates require the expected
revision. Source corrections invalidate old summaries and mark dependent graph
entries/links for review; those are withheld from agent context until corrected.
Relevant names/aliases inject bounded relationship context into chat.
Agents can search, but cannot edit this graph. There is no automatic identity
inference or name-based merging. Listings cap at 200 nodes and 1,000 edges.

Graph deletion removes links and versions; raw chat and saved memories are
separate. Memory forgetting removes graph copies by provenance, including older
versions, and exact known text, plus associated repairs/source-report copies.
This remains a recorded-copy pipeline, not erasure of all paraphrases/backups.

## Freshness and repair

Changes-only research schedules re-read up to six public sources before delivery.
Each observation records its own time, resolved URL, content hash and bounded
excerpt. Temporary tabs are closed. Unknown publication dates stay unknown:
a recent fetch does not establish a recent event, price or legal rule.

Luna reviews material claims against those excerpts. Missing, failed, stale or
future observations, invalid references, incomplete review, contradictions and
insufficient support hold the update and open a repair thread. Observation times
are checked again after model review. Time-sensitive claims whose publication or
effective dates cannot be assessed should remain insufficient. Manual browser
control blocks reads. Evidence can run the same review explicitly. This is
bounded model-based support review, not independent proof of truth or a complete
publication/effective-date extraction engine. Explicit every-occurrence reminders
retain their existing behavior.

Corrections, background failures and held reviews create durable repairs,
deduplicated by kind/subject while open. Transitions: open → reviewing/dismissed;
reviewing → resolved/dismissed/open; resolved/dismissed → open. Every transition
requires a note and matching revision. Resolution needs an existing message,
memory, task or report ID, or a public HTTP(S) URL. URL evidence is owner-attested,
not automatically fetched or certified. Repair review does not send, retry tasks,
replay uncertain actions or rewrite memory. Perform the concrete fix using the
existing controls, then record evidence.

## Provider coverage

| Provider | Reads | Reviewed writes | Authorization |
| --- | --- | --- | --- |
| Slack | Up to 15 channels/messages; exact conversation ID | Plain-text message to exact conversation | Installed app/account token; membership/scopes apply |
| Mastodon | Up to 15 home-timeline posts | Post with explicit visibility | Authorized token for configured HTTPS instance |
| Spotify | Current item and up to 15 saved tracks | None | PKCE OAuth, one-use expiring state, serialized refresh |
| Shopify Storefront | Up to 10 products, observed price/currency | None; no carts, payments or checkout | Storefront public token for configured shop |
| Home Assistant | One exact entity's state; attributes excluded | None; no device/lock/alarm control | Long-lived token for configured trusted installation |

Enter tokens only in Connections; Spotify uses its consent page. Identity checks
precede provider-bound AES-GCM storage outside model workspace/context. Status
reports stored identity/last verification, not a live permission check or proof
that every operation's scope works. Origins cannot be overridden in agent tools.
Home Assistant allows your explicitly configured trusted LAN origin, not generic
private browsing. Provider content stays untrusted and social HTML is not rendered.

Slack/Mastodon proposals bind exact content, destination/audience, origin,
identity and connection generation. Reconnecting invalidates old proposals.
Existing digests, execution claims, uncertain outcomes and replay protections
apply. Mastodon also gets the approval ID as its idempotency key. Connecting or
proposing never sends; writes are not automatically retried. Disconnect removes
local credentials; revoke the remote grant separately when desired.

## Setup and acceptance

No new dependencies are required. Stop the previous server, then run:

```powershell
npm run check
npm test
npm run build
npm run dev
```

In another terminal, with chat/background work idle:

```powershell
npm run test:knowledge
```

The synthetic smoke test makes three short model runs: chat, query expansion and
ranking. It checks graph provenance/revisions, history retrieval, repair evidence,
an unsourced-update hold and a credential-free provider catalogue. Temporary
graph/memory fixtures are removed. Synthetic chat and some review audit records
remain. It performs no provider account writes. Real source support review and
provider access remain separate live gates.

Configure only desired providers in `.dev.vars` and restart:

```dotenv
SPOTIFY_CLIENT_ID=
MASTODON_BASE_URL=https://your-instance.example
SHOPIFY_STORE=your-store.myshopify.com
HOME_ASSISTANT_BASE_URL=http://your-trusted-installation:8123
```

Register Spotify callback `http://127.0.0.1:8787/oauth/spotify/callback`, adjusting
the port. App/account eligibility and development-mode rules apply. Slack needs
`channels:read`, `channels:history`, and `chat:write` for sends; other conversation
types need corresponding scopes/membership. Mastodon needs authorized account
and status reads, plus status writes if desired. Shopify uses a Storefront public
token, not an Admin API token. Home Assistant uses a long-lived account token.

## API and agent tools

- `GET /api/history/index`; `POST /api/history/search` with `{query,semantic}`.
- `GET/POST /api/people`; `PATCH/DELETE /api/people/:id`;
  `GET /api/people/:id/lineage`; `POST /api/people/relationships`;
  `DELETE /api/people/relationships/:id`.
- `GET/POST /api/repairs`; `PATCH /api/repairs/:id`.
- `GET /api/freshness`; `POST /api/freshness/verify` with `{text,maxAgeSeconds?}`.
- `GET /api/connections` includes provider catalogue/status.
- `POST /api/connections/:provider/authorize` with `{token}` for manual tokens.
- `POST /api/connections/spotify/start`; state-validated public OAuth callback.
- `POST /api/connections/:provider/read` with supported action/arguments.
- `DELETE /api/connections/:provider` removes local authorization.
- Existing action API adds `slack.send` and `mastodon.publish`.

Read-only workflow agents may call `history_search`, `people_search` and
`provider_read`; they cannot authorize accounts or propose sends. API bearer
authentication is unchanged. Spotify callback checks one-use OAuth state.

## Primary references consulted

- https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow
- https://developer.spotify.com/documentation/web-api/concepts/redirect_uri
- https://developer.spotify.com/documentation/web-api/concepts/scopes
- https://docs.slack.dev/reference/methods/auth.test/
- https://docs.slack.dev/reference/methods/conversations.history/
- https://docs.slack.dev/reference/methods/chat.postmessage/
- https://docs.joinmastodon.org/client/authorized/
- https://shopify.dev/docs/api/storefront/2026-10
- https://developers.home-assistant.io/docs/api/rest/

The earlier live Python checks describe the baseline. New provider tests use
mocked HTTP, not real account grants, scopes or delivery. No VM or hosted
Cloudflare deployment was introduced.
