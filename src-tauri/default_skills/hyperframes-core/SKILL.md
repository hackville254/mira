---
name: hyperframes-core
description: The HyperFrames composition contract, for building one renderable project. Use for composition structure, the data-* timing attributes, class="clip", tracks, sub-compositions, variables, framework-owned media playback, deterministic-render rules, and validation. Read before writing composition HTML.
---

# HyperFrames Core

The composition contract. Read this before writing any composition HTML.

## Key concepts

- **Structure**: a HyperFrames project is an HTML composition with a single
  paused timeline.
- **Timing attributes**: `data-*` attributes drive clip timing. Treat them as
  the source of truth for when elements appear and disappear.
- **Clips**: elements carrying `class="clip"` participate in the timeline.
- **Tracks**: lay out clips on tracks; one element kind per track, one caption
  track for captions.
- **Sub-compositions**: every scene should be a sub-composition for reuse.
- **Variables**: expose tunable values as composition variables.
- **Framework-owned media playback**: let the framework own media playback so
  renders stay deterministic.
- **Deterministic render rules**: no wall-clock time, no randomness; every
  render must seek to a time and produce the same output.

## Validation

Validate the composition before rendering. Fix errors rather than suppressing
them.
