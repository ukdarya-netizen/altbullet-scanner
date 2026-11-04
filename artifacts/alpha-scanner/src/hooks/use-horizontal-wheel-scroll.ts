import { useEffect } from "react";

const HORIZONTAL_SELECTOR = ".overflow-x-auto, [data-horizontal-wheel-scroll]";
const VERTICAL_OVERFLOW = new Set(["auto", "scroll"]);

/**
 * Let a regular mouse wheel navigate wide metric tables without changing
 * native trackpad horizontal scrolling or trapping page scrolling at the ends.
 */
export function useHorizontalWheelScroll() {
  useEffect(() => {
    const onWheel = (event: WheelEvent) => {
      if (
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        !event.deltaY ||
        Math.abs(event.deltaX) > Math.abs(event.deltaY) * 0.25 ||
        !(event.target instanceof Element) ||
        event.target.closest(
          "input, textarea, select, [contenteditable], [role='slider']",
        )
      ) {
        return;
      }

      if (!event.target.closest(HORIZONTAL_SELECTOR)) return;

      const direction = Math.sign(event.deltaY);
      for (
        let element: Element | null = event.target;
        element && element !== document.body;
        element = element.parentElement
      ) {
        if (!(element instanceof HTMLElement)) continue;

        const style = getComputedStyle(element);
        // A vertically scrollable inner panel keeps its native wheel behavior.
        if (
          VERTICAL_OVERFLOW.has(style.overflowY) &&
          element.scrollHeight > element.clientHeight + 1 &&
          (direction > 0
            ? element.scrollTop <
              element.scrollHeight - element.clientHeight - 1
            : element.scrollTop > 1)
        ) {
          return;
        }

        if (!element.matches(HORIZONTAL_SELECTOR)) continue;
        if (
          !VERTICAL_OVERFLOW.has(style.overflowX) ||
          element.scrollWidth <= element.clientWidth + 1
        )
          continue;

        const delta =
          event.deltaY *
          (event.deltaMode === WheelEvent.DOM_DELTA_LINE
            ? 16
            : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
              ? element.clientWidth
              : 1);
        const maxScroll = element.scrollWidth - element.clientWidth;
        const next = Math.max(
          0,
          Math.min(maxScroll, element.scrollLeft + delta),
        );

        if (Math.abs(next - element.scrollLeft) > 0.5) {
          event.preventDefault();
          element.scrollLeft = next;
        }
        // At the horizontal boundary, let the wheel scroll the page normally.
        return;
      }
    };

    document.addEventListener("wheel", onWheel, { passive: false });
    return () => document.removeEventListener("wheel", onWheel);
  }, []);
}
