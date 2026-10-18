# Abuse response runbook

1. Receive a report through `POST /api/moderation/reports` or the published
   abuse contact.
2. Verify the reporter identity and preserve only the minimum evidence needed
   to investigate. Do not record room audio.
3. Review the report category, room, target account, recent audit events, and
   active subscription state.
4. Apply the narrowest action: dismiss, remove from a room, create a room block,
   create a time-limited ban, or permanently suspend an account.
5. Record the decision, reason, actor, and timestamp in the audit system.
6. Notify the reporter when appropriate and follow the documented appeal path.
7. For copyright, child-safety, imminent-threat, or law-enforcement matters,
   escalate to `[designated safety/legal contact]` immediately.

The current backend exposes report, block, and administrator ban contracts and
persists them in PostgreSQL when `DATABASE_URL` is configured. Production
operators must still add an authenticated admin console or use an approved
internal API client; do not expose unrestricted moderation endpoints publicly.
