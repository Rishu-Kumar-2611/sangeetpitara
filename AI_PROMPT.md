# PROJECT BRIEF + AI PROMPT — "RoomSound" (working name)
### Live Audio Room: share my phone's sound with everyone in the room, with host-to-participant control handoff

> **How to use this file:** Copy everything between the `=== BEGIN PROMPT ===` and
> `=== END PROMPT ===` markers and paste it into the AI. Fill in the "DECISIONS I STILL
> NEED TO MAKE" section (Section 15) or just let the AI ask you about them.

---

=== BEGIN PROMPT ===

## 0. Your role and how I want you to work

You are a **senior realtime-audio + mobile engineer and technical co-founder**. I am a solo
developer/idea owner, not an expert in WebRTC or Android audio internals.

Rules for your answers:
- Be **blunt about what is technically impossible** on each platform. Do not invent APIs.
- Prefer **existing, battle-tested libraries and servers** over writing custom audio
  transport. Custom UDP/RTP stacks are out of scope.
- When you recommend something, give me the **tradeoff in one line** (latency vs cost vs
  effort vs platform support).
- Separate **"MVP / must work"** from **"nice to have later"**.
- Anything with a legal or platform-policy risk, flag it in a **RISK** callout.
- Ask me clarifying questions **before** producing large amounts of code.

## 1. The problem, in my own words

I am listening to music (or any audio) on my phone through my earbuds. My four friends want to
hear **exactly the same audio, at the same moment**, on their own phones. Today there is no
simple way to do that. Every "share audio" option out there shares *video*, or shares *my
microphone* (which only captures my voice, not the music), or makes them install something that
still can't hear my music.

I want an app where the sound comes from **my phone's audio output**, and everyone in the room
hears it live.

## 2. The product in one sentence

A **private live-audio room** where the **host's device audio is streamed to every listener in
real time**, and the **broadcasting right can be handed to another participant and taken back**
on demand.

## 3. Core user story (the story that must work end-to-end)

1. I install the app and create a room called "Movie Night". I am the **Host**.
2. I get a 6-character room code / invite link and send it to my four friends.
3. They join on their own phones. By default they are **Listeners** (they cannot broadcast).
4. I tap **"Share my device audio"**. The app asks for system permission to capture my phone's
   audio output. I approve.
5. I open Spotify / YouTube / my local player / a game — whatever I want — and press play.
6. All four friends hear it within about a tenth of a second of each other.
7. Friend #2 taps **"Request to play mine"**. I see a request in the room.
8. I tap **Approve**. Friend #2 becomes the **Active Broadcaster**; my stream pauses/mutes
   automatically; their phone's audio now plays for everyone.
9. I tap **"Take back control"**. Friend #2 is revoked; my audio resumes. No one leaves the room.

## 4. Role model

| Role | Can hear | Can broadcast | Can grant/revoke | Notes |
|---|---|---|---|---|
| **Host** | yes | yes | yes (always) | Room owner. Cannot be removed. Has a "take over" override. |
| **Co-host** | yes | yes | yes (delegated) | Optional. Host can promote/demote. |
| **Active Broadcaster** | yes | **yes** | no | A temporary state, not a permanent role. At most **one** at a time by default. |
| **Listener** | yes | no | no | Default role on join. Can send a broadcast *request*. |
| **Muted/Kicked** | no | no | no | Host moderation actions. |

Key rule: **broadcasting right is a short-lived, server-enforced permission**, not a client-side

## 5. Feature list

### P0 — MVP, must work end-to-end
- F1.  Account-less join: create/join room by code or link (nickname only).
- F2.  Room roster — live join/leave presence, each with a role badge.
- F3.  Host device-audio capture & broadcast (see Section 6 — the hardest part).
- F4.  Live playback on all listeners — low latency, jitter-buffered.
- F5.  Listen-only enforcement — listeners have no audio publishing path at all.
- F6.  Request to broadcast → Approve / Deny flow.
- F7.  Host "take back control" override at any moment.
- F8.  Per-listener self-mute + per-listener local volume slider.
- F9.  Host can mute / remove a participant.
- F10. Audio route awareness — detect headphones vs speaker; warn host if on speaker
      (feedback / echo risk).
- F11. Handles background / foreground, screen off, and network switch (4G-WiFi)
      without kicking the user out. Graceful reconnect after a brief drop.
- F12. Room ends when host leaves (configurable) or after an idle timeout.

### P1 — shortly after MVP
- F13. Text chat side-channel in the room.
- F14. Wait-in-lobby / knock-to-enter moderation.
- F15. Local recording of the broadcast (see legal risks, Section 13).
- F16. In-app music source — host picks tracks / URLs / files inside our app instead of
      capturing the OS. This is the iOS workaround and the highest-quality path.
- F17. Bluetooth-latency compensation — per-listener manual sync offset in ±ms.
- F18. Listen-together sync mode — everyone buffers and starts at an agreed wall-clock
      timestamp so all listeners are sample-aligned (for non-live sources).
- F19. Reactions / emotes, room capacity limits, host transfer of room ownership,
      scheduled rooms, invite expiry.

### P2 — later
- F20. Spatial / positional audio, audio quality modes, video, cross-room relay,
      monetization, soundboard clips, follower / following, room discovery.

flag. The client must never be trusted to decide whether it may publish audio.
