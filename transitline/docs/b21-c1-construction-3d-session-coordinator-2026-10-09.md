# B21-C1 optional 3D session coordinator

`assessConstruction3dSession` is the host-side gate before an optional Unity/WebGL or desktop 3D loader is offered a B21 scene manifest. It checks the existing adapter handshake plus exact pack, coordinate, active-source, and revision identity.

It returns `3d-available` only when every supplied fact is current. Any unavailable/incompatible client, missing scene, or changed source returns `2d-only`; this is a fallback state, not a game error. The function does not load a binary, initialize WebGL, call Unity, apply a change set, approve construction, or mutate cash, clock, demand, or state.

`construction3dCoordinatorDocument` is safe for an integrated save: it retains selected IDs and client identity only, never a renderer, binary, scene geometry, or GPU/WebGL runtime object. A future loader may use the result as its preflight contract, but must still keep 2D as the authority and re-check current source revisions before accepting a returned proposal.
