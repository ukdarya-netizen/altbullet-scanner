import { motion } from 'framer-motion';
import { EASE } from '../Candles';

const TILES = [
  { n: '01', t: 'Stealth Breakout', s: 'пробой ренджа', bg: '#ECE6DA', fg: '#15171D', g: 'M5 60 L50 58 L52 62 L90 59 L100 20' },
  { n: '02', t: 'Neon Support', s: 'отскок от поддержки', bg: '#2F3FD8', fg: '#ECE6DA', g: 'M5 15 L35 40 L60 70 L75 50 L100 25' },
  { n: '03', t: 'Каскад', s: 'разворот после ликвидаций', bg: '#15171D', fg: '#ECE6DA', g: 'M5 10 L25 25 L45 45 L65 75 L80 55 L100 35' },
  { n: '04', t: 'Импульс', s: 'продолжение свечи 30м', bg: '#FF4A1C', fg: '#15171D', g: 'M5 65 L45 62 L55 15 L100 8' },
];

export function Scene6() {
  return (
    <motion.section className="absolute inset-0 overflow-hidden grain" style={{ background: '#ECE6DA', color: '#15171D' }}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>
      <motion.div className="absolute grid" style={{ left: '6%', right: '6%', top: '9%', bottom: '9%', gridTemplateColumns: '1fr 1fr', gap: '2vmin' }}
        animate={{ scale: [1, 1, 0.5], x: ['0%', '0%', '45%'], y: ['0%', '0%', '-2%'], opacity: [1, 1, 1] }}
        transition={{ duration: 2.4, times: [0, 0.75, 1], ease: EASE }}>
        {TILES.map((t, i) => (
          <motion.div key={t.n} className="relative overflow-hidden" style={{ background: t.bg, color: t.fg, padding: '3vmin', border: '0.3vmin solid #15171D' }}
            initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: i * 0.3, type: 'spring', stiffness: 280, damping: 22 }}>
            <div className="f-mono" style={{ fontSize: '2.2vmin' }}>{t.n}</div>
            <div className="f-disp font-black" style={{ fontSize: '5vmin', lineHeight: 1 }}>{t.t}</div>
            <div className="f-mono" style={{ fontSize: '2.2vmin', opacity: 0.75, marginTop: '0.8vmin' }}>{t.s}</div>
            <svg viewBox="0 0 100 80" preserveAspectRatio="none" className="absolute" style={{ right: '3vmin', bottom: '2vmin', width: '38%', height: '50%' }}>
              <motion.path d={t.g} fill="none" stroke={t.fg} strokeWidth={3} vectorEffect="non-scaling-stroke"
                initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ delay: 0.3 + i * 0.3, duration: 0.6 }} />
            </svg>
          </motion.div>
        ))}
      </motion.div>

      <div className="absolute" style={{ left: '6%', top: '28%' }}>
        <motion.div className="f-mono uppercase tracking-[0.35em]" style={{ fontSize: '2.2vmin', color: '#FF4A1C' }}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 2.0, duration: 0.3 }}>BingX</motion.div>
        <div className="overflow-hidden">
          <motion.div className="f-disp font-black leading-none" style={{ fontSize: '13vmin', letterSpacing: '-0.03em' }}
            initial={{ y: '105%' }} animate={{ y: 0 }} transition={{ delay: 2.15, duration: 0.6, ease: EASE }}>
            Alt<span style={{ color: '#FF4A1C' }}>Bullet</span>
          </motion.div>
        </div>
        <motion.div className="f-disp" style={{ fontSize: '4vmin', fontWeight: 600, marginTop: '2.5vmin' }}
          initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 2.8, duration: 0.45, ease: EASE }}>
          Четыре паттерна. Один сканер.
        </motion.div>
      </div>

      {/* loop handoff: ink closes in */}
      <motion.div className="absolute inset-0" style={{ background: '#15171D' }}
        initial={{ clipPath: 'circle(0% at 50% 50%)' }} animate={{ clipPath: ['circle(0% at 50% 50%)', 'circle(0% at 50% 50%)', 'circle(80% at 50% 50%)'] }}
        transition={{ duration: 5.4, times: [0, 0.9, 1], ease: 'easeIn' }} />
    </motion.section>
  );
}
