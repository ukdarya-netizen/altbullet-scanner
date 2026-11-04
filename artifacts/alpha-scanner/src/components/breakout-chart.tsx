import React, { useEffect, useRef, useState } from "react";

export interface ChartCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ChartPivot {
  index: number;
  time: number;
  price: number;
  kind: "high" | "low";
}

export interface ChartLevel {
  price: number;
  touches: number;
}

export interface ChartTrendline {
  startIndex: number;
  endIndex: number;
  startPrice: number;
  endPrice: number;
  kind: "resistance" | "support";
}

export interface ChartRetestZone {
  fromIndex: number;
  toIndex: number;
  level: number;
}

export interface ChartBreakoutZone {
  lower: number;
  upper: number;
}

export interface ChartBreakoutLifecycle {
  breakoutIndex: number;
  endIndex: number;
  retestIndices: number[];
}

export interface ChartAbNeonOverlay {
  support: number | null;
  resistance: number | null;
  range: { upper: number; lower: number; state: string } | null;
}

export interface ChartRangeDetectorOverlay {
  status: "ready" | "unknown";
  activeConfirmedRange: {
    upper: number;
    lower: number;
    anchorAt: number;
  } | null;
  latestUpsideBreakout: {
    upper: number;
    lower: number;
    anchorAt: number;
    breakoutCloseTime: number;
  } | null;
}

export interface BreakoutChartProps {
  candles: ChartCandle[];
  timeframeMs?: number;
  showVolume?: boolean;
  pivots?: ChartPivot[];
  levels?: ChartLevel[];
  trendline?: ChartTrendline | null;
  retestZone?: ChartRetestZone | null;
  breakoutLevel?: number | null;
  breakoutTolerance?: number | null;
  breakoutZone?: ChartBreakoutZone | null;
  lifecycle?: ChartBreakoutLifecycle | null;
  eventKind?: "horizontal" | "trendline" | "both" | "none";
  breakoutSource?: "horizontal" | "trendline" | "none";
  quietZone?: boolean;
  eventIndex?: number | null;
  eventLabel?: string;
  abNeon?: ChartAbNeonOverlay | null;
  rangeDetector?: ChartRangeDetectorOverlay | null;
  abNeonLabel?: string;
}

function formatPrice(p: number | null | undefined): string {
  if (p == null) return "—";
  if (p < 0.01) return p.toPrecision(4);
  if (p < 1) return p.toFixed(4);
  if (p < 100) return p.toFixed(2);
  return p.toFixed(1);
}

export function BreakoutChart({
  candles,
  timeframeMs = 4 * 60 * 60_000,
  showVolume = false,
  pivots,
  levels,
  trendline,
  retestZone,
  breakoutLevel,
  breakoutTolerance,
  breakoutZone,
  lifecycle,
  eventKind = "none",
  breakoutSource = "none",
  quietZone = false,
  eventIndex,
  eventLabel,
  abNeon,
  rangeDetector,
  abNeonLabel = "текущий срез",
}: BreakoutChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 400 });

  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver((entries) => {
      if (entries[0]) {
        setSize({
          w: entries[0].contentRect.width,
          h: entries[0].contentRect.height,
        });
      }
    });
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  const { w, h } = size;
  const padX = 10;
  const padY = 20;
  const yAxisW = 60;
  const drawW = Math.max(1, w - padX - yAxisW);
  const volumeH = showVolume ? Math.min(65, h * 0.2) : 0;
  const axisH = showVolume ? 24 : 0;
  const drawH = Math.max(
    1,
    h - padY * 2 - volumeH - axisH - (showVolume ? 15 : 0),
  );

  const len = candles.length;
  if (len === 0) return <div ref={containerRef} className="w-full h-full" />;

  const firstVisibleAt = candles[0]!.time;
  const lastVisibleCloseAt = candles[len - 1]!.time + timeframeMs;
  const rangeBox =
    rangeDetector?.status === "ready"
      ? (rangeDetector.activeConfirmedRange ??
        rangeDetector.latestUpsideBreakout)
      : null;
  const rangeBoxEndAt = rangeDetector?.activeConfirmedRange
    ? lastVisibleCloseAt
    : (rangeDetector?.latestUpsideBreakout?.breakoutCloseTime ?? 0);
  const rangeBoxVisible =
    rangeBox != null &&
    rangeBox.anchorAt < lastVisibleCloseAt &&
    rangeBoxEndAt > firstVisibleAt;
  const allPrices = [
    ...candles.map((c) => c.low),
    ...candles.map((c) => c.high),
    ...(levels?.map((l) => l.price) || []),
    ...(breakoutLevel != null ? [breakoutLevel] : []),
    ...(breakoutZone ? [breakoutZone.lower, breakoutZone.upper] : []),
    ...(abNeon?.support != null ? [abNeon.support] : []),
    ...(abNeon?.resistance != null ? [abNeon.resistance] : []),
    ...(abNeon?.range ? [abNeon.range.lower, abNeon.range.upper] : []),
    ...(rangeBoxVisible && rangeBox ? [rangeBox.lower, rangeBox.upper] : []),
  ];
  if (trendline) {
    allPrices.push(trendline.startPrice, trendline.endPrice);
    const slope =
      (trendline.endPrice - trendline.startPrice) /
      Math.max(1, trendline.endIndex - trendline.startIndex);
    allPrices.push(
      trendline.startPrice + slope * (len - 1 - trendline.startIndex),
    );
  }
  if (pivots) {
    allPrices.push(...pivots.map((p) => p.price));
  }

  const minPRaw = Math.min(...allPrices);
  const maxPRaw = Math.max(...allPrices);
  const diff = Math.max(maxPRaw - minPRaw, 0.0001);
  const minP = minPRaw - diff * 0.05;
  const maxP = maxPRaw + diff * 0.05;
  const range = maxP - minP;

  const getX = (idx: number) =>
    padX + (len > 1 ? (idx / (len - 1)) * drawW : drawW / 2);
  const getY = (p: number) => padY + (1 - (p - minP) / range) * drawH;
  const getTimeX = (time: number) =>
    getX(Math.max(0, Math.min(len - 1, (time - firstVisibleAt) / timeframeMs)));

  const candleW = Math.max(1, (drawW / len) * 0.6);
  // AB Neon is a current reading, not a history covering many candles.
  const currentOverlayStartX = Math.max(
    padX,
    getX(len - 1) -
      (timeframeMs >= 24 * 60 * 60_000
        ? Math.max(candleW, 8)
        : Math.max(candleW * 3, 12)),
  );
  const volumeTop = padY + drawH + 15;
  const maxVolume = Math.max(1, ...candles.map((c) => c.volume));
  const axisTime = (time: number) =>
    new Intl.DateTimeFormat("ru-RU", {
      timeZone: "UTC",
      day: "2-digit",
      month: "short",
      ...(timeframeMs < 24 * 60 * 60_000
        ? { hour: "2-digit", minute: "2-digit" }
        : {}),
    }).format(time);
  const lifecycleStart = lifecycle
    ? Math.max(0, Math.min(lifecycle.breakoutIndex, len - 1))
    : 0;
  const lifecycleEnd = lifecycle
    ? Math.max(lifecycleStart, Math.min(lifecycle.endIndex, len - 1))
    : len - 1;
  const trendlineSlope = trendline
    ? (trendline.endPrice - trendline.startPrice) /
      Math.max(1, trendline.endIndex - trendline.startIndex)
    : null;
  const trendlineLevelAt = (index: number) =>
    trendline && trendlineSlope !== null
      ? trendline.startPrice + trendlineSlope * (index - trendline.startIndex)
      : null;
  const isTrendlineBreakout = breakoutSource === "trendline" && !!trendline;
  const projectedTrendlineEnd = trendline
    ? Math.max(
        trendline.endIndex,
        isTrendlineBreakout && lifecycle ? lifecycleEnd : trendline.endIndex,
      )
    : 0;
  const eventKindLabel: Record<
    NonNullable<BreakoutChartProps["eventKind"]>,
    string
  > = {
    horizontal: "HORIZONTAL",
    trendline: "TRENDLINE",
    both: "BOTH",
    none: "—",
  };

  return (
    <div
      ref={containerRef}
      className="w-full h-full relative font-mono text-[10px] select-none"
    >
      <div className="absolute left-3 top-2 z-10 flex max-w-[calc(100%-84px)] flex-wrap gap-1.5 pointer-events-none">
        {!abNeon && !rangeDetector && (
          <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-amber-300">
            Event: {eventKindLabel[eventKind]}
            {breakoutSource !== "none" &&
              ` · primary ${breakoutSource.toUpperCase()}`}
          </span>
        )}
        {abNeon && (
          <span className="rounded border border-fuchsia-500/30 bg-black/70 px-1.5 py-0.5 text-fuchsia-300">
            AB Neon · {abNeonLabel}
          </span>
        )}
        {rangeDetector?.status === "ready" && (
          <span className="rounded border border-cyan-500/30 bg-black/70 px-1.5 py-0.5 text-cyan-300">
            Range Detector · 4H
          </span>
        )}
        {breakoutLevel != null && (
          <span className="rounded border border-amber-500/20 bg-black/50 px-1.5 py-0.5 text-amber-200">
            Level {formatPrice(breakoutLevel)}
          </span>
        )}
        {breakoutTolerance != null && (
          <span className="rounded border border-amber-500/20 bg-black/50 px-1.5 py-0.5 text-amber-100/80">
            Zone ±{formatPrice(breakoutTolerance)}
          </span>
        )}
        {trendline && (
          <span className="rounded border border-sky-500/25 bg-sky-500/10 px-1.5 py-0.5 text-sky-300">
            Trendline · context
          </span>
        )}
      </div>
      <svg width={w} height={h} className="absolute inset-0">
        {rangeBoxVisible && rangeBox && (
          <g>
            <rect
              x={getTimeX(rangeBox.anchorAt)}
              y={getY(rangeBox.upper)}
              width={Math.max(
                1,
                getTimeX(rangeBoxEndAt) - getTimeX(rangeBox.anchorAt),
              )}
              height={Math.max(1, getY(rangeBox.lower) - getY(rangeBox.upper))}
              fill="#22d3ee"
              fillOpacity={0.12}
              stroke="#22d3ee"
              strokeOpacity={0.8}
              strokeWidth={1}
            />
            <text
              x={Math.min(getTimeX(rangeBox.anchorAt) + 4, padX + drawW - 102)}
              y={Math.max(padY + 27, getY(rangeBox.upper) - 5)}
              fill="#67e8f9"
              fontSize={9}
            >
              {rangeDetector?.activeConfirmedRange
                ? "Range · active"
                : "Range · breakout"}
            </text>
          </g>
        )}
        {abNeon?.range && (
          <g>
            <rect
              x={currentOverlayStartX}
              y={getY(abNeon.range.upper)}
              width={Math.max(1, getX(len - 1) - currentOverlayStartX)}
              height={Math.max(
                1,
                getY(abNeon.range.lower) - getY(abNeon.range.upper),
              )}
              fill="#d946ef"
              fillOpacity={0.08}
              stroke="#e879f9"
              strokeOpacity={0.65}
              strokeDasharray="4 3"
            />
            <text
              x={Math.min(currentOverlayStartX + 3, padX + drawW - 90)}
              y={Math.max(padY + 42, getY(abNeon.range.upper) - 4)}
              fill="#f0abfc"
              fontSize={9}
            >
              AB Neon · {abNeon.range.state}
            </text>
          </g>
        )}
        {abNeon &&
          (
            [
              ["resistance", abNeon.resistance],
              ["support", abNeon.support],
            ] as const
          ).map(([kind, price]) =>
            price == null ? null : (
              <g key={kind}>
                <line
                  x1={currentOverlayStartX}
                  x2={getX(len - 1)}
                  y1={getY(price)}
                  y2={getY(price)}
                  stroke={kind === "support" ? "#a78bfa" : "#e879f9"}
                  strokeWidth={1.5}
                  strokeDasharray="5 3"
                />
                <text
                  x={Math.min(currentOverlayStartX + 2, padX + drawW - 100)}
                  y={Math.max(padY + 12, getY(price) - 5)}
                  fill={kind === "support" ? "#c4b5fd" : "#f0abfc"}
                  fontSize={9}
                >
                  {`AB ${kind === "support" ? "S" : "R"} ${formatPrice(price)}`}
                </text>
              </g>
            ),
          )}
        {/* 4H quiet zone immediately before the current structure candle */}
        {quietZone && (
          <g>
            <rect
              x={getX(Math.max(0, len - 8))}
              y={padY}
              width={Math.max(1, getX(len - 1) - getX(Math.max(0, len - 8)))}
              height={drawH}
              className="fill-sky-500/5"
            />
            <text
              x={getX(Math.max(0, len - 8)) + 4}
              y={padY + 13}
              className="fill-sky-400/70 text-[9px]"
            >
              Quiet zone
            </text>
          </g>
        )}

        {/* Retest Zone */}
        {retestZone && !isTrendlineBreakout && (
          <rect
            x={getX(retestZone.fromIndex)}
            y={getY(retestZone.level) - 10}
            width={Math.max(
              1,
              getX(retestZone.toIndex) - getX(retestZone.fromIndex),
            )}
            height={20}
            className="fill-purple-500/10"
          />
        )}

        {/* One lifecycle: first cross through the latest observed retest. */}
        {lifecycle && breakoutZone && (
          <g>
            {isTrendlineBreakout && trendlineLevelAt(lifecycleStart) != null ? (
              <polygon
                points={[
                  ...Array.from(
                    { length: lifecycleEnd - lifecycleStart + 1 },
                    (_, offset) => {
                      const index = lifecycleStart + offset;
                      return `${getX(index)},${getY(
                        trendlineLevelAt(index)! +
                          (breakoutTolerance ??
                            (breakoutZone.upper - breakoutZone.lower) / 2),
                      )}`;
                    },
                  ),
                  ...Array.from(
                    { length: lifecycleEnd - lifecycleStart + 1 },
                    (_, offset) => {
                      const index = lifecycleEnd - offset;
                      return `${getX(index)},${getY(
                        trendlineLevelAt(index)! -
                          (breakoutTolerance ??
                            (breakoutZone.upper - breakoutZone.lower) / 2),
                      )}`;
                    },
                  ),
                ].join(" ")}
                className="fill-amber-400/10"
              />
            ) : (
              <rect
                x={getX(lifecycleStart)}
                y={getY(breakoutZone.upper)}
                width={Math.max(1, getX(lifecycleEnd) - getX(lifecycleStart))}
                height={Math.max(
                  1,
                  getY(breakoutZone.lower) - getY(breakoutZone.upper),
                )}
                className="fill-amber-400/10"
              />
            )}
            <line
              x1={getX(lifecycleStart)}
              y1={padY}
              x2={getX(lifecycleStart)}
              y2={padY + drawH}
              className="stroke-amber-300/80"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            {lifecycle.retestIndices.map((index) => (
              <circle
                key={`retest-${index}`}
                cx={getX(Math.max(0, Math.min(index, len - 1)))}
                cy={getY(
                  isTrendlineBreakout
                    ? (trendlineLevelAt(
                        Math.max(0, Math.min(index, len - 1)),
                      ) ??
                        breakoutLevel ??
                        breakoutZone.lower)
                    : (breakoutLevel ?? breakoutZone.lower),
                )}
                r={3}
                className="fill-purple-300 stroke-purple-950"
                strokeWidth={1}
              >
                <title>Retest within the same breakout lifecycle</title>
              </circle>
            ))}
          </g>
        )}

        {/* Levels */}
        {levels?.map((l, i) => {
          const y = getY(l.price);
          return (
            <g key={`lvl-${i}`}>
              <line
                x1={padX}
                y1={y}
                x2={padX + drawW}
                y2={y}
                className="stroke-zinc-500/40"
                strokeWidth={1}
                strokeDasharray="4 4"
              />
              <text
                x={padX + 2}
                y={y - 4}
                className="fill-zinc-500/60 text-[9px]"
              >
                T:{l.touches}
              </text>
            </g>
          );
        })}

        {/* Breakout Level */}
        {breakoutLevel != null && !isTrendlineBreakout && (
          <g>
            <line
              x1={padX}
              y1={getY(breakoutLevel)}
              x2={padX + drawW}
              y2={getY(breakoutLevel)}
              className="stroke-amber-500/60"
              strokeWidth={1.5}
              strokeDasharray="6 2"
            />
            <text
              x={padX + 3}
              y={Math.max(padY + 11, getY(breakoutLevel) - 4)}
              className="fill-amber-300 text-[9px]"
            >
              {`Breakout ${formatPrice(breakoutLevel)}`}
            </text>
          </g>
        )}
        {breakoutLevel != null && isTrendlineBreakout && (
          <g>
            <circle
              cx={getX(lifecycleStart)}
              cy={getY(breakoutLevel)}
              r={3.5}
              className="fill-amber-300 stroke-amber-950"
              strokeWidth={1}
            />
            <text
              x={Math.min(getX(lifecycleStart) + 4, padX + drawW - 104)}
              y={Math.max(padY + 11, getY(breakoutLevel) - 5)}
              className="fill-amber-300 text-[9px]"
            >
              {`Trendline break ${formatPrice(breakoutLevel)}`}
            </text>
          </g>
        )}

        {/* Closed 1H confirmation, when the last completed candle crossed the 4H level */}
        {eventIndex != null && eventIndex >= 0 && eventIndex < len && (
          <g>
            <line
              x1={getX(eventIndex)}
              y1={padY}
              x2={getX(eventIndex)}
              y2={padY + drawH}
              className="stroke-amber-400/70"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            {eventLabel && (
              <text
                x={Math.min(getX(eventIndex) + 4, padX + drawW - 72)}
                y={padY + drawH - 6}
                className="fill-amber-300 text-[9px]"
              >
                {eventLabel}
              </text>
            )}
          </g>
        )}

        {/* Trendline */}
        {trendline && (
          <g>
            <line
              x1={getX(trendline.startIndex)}
              y1={getY(trendline.startPrice)}
              x2={getX(projectedTrendlineEnd)}
              y2={getY(
                trendlineLevelAt(projectedTrendlineEnd) ?? trendline.endPrice,
              )}
              className="stroke-sky-400/70"
              strokeWidth={1.5}
              strokeDasharray="5 3"
            />
            <text
              x={Math.min(getX(projectedTrendlineEnd) + 4, padX + drawW - 86)}
              y={
                getY(
                  trendlineLevelAt(projectedTrendlineEnd) ?? trendline.endPrice,
                ) - 5
              }
              className="fill-sky-300 text-[9px]"
            >
              Trendline context
            </text>
          </g>
        )}

        {/* Candles */}
        {candles.map((c, i) => {
          const x = getX(i);
          const yHigh = getY(c.high);
          const yLow = getY(c.low);
          const yOpen = getY(c.open);
          const yClose = getY(c.close);
          const isUp = c.close >= c.open;
          const fillClass = isUp ? "fill-emerald-500" : "fill-rose-500";
          const strokeClass = isUp ? "stroke-emerald-500" : "stroke-rose-500";

          return (
            <g key={`c-${i}`} className="hover:opacity-80 transition-opacity">
              <title>{`Time: ${new Date(c.time).toLocaleString()}
O: ${c.open}
H: ${c.high}
L: ${c.low}
C: ${c.close}
Vol: ${c.volume}`}</title>
              <line
                x1={x}
                x2={x}
                y1={yHigh}
                y2={yLow}
                className={strokeClass}
                strokeWidth={1}
              />
              <rect
                x={x - candleW / 2}
                y={Math.min(yOpen, yClose)}
                width={candleW}
                height={Math.max(1, Math.abs(yOpen - yClose))}
                className={fillClass}
              />
            </g>
          );
        })}

        {/* Pivots */}
        {pivots?.map((p, i) => {
          const isHigh = p.kind === "high";
          const x = getX(p.index);
          const y = getY(p.price) + (isHigh ? -8 : 8);
          return (
            <circle
              key={`piv-${i}`}
              cx={x}
              cy={y}
              r={2.5}
              className={isHigh ? "fill-cyan-400" : "fill-fuchsia-400"}
            >
              <title>{`${isHigh ? "High" : "Low"} Pivot: ${p.price}`}</title>
            </circle>
          );
        })}
        {showVolume && (
          <g>
            <line
              x1={padX}
              x2={padX + drawW}
              y1={volumeTop}
              y2={volumeTop}
              stroke="#334155"
            />
            <text x={padX + 2} y={volumeTop + 11} fill="#94a3b8" fontSize={9}>
              ОБЪЁМ
            </text>
            {candles.map((c, i) => {
              const barH = Math.max(1, (c.volume / maxVolume) * (volumeH - 12));
              return (
                <rect
                  key={`vol-${i}`}
                  x={getX(i) - candleW / 2}
                  y={volumeTop + volumeH - barH}
                  width={candleW}
                  height={barH}
                  fill={c.close >= c.open ? "#10b981" : "#f43f5e"}
                  opacity={0.6}
                >
                  <title>{`${axisTime(c.time)} UTC · Объём: ${c.volume.toLocaleString("ru-RU")}`}</title>
                </rect>
              );
            })}
            {(w < 640 ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1]).map(
              (portion) => {
                const index = Math.round(portion * (len - 1));
                return (
                  <text
                    key={portion}
                    x={getX(index)}
                    y={h - 5}
                    textAnchor={
                      portion === 0 ? "start" : portion === 1 ? "end" : "middle"
                    }
                    fill="#94a3b8"
                    fontSize={9}
                  >
                    {axisTime(candles[index]!.time)}
                  </text>
                );
              },
            )}
          </g>
        )}
      </svg>

      {/* Y Axis Labels */}
      <div className="absolute top-0 right-0 w-[60px] h-full pointer-events-none">
        <div
          className="absolute text-zinc-500"
          style={{ top: getY(maxPRaw) - 6 }}
        >
          {formatPrice(maxPRaw)}
        </div>
        <div
          className="absolute text-zinc-500"
          style={{ top: getY(minPRaw) - 6 }}
        >
          {formatPrice(minPRaw)}
        </div>
        {candles.length > 0 && (
          <div
            className={`absolute px-1 rounded ${
              candles[candles.length - 1].close >=
              candles[candles.length - 1].open
                ? "bg-emerald-500/20 text-emerald-400"
                : "bg-rose-500/20 text-rose-400"
            }`}
            style={{ top: getY(candles[candles.length - 1].close) - 8 }}
          >
            {formatPrice(candles[candles.length - 1].close)}
          </div>
        )}
      </div>
    </div>
  );
}
