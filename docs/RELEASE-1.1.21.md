# SangeetPitara 1.1.21

## No limit on room size

Rooms no longer stop at 10 people, for online rooms and for offline hotspot
(Play Close) rooms. The website and app now say "Live, with everyone you
invite."

Server-wide safety caps still protect the free server, and can be changed
in the Render environment without a new release:

- `MAX_CONNECTIONS` (default 200): everyone connected to the server at once,
  across all rooms.
- `MAX_CONNECTIONS_PER_IP` (default 20): connections from one network address.
  People on the same Wi-Fi often share one address, so raise this for big
  gatherings in one place.

Offline hotspot rooms are still limited by how many devices the phone's
hotspot accepts (often about 10). Direct (non-relay) audio mode was designed
for small rooms; keep the relay on (`MEDIA_RELAY_ENABLED=1`, the default) for
large rooms.

## Compatibility

Older apps keep working. `/config` now reports `maxMembers: null`. Version
1.1.21 / versionCode 10121 / shared asset cache 20261109-rooms1. No database
migration.
