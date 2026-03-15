'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '@/components/auth-provider';
import { useRouter } from 'next/navigation';
import {
  updateUserProfile, getUserProfile, addHabit,
  HABIT_CATEGORIES, HABIT_CATEGORY_LABELS, HabitCategory, Persona,
} from '@/lib/db';
import { Mic, MicOff } from 'lucide-react';

// WebSocket connects directly to the backend (Next.js can't proxy WS)
const BACKEND_WS_URL = process.env.NEXT_PUBLIC_BACKEND_WS_URL || 'ws://localhost:8000';

interface OnboardingData {
  agentName: string;
  persona: Persona;
  language: string;
  dailyCheckInTime: string;
  habits: {
    category: HabitCategory;
    label: string;
    identityStatement: string;
  }[];
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
      // We shift the blob shape percentages by the level
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

// ─── Welcome Visual: Sound bars → circle → collapse ───

function WelcomeVisual({ phase }: { phase: 'welcome' | 'transitioning' }) {
  const [step, setStep] = useState<'line' | 'circle' | 'collapse'>('line');

  useEffect(() => {
    if (phase === 'transitioning') {
      setStep('circle');
      const timer = setTimeout(() => setStep('collapse'), 800);
      return () => clearTimeout(timer);
    }
  }, [phase]);

  const BARS = 12;
  const HEIGHTS = [18, 30, 22, 42, 26, 48, 48, 26, 42, 22, 30, 18];

  return (
    <div className="absolute inset-0">
      {Array.from({ length: BARS }).map((_, i) => {
        const h = HEIGHTS[i];
        const lineX = (i - (BARS - 1) / 2) * 8;
        const angleDeg = (360 / BARS) * i - 90;
        const angleRad = angleDeg * Math.PI / 180;
        const circleR = 50;
        const cx = Math.cos(angleRad) * circleR;
        const cy = Math.sin(angleRad) * circleR;
        const rotDeg = (360 / BARS) * i;

        let outerTransform: string;
        if (step === 'line') {
          outerTransform = `translate(${lineX}px, 0px)`;
        } else if (step === 'circle') {
          outerTransform = `translate(${cx}px, ${cy}px) rotate(${rotDeg}deg)`;
        } else {
          outerTransform = `translate(0px, 0px) rotate(${rotDeg}deg) scale(0)`;
        }

        const barH = step === 'circle' ? 14 : step === 'collapse' ? 3 : h;
        const barOpacity = step === 'collapse' ? 0 : step === 'circle' ? 0.7 : (0.3 + (h / 48) * 0.5);

        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              width: 0,
              height: 0,
              transform: outerTransform,
              transition: step === 'line' ? 'none' : 'transform 0.7s cubic-bezier(0.4, 0, 0.2, 1)',
            }}
          >
            <div
              style={{
                width: 3,
                height: barH,
                marginLeft: -1.5,
                marginTop: -(barH / 2),
                borderRadius: 2,
                background: '#82b89a',
                opacity: barOpacity,
                transition: step === 'line' ? 'none' : 'height 0.7s ease, opacity 0.7s ease, margin-top 0.7s ease',
                animation: step === 'line'
                  ? `barPulse ${1.2 + (i % 5) * 0.15}s ease-in-out ${i * 0.08}s infinite alternate`
                  : 'none',
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

// ─── Keyframes (shared across phases) ───

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
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes fadeOut {
    from { opacity: 1; transform: translateY(0); }
    to { opacity: 0; transform: translateY(-12px); }
  }
  @keyframes bloomIn {
    from { opacity: 0; transform: scale(0.5); }
    to { opacity: 1; transform: scale(1); }
  }
  @keyframes barPulse {
    from { transform: scaleY(1); }
    to { transform: scaleY(0.4); }
  }
`;

// ─── RMS calculation helper ───
function calculateRMS(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}

// ─── Main Component ───

export default function OnboardingPage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  // Flow: welcome → orb → listening → review
  const [phase, setPhase] = useState<'welcome' | 'transitioning' | 'orb' | 'listening' | 'review'>('welcome');

  // Voice state
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [currentSpeaker, setCurrentSpeaker] = useState<'agent' | 'user' | null>(null);

  // Transcript accumulation state
  const [agentMessages, setAgentMessages] = useState<string[]>([]);
  const [currentAgentText, setCurrentAgentText] = useState('');
  const [lastUserText, setLastUserText] = useState('');
  // Track which role last sent a transcript to detect role switches
  const lastTranscriptRoleRef = useRef<'assistant' | 'user' | null>(null);

  // Audio level state (updated via refs, read from state for Aurora)
  const [audioLevel, setAudioLevel] = useState(0);
  const userAudioLevelRef = useRef(0);
  const agentAudioLevelRef = useRef(0);
  const audioLevelRafRef = useRef<number>(0);

  // Form state
  const [formData, setFormData] = useState<OnboardingData>({
    agentName: '',
    persona: 'friend',
    language: 'en',
    dailyCheckInTime: '20:00',
    habits: [],
  });
  const [isSaving, setIsSaving] = useState(false);

  // Refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const nextPlayTimeRef = useRef<number>(0);
  const isMicMutedRef = useRef(false);
  const agentAudioDecayRef = useRef<number>(0);
  const currentSpeakerTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { isMicMutedRef.current = isMicMuted; }, [isMicMuted]);

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

  // Redirect if already onboarded
  useEffect(() => {
    if (user) {
      getUserProfile(user.uid).then(profile => {
        if (profile?.onboardingComplete) router.push('/');
      }).catch(() => {});
    }
  }, [user, router]);

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

  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

  // ─── Audio Playback ───

  const playAudioChunk = (base64Audio: string) => {
    if (!audioContextRef.current) return;
    const ctx = audioContextRef.current;
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
      // Scale RMS to a 0-1 range (speech RMS is typically 0.01–0.3)
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
      // Clear any previous timeout
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

  // ─── Transition: welcome → orb ───

  const handleGetStarted = () => {
    setPhase('transitioning');
    setTimeout(() => setPhase('orb'), 1800);
  };

  // ─── Start Voice ───

  const startVoice = async () => {
    if (!user) return;
    setIsConnecting(true);

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

      audioContextRef.current = new window.AudioContext();
      nextPlayTimeRef.current = audioContextRef.current.currentTime;

      const source = audioContextRef.current.createMediaStreamSource(stream);
      const processor = audioContextRef.current.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      source.connect(processor);
      processor.connect(audioContextRef.current.destination);

      const ws = new WebSocket(`${BACKEND_WS_URL}/api/onboarding/${user.uid}`);
      wsRef.current = ws;

      ws.onopen = () => {};

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);

        switch (msg.type) {
          case 'connected':
            setIsConnected(true);
            setIsConnecting(false);
            setPhase('listening');

            processor.onaudioprocess = (e) => {
              if (isMicMutedRef.current || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
              const inputData = e.inputBuffer.getChannelData(0);

              // Calculate user audio level (RMS)
              const rms = calculateRMS(inputData);
              const scaledLevel = Math.min(1, rms * 8);
              userAudioLevelRef.current = Math.max(userAudioLevelRef.current * 0.9, scaledLevel);

              // Resample from native rate to 16000Hz
              const nativeRate = audioContextRef.current!.sampleRate;
              const targetRate = 16000;
              const ratio = nativeRate / targetRate;
              const targetLength = Math.floor(inputData.length / ratio);
              const resampled = new Float32Array(targetLength);
              for (let i = 0; i < targetLength; i++) {
                resampled[i] = inputData[Math.floor(i * ratio)];
              }

              // Convert to PCM16
              const pcm16 = new Int16Array(resampled.length);
              for (let i = 0; i < resampled.length; i++) {
                pcm16[i] = Math.max(-32768, Math.min(32767, resampled[i] * 32768));
              }

              // Base64 encode (chunked to avoid stack overflow)
              const bytes = new Uint8Array(pcm16.buffer);
              let binary = '';
              for (let i = 0; i < bytes.length; i++) {
                binary += String.fromCharCode(bytes[i]);
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
            if (audioContextRef.current) {
              nextPlayTimeRef.current = audioContextRef.current.currentTime;
            }
            agentAudioLevelRef.current = 0;
            break;

          case 'transcript':
            if (msg.role === 'assistant') {
              setCurrentSpeaker('agent');
              // If previous transcript was from user, finalize current agent text first
              if (lastTranscriptRoleRef.current === 'user') {
                // Nothing to finalize — agent is starting fresh
              }
              lastTranscriptRoleRef.current = 'assistant';
              setCurrentAgentText(prev => {
                // Append chunk to accumulating agent text
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
            break;

          case 'onboarding_complete':
            // Finalize any remaining agent text
            setCurrentAgentText(prev => {
              if (prev.trim()) {
                setAgentMessages(msgs => [...msgs, prev.trim()]);
              }
              return '';
            });
            setFormData({
              agentName: msg.agentName || '',
              persona: msg.persona || 'friend',
              language: msg.language || 'en',
              dailyCheckInTime: msg.dailyCheckInTime || '20:00',
              habits: (msg.habits || []).slice(0, 3).map((h: { category: string; label: string; identityStatement: string }) => ({
                category: (HABIT_CATEGORIES as readonly string[]).includes(h.category) ? h.category as HabitCategory : 'exercise' as HabitCategory,
                label: h.label || '',
                identityStatement: h.identityStatement || '',
              })),
            });
            cleanup();
            setIsConnected(false);
            setPhase('review');
            break;

          case 'error':
            console.error('Onboarding error:', msg.message);
            cleanup();
            setIsConnected(false);
            setPhase('review');
            break;
        }
      };

      ws.onclose = () => {
        if (phase === 'listening') {
          setIsConnected(false);
          setPhase('review');
        }
      };

      ws.onerror = (e) => {
        console.error('WebSocket error:', e);
        setIsConnected(false);
        setIsConnecting(false);
        setPhase('review');
      };
    } catch (error) {
      console.error('Error starting onboarding voice:', error);
      setIsConnecting(false);
      setPhase('review');
    }
  };

  // ─── End voice → review ───

  const finishVoice = () => {
    cleanup();
    setIsConnected(false);
    setPhase('review');
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

  // ─── Save ───

  const handleSave = async () => {
    if (!user) return;
    if (!formData.agentName.trim() || formData.habits.length === 0) return;

    setIsSaving(true);
    try {
      await updateUserProfile(user.uid, {
        agentName: formData.agentName,
        persona: formData.persona,
        language: formData.language,
        dailyCheckInTime: formData.dailyCheckInTime,
        onboardingComplete: true,
        displayName: user.displayName || user.email?.split('@')[0] || '',
      } as any);

      for (const habit of formData.habits) {
        await addHabit(user.uid, habit);
      }

      router.push('/');
    } catch (error) {
      console.error('Error saving onboarding:', error);
    } finally {
      setIsSaving(false);
    }
  };

  // ─── Habit helpers ───

  const updateHabit = (index: number, field: string, value: string) => {
    const updated = [...formData.habits];
    (updated[index] as Record<string, string>)[field] = value;
    setFormData({ ...formData, habits: updated });
  };

  const removeHabit = (index: number) => {
    setFormData({ ...formData, habits: formData.habits.filter((_, i) => i !== index) });
  };

  const addEmptyHabit = () => {
    if (formData.habits.length >= 3) return;
    setFormData({
      ...formData,
      habits: [...formData.habits, { category: 'exercise' as HabitCategory, label: '', identityStatement: '' }],
    });
  };

  // ─── Loading / Auth ───

  if (loading || !user) {
    return (
      <div className="min-h-screen" style={{ background: 'linear-gradient(180deg, #1e2128 0%, #262b34 100%)' }} />
    );
  }

  // ═══════════════════════════════════════════════════
  // WELCOME — Bold statement + "Get started"
  // ═══════════════════════════════════════════════════

  if (phase === 'welcome' || phase === 'transitioning') {
    const fading = phase === 'transitioning';

    return (
      <div
        className="min-h-screen flex flex-col items-center justify-center text-foreground px-6"
        style={{
          background: 'linear-gradient(180deg, #1e2128 0%, #262b34 100%)',
          fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
        }}
      >
        <style>{AURORA_KEYFRAMES}</style>

        <div className="w-full max-w-[380px] text-center">
          {/* Visual area: sound bars → circle → aurora */}
          <div className="relative mx-auto mb-10" style={{ width: 240, height: 240 }}>
            <WelcomeVisual phase={phase} />

            {/* Aurora blooms in during collapse */}
            {fading && (
              <div style={{
                position: 'absolute',
                inset: 0,
                animation: 'bloomIn 0.8s ease-out 0.7s both',
              }}>
                <Aurora state="idle" audioLevel={0} />
              </div>
            )}
          </div>

          {/* Text + CTA — fades out on transition */}
          <div style={{
            opacity: fading ? 0 : 1,
            transform: fading ? 'translateY(-12px)' : 'translateY(0)',
            transition: 'opacity 0.5s ease, transform 0.5s ease',
          }}>
            {/* Headline */}
            <h1
              style={{
                color: '#e2e0e6',
                fontSize: 20,
                fontWeight: 600,
                letterSpacing: '-0.5px',
                lineHeight: 1.25,
                whiteSpace: 'nowrap',
                marginBottom: 16,
              }}
            >
              Your voice-first accountability partner
            </h1>

            {/* Description */}
            <p
              className="text-sm mb-12"
              style={{ color: '#7e8a96', lineHeight: 1.7, maxWidth: 300, margin: '0 auto 48px' }}
            >
              Check in daily — your partner tracks your habits and keeps you accountable. Send updates by voice or message.
            <br />
            <span style={{ display: 'inline-block', marginTop: 4 }}>No manual logging.</span>
            </p>

            {/* CTA */}
            <button
              onClick={handleGetStarted}
              className="w-full rounded-2xl py-4 text-[15px] font-semibold transition-all hover:opacity-90"
              style={{
                backgroundColor: '#82b89a',
                color: '#1e2128',
                letterSpacing: '-0.1px',
              }}
            >
              Get started
            </button>

            {/* Time estimate */}
            <p className="mt-4 text-xs" style={{ color: '#7e8a96' }}>
              Takes about 2 minutes
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════
  // ORB — Aurora blooms in + "Say hello"
  // ═══════════════════════════════════════════════════

  if (phase === 'orb') {
    return (
      <div
        className="min-h-screen flex flex-col items-center justify-center text-foreground px-6"
        style={{
          background: 'linear-gradient(180deg, #1e2128 0%, #262b34 100%)',
          fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
        }}
      >
        <style>{AURORA_KEYFRAMES}</style>

        <div className="w-full max-w-[380px] text-center">
          {/* Aurora */}
          <div style={{ marginBottom: 40 }}>
            <Aurora state="idle" audioLevel={0} />
          </div>

          {/* Text fades in */}
          <div style={{ animation: 'fadeIn 0.6s ease-out 0.4s both' }}>
            <button
              onClick={startVoice}
              disabled={isConnecting}
              className="w-full rounded-2xl py-4 text-[15px] font-semibold transition-all hover:opacity-90 disabled:opacity-50 mb-4"
              style={{
                backgroundColor: '#82b89a',
                color: '#1e2128',
                letterSpacing: '-0.1px',
              }}
            >
              {isConnecting ? 'Connecting...' : 'Say hello'}
            </button>

            <button
              onClick={() => setPhase('review')}
              className="text-xs transition-opacity hover:opacity-80"
              style={{ color: '#7e8a96' }}
            >
              Not now — schedule our first check-in
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════
  // LISTENING — Aurora reacts to voice + audio levels
  // ═══════════════════════════════════════════════════

  if (phase === 'listening') {
    const auroraState = currentSpeaker === 'agent' ? 'speaking' : currentSpeaker === 'user' ? 'listening' : 'idle';

    // Determine what text to show
    // If agent is currently speaking, show the in-progress text building up
    // Otherwise show the last complete agent message
    const lastCompleteMessage = agentMessages.length > 0 ? agentMessages[agentMessages.length - 1] : '';
    const displayText = currentAgentText || lastCompleteMessage;
    const isAgentSpeaking = currentSpeaker === 'agent' && currentAgentText.length > 0;

    return (
      <div
        className="min-h-screen flex flex-col text-foreground"
        style={{
          background: 'linear-gradient(180deg, #1e2128 0%, #262b34 100%)',
          fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
        }}
      >
        <style>{AURORA_KEYFRAMES}</style>

        {/* Center: Aurora + status */}
        <div className="flex-1 flex flex-col items-center justify-center px-6">
          <div className="w-full max-w-[380px] text-center">
            <Aurora state={auroraState} audioLevel={audioLevel} />

            <p
              className="text-sm mt-8"
              style={{ color: '#7e8a96' }}
            >
              {currentSpeaker === 'agent'
                ? 'Speaking...'
                : currentSpeaker === 'user'
                  ? 'Listening...'
                  : 'Listening...'
              }
            </p>
          </div>
        </div>

        {/* Transcript area */}
        <div className="mx-5 mb-4 max-w-[380px] self-center w-full" style={{ minHeight: 60 }}>
          {/* Agent's message bubble — last complete question or in-progress text */}
          {displayText && (
            <div
              className="rounded-2xl px-4 py-3 mb-2"
              style={{
                backgroundColor: '#2e3440',
                border: '1px solid rgba(255,255,255,0.04)',
                transition: 'opacity 0.2s ease',
              }}
            >
              <p
                className="text-sm"
                style={{
                  color: isAgentSpeaking ? '#c8d0dc' : '#b0b8c4',
                  lineHeight: 1.5,
                  fontStyle: 'normal',
                }}
              >
                {displayText}
                {isAgentSpeaking && (
                  <span
                    style={{
                      display: 'inline-block',
                      width: 4,
                      height: 14,
                      backgroundColor: '#82b89a',
                      marginLeft: 2,
                      verticalAlign: 'text-bottom',
                      animation: 'cursorBlink 1s step-end infinite',
                    }}
                  />
                )}
              </p>
            </div>
          )}

          {/* User's last spoken text — smaller, secondary */}
          {lastUserText && (
            <div
              className="rounded-xl px-3 py-2 self-end"
              style={{
                backgroundColor: 'rgba(130, 184, 154, 0.08)',
                border: '1px solid rgba(130, 184, 154, 0.12)',
                marginLeft: 'auto',
                maxWidth: '85%',
                float: 'right',
              }}
            >
              <p
                className="text-xs"
                style={{ color: '#82b89a', lineHeight: 1.4 }}
              >
                {lastUserText}
              </p>
            </div>
          )}
          {lastUserText && <div style={{ clear: 'both' }} />}
        </div>

        {/* Cursor blink keyframe */}
        <style>{`
          @keyframes cursorBlink {
            0%, 100% { opacity: 1; }
            50% { opacity: 0; }
          }
        `}</style>

        {/* Controls */}
        <div className="flex items-center justify-center gap-4 px-6 pb-8 pt-2">
          <button
            onClick={toggleMic}
            className="w-10 h-10 rounded-full flex items-center justify-center transition-all"
            style={{
              backgroundColor: isMicMuted ? 'rgba(239, 68, 68, 0.15)' : 'rgba(130, 184, 154, 0.08)',
              border: '1px solid',
              borderColor: isMicMuted ? 'rgba(239, 68, 68, 0.3)' : 'rgba(130, 184, 154, 0.15)',
            }}
          >
            {isMicMuted
              ? <MicOff className="w-4 h-4" style={{ color: '#ef4444' }} />
              : <Mic className="w-4 h-4" style={{ color: '#82b89a' }} />
            }
          </button>

          <button
            onClick={finishVoice}
            className="px-5 py-2.5 rounded-full text-xs font-medium transition-opacity hover:opacity-80"
            style={{
              backgroundColor: 'rgba(255,255,255,0.06)',
              color: '#b0b8c4',
              border: '1px solid rgba(255,255,255,0.08)',
            }}
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════
  // REVIEW — Pre-filled form (mobile-width)
  // ═══════════════════════════════════════════════════

  const canSave = formData.agentName.trim().length > 0 && formData.habits.length > 0;

  return (
    <div
      className="min-h-screen text-foreground px-5 py-8 flex justify-center"
      style={{
        background: 'linear-gradient(180deg, #1e2128 0%, #262b34 100%)',
        fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
      }}
    >
      <div className="w-full max-w-[380px]">
        {/* Header */}
        <div className="text-center mb-8">
          <h1
            className="text-xl font-semibold mb-1"
            style={{ color: '#e2e0e6', letterSpacing: '-0.3px' }}
          >
            Review your setup
          </h1>
          <p className="text-xs" style={{ color: '#7e8a96' }}>
            Edit anything, then confirm.
          </p>
        </div>

        {/* Partner name */}
        <div
          className="rounded-2xl p-4 mb-3"
          style={{ backgroundColor: '#2e3440', border: '1px solid rgba(255,255,255,0.04)' }}
        >
          <label className="block text-[11px] font-medium uppercase tracking-wide mb-1.5" style={{ color: '#7e8a96' }}>
            Partner name
          </label>
          <input
            value={formData.agentName}
            onChange={e => setFormData({ ...formData, agentName: e.target.value })}
            placeholder="What do you call them?"
            className="w-full bg-transparent text-sm px-3 py-2 rounded-xl focus:outline-none focus:ring-1"
            style={{
              color: '#e2e0e6',
              border: '1px solid rgba(255,255,255,0.08)',
            }}
          />
        </div>

        {/* Persona */}
        <div
          className="rounded-2xl p-4 mb-3"
          style={{ backgroundColor: '#2e3440', border: '1px solid rgba(255,255,255,0.04)' }}
        >
          <label className="block text-[11px] font-medium uppercase tracking-wide mb-3" style={{ color: '#7e8a96' }}>
            Feedback style
          </label>
          <div className="flex gap-2">
            {(['coach', 'friend', 'reflective'] as Persona[]).map(p => {
              const selected = formData.persona === p;
              const labels: Record<Persona, string> = {
                coach: 'Direct',
                friend: 'Encouraging',
                reflective: 'Curious',
              };
              return (
                <button
                  key={p}
                  onClick={() => setFormData({ ...formData, persona: p })}
                  className="flex-1 py-2 rounded-xl text-xs font-medium transition-all"
                  style={{
                    backgroundColor: selected ? 'rgba(130, 184, 154, 0.15)' : 'rgba(255,255,255,0.03)',
                    color: selected ? '#82b89a' : '#7e8a96',
                    border: '1px solid',
                    borderColor: selected ? 'rgba(130, 184, 154, 0.3)' : 'rgba(255,255,255,0.06)',
                  }}
                >
                  {labels[p]}
                </button>
              );
            })}
          </div>
        </div>

        {/* Check-in time */}
        <div
          className="rounded-2xl p-4 mb-3"
          style={{ backgroundColor: '#2e3440', border: '1px solid rgba(255,255,255,0.04)' }}
        >
          <label className="block text-[11px] font-medium uppercase tracking-wide mb-1.5" style={{ color: '#7e8a96' }}>
            Daily check-in time
          </label>
          <input
            type="time"
            value={formData.dailyCheckInTime}
            onChange={e => setFormData({ ...formData, dailyCheckInTime: e.target.value })}
            className="w-full bg-transparent text-sm px-3 py-2 rounded-xl focus:outline-none focus:ring-1"
            style={{
              color: '#e2e0e6',
              border: '1px solid rgba(255,255,255,0.08)',
              colorScheme: 'dark',
            }}
          />
        </div>

        {/* Habits */}
        <div
          className="rounded-2xl p-4 mb-6"
          style={{ backgroundColor: '#2e3440', border: '1px solid rgba(255,255,255,0.04)' }}
        >
          <div className="flex items-center justify-between mb-3">
            <label className="text-[11px] font-medium uppercase tracking-wide" style={{ color: '#7e8a96' }}>
              Habits ({formData.habits.length}/3)
            </label>
            {formData.habits.length < 3 && (
              <button
                onClick={addEmptyHabit}
                className="text-xs font-medium transition-opacity hover:opacity-80"
                style={{ color: '#82b89a' }}
              >
                + Add
              </button>
            )}
          </div>

          {formData.habits.length === 0 && (
            <p className="text-xs text-center py-4" style={{ color: '#7e8a96' }}>
              Add at least one habit to get started.
            </p>
          )}

          <div className="space-y-3">
            {formData.habits.map((habit, i) => (
              <div
                key={i}
                className="rounded-xl p-3"
                style={{
                  backgroundColor: 'rgba(255,255,255,0.02)',
                  border: '1px solid rgba(255,255,255,0.06)',
                }}
              >
                <div className="flex items-center justify-between mb-2">
                  <select
                    value={habit.category}
                    onChange={e => updateHabit(i, 'category', e.target.value)}
                    className="text-xs font-medium bg-transparent focus:outline-none"
                    style={{ color: '#82b89a' }}
                  >
                    {HABIT_CATEGORIES.map(cat => (
                      <option key={cat} value={cat} style={{ backgroundColor: '#2e3440', color: '#e2e0e6' }}>
                        {HABIT_CATEGORY_LABELS[cat]}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => removeHabit(i)}
                    className="text-[10px] transition-opacity hover:opacity-80"
                    style={{ color: '#7e8a96' }}
                  >
                    Remove
                  </button>
                </div>
                <input
                  value={habit.label}
                  onChange={e => updateHabit(i, 'label', e.target.value)}
                  placeholder="Your goal"
                  className="w-full bg-transparent text-sm focus:outline-none"
                  style={{ color: '#e2e0e6' }}
                />
              </div>
            ))}
          </div>
        </div>

        {/* Confirm */}
        <button
          onClick={handleSave}
          disabled={!canSave || isSaving}
          className="w-full rounded-2xl py-3.5 text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-40"
          style={{
            backgroundColor: '#82b89a',
            color: '#1e2128',
            letterSpacing: '-0.1px',
          }}
        >
          {isSaving ? 'Saving...' : 'Looks good \u2014 let\u2019s go'}
        </button>
      </div>
    </div>
  );
}
