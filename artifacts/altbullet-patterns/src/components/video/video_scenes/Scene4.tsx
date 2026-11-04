import { motion } from 'framer-motion';
import { Candles, EASE, type C } from '../Candles';

const y = (p: number) => 860 - p * 7;
const CASC: C[] = [[96, 90, 97, 88], [90, 82, 91, 80], [82, 70, 83, 66], [70, 56, 71, 52], [56, 40, 57, 34], [40, 30, 42, 24]];
const REC: C[] = [[30, 38, 40, 28], [38, 44, 46, 36], [44, 52, 54, 42]];

export function Scene4() {
  return (
    <motion.section
      className="absolute inset-0 overflow-hidden grain"
      style={{ background: '#15171D', color: '#ECE6DA' }}
      initial={{ y: '100%' }}
      animate={{ y: 0 }}
      exit={{ opacity: 0, transition: { duration: 0.3, delay: 0.3 } }}
      transition={{ duration: 0.55, ease: [0.7, 0, 0.3, 1] }}
    >
      <div className="absolute" style={{ left: '6%', top: '9%' }}>
        <motion.div className="f-mono uppercase tracking-[0.25em] flex items-center" style={{ fontSize: '2.1vmin', gap: '1.5vmin', color: '#8C877C' }}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }}>
          <span style={{ background: '#FF4A1C', color: '#15171D', padding: '0.4vmin 1vmin' }}>03</span> паттерн
        </motion.div>
        <div className="overflow-hidden" style={{ marginTop: '1.4vmin' }}>
          <motion.div className="f-disp font-black uppercase leading-[0.95]" style={{ fontSize: '9vmin' }}
            initial={{ y: '105%' }} animate={{ y: 0 }} transition={{ delay: 0.4, duration: 0.55, ease: EASE }}>
            Каскад
          </motion.div>
        </div>
        <div className="overflow-hidden">
          <motion.div className="f-disp font-black uppercase leading-[0.95]" style={{ fontSize: '9vmin', color: '#FF4A1C' }}
            initial={{ y: '105%' }} animate={{ y: 0 }} transition={{ delay: 0.6, duration: 0.55, ease: EASE }}>
            ликвидаций
          </motion.div>
        </div>
      </div>

      <svg viewBox="0 0 1600 900" className="absolute inset-0 w-full h-full">
        <Candles data={CASC} x0={900} step={80} y={y} delay={0.3} stagger={0.28} />
        {CASC.map((_, i) => (
          <motion.g key={i} initial={{ opacity: 0, y: -30 }} animate={{ opacity: [0, 1, 0.35], y: 0 }}
            transition={{ delay: 0.4 + i * 0.28, duration: 0.5 }}>
            <rect x={900 + i * 80 - 26} y={820} width={52} height={26} fill="#FF4A1C" />
            <text x={900 + i * 80} y={839} textAnchor="middle" className="f-mono" fontSize={16} fontWeight={800} fill="#15171D">LIQ</text>
          </motion.g>
        ))}
        <Candles data={REC} x0={900 + 6 * 80} step={80} y={y} delay={2.6} stagger={0.3} />
        <motion.path d={`M ${900 + 5 * 80} ${y(18)} L ${900 + 8 * 80} ${y(62)}`} stroke="#0E9F6E" strokeWidth={5} fill="none" strokeLinecap="round"
          initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ delay: 3.3, duration: 0.5 }} />
      </svg>

      <div className="absolute" style={{ left: '6%', bottom: '14%', width: '40%' }}>
        <motion.div className="f-mono" style={{ fontSize: '2.4vmin', color: '#8C877C' }}
          initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 1.6, duration: 0.4 }}>
          волна принудительных закрытий позиций
        </motion.div>
        <motion.div className="f-disp font-extrabold" style={{ fontSize: '3.6vmin', marginTop: '1.4vmin' }}
          initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 2.2, duration: 0.4 }}>
          давление продавцов выдыхается
        </motion.div>
        <motion.div className="f-disp font-extrabold" style={{ fontSize: '3.6vmin', marginTop: '1vmin', color: '#0E9F6E' }}
          initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 3.4, duration: 0.4 }}>
          → ловим разворот
        </motion.div>
      </div>

      {/* vermilion aperture handoff from last candle */}
      <motion.div className="absolute rounded-full" style={{ left: '87%', top: '43%', width: '10vmin', height: '10vmin', background: '#FF4A1C', x: '-50%', y: '-50%' }}
        initial={{ scale: 0 }} animate={{ scale: [0, 0, 30] }} transition={{ duration: 4.95, times: [0, 0.86, 1], ease: 'easeIn' }} />
    </motion.section>
  );
}
