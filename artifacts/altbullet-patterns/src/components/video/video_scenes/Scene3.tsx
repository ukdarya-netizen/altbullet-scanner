import { motion } from 'framer-motion';
import { Candles, EASE, type C } from '../Candles';

const y = (p: number) => 760 - p * 6.4;
const FALL: C[] = [[88, 84, 90, 82], [84, 78, 85, 76], [78, 74, 80, 72], [74, 66, 75, 64], [66, 58, 67, 56], [58, 50, 59, 48], [50, 44, 51, 38]];
const UP: C[] = [[44, 54, 56, 41], [54, 62, 64, 52], [62, 72, 74, 60]];
const VOL = [18, 22, 20, 26, 30, 34, 52, 88, 74, 66];

export function Scene3() {
  return (
    <motion.section
      className="absolute inset-0 overflow-hidden grain"
      style={{ background: '#2F3FD8', color: '#ECE6DA' }}
      initial={{ clipPath: 'circle(0% at 50% 50%)' }}
      animate={{ clipPath: 'circle(80% at 50% 50%)' }}
      exit={{ y: '-100%', transition: { duration: 0.55, ease: [0.7, 0, 0.3, 1] } }}
      transition={{ duration: 0.6, ease: EASE }}
    >
      <motion.div className="f-disp outline-word absolute font-black uppercase leading-none whitespace-nowrap"
        style={{ ['--outline-color' as string]: 'rgba(236,230,218,0.35)', fontSize: '30vmin', left: '50%', top: '4%', x: '-50%' } as never}
        initial={{ scale: 1.3, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ delay: 0.2, duration: 0.9, ease: EASE }}>
        отскок
      </motion.div>

      <svg viewBox="0 0 1600 900" className="absolute inset-0 w-full h-full">
        {/* support band */}
        <motion.rect x={0} y={y(46)} height={y(36) - y(46)} width={1600} fill="#F2B33D" opacity={0.85}
          style={{ transformOrigin: '0px 0px', transformBox: 'view-box' }}
          initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ delay: 0.2, duration: 0.6, ease: EASE }} />
        <motion.text x={60} y={y(46) - 14} className="f-mono" fontSize={26} fontWeight={700} fill="#F2B33D"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.7 }}>
          СИЛЬНАЯ ЗОНА ПОДДЕРЖКИ
        </motion.text>
        <Candles data={FALL} x0={360} step={72} y={y} delay={0.6} stagger={0.19} bull="#7CF0B9" bear="#ECE6DA" />
        <Candles data={UP} x0={360 + 7 * 72} step={72} y={y} delay={2.0} stagger={0.25} bull="#7CF0B9" />
        {VOL.map((v, i) => (
          <motion.rect key={i} x={360 + i * 72 - 20} width={40} y={880 - v} height={v} fill={i >= 7 ? '#7CF0B9' : 'rgba(236,230,218,0.4)'}
            style={{ transformOrigin: `0px 880px`, transformBox: 'view-box' }}
            initial={{ scaleY: 0 }} animate={{ scaleY: 1 }} transition={{ delay: i < 7 ? 0.6 + i * 0.19 : 2.0 + (i - 7) * 0.25, duration: 0.3 }} />
        ))}
        <motion.path d={`M ${360 + 6 * 72} ${y(36)} Q ${360 + 6 * 72} ${y(20)} ${360 + 8 * 72} ${y(26)}`} fill="none" stroke="#7CF0B9" strokeWidth={4}
          initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ delay: 2.0, duration: 0.5 }} />
      </svg>

      <div className="absolute" style={{ left: '6%', top: '9%' }}>
        <motion.div className="f-mono uppercase tracking-[0.25em] flex items-center" style={{ fontSize: '2.1vmin', gap: '1.5vmin' }}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }}>
          <span style={{ background: '#ECE6DA', color: '#2F3FD8', padding: '0.4vmin 1vmin' }}>02</span> Neon Support
          <span className="normal-case tracking-normal" style={{ border: '1px solid #ECE6DA', padding: '0.2vmin 1vmin', borderRadius: 99 }}>эксперимент</span>
        </motion.div>
      </div>

      <div className="absolute" style={{ right: '6%', top: '30%', width: '30%' }}>
        <motion.div className="f-disp font-black leading-none" style={{ fontSize: '7.5vmin' }}
          initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 2.4, duration: 0.5, ease: EASE }}>
          Отскок от поддержки
        </motion.div>
        <motion.div className="f-mono" style={{ fontSize: '2.3vmin', marginTop: '2vmin', lineHeight: 1.4 }}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 3.0, duration: 0.4 }}>
          цена вернулась к зоне и оттолкнулась вверх — <span style={{ color: '#7CF0B9' }}>с объёмом и покупателем</span>
        </motion.div>
      </div>
    </motion.section>
  );
}
