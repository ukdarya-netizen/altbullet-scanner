import { useCallback, useMemo, useState } from 'react';
const RE = /_r[12]$/;
export function stripRepeatSuffix(k: string) { return k.replace(RE, ''); }
function rotate(d: Record<string, number>, s: number) { const ks = Object.keys(d); if (s <= 0) return d; const r: Record<string, number> = {}; for (let i = 0; i < ks.length; i++) { const k = ks[(s + i) % ks.length]; r[k] = d[k]; } return r; }
export function useSceneControls(base: Record<string, number>) {
  const sceneKeys = useMemo(() => Object.keys(base), [base]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [locked, setLocked] = useState(false);
  const [paused, setPaused] = useState(false);
  const [mountKey, setMountKey] = useState(0);
  const [tick, setTick] = useState(0);
  const durations = useMemo(() => { if (locked) { const k = sceneKeys[activeIndex]; return { [k + '_r1']: base[k], [k + '_r2']: base[k] }; } return rotate(base, activeIndex); }, [locked, activeIndex, sceneKeys, base]);
  const totalDuration = useMemo(() => Object.values(base).reduce((a, b) => a + b, 0), [base]);
  const activeStartTime = useMemo(() => sceneKeys.slice(0, activeIndex).reduce((a, k) => a + base[k], 0), [activeIndex, base, sceneKeys]);
  const onSceneChange = useCallback((raw: string) => { const i = sceneKeys.indexOf(stripRepeatSuffix(raw)); if (i >= 0) setActiveIndex(i); setTick(t => t + 1); }, [sceneKeys]);
  const jumpTo = useCallback((i: number) => { setActiveIndex(i); setPaused(false); setMountKey(k => k + 1); setTick(t => t + 1); }, []);
  const toggleLock = useCallback(() => { setLocked(p => !p); setPaused(false); setMountKey(k => k + 1); setTick(t => t + 1); }, []);
  const togglePause = useCallback(() => setPaused(p => !p), []);
  return { sceneKeys, activeIndex, locked, paused, mountKey, tick, durations, activeDuration: base[sceneKeys[activeIndex]] ?? 0, activeStartTime, totalDuration, onSceneChange, jumpTo, toggleLock, togglePause };
}
