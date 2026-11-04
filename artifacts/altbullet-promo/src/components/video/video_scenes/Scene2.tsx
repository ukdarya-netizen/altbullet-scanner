import { useState } from 'react';
import { motion } from 'framer-motion';
import { useSceneTimer } from '@/lib/video';

const E = [0.22, 1, 0.36, 1] as const;
// candles: open, close, high, low in chart units (0 bottom..100 top)
const C = Array.from({ length: 22 }, (_, i) => {
  if (i < 16) { const base = 38 + Math.sin(i * 1.7) * 5; const o = base + ((i * 7) % 5) - 2; const c = base - ((i * 3) % 5) + 2; return { o, c, h: Math.max(o, c) + 3, l: Math.min(o, c) - 3 }; }
  const k = i - 16; const o = 44 + k * 8; return { o, c: o + 9, h: o + 12, l: o - 2 };
});
const CALL = ['Паттерн: выход из боковика', 'Открытый интерес +18,4% за 4ч', 'BTC-фильтр: OK'];

export function Scene2() {
  const [b, setB] = useState(0);
  useSceneTimer([
    { time: 900, callback: () => setB(1) },
    { time: 1500, callback: () => setB(2) },
    { time: 1950, callback: () => setB(3) },
    { time: 2450, callback: () => setB(4) },
    { time: 2950, callback: () => setB(5) },
    { time: 3350, callback: () => setB(6) },
  ]);
  const W = 100 / C.length;
  const y = (v: number) => 100 - v;
  return (
    <motion.section className="absolute inset-0 overflow-hidden grid-bg" style={{ background: 'var(--ink2)' }}
      initial={{ scale: 1.5, opacity: 0, filter: 'blur(12px)' }} animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
      transition={{ duration: 0.7, ease: E }} exit={{ opacity: 0, transition: { duration: 0.3, delay: 0.25 } }}>
      <motion.div className="absolute" style={{ left: '30%', top: '14%', width: '66%', height: '74%' }}
        animate={{ scale: b >= 6 ? 1.12 : 1, x: b >= 6 ? '-4%' : '0%' }} transition={{ duration: 0.5, ease: E }}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="w-full h-full overflow-visible">
          <motion.rect x={0.5} y={y(46)} width={W * 16} height={14} fill="rgba(198,255,61,.07)" stroke="var(--lime)" strokeWidth={0.3} strokeDasharray="1.2 0.8"
            initial={{ opacity: 0, scaleX: 0 }} animate={{ opacity: b >= 1 ? 1 : 0, scaleX: b >= 1 ? 1 : 0 }} style={{ transformOrigin: 'left' }} transition={{ duration: 0.5, ease: E }} />
          {C.map((c, i) => {
            const up = c.c >= c.o; const col = i >= 16 ? 'var(--lime)' : up ? '#8fa0d0' : 'var(--coral)';
            return (
              <motion.g key={i} initial={{ opacity: 0, scaleY: 0 }} animate={{ opacity: i >= 16 && b < 2 ? 0 : 1, scaleY: i >= 16 && b < 2 ? 0 : 1 }}
                transition={{ delay: i < 16 ? i * 0.055 : (i - 16) * 0.06, duration: 0.3, ease: E }} style={{ transformOrigin: `50% ${y(c.l)}%` }}>
                <line x1={i * W + W / 2} x2={i * W + W / 2} y1={y(c.h)} y2={y(c.l)} stroke={col} strokeWidth={0.25} />
                <rect x={i * W + W * 0.2} width={W * 0.6} y={y(Math.max(c.o, c.c))} height={Math.abs(c.c - c.o) + 0.6} fill={col} />
              </motion.g>
            );
          })}
        </svg>
        <motion.div className="absolute" style={{ left: `${16 * W}%`, top: `${y(56)}%`, width: '4vmin', height: '4vmin', marginLeft: '-2vmin', marginTop: '-2vmin', borderRadius: '50%', background: 'var(--lime)' }}
          initial={{ scale: 0 }} animate={{ scale: b >= 6 ? 80 : b >= 2 ? [0, 1.4, 1] : 0 }} transition={{ duration: b >= 6 ? 0.45 : 0.35, ease: b >= 6 ? [0.7, 0, 0.84, 0] : E }} />
        <motion.div className="absolute mono text-[2vmin] font-bold px-[1.2vmin] py-[0.4vmin]" style={{ left: `${16 * W + 2}%`, top: `${y(64)}%`, background: 'var(--lime)', color: 'var(--ink)' }}
          initial={{ opacity: 0, x: -10 }} animate={{ opacity: b >= 2 && b < 6 ? 1 : 0, x: 0 }}>LONG · ARB-USDT</motion.div>
      </motion.div>
      <div className="absolute left-[5%] top-[9%] overflow-hidden">
        <motion.div className="disp font-black text-[10vmin] leading-none" initial={{ y: '105%' }} animate={{ y: '0%' }} transition={{ duration: 0.6, delay: 0.15, ease: E }}>СКАНЕР</motion.div>
      </div>
      <motion.div className="absolute left-[5%] top-[23%] mono text-[2.1vmin] tracking-[0.25em]" style={{ color: 'var(--dim)' }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.45 }}>ИЩЕТ СЕТАП ДО ДВИЖЕНИЯ</motion.div>
      <div className="absolute left-[5%] bottom-[12%] flex flex-col gap-[1.8vmin] w-[24%]">
        {CALL.map((t, i) => (
          <motion.div key={t} className="mono text-[2.6vmin] leading-tight pl-[1.6vmin]" style={{ borderLeft: '0.5vmin solid var(--lime)' }}
            initial={{ opacity: 0, x: '-30%' }} animate={b >= 3 + i ? { opacity: 1, x: '0%' } : {}} transition={{ type: 'spring', stiffness: 300, damping: 26 }}>{t}</motion.div>
        ))}
      </div>
    </motion.section>
  );
}
