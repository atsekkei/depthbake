# depth-splats

Renders a photospace package as a depth-placed point cloud. The photo is
importance-sampled into ~90k particles (denser where luminance gradients are
high), each point is projected back to world space from `depth.png` +
`meta.json` via `photospace-runtime`, and drawn as soft Gaussian splats with a
cursor-following parallax camera.

Intended as the hero demo for the README video: with no pointer input the
camera follows a figure-eight orbit with an exactly 5-second period, so a
5-second screen recording loops seamlessly. No UI is drawn.

## Run

```bash
pnpm dev:depth-splats
```

Build / preview:

```bash
pnpm build:depth-splats
pnpm preview:depth-splats
```

## Recording the loop

Open the page, don't touch the mouse (after ~3 seconds the camera settles onto
the autopilot orbit), and record any 5-second window. Aesthetic parameters
(point overlap, splat sharpness, parallax amplitude, loop length, …) are
gathered in the constants block at the top of [`main.ts`](./main.ts).

## Photo credit

[`maiko.photospace`](./maiko.photospace) is baked from a photo by
[Tianshu Liu](https://unsplash.com/ja/@tianshu?utm_source=unsplash&utm_medium=referral&utm_content=creditCopyText)
on
[Unsplash](https://unsplash.com/ja/%E5%86%99%E7%9C%9F/%E5%BB%BA%E7%89%A9%E3%81%AE%E8%BF%91%E3%81%8F%E3%81%A7%E7%9F%B3%E6%B2%B9%E5%82%98%E3%82%92%E6%8C%81%E3%81%A4%E5%A5%B3%E6%80%A7-khQY5Eu-aa0?utm_source=unsplash&utm_medium=referral&utm_content=creditCopyText).
