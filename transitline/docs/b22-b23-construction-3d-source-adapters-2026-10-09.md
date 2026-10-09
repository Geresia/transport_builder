# B22-B23 construction 3D source adapters

`construction3dSourcesFrom2d` normalizes the current B13 rail geometry, station
site, depot site, and B19 new-town exports into B21 source identities. It copies
only supplied IDs, revisions, pack IDs, active flags, and geometry. Missing
identity is reported as a warning; no source ID is invented.

The result is suitable as `currentSources` for B21/B22/B24 checks and as scene
input after host coordinate selection. It does not build meshes or terrain,
interpret overlap as conflict, or decide cost, schedule, construction approval,
or any operational state.
