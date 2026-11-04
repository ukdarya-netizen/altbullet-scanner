import { motion } from 'framer-motion';
import { EASE, BULL, BEAR } from '../Candles';

const STRIP = Array.from({ length: 40 }, (_, i) => {
  const up = (i * 7) % 5 !== 0 && (i * 3) % 4 !== 1;
  const h = 14 + ((i * 37) % 46);
  return { up, h, off: (i * 23) % 30 };
});

export function Scene1() {
  return (
    <motion.section
      className="absolute inset-0 overflow-hidden grain"
      style={{ background: '#15171D', color: '#ECE6DA' }}
      exit={{ opacity: 0, transition: { duration: 0.35, delay: 0.15 } }}
    >
      {/* eyebrow */}
      <motion.div
        className="f-mono absolute uppercase tracking-[0.3em]"
        style={{ left: '7%', top: '11%', fontSize: '2.1vmin', color: '#8C877C' }}
        initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.9, duration: 0.4, ease: EASE }}
      >
        BingX AltBullet <span style={{ color: '#FF4A1C' }}>●</span> сканер
      </motion.div>

      {/* giant 4 */}
      <motion.div
        className="f-disp absolute font-black leading-none"
        style={{ left: '6%', top: '14%', fontSize: '62vmin', color: '#FF4A1C', transformOrigin: '30% 55%' }}
        initial={{ scale: 0.2, opacity: 0, rotate: -14 }}
        animate={{ scale: 1, opacity: 1, rotate: 0 }}
        exit={{ scale: 3.2, opacity: 0, filter: 'blur(14px)', transition: { duration: 0.6, ease: [0.7, 0, 0.84, 0] } }}
        transition={{ type: 'spring', stiffness: 300, damping: 18 }}
      >
        4
      </motion.div>

      <div className="absolute" style={{ left: '45%', top: '26%' }}>
        <div className="overflow-hidden">
          <motion.div
            className="f-disp font-black uppercase leading-[0.95]"
            style={{ fontSize: '11vmin' }}
            initial={{ y: '105%' }} animate={{ y: 0 }}
            exit={{ x: '-12%', opacity: 0, transition: { duration: 0.35 } }}
            transition={{ delay: 0.45, duration: 0.55, ease: EASE }}
          >
            паттерна
          </motion.div>
        </div>
        <motion.div
          className="f-disp"
          style={{ fontSize: '4.6vmin', marginTop: '2vmin', fontWeight: 600 }}
          initial={{ opacity: 0, x: -30 }} animate={{ opacity: 1, x: 0 }}
          exit={{ x: '-12%', opacity: 0, transition: { duration: 0.3 } }}
          transition={{ delay: 2.0, duration: 0.5, ease: EASE }}
        >
          которые ловит <span style={{ color: '#FF4A1C' }}>сканер</span>
        </motion.div>
        <motion.div
          className="f-mono"
          style={{ fontSize: '2.4vmin', marginTop: '2.4vmin', color: '#8C877C' }}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }}
          transition={{ delay: 2.6, duration: 0.4 }}
        >
          01 пробой · 02 отскок · 03 каскад · 04 импульс
        </motion.div>
      </div>

      {/* candle marquee */}
      <motion.div
        className="absolute left-0 right-0 overflow-hidden"
        style={{ bottom: '7%', height: '14vmin' }}
        initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 1.3, duration: 0.5, ease: EASE }}
      >
        <div className="flex items-end h-full" style={{ width: '200%', animation: 'marquee 6s linear infinite', gap: '1.4vmin' }}>
          {[...STRIP, ...STRIP].map((c, i) => (
            <div key={i} style={{ width: '1.6vmin', height: `${c.h}%`, marginBottom: `${c.off / 3}vmin`, background: c.up ? BULL : BEAR, borderRadius: 2, flexShrink: 0 }} />
          ))}
        </div>
      </motion.div>
    </motion.section>
  );
}
