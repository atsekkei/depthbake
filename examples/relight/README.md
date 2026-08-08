# relight

Relights a photospace package with a cursor-driven point light. Each pixel's
world position is recovered from `depth.png` + `meta.json` and its world
normal from `normal.png`, then lit with Blinn-Phong; a short screen-space
raymarch against the depth surface adds contact shadows. `mask.png` attenuates
lighting on depth-discontinuity edges (where baked normals are unreliable) and
would exclude sky, had the photo any.

This is the example that exercises the opt-in `mask.png` / `normal.png` maps
(bake with `--mask --normal`). The same data can be derived at runtime instead
— see `computeNormals` / `GLSL_SNIPPETS.screenSpaceNormal` in
`photospace-runtime` — bundling just skips that cost.

With no pointer input the light orbits the subject with an exactly 5-second
period while its color temperature swings sunset ⇄ moonlight, so a 5-second
screen recording loops seamlessly. No UI is drawn.

## Run

```bash
pnpm dev:relight
```

Build / preview:

```bash
pnpm build:relight
pnpm preview:relight
```

## Recording the loop

Open the page, don't touch the mouse (after ~3 seconds the light settles onto
the autopilot orbit), and record any 5-second window. Aesthetic parameters
(ambient level, specular shape, shadow reach, orbit size, loop length, …) are
gathered in the constants block at the top of [`main.ts`](./main.ts).

## Photo credit

[`bust.photospace`](./bust.photospace) is baked from a photo by
[Evan Lee](https://unsplash.com/@evan_lee?utm_source=unsplash&utm_medium=referral&utm_content=creditCopyText)
on
[Unsplash](https://unsplash.com/photos/EdAVNRvUVH4?utm_source=unsplash&utm_medium=referral&utm_content=creditCopyText).
