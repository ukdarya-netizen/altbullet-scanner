import { useState } from 'react';
import { motion } from 'framer-motion';
import { useSceneTimer } from '@/lib/video';

const E = [0.22, 1, 0.36, 1] as const;
const NODES = ['СИГНАЛ', 'ВХОД', 'TP1', 'TP2'];
const PNL = [0, 0.4, 1.1, 1.9, 2.6, 3.2, 3.9, 4.5, 5.0, 5.6, 6.1, 6.6, 7.0, 7.3];

export function Scene3() {
  const [b, setB] = useState(-1);
  const [p, setP] = useState(0);
  useSceneTimer([
    { time: 150, callback: () => setB(0) },
    { time: 650, callback: () => setB(1) },
    { time: 1150, callback: () => setB(2) },
    { time: 1650, callback: () => setB(3) },
    { time: 2200, callback: () => setB(4) },
    { time: 2950, callback: () => setB(5) },
    ...PNL.map((_, i) => ({ time: 650 + i * 110, callback: () => setP(i) })),
  ]);
  return (
    <motion.section className="absolute inset-0 overflow-hidden" style={{ background: 'var(--lime)', color: 'var(--ink)' }}
      exit={{ clipPath: 'inset(49% 0% 49% 0%)', transition: { duration: 0.4, ease: [0.7, 0, 0.3, 1] } }} initial={{ clipPath: 'inset(0% 0% 0% 0%)' }}>
      <motion.div className="absolute left-[6%] top-[9%] mono text-[2.2vmin] tracking-[0.3em] font-bold" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>БОТ · АВТОСОПРОВОЖДЕНИЕ</motion.div>
      <motion.div className="absolute inset-x-0 top-[17%] text-center disp font-black leading-none" style={{ fontSize: '24vmin' }}
        initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: b >= 5 ? 1.08 : 1, opacity: b >= 1 ? 1 : 0 }} transition={{ type: 'spring', stiffness: 260, damping: 20 }}>
        +{PNL[p].toFixed(1).replace('.', ',')}%
      </motion.div>
      <div className="absolute left-[8%] right-[8%] top-[66%] h-[10vmin]">
        <div className="absolute left-0 right-0 top-1/2 h-[0.5vmin] -translate-y-1/2" style={{ background: 'rgba(11,16,32,.2)' }} />
        <motion.div className="absolute left-0 top-1/2 h-[0.5vmin] -translate-y-1/2" style={{ background: 'var(--ink)', width: '100%', transformOrigin: 'left' }}
          initial={{ scaleX: 0 }} animate={{ scaleX: Math.max(0, b) / 3 }} transition={{ duration: 0.4, ease: E }} />
        {NODES.map((n, i) => (
          <motion.div key={n} className="absolute top-1/2 flex flex-col items-center" style={{ left: `${(i / 3) * 100}%`, transform: 'translate(-50%,-50%)' }}>
            <motion.div className="rounded-full" style={{ width: '4.5vmin', height: '4.5vmin', border: '0.6vmin solid var(--ink)' }}
              animate={{ backgroundColor: b >= i ? '#0b1020' : 'rgba(0,0,0,0)', scale: b === i ? [1, 1.5, 1] : 1 }} transition={{ duration: 0.3 }} />
            <motion.div className="absolute top-[6vmin] disp font-bold text-[3.2vmin] whitespace-nowrap" animate={{ opacity: b >= i ? 1 : 0.3 }}>{n}</motion.div>
          </motion.div>
        ))}
      </div>
      <motion.div className="absolute inset-x-0 bottom-[7%] text-center mono text-[3vmin] font-semibold"
        initial={{ opacity: 0, y: 20 }} animate={b >= 4 ? { opacity: 1, y: 0 } : {}}>Вход, стоп и тейки — бот ведёт позицию сам</motion.div>
    </motion.section>
  );
}
