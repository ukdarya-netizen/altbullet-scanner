import { motion } from 'framer-motion';

export type C = [number, number, number, number]; // open, close, high, low

export const BULL = '#0E9F6E';
export const BEAR = '#FF4A1C';
export const EASE = [0.22, 1, 0.36, 1] as const;

/** Candles in an SVG viewBox. y(price) maps price 0..100 to height. */
export function Candles({
  data, x0, step, y, delay = 0, stagger = 0.08, bull = BULL, bear = BEAR, width = 0.62,
}: {
  data: C[]; x0: number; step: number; y: (p: number) => number;
  delay?: number; stagger?: number; bull?: string; bear?: string; width?: number;
}) {
  return (
    <g>
      {data.map(([o, c, h, l], i) => {
        const x = x0 + i * step;
        const col = c >= o ? bull : bear;
        const top = y(Math.max(o, c));
        const bh = Math.max(3, Math.abs(y(o) - y(c)));
        return (
          <motion.g
            key={i}
            style={{ transformOrigin: `${x}px ${y(o)}px`, transformBox: 'view-box' }}
            initial={{ scaleY: 0, opacity: 0 }}
            animate={{ scaleY: 1, opacity: 1 }}
            transition={{ delay: delay + i * stagger, duration: 0.35, ease: EASE }}
          >
            <line x1={x} x2={x} y1={y(h)} y2={y(l)} stroke={col} strokeWidth={3} />
            <rect x={x - (step * width) / 2} y={top} width={step * width} height={bh} fill={col} rx={2} />
          </motion.g>
        );
      })}
    </g>
  );
}
