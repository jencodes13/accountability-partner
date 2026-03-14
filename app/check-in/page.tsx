'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '@/components/auth-provider';
import { Mic, MicOff, Square } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getUserProfile, getHabits, Habit, UserProfile, HABIT_CATEGORY_LABELS, HabitCategory } from '@/lib/db';

// WebSocket connects directly to the backend (Next.js can't proxy WS)
const BACKEND_WS_URL = process.env.NEXT_PUBLIC_BACKEND_WS_URL || 'ws://localhost:8000';

// ─── Types ───

interface SessionSummary {
  habitsCovered: string[];
  habitsSkipped: string[];
  commitments: string[];
  insight: string;
  streaks: Record<string, number>;
  milestoneHabit?: string;
  isNewRecord?: boolean;
}

interface TranscriptEntry {
  role: string;
  text: string;
}

// ─── RMS calculation helper ───

function calculateRMS(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}

// ─── Aurora Component ───
// Wide aurora with multiple translucent layers that drift independently.
// Accepts audioLevel (0-1) to dynamically morph shape and scale.

function Aurora({ state, audioLevel = 0 }: { state: 'idle' | 'listening' | 'speaking'; audioLevel?: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const smoothLevelRef = useRef(0);
  const rafRef = useRef<number>(0);
  const layerRefs = useRef<(HTMLDivElement | null)[]>([null, null, null, null]);

  // Smoothly interpolate audio level with requestAnimationFrame
  useEffect(() => {
    let running = true;

    const animate = () => {
      if (!running) return;

      // Smoothly approach target level — fast attack, slow release
      const target = audioLevel;
      const current = smoothLevelRef.current;
      const speed = target > current ? 0.25 : 0.08;
      smoothLevelRef.current = current + (target - current) * speed;
      const level = smoothLevelRef.current;

      // Config per state (base values)
      const baseConfig = {
        idle: { outerScale: 1, midScale: 1, innerScale: 1, coreScale: 1 },
        listening: { outerScale: 0.85, midScale: 0.88, innerScale: 0.9, coreScale: 1.05 },
        speaking: { outerScale: 1.15, midScale: 1.12, innerScale: 1.1, coreScale: 1.15 },
      };
      const bc = baseConfig[state];

      // Audio modulation on scales
      const outerScale = bc.outerScale + level * 0.08;
      const midScale = bc.midScale + level * 0.12;
      const innerScale = bc.innerScale + level * 0.15;
      const coreScale = bc.coreScale + level * 0.2;

      // Dynamic border-radius based on audio level for organic morphing
      const shift = level * 12; // 0-12% shift
      const coreBR = `${48 + shift}% ${52 - shift}% ${55 - shift * 0.5}% ${45 + shift * 0.5}% / ${52 - shift * 0.7}% ${48 + shift * 0.7}% ${45 + shift}% ${55 - shift}%`;
      const innerBR = `${50 + shift * 0.8}% ${50 - shift * 0.8}% ${45 + shift * 0.6}% ${55 - shift * 0.6}% / ${55 - shift * 0.5}% ${50 + shift * 0.5}% ${50 - shift * 0.3}% ${45 + shift * 0.3}%`;
      const midBR = `${55 - shift * 0.5}% ${45 + shift * 0.5}% ${58 - shift * 0.4}% ${42 + shift * 0.4}% / ${42 + shift * 0.6}% ${55 - shift * 0.6}% ${45 + shift * 0.3}% ${58 - shift * 0.3}%`;
      const outerBR = `${62 - shift * 0.3}% ${38 + shift * 0.3}% ${52 + shift * 0.2}% ${48 - shift * 0.2}% / ${48 + shift * 0.4}% ${62 - shift * 0.4}% ${38 + shift * 0.2}% ${52 - shift * 0.2}%`;

      // Opacity modulation
      const outerOpacity = (state === 'speaking' ? 0.1 : 0.06) + level * 0.04;
      const midOpacity = (state === 'speaking' ? 0.18 : state === 'listening' ? 0.08 : 0.12) + level * 0.06;
      const innerOpacity = (state === 'speaking' ? 0.3 : state === 'listening' ? 0.18 : 0.22) + level * 0.08;

      // Shadow modulation
      const shadowIntensity = state === 'speaking' ? 0.45 : state === 'listening' ? 0.35 : 0.25;
      const shadowMod = shadowIntensity + level * 0.2;
      const shadowSpread = 40 + level * 30;
      const shadowSpread2 = 80 + level * 40;

      // Apply to layers via refs (no React re-render)
      const outer = layerRefs.current[0];
      const mid = layerRefs.current[1];
      const inner = layerRefs.current[2];
      const core = layerRefs.current[3];

      if (outer) {
        outer.style.transform = `scale(${outerScale})`;
        outer.style.borderRadius = outerBR;
        outer.style.opacity = String(outerOpacity);
      }
      if (mid) {
        mid.style.transform = `scale(${midScale})`;
        mid.style.borderRadius = midBR;
        mid.style.opacity = String(midOpacity);
      }
      if (inner) {
        inner.style.transform = `scale(${innerScale})`;
        inner.style.borderRadius = innerBR;
        inner.style.opacity = String(innerOpacity);
      }
      if (core) {
        core.style.transform = `scale(${coreScale})`;
        core.style.borderRadius = coreBR;
        core.style.boxShadow = `0 0 ${shadowSpread}px rgba(130,184,154,${shadowMod}), 0 0 ${shadowSpread2}px rgba(130,184,154,${shadowMod * 0.4})`;
      }

      rafRef.current = requestAnimationFrame(animate);
    };

    rafRef.current = requestAnimationFrame(animate);
    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [audioLevel, state]);

  const speed = state === 'speaking' ? 0.6 : state === 'listening' ? 0.85 : 1;

  return (
    <div ref={containerRef} className="relative mx-auto" style={{ width: 240, height: 240 }}>
      {/* Outermost layer */}
      <div
        ref={el => { layerRefs.current[0] = el; }}
        className="absolute"
        style={{
          inset: 0,
          background: 'rgba(130,184,154,0.04)',
          filter: 'blur(8px)',
          transition: 'none',
          animation: `auroraLayer1 ${12 * speed}s ease-in-out infinite`,
        }}
      />
      {/* Layer 2 — mid spread */}
      <div
        ref={el => { layerRefs.current[1] = el; }}
        className="absolute"
        style={{
          inset: 25,
          background: 'linear-gradient(160deg, rgba(130,184,154,0.1) 0%, rgba(100,170,135,0.06) 50%, rgba(150,200,170,0.08) 100%)',
          filter: 'blur(4px)',
          transition: 'none',
          animation: `auroraLayer2 ${9 * speed}s ease-in-out infinite`,
        }}
      />
      {/* Layer 3 — inner shimmer */}
      <div
        ref={el => { layerRefs.current[2] = el; }}
        className="absolute"
        style={{
          inset: 55,
          background: 'linear-gradient(200deg, rgba(130,184,154,0.22) 0%, rgba(163,212,183,0.15) 40%, rgba(110,168,142,0.2) 100%)',
          backgroundSize: '200% 200%',
          filter: 'blur(1px)',
          transition: 'none',
          animation: `auroraLayer3 ${7 * speed}s ease-in-out infinite, auroraShimmer ${8 * speed}s ease-in-out infinite`,
        }}
      />
      {/* Core — warm highlight */}
      <div
        ref={el => { layerRefs.current[3] = el; }}
        className="absolute"
        style={{
          inset: 90,
          background: 'linear-gradient(135deg, rgba(180,224,200,0.45) 0%, rgba(130,184,154,0.35) 60%, rgba(163,212,183,0.4) 100%)',
          backgroundSize: '200% 200%',
          transition: 'none',
          animation: `auroraCore ${4 * speed}s ease-in-out infinite, auroraShimmer ${5 * speed}s ease-in-out infinite`,
        }}
      />
    </div>
  );
}

// ─── Keyframes ───

const AURORA_KEYFRAMES = `
  @keyframes auroraLayer1 {
    0% { border-radius: 62% 38% 52% 48% / 48% 62% 38% 52%; transform: rotate(0deg); }
    33% { border-radius: 48% 52% 38% 62% / 62% 48% 52% 38%; transform: rotate(40deg); }
    66% { border-radius: 52% 48% 62% 38% / 38% 52% 48% 62%; transform: rotate(80deg); }
    100% { border-radius: 62% 38% 52% 48% / 48% 62% 38% 52%; transform: rotate(120deg); }
  }
  @keyframes auroraLayer2 {
    0% { border-radius: 55% 45% 58% 42% / 42% 55% 45% 58%; transform: rotate(0deg); }
    50% { border-radius: 42% 58% 45% 55% / 58% 42% 55% 45%; transform: rotate(-60deg); }
    100% { border-radius: 55% 45% 58% 42% / 42% 55% 45% 58%; transform: rotate(-120deg); }
  }
  @keyframes auroraLayer3 {
    0% { border-radius: 50% 50% 45% 55% / 55% 50% 50% 45%; transform: scale(1); }
    33% { border-radius: 45% 55% 50% 50% / 50% 45% 55% 50%; transform: scale(1.08); }
    66% { border-radius: 55% 45% 50% 50% / 50% 55% 45% 50%; transform: scale(0.96); }
    100% { border-radius: 50% 50% 45% 55% / 55% 50% 50% 45%; transform: scale(1); }
  }
  @keyframes auroraCore {
    0% { border-radius: 48% 52% 55% 45% / 52% 48% 45% 55%; }
    50% { border-radius: 52% 48% 45% 55% / 48% 52% 55% 45%; }
    100% { border-radius: 48% 52% 55% 45% / 52% 48% 45% 55%; }
  }
  @keyframes auroraShimmer {
    0% { background-position: 0% 50%; }
    50% { background-position: 100% 50%; }
    100% { background-position: 0% 50%; }
  }
  @keyframes pulseDot {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.5; transform: scale(0.7); }
  }
  @keyframes blinkCursor {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }
`;

// ─── Timer Hook ───

function useTimer(running: boolean) {
  const [seconds, setSeconds] = useState(0);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (running) {
      intervalRef.current = setInterval(() => {
        setSeconds(s => s + 1);
      }, 1000);
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [running]);

  const reset = useCallback(() => setSeconds(0), []);
  const formatted = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  return { seconds, formatted, reset };
}

// ─── Main Component ───

export default function CheckInPage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  // Profile + habits
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [profileChecked, setProfileChecked] = useState(false);
  const [habits, setHabits] = useState<Habit[]>([]);

  // Session state
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [currentSpeaker, setCurrentSpeaker] = useState<'agent' | 'user' | null>(null);
  const [activeHabitIndex, setActiveHabitIndex] = useState(0);
  const [coveredHabits, setCoveredHabits] = useState<Set<string>>(new Set());

  // Transcript display state
  const [agentMessages, setAgentMessages] = useState<string[]>([]);
  const [currentAgentText, setCurrentAgentText] = useState('');
  const [lastUserText, setLastUserText] = useState('');
  const lastTranscriptRoleRef = useRef<'assistant' | 'user' | null>(null);

  // Audio level state (updated via refs, read from state for Aurora)
  const [audioLevel, setAudioLevel] = useState(0);
  const userAudioLevelRef = useRef(0);
  const agentAudioLevelRef = useRef(0);
  const audioLevelRafRef = useRef<number>(0);

  // Debrief state
  const [sessionEnded, setSessionEnded] = useState(false);
  const [sessionSummary, setSessionSummary] = useState<SessionSummary | null>(null);

  // Timer
  const timer = useTimer(isConnected);

  // Refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const playbackContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const nextPlayTimeRef = useRef<number>(0);
  const isMicMutedRef = useRef(false);
  const isConnectedRef = useRef(false);
  const currentSpeakerTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep refs in sync
  useEffect(() => { isMicMutedRef.current = isMicMuted; }, [isMicMuted]);
  useEffect(() => { isConnectedRef.current = isConnected; }, [isConnected]);

  // Audio level animation loop — pushes combined level to React state at ~60fps
  useEffect(() => {
    let running = true;

    const tick = () => {
      if (!running) return;

      // Decay agent audio level over time (smooth falloff)
      agentAudioLevelRef.current *= 0.92;
      // Decay user audio level slightly
      userAudioLevelRef.current *= 0.95;

      const combined = Math.min(1, Math.max(userAudioLevelRef.current, agentAudioLevelRef.current));
      setAudioLevel(combined);
      audioLevelRafRef.current = requestAnimationFrame(tick);
    };

    audioLevelRafRef.current = requestAnimationFrame(tick);
    return () => {
      running = false;
      cancelAnimationFrame(audioLevelRafRef.current);
    };
  }, []);

  // Load profile + habits — redirect to onboarding if not complete
  useEffect(() => {
    if (!user) return;
    getUserProfile(user.uid).then(p => {
      if (!p || !p.onboardingComplete) {
        router.push('/onboarding');
        return;
      }
      setProfile(p);
      setProfileChecked(true);
      return getHabits(user.uid);
    }).then(h => {
      if (h) setHabits(h);
    }).catch(() => {
      router.push('/onboarding');
    });
  }, [user, router]);

  const agentName = profile?.agentName || '';
  const displayName = profile?.displayName?.split(' ')[0] || user?.displayName?.split(' ')[0] || 'there';

  // ─── Cleanup ───

  const cleanup = useCallback(() => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (playbackContextRef.current && playbackContextRef.current.state !== 'closed') {
      playbackContextRef.current.close();
      playbackContextRef.current = null;
    }
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'end' }));
      wsRef.current.close();
      wsRef.current = null;
    }
    if (currentSpeakerTimeoutRef.current) {
      clearTimeout(currentSpeakerTimeoutRef.current);
      currentSpeakerTimeoutRef.current = null;
    }
  }, []);

  const endSession = useCallback(() => {
    // Finalize any remaining agent text into agentMessages
    setCurrentAgentText(prev => {
      if (prev.trim()) {
        setAgentMessages(msgs => [...msgs, prev.trim()]);
      }
      return '';
    });
    setIsConnected(false);
    setIsConnecting(false);
    setSessionEnded(true);
    setCurrentSpeaker(null);
    cleanup();
  }, [cleanup]);

  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

  // ─── Audio Playback ───

  const playAudioChunk = (base64Audio: string) => {
    if (!playbackContextRef.current) return;
    const ctx = playbackContextRef.current;

    const binaryString = atob(base64Audio);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    try {
      const audioBuffer = ctx.createBuffer(1, bytes.length / 2, 24000);
      const channelData = audioBuffer.getChannelData(0);
      const dataView = new DataView(bytes.buffer);
      for (let i = 0; i < channelData.length; i++) {
        channelData[i] = dataView.getInt16(i * 2, true) / 32768.0;
      }

      // Calculate RMS of decoded audio for agent audio level
      const rms = calculateRMS(channelData);
      const scaledLevel = Math.min(1, rms * 5);
      agentAudioLevelRef.current = Math.max(agentAudioLevelRef.current, scaledLevel);

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);

      const currentTime = ctx.currentTime;
      if (nextPlayTimeRef.current < currentTime) {
        nextPlayTimeRef.current = currentTime;
      }

      source.start(nextPlayTimeRef.current);
      const chunkEndTime = nextPlayTimeRef.current + audioBuffer.duration;
      nextPlayTimeRef.current = chunkEndTime;

      // Reset currentSpeaker to null after audio finishes playing
      if (currentSpeakerTimeoutRef.current) {
        clearTimeout(currentSpeakerTimeoutRef.current);
      }
      const delayMs = Math.max(0, (chunkEndTime - ctx.currentTime) * 1000) + 300;
      currentSpeakerTimeoutRef.current = setTimeout(() => {
        // Only reset if still 'agent' (user might have started speaking)
        setCurrentSpeaker(prev => prev === 'agent' ? null : prev);
        agentAudioLevelRef.current = 0;
      }, delayMs);
    } catch (e) {
      console.error('Error playing audio', e);
    }
  };

  // ─── Start Session ───

  const startSession = async () => {
    if (!user) return;
    setIsConnecting(true);
    setSessionEnded(false);
    setSessionSummary(null);
    setTranscript([]);
    setAgentMessages([]);
    setCurrentAgentText('');
    setLastUserText('');
    lastTranscriptRoleRef.current = null;
    setCoveredHabits(new Set());
    setActiveHabitIndex(0);
    timer.reset();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      mediaStreamRef.current = stream;

      audioContextRef.current = new window.AudioContext({ sampleRate: 16000 });
      playbackContextRef.current = new window.AudioContext();
      nextPlayTimeRef.current = playbackContextRef.current.currentTime;

      const source = audioContextRef.current.createMediaStreamSource(stream);
      const processor = audioContextRef.current.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      source.connect(processor);
      processor.connect(audioContextRef.current.destination);

      const ws = new WebSocket(`${BACKEND_WS_URL}/api/sessions/${user.uid}`);
      wsRef.current = ws;

      ws.onopen = () => {
        // Wait for backend "connected" message
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);

        switch (msg.type) {
          case 'connected':
            setIsConnected(true);
            setIsConnecting(false);

            processor.onaudioprocess = (e) => {
              if (isMicMutedRef.current || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
              const inputData = e.inputBuffer.getChannelData(0);

              // Calculate user audio level (RMS)
              const rms = calculateRMS(inputData);
              const scaledLevel = Math.min(1, rms * 8);
              userAudioLevelRef.current = Math.max(userAudioLevelRef.current * 0.9, scaledLevel);

              const pcm16 = new Int16Array(inputData.length);
              for (let i = 0; i < inputData.length; i++) {
                pcm16[i] = Math.max(-32768, Math.min(32767, inputData[i] * 32768));
              }
              const uint8 = new Uint8Array(pcm16.buffer);
              let binary = '';
              const chunkSize = 8192;
              for (let offset = 0; offset < uint8.length; offset += chunkSize) {
                const chunk = uint8.subarray(offset, Math.min(offset + chunkSize, uint8.length));
                binary += String.fromCharCode.apply(null, Array.from(chunk));
              }
              const base64Data = btoa(binary);
              wsRef.current!.send(JSON.stringify({ type: 'audio', data: base64Data }));
            };
            break;

          case 'audio':
            setCurrentSpeaker('agent');
            playAudioChunk(msg.data);
            break;

          case 'interrupted':
            if (playbackContextRef.current) {
              nextPlayTimeRef.current = playbackContextRef.current.currentTime;
            }
            agentAudioLevelRef.current = 0;
            break;

          case 'transcript':
            if (msg.role === 'assistant') {
              setCurrentSpeaker('agent');
              lastTranscriptRoleRef.current = 'assistant';
              setCurrentAgentText(prev => {
                const next = prev ? prev + ' ' + msg.text : msg.text;
                return next;
              });
            } else if (msg.role === 'user') {
              // If we were accumulating agent text, finalize it as a complete message
              if (lastTranscriptRoleRef.current === 'assistant') {
                setCurrentAgentText(prev => {
                  if (prev.trim()) {
                    setAgentMessages(msgs => [...msgs, prev.trim()]);
                  }
                  return '';
                });
              }
              lastTranscriptRoleRef.current = 'user';
              setCurrentSpeaker('user');
              setLastUserText(msg.text);
            }
            // Also keep the full transcript for the debrief
            setTranscript(prev => {
              const last = prev[prev.length - 1];
              if (last && last.role === msg.role) {
                return [...prev.slice(0, -1), { ...last, text: last.text + ' ' + msg.text }];
              }
              return [...prev, { role: msg.role, text: msg.text }];
            });
            break;

          case 'habit_update':
            // Backend signals which habit is now being discussed
            if (msg.habitId) {
              setCoveredHabits(prev => new Set(prev).add(msg.habitId));
              const idx = habits.findIndex(h => h.id === msg.habitId);
              if (idx >= 0) setActiveHabitIndex(idx);
            }
            break;

          case 'session_summary':
            setSessionSummary({
              habitsCovered: msg.habitsCovered || [],
              habitsSkipped: msg.habitsSkipped || [],
              commitments: msg.commitments || [],
              insight: msg.insight || '',
              streaks: msg.streaks || {},
              milestoneHabit: msg.milestoneHabit,
              isNewRecord: msg.isNewRecord,
            });
            endSession();
            break;

          case 'session_ended':
            endSession();
            break;

          case 'error':
            console.error('Backend error:', msg.message);
            endSession();
            break;
        }
      };

      ws.onclose = () => {
        if (isConnectedRef.current) endSession();
      };

      ws.onerror = (e) => {
        console.error('WebSocket error:', e);
        endSession();
      };
    } catch (error) {
      console.error('Error starting session:', error);
      setIsConnecting(false);
    }
  };

  // ─── Mic Toggle ───

  const toggleMic = () => {
    const newMuted = !isMicMuted;
    setIsMicMuted(newMuted);
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getAudioTracks().forEach(track => {
        track.enabled = !newMuted;
      });
    }
  };

  // ─── Loading / Auth Guard ───

  if (loading || !user || !profileChecked) {
    return (
      <div className="min-h-screen bg-background" />
    );
  }

  // ─── Build Debrief from transcript if no summary from backend ───

  const buildFallbackSummary = (): SessionSummary => {
    const covered = Array.from(coveredHabits);
    const skipped = habits.filter(h => !coveredHabits.has(h.id)).map(h => h.id);
    return {
      habitsCovered: covered,
      habitsSkipped: skipped,
      commitments: [],
      insight: '',
      streaks: {},
    };
  };

  const debriefData = sessionSummary || (sessionEnded ? buildFallbackSummary() : null);

  // ─── Helpers ───

  const getHabitLabel = (habitId: string): string => {
    const habit = habits.find(h => h.id === habitId);
    if (!habit) return habitId;
    return HABIT_CATEGORY_LABELS[habit.category as HabitCategory] || habit.label;
  };

  const getHabitShortLabel = (habit: Habit): string => {
    const labels: Record<string, string> = {
      'alcohol': 'Alcohol',
      'sports-betting': 'Betting',
      'nutrition': 'Nutrition',
      'exercise': 'Exercise',
      'spending': 'Spending',
      'journaling': 'Journaling',
      'screen-time': 'Screen Time',
      'sleep': 'Sleep',
      'workouts-steps': 'Workouts',
    };
    return labels[habit.category] || habit.label;
  };

  const currentHabitLabel = habits[activeHabitIndex]
    ? getHabitShortLabel(habits[activeHabitIndex])
    : '';

  // Derive the last complete agent message for prominent display
  const lastAgentMessage = agentMessages.length > 0 ? agentMessages[agentMessages.length - 1] : '';

  // Determine Aurora state
  const auroraState: 'idle' | 'listening' | 'speaking' =
    currentSpeaker === 'agent' ? 'speaking' :
    currentSpeaker === 'user' ? 'listening' :
    'idle';

  // ─── Debrief View ───

  if (sessionEnded && debriefData) {
    const isMilestone = debriefData.isNewRecord && debriefData.milestoneHabit;
    const milestoneLabel = debriefData.milestoneHabit ? getHabitLabel(debriefData.milestoneHabit) : '';
    const milestoneStreak = debriefData.milestoneHabit ? debriefData.streaks[debriefData.milestoneHabit] || 0 : 0;

    return (
      <div
        className="min-h-screen flex flex-col text-foreground"
        style={{
          background: 'linear-gradient(180deg, #1e2128 0%, #262b34 100%)',
          fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
        }}
      >
        <style>{AURORA_KEYFRAMES}</style>

        <div className="flex-1 flex flex-col items-center justify-start px-6 pt-16 pb-8 max-w-md mx-auto w-full">
          {/* Session label */}
          <div
            className="text-xs font-semibold tracking-[0.15em] uppercase mb-4"
            style={{ color: '#82b89a' }}
          >
            {isMilestone ? 'NEW RECORD' : 'SESSION COMPLETE'}
          </div>

          {/* Headline */}
          <h1
            className="text-2xl font-semibold text-center mb-1"
            style={{ color: '#e2e0e6', letterSpacing: '-0.3px' }}
          >
            {isMilestone
              ? `${milestoneStreak} days on ${milestoneLabel}.`
              : `Nice work, ${displayName}.`
            }
          </h1>

          {/* Sub-line */}
          <p
            className="text-sm text-center mb-8"
            style={{ color: '#b0b8c4' }}
          >
            {timer.formatted} session
            {debriefData.habitsCovered.length > 0 &&
              ` / ${debriefData.habitsCovered.length} habit${debriefData.habitsCovered.length !== 1 ? 's' : ''} covered`
            }
          </p>

          {/* Habit pills */}
          {habits.length > 0 && (
            <div className="flex flex-wrap justify-center gap-2 mb-8">
              {habits.map(habit => {
                const isCovered = debriefData.habitsCovered.includes(habit.id);
                return (
                  <div
                    key={habit.id}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium"
                    style={{
                      backgroundColor: isCovered ? 'rgba(130, 184, 154, 0.15)' : 'rgba(255,255,255,0.04)',
                      color: isCovered ? '#82b89a' : '#7e8a96',
                      border: '1px solid',
                      borderColor: isCovered ? 'rgba(130, 184, 154, 0.3)' : 'rgba(255,255,255,0.08)',
                    }}
                  >
                    <span>{isCovered ? '\u2713' : '\u2014'}</span>
                    <span>{getHabitShortLabel(habit)}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Commitments card */}
          {debriefData.commitments.length > 0 && (
            <div
              className="w-full rounded-2xl p-4 mb-4"
              style={{
                backgroundColor: '#2e3440',
                border: '1px solid rgba(255,255,255,0.04)',
              }}
            >
              <div
                className="text-[11px] font-semibold tracking-[0.12em] uppercase mb-3"
                style={{ color: '#7e8a96' }}
              >
                YOUR COMMITMENTS
              </div>
              <ul className="space-y-2">
                {debriefData.commitments.map((c, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 text-sm"
                    style={{ color: '#e2e0e6' }}
                  >
                    <span
                      className="mt-1.5 w-1 h-1 rounded-full flex-shrink-0"
                      style={{ backgroundColor: '#82b89a' }}
                    />
                    {c}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Insight card */}
          {debriefData.insight && (
            <div
              className="w-full rounded-2xl p-4 mb-6"
              style={{
                backgroundColor: '#2e3440',
                border: '1px solid rgba(255,255,255,0.04)',
              }}
            >
              <div
                className="text-[11px] font-semibold tracking-[0.12em] uppercase mb-3"
                style={{ color: '#7e8a96' }}
              >
                INSIGHT
              </div>
              <p className="text-sm" style={{ color: '#b0b8c4', lineHeight: 1.6 }}>
                {debriefData.insight}
              </p>
            </div>
          )}

          {/* Streak row */}
          {habits.length > 0 && (
            <div className="w-full grid grid-cols-3 gap-2 mb-8">
              {habits.map(habit => {
                const streak = debriefData.streaks[habit.id] ?? habit.currentStreak;
                const isMilestoneHabit = debriefData.milestoneHabit === habit.id;
                return (
                  <div
                    key={habit.id}
                    className="rounded-xl px-3 py-3 text-center"
                    style={{
                      backgroundColor: '#2e3440',
                      border: isMilestoneHabit
                        ? '1px solid rgba(130, 184, 154, 0.5)'
                        : '1px solid rgba(255,255,255,0.04)',
                    }}
                  >
                    <div
                      className="text-lg font-semibold mb-0.5"
                      style={{ color: isMilestoneHabit ? '#82b89a' : '#e2e0e6' }}
                    >
                      {streak} {streak === 1 ? 'day' : 'days'}
                    </div>
                    <div
                      className="text-[11px] truncate"
                      style={{ color: '#7e8a96' }}
                    >
                      {getHabitShortLabel(habit)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Done button */}
          <Link
            href="/"
            className="w-full flex items-center justify-center rounded-2xl py-3.5 text-sm font-semibold transition-opacity hover:opacity-90"
            style={{
              backgroundColor: '#82b89a',
              color: '#1e2128',
              letterSpacing: '-0.1px',
            }}
          >
            Done
          </Link>
        </div>
      </div>
    );
  }

  // ─── Live Session / Pre-Session View ───

  return (
    <div
      className="min-h-screen flex flex-col text-foreground"
      style={{
        background: 'linear-gradient(180deg, #1e2128 0%, #262b34 100%)',
        fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
      }}
    >
      <style>{AURORA_KEYFRAMES}</style>

      {/* ─── Pre-Session ─── */}
      {!isConnected && !isConnecting && !sessionEnded && (
        <div className="flex-1 flex flex-col items-center justify-center px-6">
          <div className="w-full max-w-xs text-center">
            <div
              className="w-16 h-16 rounded-full mx-auto mb-6 flex items-center justify-center"
              style={{ backgroundColor: 'rgba(130, 184, 154, 0.15)' }}
            >
              <Mic className="w-7 h-7" style={{ color: '#82b89a' }} />
            </div>
            <h2
              className="text-xl font-semibold mb-2"
              style={{ color: '#e2e0e6', letterSpacing: '-0.3px' }}
            >
              Ready for your check-in?
            </h2>
            <p
              className="text-sm mb-8"
              style={{ color: '#7e8a96' }}
            >
              {agentName} will ask you about your habits today.
            </p>
            <button
              onClick={startSession}
              className="w-full rounded-2xl py-3.5 text-sm font-semibold transition-opacity hover:opacity-90"
              style={{
                backgroundColor: '#82b89a',
                color: '#1e2128',
              }}
            >
              Start Check-in
            </button>
          </div>
        </div>
      )}

      {/* ─── Connecting ─── */}
      {isConnecting && (
        <div className="flex-1 flex flex-col items-center justify-center px-6">
          <div className="w-full max-w-xs text-center">
            <div
              className="w-16 h-16 rounded-full mx-auto mb-6 flex items-center justify-center"
              style={{ backgroundColor: 'rgba(130, 184, 154, 0.15)' }}
            >
              <div
                className="w-5 h-5 rounded-full animate-pulse"
                style={{ backgroundColor: '#82b89a' }}
              />
            </div>
            <p className="text-sm" style={{ color: '#7e8a96' }}>
              Connecting to {agentName}...
            </p>
          </div>
        </div>
      )}

      {/* ─── Live Session ─── */}
      {isConnected && (
        <>
          {/* Top Bar */}
          <header className="flex items-center justify-between px-5 pt-5 pb-3">
            {/* Timer */}
            <div
              className="text-sm font-mono tabular-nums"
              style={{ color: '#b0b8c4' }}
            >
              {timer.formatted}
            </div>

            {/* Current habit */}
            <div
              className="text-sm font-medium"
              style={{ color: '#82b89a' }}
            >
              {currentHabitLabel}
            </div>

            {/* End button */}
            <button
              onClick={endSession}
              className="w-9 h-9 rounded-full flex items-center justify-center transition-opacity hover:opacity-80"
              style={{
                backgroundColor: 'rgba(239, 68, 68, 0.12)',
              }}
              title="End session"
            >
              <Square
                className="w-3.5 h-3.5"
                style={{ color: '#ef4444' }}
                fill="#ef4444"
              />
            </button>
          </header>

          {/* Habit Progress Pills */}
          {habits.length > 0 && (
            <div className="flex flex-wrap justify-center gap-2 px-5 pb-4">
              {habits.map((habit, idx) => {
                const isCovered = coveredHabits.has(habit.id);
                const isActive = idx === activeHabitIndex && !isCovered;
                const isPending = !isCovered && !isActive;
                return (
                  <div
                    key={habit.id}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium"
                    style={{
                      backgroundColor: isCovered
                        ? 'rgba(130, 184, 154, 0.15)'
                        : isActive
                          ? 'rgba(130, 184, 154, 0.08)'
                          : 'rgba(255,255,255,0.03)',
                      color: isCovered
                        ? '#82b89a'
                        : isActive
                          ? '#82b89a'
                          : '#7e8a96',
                      border: '1px solid',
                      borderColor: isCovered
                        ? 'rgba(130, 184, 154, 0.3)'
                        : isActive
                          ? 'rgba(130, 184, 154, 0.2)'
                          : 'rgba(255,255,255,0.08)',
                      opacity: isPending ? 0.5 : 1,
                    }}
                  >
                    {isCovered && <span>{'\u2713'}</span>}
                    {isActive && (
                      <span
                        className="w-2 h-2 rounded-full"
                        style={{
                          backgroundColor: '#82b89a',
                          animation: 'pulseDot 1.5s ease-in-out infinite',
                        }}
                      />
                    )}
                    <span>{getHabitShortLabel(habit)}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Center: Aurora Orb */}
          <div className="flex-1 flex flex-col items-center justify-center px-6">
            <Aurora state={auroraState} audioLevel={audioLevel} />
            <p
              className="text-sm mt-6"
              style={{ color: '#7e8a96' }}
            >
              {currentSpeaker === 'agent'
                ? `${agentName} is speaking...`
                : currentSpeaker === 'user'
                  ? 'Listening...'
                  : 'Listening...'}
            </p>
          </div>

          {/* Live Transcript */}
          <div
            className="mx-4 mb-4 rounded-2xl px-4 py-3"
            style={{
              backgroundColor: '#2e3440',
              border: '1px solid rgba(255,255,255,0.04)',
              minHeight: 64,
            }}
          >
            {/* Last complete agent message — prominent, re-readable */}
            {lastAgentMessage && !currentAgentText && (
              <p
                className="text-sm leading-relaxed"
                style={{ color: '#e2e0e6' }}
              >
                {lastAgentMessage}
              </p>
            )}

            {/* Current agent speech building up with blinking cursor */}
            {currentAgentText && (
              <p
                className="text-sm leading-relaxed"
                style={{ color: '#e2e0e6' }}
              >
                {currentAgentText}
                <span
                  className="inline-block w-[2px] h-[14px] ml-0.5 align-middle"
                  style={{
                    backgroundColor: '#82b89a',
                    animation: 'blinkCursor 1s step-end infinite',
                  }}
                />
              </p>
            )}

            {/* Fallback when no agent text yet */}
            {!lastAgentMessage && !currentAgentText && (
              <p
                className="text-sm italic"
                style={{ color: '#7e8a96' }}
              >
                Waiting for {agentName}...
              </p>
            )}

            {/* Last user text — smaller, muted */}
            {lastUserText && (
              <p
                className="text-xs mt-2"
                style={{ color: '#7e8a96' }}
              >
                You: {lastUserText}
              </p>
            )}
          </div>

          {/* Bottom Controls */}
          <div className="flex items-center justify-center gap-6 px-6 pb-8 pt-2">
            {/* Mute toggle (larger) */}
            <button
              onClick={toggleMic}
              className="w-16 h-16 rounded-full flex items-center justify-center transition-all"
              style={{
                backgroundColor: isMicMuted ? 'rgba(239, 68, 68, 0.15)' : 'rgba(130, 184, 154, 0.15)',
                border: '1px solid',
                borderColor: isMicMuted ? 'rgba(239, 68, 68, 0.3)' : 'rgba(130, 184, 154, 0.3)',
              }}
              title={isMicMuted ? 'Unmute' : 'Mute'}
            >
              {isMicMuted
                ? <MicOff className="w-6 h-6" style={{ color: '#ef4444' }} />
                : <Mic className="w-6 h-6" style={{ color: '#82b89a' }} />
              }
            </button>

          </div>
        </>
      )}
    </div>
  );
}
