# Official-catalog / upstream nomination track

Companion to [openclaw-2.0-spec.md](./openclaw-2.0-spec.md) (decision 3, §8 Q3).
This is the non-code track: getting `@37signals/openclaw-basecamp` into
OpenClaw's trusted official external plugin catalog — or upstreamed as a
bundled channel — so the trust-gated runtime surfaces open up.

## Why we want it

As of openclaw 2026.8.1, `api.runtime.state.{openKeyedStore, openSyncKeyedStore,
openBlobStore, openChannelIngressQueue, openChannelIngressDrain}` and
`createChannelIngressMonitor` throw unless the plugin is bundled or present in
openclaw's *bundled* official external catalog (verified against
`loader`/`manifest-registry` in the shipped JS; install overrides do not confer
trust). That blocks:

- **Durable ingress queues + monitors** (SPEC §2.16) — ack-gated webhook
  ingestion with replay, instead of our at-most-once semaphore path.
- **Keyed/blob state stores** — shared `openclaw.sqlite` state instead of
  plugin-owned JSON files.

Until then we run the ungated equivalents (`persistent-dedupe`,
`ingress-effect-once`, `resolveStateDir` + `json-store`), with dedup behind a
ReplayGuard-shaped seam (SPEC §2.14) so a durable-ingress backend can slot in
without another rewrite.

## The catalog today

The trusted catalog ships inside openclaw
(`official-external-plugin-bundled-catalogs` chunk): ~140 `@openclaw/*`
packages plus 3 Tencent partner packages (the only non-`@openclaw` entries —
precedent for partner inclusion). There is no self-serve path and no
documented nomination process; entries are added by the openclaw maintainers
in-tree. ClawHub publication/verification is a separate, documented track
(`docs/plugins/community.md`, `/clawhub/publishing`) that does **not** confer
official trust — it's still worth doing for distribution hygiene.

## Tracks, in order of ambition

1. **ClawHub publish + verification** (self-serve, do first)
   - Prereqs: public GitHub repo (`basecamp/openclaw-basecamp`), setup/usage
     docs, `openclaw.build` metadata in package.json (done in the 2.0 upgrade),
     clean `clawhub package publish --dry-run`.
   - Outcome: discovery + install hints. No trust-gate change.
2. **Official external catalog entry** (maintainer decision)
   - The ask: add `@37signals/openclaw-basecamp` to the bundled catalog the way
     the Tencent partner packages are included.
   - Evidence to attach: the 2.0-idiomatic surface (turn kernel, ingress
     resolver, setup contract, doctor contract, generated `channelConfigs`),
     CI pack-install smoke, test suite size/coverage, 37signals as a named
     maintainer with production usage (Coworker).
3. **Upstream inclusion as a bundled channel** (per AGENTS.md, the long game)
   - The plugin was designed to be general-purpose ("any OpenClaw user could
     bind agents to Basecamp projects"). Bundling moves us inside the trust
     boundary entirely and puts the channel in `openclaw channels add`'s
     default list.

## Status

- [ ] 2.0 upgrade merged and released (prerequisite for any of the above)
- [ ] ClawHub dry-run publish clean
- [ ] ClawHub publish + verification
- [ ] Contact openclaw maintainers re: catalog entry (attach evidence bundle)
- [ ] Upstream nomination proposal

Owner: 37signals (Jeremy). Revisit after the 2.0 upgrade ships.
