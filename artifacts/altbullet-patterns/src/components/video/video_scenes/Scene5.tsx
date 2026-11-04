import { motion } from 'framer-motion';
import { EASE } from '../Candles';

export function Scene5() {
  return (
    <motion.section
      className="absolute inset-0 overflow-hidden grain"
      style={{ background: '#FF4A1C', color: '#15171D' }}
      exit={{ opacity: 0, transition: { duration: 0.4, delay: 0.2 } }}
    >
      {/* giant candle */}
      <motion.div className="absolute" style={{ left: '60%', bottom: '8%', width: '16vmin', height: '84%' }}
        exit={{ scale: 0.25, x: '-60%', y: '-30%', transition: { duration: 0.55, ease: EASE } }}>
        <motion.div className="absolute left-1/2" style={{ width: '0.8vmin', top: 0, bottom: 0, background: '#15171D', x: '-50%', transformOrigin: 'bottom' }}
          initial={{ scaleY: 0 }} animate={{ scaleY: 1 }} transition={{ delay: 0.15, duration: 0.7, ease: EASE }} />
        <motion.div className="absolute left-0 right-0" style={{ top: '9%', bottom: '18%', background: '#ECE6DA', border: '0.8vmin solid #15171D', transformOrigin: 'bottom' }}
          initial={{ scaleY: 0.03 }} animate={{ scaleY: 1 }} transition={{ delay: 0.1, type: 'spring', stiffness: 260, damping: 20 }} />
        <motion.div className="f-mono absolute font-extrabold" style={{ right: '-9vmin', top: '9%', fontSize: '3vmin' }}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.6 }}>30м</motion.div>
      </motion.div>
      {/* volume bar */}
      <motion.div className="absolute" style={{ left: '80%', bottom: '8%', width: '6vmin', height: '58%', background: '#15171D', transformOrigin: 'bottom' }}
        initial={{ scaleY: 0 }} animate={{ scaleY: 1 }} transition={{ delay: 1.0, duration: 0.6, ease: EASE }} />
      <motion.div className="f-mono absolute uppercase" style={{ left: '80%', bottom: '68%', fontSize: '2vmin', fontWeight: 800 }}
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.5 }}>объём</motion.div>
      {[0, 1, 2, 3, 4].map((i) => (
        <motion.div key={i} className="absolute" style={{ left: `${36 + i * 4}%`, bottom: '8%', width: '2.4vmin', height: `${6 + (i % 3) * 3}%`, background: 'rgba(21,23,29,0.35)', transformOrigin: 'bottom' }}
          initial={{ scaleY: 0 }} animate={{ scaleY: 1 }} transition={{ delay: 0.1 + i * 0.06, duration: 0.3 }} />
      ))}

      <div className="absolute" style={{ left: '6%', top: '10%', width: '50%' }}>
        <motion.div className="f-mono uppercase tracking-[0.25em] flex items-center" style={{ fontSize: '2.1vmin', gap: '1.5vmin' }}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2 }}>
          <span style={{ background: '#15171D', color: '#FF4A1C', padding: '0.4vmin 1vmin' }}>04</span> паттерн
        </motion.div>
        {['Импульсная', 'покупка'].map((w, i) => (
          <div key={w} className="overflow-hidden">
            <motion.div className="f-disp font-black uppercase leading-[0.98]" style={{ fontSize: '9.5vmin' }}
              initial={{ y: '105%' }} animate={{ y: 0 }} transition={{ delay: 1.2 + i * 0.18, duration: 0.5, ease: EASE }}>{w}</motion.div>
          </div>
        ))}
        <motion.div className="f-mono" style={{ fontSize: '2.5vmin', marginTop: '3vmin', lineHeight: 1.4, maxWidth: '80%' }}
          initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 2.2, duration: 0.4 }}>
          сильная получасовая свеча вверх на большом объёме
        </motion.div>
        <motion.div className="f-disp font-extrabold" style={{ fontSize: '3.8vmin', marginTop: '2.4vmin', color: '#ECE6DA' }}
          initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 3.0, duration: 0.4, ease: EASE }}>
          ловим продолжение свежего импульса ↗
        </motion.div>
      </div>
    </motion.section>
  );
}
