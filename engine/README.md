# Spud Engine

A small game engine with an Unreal-style editor. It runs in the browser and is
built for low-end hardware: old laptops, Intel HD graphics, cheap Chromebooks
and phones. It aims for a **PS3-era look**: low-poly assets, small textures,
per-vertex or Blinn-Phong lighting, cheap bloom and baked terrain lighting. It
also includes an **automatic rigging tool** that turns a static humanoid model
into an animated, playable character.

No install and no GPU drivers to fight: open `index.html` and the editor runs.
Packaged games are **one HTML file** that plays offline, from a USB stick or
from any static web host.

```
engine/
  index.html           editor shell (open this)
  app/editor.js        built editor bundle (committed, so file:// works without Node)
  css/editor.css
  src/core/            runtime: renderer, quality presets, world, physics, blueprints, auto-rig …
  src/editor/          editor UI: viewport, panels, blueprint graph, auto-rig tool, packager
  src/player/          packaged-game boot (title screen, quality menu)
  tests/               node --test suites (auto-rig, blueprints, physics, terrain, projects)
  tools/build.mjs      esbuild bundler      tools/serve.mjs   zero-dependency dev server
```

## Running it

```bash
# Option 1: no tooling at all
open engine/index.html            # or double-click it

# Option 2: dev server (needed if your browser blocks file:// IndexedDB)
cd engine && npm install && npm run dev   # http://localhost:8080

npm run build     # rebuild app/editor.js after editing src/
npm test          # 16 tests, < 1 s
```

You need a browser with WebGL2: any Chrome, Edge or Firefox from 2020 on, or
Safari 15+.

## What is in it (UE5 feature → Spud equivalent)

| Unreal Engine 5 | Spud Engine |
|---|---|
| Level editor: viewport, Place Actors, Outliner, Details, Content Browser, Output Log | Same layout. Translate/rotate/scale gizmo (W/E/R), world/local space, grid snap, right-mouse + WASD fly camera, Alt-orbit, F to focus, G for game view, multi-level undo/redo, duplicate (Ctrl+D) |
| Play In Editor | **Play** (Alt+P): character with run, jump, camera collision and HUD. Esc stops |
| Game mode templates | Third Person, First Person, Top Down, Side Scroller (2.5D), set in World Settings |
| Blueprints | Node-graph visual scripting: 37 nodes (events, flow control, movement, physics, player, HUD, variables, sound, camera shake, win/lose) plus 7 one-click templates (spin, jump pad, moving platform, damage zone, win zone, HUD score, explode on key) |
| Landscape + sculpt/paint | Heightmap terrain with raise, lower, smooth, flatten, noise and 3 paint layers. Procedural generation and **baked lighting** (per-vertex, so zero runtime cost) |
| Foliage tool | Instanced foliage scatter (trees, pines, bushes, rocks, grass) that snaps to the landscape and thins out automatically on low settings |
| Niagara | CPU particle emitters (fire, smoke, sparks, magic, rain, snow) that scale with quality |
| Nanite / LOD | **Auto LOD**: imported meshes get simplified LODs and distance culling |
| Lumen / lights | Directional (with a camera-following shadow frustum), point and spot lights, hemisphere ambient, exponential fog, sky gradient |
| Scalability settings | 4 presets (**Potato / Low / PS3 / High**), auto-detected from the GPU, plus **dynamic resolution** that holds the target FPS |
| Chaos physics | Lightweight character controller (step-up, slopes, ledges, ceilings) and box/mesh collision. Dynamic crates and barrels that the player can push |
| Skeletal meshes + animation | glTF/FBX skinned meshes with their own clips, or procedural idle/walk/run/jump/wave for any humanoid rig (Mixamo names recognised) |
| (Mixamo / AccuRig, external) | **Built-in Auto-Rig**, see below |
| Package project | **Package Game** → one self-contained `.html` (≈ 900 KB runtime + your assets) with title screen, quality menu and FPS counter |
| Import | `.glb`, `.fbx`, `.obj`, textures `.png/.jpg/.webp`, sounds `.mp3/.wav/.ogg`. Drag-and-drop into the viewport; unit scale (cm/mm) detected; heavy meshes flagged |
| Save | `.spud` project files (a single JSON with embedded assets) plus autosave to the browser |

**Not included.** Some things are out of reach for a browser engine aimed at
potato hardware, and are deliberately left out: Nanite-style virtualised
geometry, Lumen GI, MetaHumans, the C++ API, multiplayer replication, a
Sequencer/cinematics timeline, a material node editor (materials are
parameter-based instead), and console export. The architecture keeps these
areas open (for example, Blueprint nodes are data-driven, and so are the actor
types).

## Quality presets

| | Potato | Low | PS3 | High |
|---|---|---|---|---|
| Resolution | 50 %, ≤ 480p | 75 %, ≤ 600p | 100 %, ≤ 720p | 100 %, ≤ 1440p + MSAA |
| Shading | per-vertex Lambert | per-vertex Lambert | Blinn-Phong + specular | PBR |
| Shadows | off | 512² | 1024² | 2048² |
| Max texture | 128 px | 256 px | 512 px | 1024 px |
| Bloom / post | off | post only | on | on |
| Draw distance | 90 m | 160 m | 280 m | 500 m |
| Foliage / particles | 35 % / 30 % | 60 % / 60 % | 100 % | 100 % |

Textures are downscaled when they load, and fog hides the draw-distance cut-off.
On top of the presets, dynamic resolution lowers the render scale when the
frame rate drops below the target, and raises it again when there is headroom.

## Auto-Rig

**Tools → Auto-Rig**, or right-click a model in the Content Browser.

1. **Model:** pick an imported mesh. It is normalised to 1.8 m, feet on the
   ground, facing +Z. Rotation and scale buttons fix models exported facing
   the other way.
2. **Markers:** chin, wrists, elbows, groin and knees are **detected
   automatically** from the mesh silhouette. This takes about 30 ms and works
   for T-pose and A-pose. Drag any marker to correct it, with optional mirror
   editing.
3. **Rig & Test:** a 19-bone humanoid skeleton is built and every vertex is
   skinned. Weights come from body-region masks, bone-distance falloff and
   Laplacian smoothing across the surface, with the top 4 influences kept. You
   can preview idle, walk, run, jump and wave, and view each bone's weights as
   a heat map.
4. **Save:** as the Player Character, placed as an NPC, kept in the Content
   Browser, or downloaded as a `.glb` for Blender, Unity or Godot.

The tool works best on a single-piece humanoid model with separated arms and
legs, like the models you get from Mixamo, AccuRig or Blender. Clothing that
bridges the legs (long robes) may need the markers adjusted by hand.

## Making a game in 2 minutes

1. **File → New → Third Person template**, or start with an empty level.
2. Drag in actors from **Place Actors**. Select one to edit it in **Details**.
3. Select the Coin and choose **Edit Blueprint** to see how gameplay is wired:
   *On Overlap → add 1 to `coins` → play sound → print → destroy*.
4. Import your character, **Auto-Rig** it, then choose **Save & use as Player
   Character**.
5. Press **Play** to test in the editor. When you're done, choose **Package** to
   get `MyGame.html`.

## Implementation notes

* The renderer is three.js (WebGL2), bundled with esbuild into a single classic
  script, so the editor works from `file://` with no server.
* The player runtime is compiled separately, then embedded as a string in the
  editor bundle. That is how Package works offline.
* Materials are generated per quality preset: Lambert, Phong or Standard, with
  the same parameters, so one project scales from Potato to High.
* Tests cover the auto-rigger (marker detection on the mannequin and on an
  A-pose figure in centimetres facing away, weight normalisation, dominant-bone
  sanity), the Blueprint interpreter, terrain brushes and serialisation, the
  character controller, light-leak regressions and project templates.
