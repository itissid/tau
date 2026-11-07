# Tau Domain

Tau gives browser clients access to terminal-owned Pi sessions without transferring ownership away from the running Pi process. Tau Hub optionally gives multiple live Tau Mirrors a single browser entry point.

## Language

**Tau**:
The product comprising the Tau Extension, Tau Browser Client, and optional Tau Hub. Use the specific component name whenever ownership or runtime boundaries matter.
_Avoid_: Tau server, Tau client

**Terminal-Owned Pi Session**:
A Pi agent session whose authoritative state and lifecycle remain with its owning Pi process. Tau presents and controls that same session; it does not create a parallel browser-owned or Hub-owned session.
_Avoid_: Tau session, browser session, Hub session

**Tau Extension**:
The Pi-integrated component that creates and maintains a Tau Mirror for its owning Pi process.
_Avoid_: Tau Hub, browser server

**Tau Mirror**:
The live projection and control surface for a Pi process's current session. A mirror follows the Pi process, so changing that process's active session does not create a new mirror.
_Avoid_: per-session mirror, Tau instance, Tau session

**Tau Browser Client**:
The web interface through which a person views and controls a Tau Mirror. It attaches to a mirror and does not own a separate Pi session.
_Avoid_: Tau client, session owner

**Tau Hub**:
An optional, separately managed gateway that provides one browser origin for discovering and reaching multiple live Tau Mirrors. It starts no Pi process and owns neither mirrors nor Pi sessions.
_Avoid_: Tau server, mirror server, session server, Tailscale server

**Tau Interaction Path**:
The bidirectional path that carries mirror state and events to a Tau Browser Client and carries client commands back to the Tau Mirror. Routing components may mediate this path but do not become owners of the Pi session.
_Avoid_: notification path, notification acknowledgement

**Notification Path**:
A one-way attention path that reports a pending Tau event to a person's device and may deep-link back to a Tau Mirror. Delivery or opening of a notification does not resolve the underlying Pi request; resolution happens through the Tau Interaction Path.
_Avoid_: WebSocket acknowledgement, Pi command path

**Safety Notification**:
A bounded, transport-neutral projection of one pending Pi safety request whose purpose is to get a person's attention and return them to the exact Tau Mirror. It carries no authority to approve or deny the request.
_Avoid_: approval command, generic Tau notification, notification session

**Notification Arrival Acknowledgement**:
Evidence that a person followed a Safety Notification into Tau and the matching actionable dialog became visible. It is neither a device-delivery receipt nor resolution of the Pi safety request.
_Avoid_: delivery acknowledgement, approval acknowledgement, page-load acknowledgement

**Deployment Adapter**:
Environment-owned wiring that lets Tau Hub discover and reach Tau Mirrors and publishes the Hub through the chosen access layer. It belongs to the environment that owns the Pi processes, not to Tau itself.
_Avoid_: Tau Hub configuration
