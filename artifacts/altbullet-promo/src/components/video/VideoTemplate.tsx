import { useEffect, useRef } from 'react';
import { VideoCanvas, type VideoAspectRatio, useVideoPlayer, VideoPausedContext } from '@/lib/video';
import { AnimatePresence } from 'framer-motion';
import { Scene1 } from './video_scenes/Scene1';
import { Scene2 } from './video_scenes/Scene2';
import { Scene3 } from './video_scenes/Scene3';
import { Scene4 } from './video_scenes/Scene4';

export const SCENE_DURATIONS = { hook: 3900, scanner: 3850, bot: 3400, lockup: 3850 };
const SCENE_COMPONENTS: Record<string, React.ComponentType> = { hook: Scene1, scanner: Scene2, bot: Scene3, lockup: Scene4 };
const VIDEO_ASPECT_RATIO: VideoAspectRatio = '16:9';
const SCENE_START_SEC: Record<string, number> = (() => {
  const out: Record<string, number> = {}; let c = 0;
  for (const [k, ms] of Object.entries(SCENE_DURATIONS)) { out[k] = c / 1000; c += ms; }
  return out;
})();
const AUDIO_SEEK_EPSILON_SEC = 0.18;

export default function VideoTemplate({ durations = SCENE_DURATIONS, loop = true, paused = false, muted = false, onSceneChange }: {
  durations?: Record<string, number>; loop?: boolean; paused?: boolean; muted?: boolean; onSceneChange?: (k: string) => void;
} = {}) {
  const { currentSceneKey } = useVideoPlayer({ durations, loop, paused });
  useEffect(() => { onSceneChange?.(currentSceneKey); }, [currentSceneKey, onSceneChange]);
  const baseSceneKey = currentSceneKey.replace(/_r[12]$/, '');
  const SceneComponent = SCENE_COMPONENTS[baseSceneKey];
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    const a = audioRef.current; if (!a) return;
    a.volume = 0.5;
    if (paused) { a.pause(); return; }
    if (lastKey.current !== currentSceneKey) {
      lastKey.current = currentSceneKey;
      const t = SCENE_START_SEC[baseSceneKey] ?? 0;
      if (Math.abs(a.currentTime - t) > AUDIO_SEEK_EPSILON_SEC) a.currentTime = t;
    }
    a.play().catch(() => {});
  }, [currentSceneKey, baseSceneKey, muted, paused]);
  return (
    <VideoPausedContext.Provider value={paused}>
      <VideoCanvas aspectRatio={VIDEO_ASPECT_RATIO} style={{ backgroundColor: 'var(--ink)' }}>
        <AnimatePresence mode="sync">{SceneComponent && <SceneComponent key={currentSceneKey} />}</AnimatePresence>
        <audio ref={audioRef} src={`${import.meta.env.BASE_URL}audio/bg_music.mp3`} preload="auto" autoPlay muted={muted} />
      </VideoCanvas>
    </VideoPausedContext.Provider>
  );
}
