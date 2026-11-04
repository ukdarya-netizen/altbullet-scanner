import { useState } from 'react';
import { motion } from 'framer-motion';
import { useSceneTimer } from '@/lib/video';

const E = [0.22, 1, 0.36, 1] as const;
const NAME = 'AltBullet'.split('');

export function Scene4() {
  const [b, setB] = useState(0);
  useSceneTimer([
    { time: 950, callback: () => setB(1) },
    { time: 1550, callback: () => setB(2) },
    { time: 3250, callback: () => setB(3) },
  ]);
  return (
    <motion.section className="absolute inset-0 overflow-hidden grid-bg flex flex-col items-center justify-center" style={{ background: 'var(--ink)' }}
      initial={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.2 } }}>
      <motion.div className="absolute left-0 top-1/2 h-[1vmin] rounded-full" style={{ width: '40vw', marginTop: '-12vmin', background: 'linear-gradient(90deg,transparent,var(--lime))' }}
        initial={{ x: '-45vw' }} animate={{ x: '120vw' }} transition={{ duration: 0.7, ease: [0.5, 0, 0.2, 1] }} />
      <motion.div animate={{ scale: b >= 3 ? 0.94 : 1, opacity: b >= 3 ? 0.4 : 1 }} transition={{ duration: 0.6, ease: E }} className="flex flex-col items-center">
        <div className="flex disp font-black leading-none" style={{ fontSize: '17vmin' }}>
          {NAME.map((ch, i) => (
            <span key={i} className="overflow-hidden inline-block pb-[1vmin]">
              <motion.span className="inline-block" style={{ color: i >= 3 ? 'var(--lime)' : 'var(--fog)' }}
                initial={{ y: '110%', rotate: 12 }} animate={{ y: '0%', rotate: 0 }} transition={{ delay: 0.2 + i * 0.045, duration: 0.55, ease: E }}>{ch}</motion.span>
            </span>
          ))}
        </div>
        <motion.div className="mono text-[3.2vmin] tracking-[0.2em] mt-[2vmin]" style={{ color: 'var(--dim)' }}
          initial={{ opacity: 0, letterSpacing: '0.8em' }} animate={b >= 1 ? { opacity: 1, letterSpacing: '0.2em' } : {}} transition={{ duration: 0.6, ease: E }}>СКАНЕР + БОТ ДЛЯ BINGX</motion.div>
        <motion.div className="disp font-bold text-[4.6vmin] mt-[5vmin] flex gap-[2vmin]" initial={{ opacity: 0 }} animate={b >= 2 ? { opacity: 1 } : {}}>
          <motion.span initial={{ y: 20 }} animate={b >= 2 ? { y: 0 } : {}}>Видит раньше.</motion.span>
          <motion.span style={{ color: 'var(--lime)' }} initial={{ y: 20, opacity: 0 }} animate={b >= 2 ? { y: 0, opacity: 1 } : {}} transition={{ delay: 0.3 }}>Входит точнее.</motion.span>
        </motion.div>
      </motion.div>
    </motion.section>
  );
}
