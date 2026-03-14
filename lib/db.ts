import { db, auth } from './firebase';
import { collection, doc, setDoc, getDoc, getDocs, query, where, updateDoc, orderBy, limit, serverTimestamp, Timestamp } from 'firebase/firestore';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string;
    email?: string | null;
    emailVerified?: boolean;
    isAnonymous?: boolean;
    tenantId?: string | null;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection() {
  try {
    await getDoc(doc(db, 'test', 'connection'));
  } catch (error) {
    if(error instanceof Error && error.message.includes('the client is offline')) {
      console.error("Please check your Firebase configuration. ");
    }
  }
}
testConnection();

// --- Habit Categories (v1) ---
export const HABIT_CATEGORIES = [
  'alcohol',
  'sports-betting',
  'nutrition',
  'exercise',
  'spending',
  'journaling',
  'screen-time',
  'sleep',
  'workouts-steps',
] as const;

export type HabitCategory = typeof HABIT_CATEGORIES[number];

export const HABIT_CATEGORY_LABELS: Record<HabitCategory, string> = {
  'alcohol': 'Alcohol / Drinking',
  'sports-betting': 'Sports Betting',
  'nutrition': 'Nutrition / Intentional Eating',
  'exercise': 'Movement / Exercise',
  'spending': 'Spending',
  'journaling': 'Journaling / Reflection',
  'screen-time': 'Screen Time / Digital Habits',
  'sleep': 'Sleep',
  'workouts-steps': 'Workouts / Steps',
};

// --- Persona Types ---
export type Persona = 'coach' | 'friend' | 'reflective';

// --- Interfaces ---

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  birthday?: string; // e.g. "1994-03-15"
  agentName: string;
  persona: Persona;
  language: string; // auto-detected from speech, defaults to 'en'
  dailyCheckInTime: string; // e.g. "20:00"
  onboardingComplete: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface Habit {
  id: string;
  category: HabitCategory;
  label: string; // user's goal statement
  identityStatement: string; // "I am someone who..."
  currentStreak: number;
  longestStreak: number;
  lastCheckIn: Timestamp | null;
  createdAt: Timestamp;
}

export interface PhotoLog {
  id: string;
  habitId: string;
  habitCategory: HabitCategory;
  imageUrl: string; // GCS URL
  visionDescription: string; // Gemini Flash analysis
  timestamp: Timestamp;
}

export interface CheckInSession {
  id: string;
  summary: string;
  habitsCovered: string[]; // habit IDs
  commitments: string[]; // extracted from conversation
  insight: string; // forward-looking, mirrors user's own words
  durationSeconds: number;
  patternsFlagged: string[]; // stored but not displayed in UI
  streakUpdates: Record<string, 'maintained' | 'broken' | 'unknown'>;
  timestamp: Timestamp;
  // Legacy field — kept for migration compatibility
  microCommitment?: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  imageUrl?: string;
  imageDescription?: string;
  habitId?: string;
  timestamp: Timestamp;
}

// Keep legacy interface for migration compatibility
export interface CheckInLog {
  id: string;
  habitId: string;
  date: Timestamp;
  status: 'success' | 'fail' | 'partial';
  notes: string;
}

// ─── User Profile ───

export const createUserProfile = async (uid: string, data: Partial<UserProfile>) => {
  const path = `users/${uid}`;
  try {
    const userRef = doc(db, 'users', uid);
    const userSnap = await getDoc(userRef);
    if (!userSnap.exists()) {
      await setDoc(userRef, {
        uid,
        onboardingComplete: false,
        language: 'en',
        ...data,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
};

export const getUserProfile = async (uid: string): Promise<UserProfile | null> => {
  const path = `users/${uid}`;
  try {
    const userRef = doc(db, 'users', uid);
    const userSnap = await getDoc(userRef);
    if (userSnap.exists()) {
      return userSnap.data() as UserProfile;
    }
    return null;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
    return null;
  }
};

export const updateUserProfile = async (uid: string, data: Partial<UserProfile>) => {
  const path = `users/${uid}`;
  try {
    const userRef = doc(db, 'users', uid);
    await updateDoc(userRef, {
      ...data,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
};

// ─── Habits (max 3 per user) ───

export const addHabit = async (
  uid: string,
  habit: Pick<Habit, 'category' | 'label' | 'identityStatement'>
) => {
  const path = `users/${uid}/habits`;
  try {
    // Enforce max 3 habits
    const existing = await getHabits(uid);
    if (existing.length >= 3) {
      throw new Error('Maximum of 3 habits allowed');
    }

    const habitsRef = collection(db, 'users', uid, 'habits');
    const newHabitRef = doc(habitsRef);
    await setDoc(newHabitRef, {
      id: newHabitRef.id,
      category: habit.category,
      label: habit.label,
      identityStatement: habit.identityStatement,
      currentStreak: 0,
      longestStreak: 0,
      lastCheckIn: null,
      createdAt: serverTimestamp(),
    });
    return newHabitRef.id;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
    return '';
  }
};

export const getHabits = async (uid: string): Promise<Habit[]> => {
  const path = `users/${uid}/habits`;
  try {
    const habitsRef = collection(db, 'users', uid, 'habits');
    const querySnapshot = await getDocs(query(habitsRef));
    return querySnapshot.docs.map(d => d.data() as Habit);
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
    return [];
  }
};

export const updateHabitStreak = async (
  uid: string,
  habitId: string,
  outcome: 'maintained' | 'broken' | 'unknown'
) => {
  const path = `users/${uid}/habits/${habitId}`;
  try {
    const habitRef = doc(db, 'users', uid, 'habits', habitId);
    const habitSnap = await getDoc(habitRef);
    if (!habitSnap.exists()) return;

    const habit = habitSnap.data() as Habit;
    let newStreak = habit.currentStreak;

    if (outcome === 'maintained') {
      newStreak += 1;
    } else if (outcome === 'broken') {
      newStreak = 0;
    }

    await updateDoc(habitRef, {
      currentStreak: newStreak,
      longestStreak: Math.max(habit.longestStreak, newStreak),
      lastCheckIn: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
};

// ─── Photo Logs ───

export const addPhotoLog = async (
  uid: string,
  photo: Omit<PhotoLog, 'id' | 'timestamp'>
) => {
  const path = `users/${uid}/photos`;
  try {
    const photosRef = collection(db, 'users', uid, 'photos');
    const newPhotoRef = doc(photosRef);
    await setDoc(newPhotoRef, {
      ...photo,
      id: newPhotoRef.id,
      timestamp: serverTimestamp(),
    });
    return newPhotoRef.id;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
    return '';
  }
};

export const getRecentPhotos = async (
  uid: string,
  sinceTimestamp?: Timestamp
): Promise<PhotoLog[]> => {
  const path = `users/${uid}/photos`;
  try {
    const photosRef = collection(db, 'users', uid, 'photos');
    let q;
    if (sinceTimestamp) {
      q = query(photosRef, where('timestamp', '>=', sinceTimestamp), orderBy('timestamp', 'desc'));
    } else {
      q = query(photosRef, orderBy('timestamp', 'desc'), limit(20));
    }
    const querySnapshot = await getDocs(q);
    return querySnapshot.docs.map(d => d.data() as PhotoLog);
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
    return [];
  }
};

// ─── Check-In Sessions ───

export const saveCheckInSession = async (
  uid: string,
  session: Omit<CheckInSession, 'id' | 'timestamp'>
) => {
  const path = `users/${uid}/sessions`;
  try {
    const sessionsRef = collection(db, 'users', uid, 'sessions');
    const newSessionRef = doc(sessionsRef);
    await setDoc(newSessionRef, {
      ...session,
      id: newSessionRef.id,
      timestamp: serverTimestamp(),
    });
    return newSessionRef.id;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
    return '';
  }
};

export const getCheckInSessions = async (
  uid: string,
  limitCount: number = 10
): Promise<CheckInSession[]> => {
  const path = `users/${uid}/sessions`;
  try {
    const sessionsRef = collection(db, 'users', uid, 'sessions');
    const q = query(sessionsRef, orderBy('timestamp', 'desc'), limit(limitCount));
    const querySnapshot = await getDocs(q);
    return querySnapshot.docs.map(d => d.data() as CheckInSession);
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
    return [];
  }
};

export const getLastCheckInSession = async (uid: string): Promise<CheckInSession | null> => {
  const sessions = await getCheckInSessions(uid, 1);
  return sessions.length > 0 ? sessions[0] : null;
};

// ─── Legacy Check-In Logs (kept for compatibility) ───

export const addCheckInLog = async (uid: string, log: Omit<CheckInLog, 'id' | 'date'>) => {
  const path = `users/${uid}/logs`;
  try {
    const logsRef = collection(db, 'users', uid, 'logs');
    const newLogRef = doc(logsRef);
    await setDoc(newLogRef, {
      ...log,
      id: newLogRef.id,
      date: serverTimestamp(),
    });
    return newLogRef.id;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
    return '';
  }
};

export const getCheckInLogs = async (uid: string, habitId?: string): Promise<CheckInLog[]> => {
  const path = `users/${uid}/logs`;
  try {
    const logsRef = collection(db, 'users', uid, 'logs');
    let q = query(logsRef);
    if (habitId) {
      q = query(logsRef, where('habitId', '==', habitId));
    }
    const querySnapshot = await getDocs(q);
    return querySnapshot.docs.map(d => d.data() as CheckInLog);
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
    return [];
  }
};

// ─── Chat Messages ───

export const getMessages = async (uid: string, limitCount: number = 50): Promise<Message[]> => {
  const path = `users/${uid}/messages`;
  try {
    const messagesRef = collection(db, 'users', uid, 'messages');
    const q = query(messagesRef, orderBy('timestamp', 'desc'), limit(limitCount));
    const querySnapshot = await getDocs(q);
    const messages = querySnapshot.docs.map(d => d.data() as Message);
    // Reverse so oldest first (chat order)
    messages.reverse();
    return messages;
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
    return [];
  }
};
