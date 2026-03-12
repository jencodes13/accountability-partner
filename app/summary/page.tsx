'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/components/auth-provider';
import {
  getHabits,
  getCheckInSessions,
  Habit,
  CheckInSession,
  HABIT_CATEGORY_LABELS,
} from '@/lib/db';
import Link from 'next/link';
import { startOfWeek, endOfWeek, format, isAfter, isBefore } from 'date-fns';

export default function WeeklySummaryPage() {
  const { user, loading } = useAuth();
  const [habits, setHabits] = useState<Habit[]>([]);
  const [sessions, setSessions] = useState<CheckInSession[]>([]);
  const [loadingData, setLoadingData] = useState(true);
  const [expandedHabit, setExpandedHabit] = useState<string | null>(null);

  useEffect(() => {
    if (user) {
      loadData();
    }
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadData = async () => {
    if (!user) return;
    setLoadingData(true);
    const [userHabits, recentSessions] = await Promise.all([
      getHabits(user.uid),
      getCheckInSessions(user.uid, 30),
    ]);
    setHabits(userHabits);
    setSessions(recentSessions);
    setLoadingData(false);
  };

  if (loading || loadingData) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-foreground">
        <span className="text-muted-foreground">Loading...</span>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-foreground">
        <p className="text-muted-foreground">Please sign in to view your weekly summary.</p>
      </div>
    );
  }

  const now = new Date();
  const weekStart = startOfWeek(now, { weekStartsOn: 1 });
  const weekEnd = endOfWeek(now, { weekStartsOn: 1 });

  const thisWeekSessions = sessions.filter((s) => {
    if (!s.timestamp) return false;
    const sessionDate = s.timestamp.toDate();
    return isAfter(sessionDate, weekStart) && isBefore(sessionDate, weekEnd);
  });

  // Stats
  const totalCheckIns = thisWeekSessions.length;
  const totalMinutes = Math.round(
    thisWeekSessions.reduce((sum, s) => sum + (s.durationSeconds || 0), 0) / 60
  );
  const totalCommitments = thisWeekSessions.reduce(
    (sum, s) => sum + (s.commitments?.length || 0),
    0
  );

  // Week header dates
  const weekLabel = `WEEK OF ${format(weekStart, 'MMM d').toUpperCase()} \u2013 ${format(weekEnd, 'd')}`;

  // Per-habit data
  const habitData = habits.map((habit) => {
    const sessionsForHabit = thisWeekSessions.filter(
      (s) => s.habitsCovered && s.habitsCovered.includes(habit.id)
    );
    const daysCheckedIn = sessionsForHabit.length;

    // Get the most recent session's insight for this habit
    const sortedSessions = [...sessionsForHabit].sort((a, b) => {
      const aTime = a.timestamp?.toDate()?.getTime() || 0;
      const bTime = b.timestamp?.toDate()?.getTime() || 0;
      return bTime - aTime;
    });
    const latestInsight = sortedSessions.length > 0 ? sortedSessions[0].insight : '';

    // Gather all commitments from sessions covering this habit
    const habitCommitments = sessionsForHabit.flatMap((s) => s.commitments || []);

    return {
      habit,
      daysCheckedIn: Math.min(daysCheckedIn, 7),
      streak: habit.currentStreak,
      insight: latestInsight,
      commitments: habitCommitments,
    };
  });

  const toggleExpand = (habitId: string) => {
    setExpandedHabit((prev) => (prev === habitId ? null : habitId));
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-lg mx-auto px-5 py-8">
        {/* Back link */}
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-8"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M10 12L6 8L10 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Back
        </Link>

        {/* Header */}
        <div className="mb-6">
          <p className="text-muted-foreground uppercase tracking-wider mb-1" style={{ fontSize: 11 }}>
            {weekLabel}
          </p>
          <h1 className="text-foreground" style={{ fontSize: 22, fontWeight: 500 }}>
            Your week
          </h1>
        </div>

        {/* Stats row */}
        <div className="flex gap-3 mb-8">
          <div
            className="flex-1 rounded-[14px] border border-border px-4 py-3"
            style={{ background: 'var(--card)' }}
          >
            <p className="text-lg font-semibold" style={{ color: 'var(--sage)' }}>
              {totalCheckIns}
            </p>
            <p className="text-muted-foreground" style={{ fontSize: 12 }}>
              check-ins
            </p>
          </div>
          <div
            className="flex-1 rounded-[14px] border border-border px-4 py-3"
            style={{ background: 'var(--card)' }}
          >
            <p className="text-lg font-semibold" style={{ color: 'var(--sage)' }}>
              {totalMinutes}
            </p>
            <p className="text-muted-foreground" style={{ fontSize: 12 }}>
              minutes
            </p>
          </div>
          <div
            className="flex-1 rounded-[14px] border border-border px-4 py-3"
            style={{ background: 'var(--card)' }}
          >
            <p className="text-lg font-semibold" style={{ color: 'var(--sage)' }}>
              {totalCommitments}
            </p>
            <p className="text-muted-foreground" style={{ fontSize: 12 }}>
              commitments
            </p>
          </div>
        </div>

        {/* Per-habit cards */}
        <div className="flex flex-col gap-3 mb-10">
          {habitData.map(({ habit, daysCheckedIn, streak, insight, commitments }) => {
            const isExpanded = expandedHabit === habit.id;
            return (
              <div
                key={habit.id}
                className="rounded-[14px] border px-4 py-3.5 cursor-pointer transition-colors"
                style={{
                  background: 'var(--card)',
                  borderColor: isExpanded
                    ? 'rgba(130,184,154,0.2)'
                    : 'var(--border)',
                }}
                onClick={() => toggleExpand(habit.id)}
              >
                {/* Top row: label + streak */}
                <div className="flex items-center justify-between mb-2.5">
                  <span className="text-foreground font-medium" style={{ fontSize: 13 }}>
                    {habit.label}
                  </span>
                  <span style={{ color: 'var(--sage)', fontSize: 13 }}>
                    {streak} {streak === 1 ? 'day' : 'days'}
                  </span>
                </div>

                {/* 7-segment progress bar */}
                <div className="flex gap-1">
                  {Array.from({ length: 7 }).map((_, i) => (
                    <div
                      key={i}
                      className="flex-1 rounded-sm"
                      style={{
                        height: 4,
                        background:
                          i < daysCheckedIn
                            ? 'var(--sage)'
                            : 'rgba(128,128,128,0.1)',
                      }}
                    />
                  ))}
                </div>

                {/* Expanded content */}
                {isExpanded && (
                  <div className="mt-3 pt-3" style={{ borderTop: '1px solid rgba(128,128,128,0.1)' }}>
                    {insight && (
                      <p className="text-muted-foreground mb-2" style={{ fontSize: 13, lineHeight: 1.5 }}>
                        {insight}
                      </p>
                    )}
                    {commitments.length > 0 && (
                      <div className="mt-2">
                        <p className="text-muted-foreground mb-1" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                          Commitments
                        </p>
                        <ul className="space-y-1">
                          {commitments.map((c, idx) => (
                            <li
                              key={idx}
                              className="text-foreground"
                              style={{ fontSize: 13, lineHeight: 1.5 }}
                            >
                              {c}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {!insight && commitments.length === 0 && (
                      <p className="text-muted-foreground" style={{ fontSize: 13 }}>
                        No insights or commitments this week.
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {habitData.length === 0 && (
            <p className="text-muted-foreground text-center py-8" style={{ fontSize: 14 }}>
              No habits tracked yet. Start a check-in to see your weekly progress.
            </p>
          )}
        </div>

        {/* Done button */}
        <Link
          href="/"
          className="block w-full text-center py-3 rounded-[14px] font-medium transition-opacity hover:opacity-90"
          style={{
            background: 'var(--sage)',
            color: '#1a1a1a',
            fontSize: 15,
          }}
        >
          Done
        </Link>

        <div className="pb-8" />
      </div>
    </div>
  );
}
