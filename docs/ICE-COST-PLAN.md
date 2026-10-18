# ICE cost-reduction plan

## Decision

RoomSound now defaults to **STUN-only direct peer connections**. `TURN_ENABLED=0`
means `/config` publishes the free public STUN candidate source and no relay
credentials or relay URL. A relay remains an explicit compatibility switch:
set `TURN_ENABLED=1` together with `TURN_URLS`, `TURN_USERNAME`, and
`TURN_CREDENTIAL` only after network measurements justify the cost.

This removes relay traffic from the default app while keeping a reversible path
for users whose networks cannot form a direct WebRTC connection.

## Research findings

- [MDN: `RTCPeerConnection()`](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/RTCPeerConnection)
  documents `iceServers` as STUN and/or TURN servers. With no servers, ICE is
  limited to local peers; STUN provides server-reflexive candidates and TURN
  provides relay candidates.
- [MDN: WebRTC connectivity](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Connectivity)
  describes host, server-reflexive, peer-reflexive, and relay candidates. STUN
  discovers a public-facing candidate; it does not forward media between peers.
- [WebRTC.org: TURN server](https://webrtc.org/getting-started/turn-server)
  states that direct sockets are often impossible unless peers share a local
  network, and identifies TURN as the normal relay solution. It also lists
  self-hosted coturn and cloud services as the available choices.
- [coturn](https://github.com/coturn/coturn) is free open-source TURN/STUN
  software, but running it still requires a reachable host and pays the
  bandwidth/egress cost that this change is intended to avoid.
- [Tailscale DERP](https://tailscale.com/kb/1232/derp-servers) can relay
  encrypted traffic inside a Tailscale tailnet, but every participant must use
  the overlay network. It is not a transparent public-browser replacement for
  RoomSound's ICE relay.

## Options considered

| Option | Software cost | Works for arbitrary public users? | Decision |
| --- | ---: | --- | --- |
| STUN-only direct WebRTC | Free | No; restrictive NAT/CGNAT/firewalls can fail | Default now |
| Self-hosted coturn | Free software | Yes, if hosted and reachable | Optional later; bandwidth is not free |
| Tailscale/DERP or another VPN overlay | Often free for small groups | No; every device must join the overlay | Not suitable for public launch |
| Port forwarding/public IPs | Free software | No; requires user router control | Not suitable |
| Cloud TURN/SFU | Usually paid after a small trial | Yes | Keep as a measured fallback, not default |

There is no free STUN setting that guarantees direct connectivity for every
network. Removing TURN is therefore a cost reduction with a known connectivity
trade-off, not a universal relay replacement.

## Implemented rollout

1. Server default is STUN-only; TURN is opt-in with `TURN_ENABLED=1`.
2. Browser and Android continue fetching the same `/config` ICE list.
3. Browser failure messages no longer tell users to buy or add TURN; they explain
   that direct connectivity needs a reachable network.
4. Android uses the same STUN-only configuration and retains the endpoint and
   WebRTC signaling behavior.
5. Tests cover both explicit relay enablement and credentials present while the
   relay is disabled.

## Validation plan

Run two-peer audio tests in this order:

1. Same Wi-Fi, browser-to-browser.
2. Same Wi-Fi, Android-to-browser.
3. Different ordinary networks with direct UDP available.
4. Mobile/CGNAT or enterprise-firewall networks.

Record ICE candidate type (`host`, `srflx`, or `relay`), connection success,
time-to-audio, packet loss, and reconnect behavior. Keep STUN-only if the target
audience passes the required scenarios. Re-enable TURN only for the measured
failure segment, and estimate relay egress before launch.
