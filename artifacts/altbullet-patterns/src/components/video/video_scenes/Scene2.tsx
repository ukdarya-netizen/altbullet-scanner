import { motion } from 'framer-motion';
import { Candles, EASE, type C, BULL } from '../Candles';

const y = (p: number) => 820 - p * 6.6;
const RANGE: C[] = [
  [50, 52, 55, 47], [52, 50, 54, 48], [50, 53, 55, 48], [53, 51, 55, 49], [51, 49, 53, 47],
  [49, 52, 54, 47], [52, 50, 55, 48], [50, 53, 55, 49], [53, 52, 55, 49], [52, 54, 55, 50],
];
const BREAK: C[] = [[54, 76, 79, 53]];
const AFTER: C[] = [[76, 82, 85, 74], [82, 80, 86, 77], [80, 90, 93, 79]];

const NOTES = [
  { t: 2.6, k: 'покупатели сильнее', v: 'фьючерсы + спот' },
  { t: 3.2, k: 'стоп', v: '−8% от закрытия свечи пробоя', c: '#FF4A1C' },
  { t: 3.8, k: '+1R', v: 'стоп в безубыток' },
  { t: 4.4, k: 'далее', v: 'трейлинг · закрытие через 72 ч' },
];

export function Scene2() {
  return (
    <motion.section
      className="absolute inset-0 overflow-hidden grain"
      style={{ background: '#ECE6DA', color: '#15171D' }}
      initial={{ scale: 1.5, opacity: 0, filter: 'blur(10px)' }}
      animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
      exit={{ scale: 1.25, y: '-8%', opacity: 0, transition: { duration: 0.5, ease: [0.7, 0, 0.84, 0] } }}
      transition={{ duration: 0.7, ease: EASE }}
    >
      {/* title zone top-left */}
      <div className="absolute" style={{ left: '6%', top: '8%' }}>
        <motion.div className="f-mono flex items-center" style={{ fontSize: '2.1vmin', gap: '1.5vmin' }}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2 }}>
          <span style={{ background: '#15171D', color: '#ECE6DA', padding: '0.4vmin 1vmin' }}>01</span>
          <span className="uppercase tracking-[0.25em]">Stealth Breakout</span>
          <span style={{ border: '1px solid #15171D', padding: '0.2vmin 1vmin', borderRadius: 99 }}>эксперимент</span>
        </motion.div>
        <div className="overflow-hidden" style={{ marginTop: '1.6vmin' }}>
          <motion.div className="f-disp font-black leading-none" style={{ fontSize: '8vmin' }}
            initial={{ y: '105%' }} animate={{ y: 0 }} transition={{ delay: 0.3, duration: 0.6, ease: EASE }}>
            Пробой узкого ренджа
          </motion.div>
        </div>
      </div>

      <svg viewBox="0 0 1600 900" className="absolute inset-0 w-full h-full">
        {/* range box */}
        <motion.rect x={160} y={y(55.5)} width={720} height={y(46.5) - y(55.5)} fill="rgba(47,63,216,0.08)"
          stroke="#2F3FD8" strokeWidth={2.5} strokeDasharray="10 8"
          initial={{ pathLength: 0, opacity: 0 }} animate={{ pathLength: 1, opacity: 1 }}
          transition={{ delay: 0.4, duration: 1.0 }} />
        <motion.text x={170} y={y(46.5) + 34} className="f-mono" fontSize={22} fill="#2F3FD8"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.2 }}>
          долго в узком диапазоне
        </motion.text>
        <Candles data={RANGE} x0={200} step={70} y={y} delay={0.3} stagger={0.11} />
        <Candles data={BREAK} x0={900} step={70} y={y} delay={1.8} />
        <Candles data={AFTER} x0={970} step={70} y={y} delay={2.4} stagger={0.15} />
        {/* breakout label */}
        <motion.g initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 2.0, duration: 0.4, ease: EASE }}>
          <line x1={900} x2={1210} y1={y(57.3)} y2={y(57.3)} stroke={BULL} strokeWidth={2} strokeDasharray="4 6" />
          <text x={930} y={y(79) - 18} className="f-mono" fontSize={24} fontWeight={700} fill={BULL}>1ч закрытие ≥ +2% над верхом</text>
        </motion.g>
        {/* stop line */}
        <motion.line x1={160} x2={1240} y1={y(49.7)} y2={y(49.7)} stroke="#FF4A1C" strokeWidth={3}
          initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ delay: 3.2, duration: 0.6 }} />
      </svg>

      {/* callouts right column */}
      <div className="absolute" style={{ right: '5%', top: '30%', width: '24%' }}>
        {NOTES.map((n) => (
          <motion.div key={n.k} style={{ borderLeft: `0.5vmin solid ${n.c ?? '#15171D'}`, paddingLeft: '1.6vmin', marginBottom: '2.6vmin' }}
            initial={{ opacity: 0, x: 40 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: n.t, duration: 0.45, ease: EASE }}>
            <div className="f-disp font-extrabold" style={{ fontSize: '3.4vmin', color: n.c ?? '#15171D' }}>{n.k}</div>
            <div className="f-mono" style={{ fontSize: '2.2vmin', color: '#5A5A5E' }}>{n.v}</div>
          </motion.div>
        ))}
      </div>
    </motion.section>
  );
}
