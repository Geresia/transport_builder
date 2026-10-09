# B21-P2 optional construction-client envelope

`construction-3d-client-envelope.mjs` is the serialisable boundary a future
Unity WebGL or desktop loader uses after it has performed its own transport and
origin checks.  It does not load Unity, create an iframe, use a message port,
render, persist browser state, or mutate simulation state.

## Envelope

Every decoded message has schema
`transitline.construction-3d-client-envelope/1`, contract version `1`, an
explicit host-provided `sessionId`, one of these kinds, and a copied payload:

- `handshake`: the existing B21 adapter client descriptor;
- `scene`: the exact current B21 scene manifest sent only after launch is ready;
- `change-set`: a proposed B21 change set returned by the client;
- `close`: reserved lifecycle notification.

`parseConstruction3dClientEnvelope` rejects a mismatched session before a
payload reaches the launch/proposal path.  It does not generate random session
IDs; the host owns session lifetime and transport identity.

## Launch/proposal gate

`prepareConstruction3dClientLaunch` combines a decoded handshake with an
existing B24 preflight report.  It sends a scene envelope only if all of these
are true:

1. the preflight schema, source list, and audit are valid;
2. the client supplies all adapter capabilities;
3. every current 2D source is current, active, same-pack, and has stated pack
   provenance;
4. the B24 audit has no blocker.

Any failure returns `ready: false`, `fallback: "2d-only"`, no scene envelope,
and reason codes.  A client that is unavailable or incompatible is therefore a
normal fallback, not a hidden blocker for the 2D game.

`assessConstruction3dClientProposal` validates only a `change-set` envelope
against the same current scene facts.  It never applies a proposal or declares
construction approval.  A later host integration must pass an applicable
proposal into the existing 2D ownership/approval route.

## Verification

The envelope tests cover session/kind rejection, immutable ready-scene handoff,
unavailable-client and unknown-provenance fallback, stale change-set rejection,
and the explicit absence of apply/clock/cash work.
