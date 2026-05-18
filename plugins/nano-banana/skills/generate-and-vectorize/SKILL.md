---
name: generate-and-vectorize
description: Use when the user wants to generate an image AND convert it to SVG in one step. Combines nano-banana MCP generation with png2svg vectorization pipeline.
user-invocable: true
allowed-tools: Read, Write, Bash, mcp__nano-banana__generate_image, mcp__nano-banana__edit_image
---

# Generate and Vectorize

Compound workflow: generate image via nano-banana MCP → vectorize to SVG via png2svg pipeline.

## When to Use

- "Generate a logo and make it SVG"
- "Create an icon and vectorize it"
- "I need a vector version of [concept]"
- Any request combining image generation + SVG output

## Workflow

### 1. Generate image

Use `mcp__nano-banana__generate_image` with user's prompt. Set `aspectRatio` to `1:1` for icons/logos unless user specifies otherwise. Save to a working directory (project's `./generated/` or `/tmp/`).

### 2. Vectorize

Apply png2svg skill pipeline:

**For flat art / logos / icons (most common):**
```bash
# Background removal (if needed)
rembg i generated/gen_*.png generated/nobg.png

# Vectorize (color)
vtracer --input generated/nobg.png --output generated/output.svg \
  --colormode color --hierarchical stacked \
  --filter_speckle 4 --color_precision 8 --corner_threshold 60

# Or monochrome (cleaner for simple logos):
convert generated/nobg.png -threshold 50% generated/bw.pbm
potrace generated/bw.pbm -s -o generated/output.svg --turdsize 5 --opttolerance 0.2
```

**Decision — color vs monochrome:**
- Icon/emblem with fills → `vtracer` (color)
- Line art / stamp / text → `potrace` (monochrome, cleaner curves)
- Ask user if unclear

### 3. Deliver

Report both files: raster (PNG) + vector (SVG). Show SVG path. If user wants refinement → use `mcp__nano-banana__edit_image` on the PNG, then re-vectorize.

## Tips

- Generate with flat colors, solid backgrounds, minimal gradients → cleaner vectors.
- Add to prompt: "flat design, solid colors, no gradients, clean edges" for better vectorization.
- `vtracer --filter_speckle 4` removes noise dots. Increase for noisy source.
- `potrace --turdsize 5` removes small blobs. Increase for cleaner output.
- If SVG is too complex (>500KB), reduce `--color_precision` or simplify source.
