'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/components/auth-provider';
import {
  googleProvider,
  signInWithPopup,
  signOut,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  auth,
} from '@/lib/firebase';
import {
  createUserProfile, getUserProfile, getHabits,
  Habit, UserProfile, HABIT_CATEGORY_LABELS,
  getCheckInSessions, CheckInSession, getRecentPhotos,
} from '@/lib/db';
import { Clock, BarChart3, LogIn, LogOut, Settings, MessageCircle } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

function getTimeOfDay(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

function getDayOfWeek(): string {
  return new Date().toLocaleDateString('en-US', { weekday: 'long' });
}

function getGreeting(persona: string, name: string): string {
  switch (persona) {
    case 'coach': return `Let's go, ${name}.`;
    case 'friend': return `Hey ${name}`;
    case 'reflective': return `Welcome back, ${name}`;
    default: return `Hey ${name}`;
  }
}

function getMessage(persona: string, context: { hasPhoto: boolean; streakDays: number; lastSession: CheckInSession | null }): string {
  if (context.hasPhoto) {
    switch (persona) {
      case 'coach': return 'Photo logged. Time to check in.';
      case 'friend': return 'Photo logged — wanna chat?';
      case 'reflective': return 'You logged something. Ready?';
      default: return 'Photo logged — wanna chat?';
    }
  }
  if (context.streakDays > 0) {
    switch (persona) {
      case 'coach': return `${context.streakDays} days. Don't stop now.`;
      case 'friend': return `${context.streakDays} day streak — nice.`;
      case 'reflective': return "You've been consistent. Ready?";
      default: return `${context.streakDays} day streak.`;
    }
  }
  switch (persona) {
    case 'coach': return 'Ready when you are.';
    case 'friend': return 'Been a minute. Check in?';
    case 'reflective': return 'Whenever you are ready.';
    default: return 'Ready to check in?';
  }
}

export default function Home() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [habits, setHabits] = useState<Habit[]>([]);
  const [recentSession, setRecentSession] = useState<CheckInSession | null>(null);
  const [hasRecentPhoto, setHasRecentPhoto] = useState(false);
  const [dataLoading, setDataLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);

  useEffect(() => {
    if (user) {
      loadData();
    } else {
      setDataLoading(false);
    }
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadData = async () => {
    if (!user) return;

    try {
      // Ensure profile exists
      await createUserProfile(user.uid, {
        uid: user.uid,
        email: user.email || '',
        displayName: user.displayName || '',
      });
    } catch {
      // Profile creation may fail on first load — continue to check
    }

    // Check onboarding status first, separately
    let userProfile: UserProfile | null = null;
    try {
      userProfile = await getUserProfile(user.uid);
    } catch {
      // If we can't read the profile, send to onboarding
      router.push('/onboarding');
      return;
    }

    if (!userProfile || !userProfile.onboardingComplete) {
      router.push('/onboarding');
      return;
    }

    // Only load remaining data after confirming onboarding is done
    try {
      const [userHabits, sessions, photos] = await Promise.all([
        getHabits(user.uid),
        getCheckInSessions(user.uid, 1),
        getRecentPhotos(user.uid),
      ]);
      setProfile(userProfile);
      setHabits(userHabits);
      setRecentSession(sessions[0] || null);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      setHasRecentPhoto(photos.some(p => p.timestamp?.toDate() >= today));
    } catch (err) {
      console.error('Error loading dashboard data:', err);
      setProfile(userProfile);
    } finally {
      setDataLoading(false);
    }
  };

  const handleLogin = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error signing in', error);
      alert(`Sign in failed: ${message}`);
    }
  };

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const credential = isSignUp
        ? await createUserWithEmailAndPassword(auth, email, password)
        : await signInWithEmailAndPassword(auth, email, password);
      const u = credential.user;
      await createUserProfile(u.uid, {
        uid: u.uid,
        email: u.email || '',
        displayName: u.displayName || u.email?.split('@')[0] || '',
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Authentication failed';
      console.error('Email auth error', error);
      alert(message);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
    } catch (error) {
      console.error('Error signing out', error);
    }
  };

  if (loading || (user && dataLoading)) {
    return (
      <div className="min-h-screen bg-background" />
    );
  }

  // --- Unauthenticated ---
  if (!user) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background text-foreground p-4">
        <div className="max-w-sm w-full space-y-8 text-center">
          <div className="space-y-2">
            <h1 className="text-3xl font-medium tracking-tight" style={{ letterSpacing: '-0.4px' }}>
              Accountability Partner
            </h1>
            <p className="text-sm text-muted-foreground">
              Your AI companion for building the habits that matter.
            </p>
          </div>

          <button
            onClick={handleLogin}
            className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground px-6 py-3 rounded-[14px] font-medium transition-colors hover:opacity-90"
          >
            <LogIn className="w-5 h-5" />
            Sign in with Google
          </button>

          <div className="flex items-center gap-4">
            <div className="flex-1 h-px bg-border" />
            <span className="text-xs text-muted-foreground">or</span>
            <div className="flex-1 h-px bg-border" />
          </div>

          <form onSubmit={handleEmailAuth} className="space-y-4 text-left">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1 uppercase tracking-wide">
                Email
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full px-4 py-2.5 rounded-[14px] border border-border bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-ring text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1 uppercase tracking-wide">
                Password
              </label>
              <input
                type="password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 6 characters"
                className="w-full px-4 py-2.5 rounded-[14px] border border-border bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-ring text-sm"
              />
            </div>
            <button
              type="submit"
              className="w-full bg-primary text-primary-foreground px-6 py-3 rounded-[14px] font-medium transition-colors hover:opacity-90"
            >
              {isSignUp ? 'Create account' : 'Sign in with email'}
            </button>
          </form>

          <p className="text-xs text-muted-foreground">
            {isSignUp ? 'Already have an account?' : "Don't have an account?"}{' '}
            <button
              type="button"
              onClick={() => setIsSignUp(!isSignUp)}
              className="text-[var(--sage)] hover:opacity-80 font-medium"
            >
              {isSignUp ? 'Sign in' : 'Create account'}
            </button>
          </p>
        </div>
      </div>
    );
  }

  // --- Authenticated: Conversation-first home ---
  const persona = profile?.persona || 'friend';
  const displayName = profile?.displayName?.split(' ')[0] || user.displayName?.split(' ')[0] || 'there';
  const agentName = profile?.agentName || '';
  const bestStreak = habits.reduce((max, h) => Math.max(max, h.currentStreak), 0);
  const todayPhotos = hasRecentPhoto;

  const greeting = getGreeting(persona, displayName);
  const message = getMessage(persona, {
    hasPhoto: todayPhotos,
    streakDays: bestStreak,
    lastSession: recentSession,
  });

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-6 pt-6 pb-2">
        <span className="text-sm font-medium text-foreground">{agentName}</span>
        <div className="flex items-center gap-1">
          <Link
            href="/messages"
            className="p-2 text-muted-foreground hover:text-foreground transition-colors rounded-full"
            title="Messages"
          >
            <MessageCircle className="w-5 h-5" />
          </Link>
          <Link
            href="/history"
            className="p-2 text-muted-foreground hover:text-foreground transition-colors rounded-full"
            title="History"
          >
            <Clock className="w-5 h-5" />
          </Link>
          <Link
            href="/summary"
            className="p-2 text-muted-foreground hover:text-foreground transition-colors rounded-full"
            title="Weekly Summary"
          >
            <BarChart3 className="w-5 h-5" />
          </Link>
          <button
            onClick={handleLogout}
            className="p-2 text-muted-foreground hover:text-foreground transition-colors rounded-full"
            title="Sign out"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Main content — centered */}
      <main className="flex-1 flex flex-col items-center justify-center px-6 pb-12">
        <div className="w-full max-w-[300px] space-y-0">
          {/* Time + Greeting */}
          <div className="text-center mb-6">
            <div className="text-xs text-muted-foreground tracking-wide mb-2">
              {getDayOfWeek()} {getTimeOfDay()}
            </div>
            <h1
              className="text-[26px] font-medium text-foreground"
              style={{ letterSpacing: '-0.4px' }}
            >
              {greeting}
            </h1>
          </div>

          {/* Message bubble */}
          <div
            className="bg-card rounded-[18px] px-4 py-3.5 mb-4"
            style={{
              boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
              borderLeft: persona === 'coach' ? '3px solid var(--sage)' : undefined,
              border: persona !== 'coach' ? '1px solid var(--panel-border)' : undefined,
            }}
          >
            <p className="text-sm text-card-foreground" style={{ letterSpacing: '-0.1px', lineHeight: 1.5 }}>
              {message}
            </p>
          </div>

          {/* Buttons */}
          <div className="flex gap-2 mb-5">
            <Link
              href="/check-in"
              className="flex-1 bg-primary text-primary-foreground rounded-[14px] py-3.5 text-center text-sm font-medium transition-colors hover:opacity-90"
              style={{ letterSpacing: '-0.1px' }}
            >
              Check in
            </Link>
            <button
              className="flex-1 bg-card text-card-foreground rounded-[14px] py-3.5 text-center text-sm border border-border transition-colors hover:opacity-90"
              style={{ letterSpacing: '-0.1px' }}
              onClick={() => {
                // Schedule — deferred for hackathon
              }}
            >
              Schedule
            </button>
          </div>

          {/* Streak + photo info */}
          <div className="flex justify-center items-center gap-3">
            {bestStreak > 0 && (
              <span
                className="text-xs font-medium"
                style={{ color: 'var(--sage)', letterSpacing: '0.2px' }}
              >
                {bestStreak} {bestStreak === 1 ? 'day' : 'days'}
              </span>
            )}
            {bestStreak > 0 && todayPhotos && (
              <span className="text-xs text-muted-foreground">·</span>
            )}
            {todayPhotos && (
              <span className="text-xs text-muted-foreground" style={{ letterSpacing: '0.2px' }}>
                1 photo today
              </span>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
