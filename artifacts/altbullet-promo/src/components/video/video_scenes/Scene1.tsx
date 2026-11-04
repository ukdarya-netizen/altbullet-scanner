import { useState } from 'react';
import { motion } from 'framer-motion';
import { useSceneTimer } from '@/lib/video';

const E = [0.22, 1, 0.36, 1] as const;
const T = ['SOL','DOGE','ARB','PEPE','WIF','OP','SUI','TIA','INJ','SEI','APT','NEAR','FET','JUP','ORDI','LINK','AVAX','ENA'];
const ROWS = Array.from({ length: 11 }, (_, r) => Array.from({ length: 9 }, (_, i) => {
  const t = T[(r * 5 + i * 7) % T.length];
  const v = (((r * 37 + i * 53) % 190) / 10 - 9).toFixed(1);
  return { t, v };
}));
const WORDS = ['500+ пар', 'BingX', 'каждую минуту'];

export function Scene1() {
  const [b, setB] = useState(-1);
  useSceneTimer([
    { time: 450, callback: () => setB(0) },
    { time: 950, callback: () => setB(1) },
    { time: 1450, callback: () => setB(2) },
    { time: 2450, callback: () => setB(3) },
    { time: 2950, callback: () => setB(4) },
    { time: 3400, callback: () => setB(5) },
  ]);
  return (
    <motion.section className="absolute inset-0 overflow-hidden grid-bg" style={{ background: 'var(--ink)' }}
      exit={{ opacity: 0, transition: { duration: 0.35, delay: 0.1 } }}>
      <motion.div className="absolute inset-0 flex flex-col justify-center gap-[1.6vmin] mono"
        animate={{ scale: b >= 5 ? 2.6 : b >= 3 ? 1.12 : 1, filter: b >= 5 ? 'blur(10px)' : 'blur(0px)' }}
        transition={{ duration: b >= 5 ? 0.5 : 0.8, ease: E }} style={{ transformOrigin: '50% 50%' }}>
        {ROWS.map((row, r) => (
          <motion.div key={r} className="flex gap-[3vmin] whitespace-nowrap text-[2.6vmin]"
            initial={{ x: r % 2 ? '-20%' : '0%' }} animate={{ x: r % 2 ? '0%' : '-20%' }}
            transition={{ duration: 3.9, ease: 'linear' }}
            style={{ opacity: r === 5 ? 1 : b >= 3 ? 0.18 : 0.45 }}>
            {[...row, ...row].map((c, i) => {
              const hit = r === 5 && i === 4;
              return (
                <span key={i} style={{ color: hit && b >= 4 ? 'var(--ink)' : Number(c.v) >= 0 ? 'var(--lime)' : 'var(--coral)', background: hit && b >= 4 ? 'var(--lime)' : 'transparent', padding: '0 1vmin', transition: 'background .15s' }}>
                  <span style={{ color: hit && b >= 4 ? 'var(--ink)' : 'var(--fog)' }}>{hit ? 'ARB' : c.t}-USDT</span> {Number(c.v) >= 0 ? '+' : ''}{hit ? '6.8' : c.v}%
                </span>
              );
            })}
          </motion.div>
        ))}
      </motion.div>
      {/* reticle */}
      <motion.div className="absolute" style={{ left: '50%', top: '50%', width: '22vmin', height: '22vmin', marginLeft: '-11vmin', marginTop: '-11vmin' }}
        initial={{ x: '-60vw', y: '-30vh', opacity: 0, rotate: -90 }}
        animate={b >= 5 ? { x: 0, y: 0, scale: 3.4, opacity: 0, rotate: 0 } : b >= 3 ? { x: 0, y: 0, opacity: 1, rotate: 0, scale: 1 } : b >= 0 ? { x: '-20vw', y: '-12vh', opacity: 0.8, rotate: -45 } : {}}
        transition={{ type: 'spring', stiffness: 260, damping: 24 }}>
        <svg viewBox="0 0 100 100" className="w-full h-full">
          <circle cx="50" cy="50" r="40" fill="none" stroke="var(--lime)" strokeWidth="1.5" strokeDasharray="6 4" />
          {[0, 90, 180, 270].map(a => <line key={a} x1="50" y1="2" x2="50" y2="18" stroke="var(--lime)" strokeWidth="2.5" transform={`rotate(${a} 50 50)`} />)}
          <circle cx="50" cy="50" r="2.5" fill="var(--lime)" />
        </svg>
      </motion.div>
      {/* hook words */}
      <div className="absolute left-[6%] top-[9%]">
        {WORDS.map((w, i) => (
          <motion.div key={w} className="disp font-black leading-[1.02]" style={{ fontSize: i === 1 ? '13vmin' : '7.5vmin', color: i === 1 ? 'var(--lime)' : 'var(--fog)' }}
            initial={{ opacity: 0, y: '40%', scale: 1.3 }} animate={b >= i && b < 5 ? { opacity: 1, y: '0%', scale: 1 } : b >= 5 ? { opacity: 0, y: '-30%' } : {}}
            transition={{ type: 'spring', stiffness: 320, damping: 22 }}>{w}</motion.div>
        ))}
      </div>
      <motion.div className="absolute right-[6%] bottom-[10%] mono text-[2.2vmin] tracking-[0.3em]" style={{ color: 'var(--lime)' }}
        initial={{ opacity: 0 }} animate={{ opacity: b >= 3 ? 1 : 0 }}>● ЦЕЛЬ ЗАХВАЧЕНА</motion.div>
    </motion.section>
  );
}
