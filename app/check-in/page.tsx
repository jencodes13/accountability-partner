'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '@/components/auth-provider';
import { Mic, MicOff, MoreHorizontal, Square } from 'lucide-react';
import Link from 'next/link';
import { getUserProfile, getHabits, Habit, UserProfile, HABIT_CATEGORY_LABELS, HabitCategory } from '@/lib/db';

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

// ─── Waveform Bar Component ───

function WaveformBars({ active }: { active: boolean }) {
  const barCount = 12;
  return (
    <div className="flex items-center justify-center gap-[3px] h-16">
      {Array.from({ length: barCount }).map((_, i) => {
        const baseHeight = [28, 40, 20, 48, 32, 56, 24, 44, 36, 52, 28, 40][i] || 32;
        const delay = i * 0.08;
        return (
          <div
            key={i}
            className="rounded-full"
            style={{
              width: 3,
              height: active ? baseHeight : 4,
              backgroundColor: '#82b89a',
              opacity: active ? 0.5 + (i % 3) * 0.15 : 0.2,
              transition: 'height 0.3s ease, opacity 0.3s ease',
              animation: active
                ? `waveform ${0.8 + (i % 3) * 0.3}s ease-in-out ${delay}s infinite alternate`
                : 'none',
            }}
          />
        );
      })}
    </div>
  );
}

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

  // Profile + habits
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [habits, setHabits] = useState<Habit[]>([]);

  // Session state
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [currentSpeaker, setCurrentSpeaker] = useState<'agent' | 'user' | null>(null);
  const [activeHabitIndex, setActiveHabitIndex] = useState(0);
  const [coveredHabits, setCoveredHabits] = useState<Set<string>>(new Set());

  // Debrief state
  const [sessionEnded, setSessionEnded] = useState(false);
  const [sessionSummary, setSessionSummary] = useState<SessionSummary | null>(null);

  // Timer
  const timer = useTimer(isConnected);

  // Refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const nextPlayTimeRef = useRef<number>(0);
  const isMicMutedRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Keep ref in sync
  useEffect(() => { isMicMutedRef.current = isMicMuted; }, [isMicMuted]);

  // Load profile + habits
  useEffect(() => {
    if (user) {
      Promise.all([getUserProfile(user.uid), getHabits(user.uid)]).then(([p, h]) => {
        setProfile(p);
        setHabits(h);
      });
    }
  }, [user]);

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
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'end' }));
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  const endSession = useCallback(() => {
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

  // ─── Photo Capture (on-demand) ───

  const capturePhoto = useCallback(() => {
    if (!videoRef.current || !canvasRef.current || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const base64Data = canvas.toDataURL('image/jpeg', 0.5).split(',')[1];
        wsRef.current.send(JSON.stringify({ type: 'video', data: base64Data }));
      }
    }
  }, []);

  // ─── Start Session ───

  const startSession = async () => {
    if (!user) return;
    setIsConnecting(true);
    setSessionEnded(false);
    setSessionSummary(null);
    setTranscript([]);
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
      nextPlayTimeRef.current = audioContextRef.current.currentTime;

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
            if (msg.role === 'assistant') {
              setCurrentSpeaker('agent');
            } else {
              setCurrentSpeaker('user');
            }
            setTranscript(prev => {
              const last = prev[prev.length - 1];
              if (last && last.role === msg.role) {
                return [...prev.slice(0, -1), { ...last, text: last.text + msg.text }];
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
        if (isConnected) endSession();
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

  if (loading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-foreground">
        <span className="text-sm text-muted-foreground">Loading...</span>
      </div>
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

  const lastTranscriptLine = transcript.length > 0 ? transcript[transcript.length - 1] : null;

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
        {/* Waveform keyframes */}
        <style>{`
          @keyframes waveform {
            0% { transform: scaleY(1); }
            100% { transform: scaleY(0.4); }
          }
        `}</style>

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
      {/* Waveform keyframes */}
      <style>{`
        @keyframes waveform {
          0% { transform: scaleY(1); }
          100% { transform: scaleY(0.4); }
        }
        @keyframes pulseDot {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(0.7); }
        }
      `}</style>

      {/* Hidden canvas for future photo capture */}
      <canvas ref={canvasRef} className="hidden" />

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

          {/* Center: Waveform */}
          <div className="flex-1 flex flex-col items-center justify-center px-6">
            <WaveformBars active={currentSpeaker !== null} />
            <p
              className="text-sm mt-4"
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
          {lastTranscriptLine && (
            <div
              className="mx-4 mb-4 rounded-2xl px-4 py-3"
              style={{
                backgroundColor: '#2e3440',
                border: '1px solid rgba(255,255,255,0.04)',
              }}
            >
              <p
                className="text-sm italic truncate"
                style={{ color: '#b0b8c4' }}
              >
                {lastTranscriptLine.text}
              </p>
            </div>
          )}

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

            {/* Overflow menu */}
            <button
              className="w-12 h-12 rounded-full flex items-center justify-center transition-opacity hover:opacity-80"
              style={{
                backgroundColor: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.08)',
              }}
              title="More options"
            >
              <MoreHorizontal className="w-5 h-5" style={{ color: '#b0b8c4' }} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
