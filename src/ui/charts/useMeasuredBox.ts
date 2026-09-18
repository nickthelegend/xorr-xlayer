/**
 * useMeasuredBox — the reason no chart in here holds a pixel.
 *
 * design.md §6 authors every candle in price space and projects to a percentage of the
 * plot box. To turn that percentage into something SVG can draw, a chart needs to know
 * how big it actually got — which is a layout fact, not a design value. So each chart
 * measures itself and multiplies.
 */
import { useCallback, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';

export interface Box {
  width: number;
  height: number;
}

export function useMeasuredBox(): [Box, (e: LayoutChangeEvent) => void] {
  const [box, setBox] = useState<Box>({ width: 0, height: 0 });

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setBox((prev) =>
      prev.width === width && prev.height === height ? prev : { width, height },
    );
  }, []);

  return [box, onLayout];
}

/** Column geometry for a series of `count` items separated by `gap`. */
export function columns(
  width: number,
  count: number,
  gap: number,
): { columnWidth: number; xOf: (index: number) => number } {
  const columnWidth = count > 0 ? Math.max(0, (width - gap * (count - 1)) / count) : 0;
  return {
    columnWidth,
    xOf: (index: number) => index * (columnWidth + gap),
  };
}
