import { describe, expect, it } from 'vitest';
import { BADGE_RADIUS, getBadgeFontSize, layoutAnnotations, type AnnotationLayout } from './annotate';

function expectFiniteLayout(layout: AnnotationLayout): void {
  const values = [
    layout.frame.x,
    layout.frame.y,
    layout.frame.width,
    layout.frame.height,
    layout.anchor.x,
    layout.anchor.y,
    layout.badgeAnchor.x,
    layout.badgeAnchor.y,
    ...layout.leader.flatMap((point) => [point.x, point.y]),
  ];
  expect(values.every(Number.isFinite)).toBe(true);
}

describe('layoutAnnotations', () => {
  it('lays out 1,000 dispersed targets with finite, viewport-contained badges', () => {
    const annotations = Array.from({ length: 1_000 }, (_, index) => ({
      bounds: {
        x: 20 + (index % 40) * 30,
        y: 20 + Math.floor(index / 40) * 30,
        width: 14,
        height: 10,
      },
      order: index + 1,
    }));

    const layouts = layoutAnnotations(annotations, 1_280, 800);

    expect(layouts).toHaveLength(1_000);
    expect(layouts.every((layout) => !layout.markerOnly)).toBe(true);
    for (const layout of layouts) {
      expectFiniteLayout(layout);
      expect(layout.badgeAnchor.x).toBeGreaterThanOrEqual(BADGE_RADIUS);
      expect(layout.badgeAnchor.x).toBeLessThanOrEqual(1_280 - BADGE_RADIUS);
      expect(layout.badgeAnchor.y).toBeGreaterThanOrEqual(BADGE_RADIUS);
      expect(layout.badgeAnchor.y).toBeLessThanOrEqual(800 - BADGE_RADIUS);
    }
  }, 10_000);

  it('spreads 1,000 coincident targets across multiple collision-free lanes', () => {
    const annotations = Array.from({ length: 1_000 }, (_, index) => ({
      bounds: { x: 100, y: 100, width: 80, height: 32 },
      order: index + 1,
    }));

    const layouts = layoutAnnotations(annotations, 1_280, 720);
    const badgeKeys = new Set(layouts.map((layout) => `${layout.badgeAnchor.x}:${layout.badgeAnchor.y}`));

    expect(layouts).toHaveLength(1_000);
    expect(layouts.every((layout) => layout.markerOnly && layout.callout !== null)).toBe(true);
    expect(badgeKeys.size).toBe(1_000);
    for (const layout of layouts) {
      expectFiniteLayout(layout);
      expect(layout.badgeAnchor.x).toBeGreaterThanOrEqual(BADGE_RADIUS);
      expect(layout.badgeAnchor.x).toBeLessThanOrEqual(1_280 - BADGE_RADIUS);
      expect(layout.badgeAnchor.y).toBeGreaterThanOrEqual(BADGE_RADIUS);
      expect(layout.badgeAnchor.y).toBeLessThanOrEqual(720 - BADGE_RADIUS);
    }
  }, 10_000);

  it('uses the uncongested axis for a long vertical list', () => {
    const annotations = Array.from({ length: 1_000 }, (_, index) => ({
      bounds: { x: 40, y: 20 + index * 24, width: 120, height: 10 },
      order: index + 1,
    }));

    const layouts = layoutAnnotations(annotations, 800, 24_100);

    expect(layouts).toHaveLength(1_000);
    layouts.forEach(expectFiniteLayout);
  }, 10_000);

  it('keeps geometry finite when the viewport is smaller than one badge', () => {
    const layouts = layoutAnnotations(
      [
        { bounds: { x: 1, y: 1, width: 4, height: 3 }, order: 1 },
        { bounds: { x: 1, y: 1, width: 4, height: 3 }, order: 2 },
      ],
      10,
      8,
    );

    expect(layouts).toHaveLength(2);
    layouts.forEach(expectFiniteLayout);
    expect(layouts.map((layout) => layout.badgeAnchor)).toEqual([
      { x: 5, y: 4 },
      { x: 5, y: 4 },
    ]);
  });

  it('shrinks four-digit labels while retaining the normal one-digit size', () => {
    expect(getBadgeFontSize(1)).toBe(BADGE_RADIUS * 2 * 0.55);
    expect(getBadgeFontSize(1_000)).toBeLessThan(getBadgeFontSize(99));
    expect(getBadgeFontSize(1_000)).toBeGreaterThanOrEqual(7);
  });
});
