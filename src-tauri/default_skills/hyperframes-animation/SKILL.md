---
name: hyperframes-animation
description: All animation knowledge for HyperFrames - atomic motion rules, multi-phase scene blueprints, scene transitions, broader motion-design techniques, and the seven runtime adapters (GSAP default, plus Lottie, Three.js, Anime.js, CSS keyframes, Web Animations API, TypeGPU). Use for any motion or animation task, to audit an existing composition's choreography, or for the 24 named text-animation effects.
---

# HyperFrames Animation

Motion and animation knowledge for HyperFrames. Native: single paused
timeline, seek-safe, deterministic.

## How to use

- Pick 2 to 4 atomic motion rules and compose them, or load a multi-phase scene
  blueprint.
- Look up runtime-specific API when needed: GSAP (default), Lottie, Three.js,
  Anime.js, CSS keyframes, Web Animations API, TypeGPU.
- Audit an existing composition's choreography with an animation map.
- 24 named text-animation effects are available for text reveals.

## Rules

- Every animation must be seek-safe: seeking to any time reproduces the exact
  frame.
- Never rely on wall-clock time or unseeded randomness.
