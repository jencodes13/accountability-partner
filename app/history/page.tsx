'use client';

import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '@/components/auth-provider';
import {
  getCheckInSessions, CheckInSession,
  getHabits, Habit,
  HABIT_CATEGORY_LABELS, HabitCategory,
} from '@/lib/db';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import {
  format,
  startOfWeek,
  isSameDay,
  subDays,
  isAfter,
  differenceInCalendarWeeks,
} from 'date-fns';

interface WeekGroup {
  label: string;
  sessions: CheckInSession[];
}

function getWeekLabel(weekIndex: number): string {
  if (weekIndex === 0) return 'THIS WEEK';
  if (weekIndex === 1) return 'LAST WEEK';
  return `${weekIndex} WEEKS AGO`;
}

function getDayLabel(date: Date): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const sessionDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (isSameDay(sessionDay, today)) return 'Today';
  if (isSameDay(sessionDay, subDays(today, 1))) return 'Yesterday';
  return format(date, 'EEEE');
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '';
  const mins = Math.round(seconds / 60);
  if (mins < 1) return '<1 min';
  return `${mins} min`;
}

export default function HistoryPage() {
  const { user, loading } = useAuth();
  const [sessions, setSessions] = useState<CheckInSession[]>([]);
  const [habits, setHabits] = useState<Habit[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    if (user) {
      loadData();
    }
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadData = async () => {
    if (!user) return;
    setLoadingSessions(true);
    const [userSessions, userHabits] = await Promise.all([
      getCheckInSessions(user.uid, 50),
      getHabits(user.uid),
    ]);
    setSessions(userSessions);
    setHabits(userHabits);
    setLoadingSessions(false);
  };

  const getHabitLabel = (habitId: string): string => {
    const habit = habits.find((h) => h.id === habitId);
    if (habit) {
      return HABIT_CATEGORY_LABELS[habit.category as HabitCategory] || habit.label;
    }
    return habitId;
  };

  const weekGroups = useMemo(() => {
    if (sessions.length === 0) return [];

    const now = new Date();
    const currentWeekStart = startOfWeek(now, { weekStartsOn: 1 });
    const cutoff = subDays(currentWeekStart, 7 * 7); // 8 weeks total

    const groups: Map<number, CheckInSession[]> = new Map();

    for (const session of sessions) {
      if (!session.timestamp) continue;
      const sessionDate = session.timestamp.toDate();
      if (!isAfter(sessionDate, cutoff) && !isSameDay(sessionDate, cutoff)) continue;

      const weekIndex = differenceInCalendarWeeks(now, sessionDate, { weekStartsOn: 1 });
      if (weekIndex > 7) continue;

      if (!groups.has(weekIndex)) {
        groups.set(weekIndex, []);
      }
      groups.get(weekIndex)!.push(session);
    }

    const result: WeekGroup[] = [];
    const sortedKeys = Array.from(groups.keys()).sort((a, b) => a - b);
    for (const key of sortedKeys) {
      result.push({
        label: getWeekLabel(key),
        sessions: groups.get(key)!,
      });
    }

    return result;
  }, [sessions]);

  const getCommitments = (session: CheckInSession): string[] => {
    if (session.commitments && session.commitments.length > 0) {
      return session.commitments;
    }
    if (session.microCommitment) {
      return [session.microCommitment];
    }
    return [];
  };

  const getInsightText = (session: CheckInSession): string => {
    if (session.insight) return session.insight;
    if (session.summary) {
      return session.summary.length > 120
        ? session.summary.slice(0, 117) + '...'
        : session.summary;
    }
    return '';
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-foreground">
        <span className="text-muted-foreground" style={{ fontSize: 13 }}>Loading...</span>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-foreground">
        <p className="text-muted-foreground" style={{ fontSize: 14 }}>
          Please sign in to view your history.
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-lg mx-auto px-4 py-6">
        {/* Back link */}
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-muted-foreground mb-5"
          style={{ fontSize: 13 }}
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back</span>
        </Link>

        {/* Header */}
        <div className="flex items-baseline justify-between mb-6">
          <h1
            className="text-foreground"
            style={{ fontSize: 22, fontWeight: 500, letterSpacing: '-0.3px' }}
          >
            History
          </h1>
          {!loadingSessions && sessions.length > 0 && (
            <span className="text-muted-foreground" style={{ fontSize: 13 }}>
              {sessions.length} session{sessions.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        {/* Content */}
        {loadingSessions ? (
          <div className="flex items-center justify-center py-20">
            <span className="text-muted-foreground" style={{ fontSize: 13 }}>
              Loading sessions...
            </span>
          </div>
        ) : sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24">
            <p className="text-muted-foreground mb-1" style={{ fontSize: 15, fontWeight: 500 }}>
              No check-ins yet
            </p>
            <p className="text-muted-foreground mb-4" style={{ fontSize: 13 }}>
              Complete your first check-in to see it here.
            </p>
            <Link
              href="/check-in"
              style={{ fontSize: 13, color: 'var(--sage)' }}
              className="font-medium"
            >
              Start a check-in
            </Link>
          </div>
        ) : (
          <div className="space-y-6">
            {weekGroups.map((group) => (
              <div key={group.label}>
                {/* Week label */}
                <div
                  className="text-muted-foreground mb-3"
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    letterSpacing: '0.3px',
                    textTransform: 'uppercase' as const,
                  }}
                >
                  {group.label}
                </div>

                {/* Session cards */}
                <div className="space-y-2.5">
                  {group.sessions.map((session) => {
                    const isExpanded = expandedId === session.id;
                    const sessionDate = session.timestamp?.toDate();
                    const duration = formatDuration(session.durationSeconds);
                    const commitments = getCommitments(session);
                    const insightText = getInsightText(session);

                    return (
                      <div
                        key={session.id}
                        className="bg-card border border-border cursor-pointer transition-all"
                        style={{ borderRadius: 14, padding: '14px 16px' }}
                        onClick={() => setExpandedId(isExpanded ? null : session.id)}
                      >
                        {/* Row 1: Day name + duration */}
                        <div className="flex items-center justify-between">
                          <span
                            className="text-foreground font-medium"
                            style={{ fontSize: 13 }}
                          >
                            {sessionDate ? getDayLabel(sessionDate) : 'Unknown'}
                          </span>
                          {duration && (
                            <span
                              className="text-muted-foreground"
                              style={{ fontSize: 12 }}
                            >
                              {duration}
                            </span>
                          )}
                        </div>

                        {/* Row 2: Habit pills */}
                        {session.habitsCovered && session.habitsCovered.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mt-2">
                            {session.habitsCovered.map((habitId) => (
                              <span
                                key={habitId}
                                style={{
                                  fontSize: 10,
                                  background: 'var(--sage-subtle)',
                                  color: 'var(--sage)',
                                  borderRadius: 12,
                                  padding: '3px 8px',
                                  fontWeight: 500,
                                }}
                              >
                                {getHabitLabel(habitId)}
                              </span>
                            ))}
                          </div>
                        )}

                        {/* Row 3: Insight */}
                        {insightText && (
                          <p
                            className="text-muted-foreground mt-2"
                            style={{
                              fontSize: 12,
                              lineHeight: 1.4,
                              display: '-webkit-box',
                              WebkitLineClamp: 1,
                              WebkitBoxOrient: 'vertical' as const,
                              overflow: 'hidden',
                            }}
                          >
                            {insightText}
                          </p>
                        )}

                        {/* Expanded content */}
                        {isExpanded && (
                          <div
                            className="mt-3 pt-3 border-t border-border space-y-3"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {/* Full insight / summary */}
                            {session.summary && (
                              <div>
                                <div
                                  className="text-muted-foreground mb-1"
                                  style={{
                                    fontSize: 10,
                                    fontWeight: 600,
                                    letterSpacing: '0.3px',
                                    textTransform: 'uppercase' as const,
                                  }}
                                >
                                  Summary
                                </div>
                                <p
                                  className="text-foreground"
                                  style={{ fontSize: 12, lineHeight: 1.5 }}
                                >
                                  {session.summary}
                                </p>
                              </div>
                            )}

                            {/* Commitments */}
                            {commitments.length > 0 && (
                              <div>
                                <div
                                  className="text-muted-foreground mb-1"
                                  style={{
                                    fontSize: 10,
                                    fontWeight: 600,
                                    letterSpacing: '0.3px',
                                    textTransform: 'uppercase' as const,
                                  }}
                                >
                                  Commitments
                                </div>
                                <ul className="space-y-1">
                                  {commitments.map((c, i) => (
                                    <li
                                      key={i}
                                      className="flex items-start gap-2"
                                      style={{ fontSize: 12 }}
                                    >
                                      <span
                                        className="mt-1.5 shrink-0"
                                        style={{
                                          width: 4,
                                          height: 4,
                                          borderRadius: '50%',
                                          background: 'var(--sage)',
                                        }}
                                      />
                                      <span className="text-foreground" style={{ lineHeight: 1.5 }}>
                                        {c}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}

                            {/* Streak updates */}
                            {session.streakUpdates && Object.keys(session.streakUpdates).length > 0 && (
                              <div>
                                <div
                                  className="text-muted-foreground mb-1"
                                  style={{
                                    fontSize: 10,
                                    fontWeight: 600,
                                    letterSpacing: '0.3px',
                                    textTransform: 'uppercase' as const,
                                  }}
                                >
                                  Streaks
                                </div>
                                <div className="space-y-1">
                                  {Object.entries(session.streakUpdates).map(([habitId, status]) => (
                                    <div
                                      key={habitId}
                                      className="flex items-center justify-between"
                                      style={{ fontSize: 12 }}
                                    >
                                      <span className="text-foreground">
                                        {getHabitLabel(habitId)}
                                      </span>
                                      <span
                                        className="text-muted-foreground"
                                        style={{
                                          fontSize: 11,
                                          color: status === 'maintained' ? 'var(--sage)' : undefined,
                                        }}
                                      >
                                        {status === 'maintained' ? 'Maintained' : status === 'broken' ? 'Broken' : 'Unknown'}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                            {/* Timestamp */}
                            {sessionDate && (
                              <div
                                className="text-muted-foreground pt-1"
                                style={{ fontSize: 11 }}
                              >
                                {format(sessionDate, 'MMMM d, yyyy  h:mm a')}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
