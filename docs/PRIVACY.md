# RoomSound privacy notice (deployment template)

> This is an implementation-ready template, not legal advice. Replace the
> bracketed contact and jurisdiction details and obtain legal review before
> accepting public users or payments.

## What RoomSound processes

- Account email address and a securely hashed password when account login is enabled.
- Session tokens stored as one-way hashes; the raw session token is not stored in the database.
- Room names, room membership identifiers, chat messages, moderation reports, blocks, bans, and subscription metadata.
- Operational data such as IP rate-limit state, connection status, error logs, and aggregate metrics.
- WebRTC signaling data needed to establish audio connections.
- If advertising is enabled, consent records and the advertising provider's
  identifiers/requests required to show sponsored placements.

RoomSound does not record or store room audio in this application. Audio may be
relayed by a configured TURN provider while a connection is active.

## Why it is processed

Data is used to authenticate accounts, operate rooms, deliver audio signaling,
prevent abuse, provide customer support, enforce subscriptions, keep the
service secure and available, and—only after the user opts in—serve sponsored
placements.

## Retention

Set and document retention periods before launch. The current implementation
keeps active room state in memory, stores durable account/room/moderation and
subscription records in PostgreSQL, and bounds in-process audit/log buffers.
Configure database backups and deletion jobs according to the final policy.

## Providers

List the hosting provider, PostgreSQL provider, TURN provider, email provider,
payment processor, monitoring provider, advertising provider, and any analytics
provider here before launch. Do not list a provider until it is actually enabled
for the deployment. The checked-in advertising adapter is disabled until a
publisher client, slot IDs, consent flow, and this notice are reviewed.

## User choices and requests

Users may request access, correction, export, or deletion by contacting
`[privacy contact email]`. Account deletion must revoke sessions and remove or
anonymize dependent records according to the final retention policy.

## Contact

Controller: `[legal entity]`  
Address: `[business address]`  
Privacy contact: `[privacy contact email]`  
Effective date: `[YYYY-MM-DD]`
