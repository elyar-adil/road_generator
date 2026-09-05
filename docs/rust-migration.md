# Native Rust migration

The native path is now the product path. `city-core` owns deterministic city,
road, lane, junction, signal, marking, jurisdiction, and asset semantics.
`city-editor` owns the desktop `winit`/`wgpu` front end and can export the same
document for simulation or offline rendering.

```text
jurisdiction rules -> lane/movement graph -> signal phases and conflicts
                   -> metric markings -> geometry/material/asset backends
```

The jurisdiction profile changes driving side, signal orientation, arrow style,
lane dimensions, crossing dimensions, and turning-on-red policy. Building and
tree profiles are selected from the same profile, so a renderer never has to
guess a regional style from a texture name.

Run the deterministic export without a window:

```text
cargo run -p city-editor -- --jurisdiction china --out target/city.scene.json
cargo run -p city-editor -- --jurisdiction japan --out target/japan.scene.json
```

Run the native GPU bootstrap:

```text
cargo run -p city-editor -- --window
```

The current window draws the generated road skeleton as a validation slice.
PBR materials, terrain, lane marking meshes, traffic simulation, and sensor
passes consume the same IDs and are added incrementally; the existing Web
application is retained only as a migration reference until those passes have
native replacements.
