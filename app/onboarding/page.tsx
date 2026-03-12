'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '@/components/auth-provider';
import { useRouter } from 'next/navigation';
import {
  updateUserProfile, getUserProfile, addHabit,
  HABIT_CATEGORIES, HABIT_CATEGORY_LABELS, HabitCategory, Persona,
} from '@/lib/db';
import { Mic, MicOff } from 'lucide-react';

const BACKEND_WS_URL = process.env.NEXT_PUBLIC_BACKEND_WS_URL || 'ws://localhost:8000';

interface OnboardingData {
  agentName: string;
  persona: Persona;
  language: string;
  dailyCheckInTime: string;
  birthday: string;
  habits: {
    category: HabitCategory;
    label: string;
    identityStatement: string;
  }[];
}

// ─── Orb Component ───

function Orb({ state }: { state: 'idle' | 'listening' | 'speaking' }) {
  return (
    <div className="relative w-40 h-40 mx-auto">
      {/* Outer glow */}
      <div
        className="absolute inset-0 rounded-full"
        style={{
          background: 'radial-gradient(circle, rgba(130, 184, 154, 0.2) 0%, transparent 70%)',
          transform: 'scale(1.8)',
          animation: state === 'idle'
            ? 'orbBreathe 4s ease-in-out infinite'
            : state === 'speaking'
              ? 'orbSpeak 1.2s ease-in-out infinite'
              : 'orbListen 2s ease-in-out infinite',
        }}
      />
      {/* Middle ring */}
      <div
        className="absolute inset-3 rounded-full"
        style={{
          background: 'radial-gradient(circle, rgba(130, 184, 154, 0.15) 0%, rgba(130, 184, 154, 0.05) 100%)',
          border: '1px solid rgba(130, 184, 154, 0.12)',
          animation: state === 'idle'
            ? 'orbBreathe 4s ease-in-out infinite 0.3s'
            : state === 'speaking'
              ? 'orbSpeak 1.2s ease-in-out infinite 0.15s'
              : 'orbListen 2s ease-in-out infinite 0.3s',
        }}
      />
      {/* Core */}
      <div
        className="absolute inset-8 rounded-full"
        style={{
          background: state === 'idle'
            ? 'radial-gradient(circle at 40% 35%, #a3d4b7 0%, #82b89a 50%, #6a9e80 100%)'
            : state === 'speaking'
              ? 'radial-gradient(circle at 40% 35%, #b8e0c8 0%, #82b89a 50%, #5d8c6f 100%)'
              : 'radial-gradient(circle at 40% 35%, #94c8a8 0%, #82b89a 60%, #6a9e80 100%)',
          boxShadow: '0 0 40px rgba(130, 184, 154, 0.3), inset 0 -4px 12px rgba(0,0,0,0.15)',
          animation: state === 'idle'
            ? 'orbCoreBreathe 4s ease-in-out infinite'
            : state === 'speaking'
              ? 'orbCoreSpeak 0.8s ease-in-out infinite'
              : 'orbCoreListen 2s ease-in-out infinite',
        }}
      />
    </div>
  );
}

// ─── Main Component ───

export default function OnboardingPage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  const [phase, setPhase] = useState<'intro' | 'listening' | 'review'>('intro');

  // Voice state
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [currentSpeaker, setCurrentSpeaker] = useState<'agent' | 'user' | null>(null);
  const [lastTranscript, setLastTranscript] = useState('');

  // Form state
  const [formData, setFormData] = useState<OnboardingData>({
    agentName: '',
    persona: 'friend',
    language: 'en',
    dailyCheckInTime: '20:00',
    birthday: '',
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

  useEffect(() => { isMicMutedRef.current = isMicMuted; }, [isMicMuted]);

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
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      const currentTime = ctx.currentTime;
      if (nextPlayTimeRef.current < currentTime) {
        nextPlayTimeRef.current = currentTime;
      }
      source.start(nextPlayTimeRef.current);
      nextPlayTimeRef.current += audioBuffer.duration;
    } catch (e) {
      console.error('Error playing audio', e);
    }
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

      audioContextRef.current = new window.AudioContext({ sampleRate: 16000 });
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
              const pcm16 = new Int16Array(inputData.length);
              for (let i = 0; i < inputData.length; i++) {
                pcm16[i] = Math.max(-32768, Math.min(32767, inputData[i] * 32768));
              }
              const base64Data = btoa(String.fromCharCode(...new Uint8Array(pcm16.buffer)));
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
            break;

          case 'transcript':
            setCurrentSpeaker(msg.role === 'assistant' ? 'agent' : 'user');
            setLastTranscript(msg.text);
            break;

          case 'onboarding_complete':
            // Backend sends extracted data
            setFormData({
              agentName: msg.agentName || '',
              persona: msg.persona || 'friend',
              language: msg.language || 'en',
              dailyCheckInTime: msg.dailyCheckInTime || '20:00',
              birthday: msg.birthday || '',
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

  // ─── End voice and go to review ───

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
        birthday: formData.birthday,
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
      <div className="min-h-screen flex items-center justify-center bg-background text-foreground">
        <span className="text-sm text-muted-foreground">Loading...</span>
      </div>
    );
  }

  const displayName = user.displayName?.split(' ')[0] || 'there';

  // ═══════════════════════════════════════
  // INTRO — Orb + "Say hello"
  // ═══════════════════════════════════════

  if (phase === 'intro') {
    return (
      <div
        className="min-h-screen flex flex-col items-center justify-center text-foreground px-6"
        style={{
          background: 'linear-gradient(180deg, #1e2128 0%, #262b34 100%)',
          fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
        }}
      >
        <style>{`
          @keyframes orbBreathe {
            0%, 100% { transform: scale(1.8); opacity: 1; }
            50% { transform: scale(2.0); opacity: 0.7; }
          }
          @keyframes orbCoreBreathe {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.05); }
          }
          @keyframes orbSpeak {
            0%, 100% { transform: scale(1.8); opacity: 1; }
            50% { transform: scale(2.2); opacity: 0.5; }
          }
          @keyframes orbCoreSpeak {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.12); }
          }
          @keyframes orbListen {
            0%, 100% { transform: scale(1.8); opacity: 0.8; }
            50% { transform: scale(1.9); opacity: 1; }
          }
          @keyframes orbCoreListen {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.03); }
          }
        `}</style>

        <div className="w-full max-w-[320px] text-center">
          {/* Orb */}
          <div className="mb-10">
            <Orb state="idle" />
          </div>

          {/* Text */}
          <h1
            className="text-2xl font-medium mb-2"
            style={{ color: '#e2e0e6', letterSpacing: '-0.3px' }}
          >
            Hi {displayName}
          </h1>
          <p
            className="text-sm mb-10 leading-relaxed"
            style={{ color: '#7e8a96' }}
          >
            This is where you meet your accountability partner.
            <br />
            Tap below to start your first conversation.
          </p>

          {/* CTA */}
          <button
            onClick={startVoice}
            disabled={isConnecting}
            className="w-full rounded-2xl py-4 text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50 mb-4"
            style={{
              backgroundColor: '#82b89a',
              color: '#1e2128',
              letterSpacing: '-0.1px',
            }}
          >
            {isConnecting ? 'Connecting...' : 'Say hello'}
          </button>

          {/* Schedule for later */}
          <button
            onClick={() => {
              // For now, go to review with empty form
              setPhase('review');
            }}
            className="text-xs transition-opacity hover:opacity-80"
            style={{ color: '#7e8a96' }}
          >
            Not now — schedule our first check-in
          </button>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════
  // LISTENING — Active voice with orb
  // ═══════════════════════════════════════

  if (phase === 'listening') {
    const orbState = currentSpeaker === 'agent' ? 'speaking' : currentSpeaker === 'user' ? 'listening' : 'idle';

    return (
      <div
        className="min-h-screen flex flex-col text-foreground"
        style={{
          background: 'linear-gradient(180deg, #1e2128 0%, #262b34 100%)',
          fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
        }}
      >
        <style>{`
          @keyframes orbBreathe {
            0%, 100% { transform: scale(1.8); opacity: 1; }
            50% { transform: scale(2.0); opacity: 0.7; }
          }
          @keyframes orbCoreBreathe {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.05); }
          }
          @keyframes orbSpeak {
            0%, 100% { transform: scale(1.8); opacity: 1; }
            50% { transform: scale(2.2); opacity: 0.5; }
          }
          @keyframes orbCoreSpeak {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.12); }
          }
          @keyframes orbListen {
            0%, 100% { transform: scale(1.8); opacity: 0.8; }
            50% { transform: scale(1.9); opacity: 1; }
          }
          @keyframes orbCoreListen {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.03); }
          }
        `}</style>

        {/* Center: Orb + status */}
        <div className="flex-1 flex flex-col items-center justify-center px-6">
          <div className="w-full max-w-[320px] text-center">
            <Orb state={orbState} />

            <p
              className="text-sm mt-6"
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

        {/* Transcript */}
        {lastTranscript && (
          <div
            className="mx-5 mb-4 rounded-2xl px-4 py-3"
            style={{
              backgroundColor: '#2e3440',
              border: '1px solid rgba(255,255,255,0.04)',
            }}
          >
            <p
              className="text-sm italic"
              style={{ color: '#b0b8c4', lineHeight: 1.5 }}
            >
              {lastTranscript}
            </p>
          </div>
        )}

        {/* Controls */}
        <div className="flex items-center justify-center gap-6 px-6 pb-8 pt-2">
          <button
            onClick={toggleMic}
            className="w-14 h-14 rounded-full flex items-center justify-center transition-all"
            style={{
              backgroundColor: isMicMuted ? 'rgba(239, 68, 68, 0.15)' : 'rgba(130, 184, 154, 0.15)',
              border: '1px solid',
              borderColor: isMicMuted ? 'rgba(239, 68, 68, 0.3)' : 'rgba(130, 184, 154, 0.3)',
            }}
          >
            {isMicMuted
              ? <MicOff className="w-5 h-5" style={{ color: '#ef4444' }} />
              : <Mic className="w-5 h-5" style={{ color: '#82b89a' }} />
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

  // ═══════════════════════════════════════
  // REVIEW — Pre-filled form
  // ═══════════════════════════════════════

  const canSave = formData.agentName.trim().length > 0 && formData.habits.length > 0;

  return (
    <div
      className="min-h-screen text-foreground px-5 py-8"
      style={{
        background: 'linear-gradient(180deg, #1e2128 0%, #262b34 100%)',
        fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
      }}
    >
      <div className="w-full max-w-md mx-auto">
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

        {/* Partner name + birthday */}
        <div
          className="rounded-2xl p-4 mb-3"
          style={{ backgroundColor: '#2e3440', border: '1px solid rgba(255,255,255,0.04)' }}
        >
          <div className="grid grid-cols-2 gap-3">
            <div>
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
            <div>
              <label className="block text-[11px] font-medium uppercase tracking-wide mb-1.5" style={{ color: '#7e8a96' }}>
                Birthday
              </label>
              <input
                type="date"
                value={formData.birthday}
                onChange={e => setFormData({ ...formData, birthday: e.target.value })}
                className="w-full bg-transparent text-sm px-3 py-2 rounded-xl focus:outline-none focus:ring-1"
                style={{
                  color: '#e2e0e6',
                  border: '1px solid rgba(255,255,255,0.08)',
                  colorScheme: 'dark',
                }}
              />
            </div>
          </div>
        </div>

        {/* Persona */}
        <div
          className="rounded-2xl p-4 mb-3"
          style={{ backgroundColor: '#2e3440', border: '1px solid rgba(255,255,255,0.04)' }}
        >
          <label className="block text-[11px] font-medium uppercase tracking-wide mb-3" style={{ color: '#7e8a96' }}>
            Style
          </label>
          <div className="flex gap-2">
            {(['coach', 'friend', 'reflective'] as Persona[]).map(p => {
              const selected = formData.persona === p;
              const labels: Record<Persona, string> = {
                coach: 'Coach',
                friend: 'Friend',
                reflective: 'Reflective',
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
                  className="w-full bg-transparent text-sm mb-1.5 focus:outline-none"
                  style={{ color: '#e2e0e6' }}
                />
                <input
                  value={habit.identityStatement}
                  onChange={e => updateHabit(i, 'identityStatement', e.target.value)}
                  placeholder="I am someone who..."
                  className="w-full bg-transparent text-xs focus:outline-none"
                  style={{ color: '#b0b8c4' }}
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
          {isSaving ? 'Saving...' : 'Looks good — let\u2019s go'}
        </button>
      </div>
    </div>
  );
}
