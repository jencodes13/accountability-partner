'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/auth-provider';
import { getUserProfile, UserProfile } from '@/lib/db';
import { ArrowLeft, Send, Camera, Image as ImageIcon, X } from 'lucide-react';
import Link from 'next/link';

// API calls go through the same origin (Next.js rewrites proxy to the backend)
const BACKEND_URL = '';

// ─── Types ───

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  imageUrl?: string;
  imageDescription?: string;
  habitId?: string;
  timestamp: string;
}

// ─── Helpers ───

function formatTime(isoString: string): string {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// ─── Typing Indicator ───

function TypingIndicator() {
  return (
    <div className="flex justify-start">
      <div
        className="px-4 py-3"
        style={{
          borderRadius: '18px 18px 18px 6px',
          backgroundColor: '#2e3440',
          border: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <div className="flex gap-1.5 items-center h-5">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="w-2 h-2 rounded-full"
              style={{
                backgroundColor: '#7e8a96',
                animation: `typingPulse 1.4s ease-in-out ${i * 0.2}s infinite`,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Message Bubble ───

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className="max-w-[80%] space-y-1">
        {/* Image */}
        {message.imageUrl && (
          <div className={isUser ? 'ml-auto' : ''}>
            <img
              src={message.imageUrl}
              alt={message.imageDescription || 'Shared photo'}
              className="object-cover"
              style={{
                maxWidth: 200,
                borderRadius: isUser ? '18px 18px 6px 18px' : '18px 18px 18px 6px',
              }}
              loading="lazy"
            />
          </div>
        )}

        {/* Text bubble */}
        {message.text && (
          <div
            style={{
              padding: '12px 16px',
              borderRadius: isUser ? '18px 18px 6px 18px' : '18px 18px 18px 6px',
              backgroundColor: isUser
                ? 'rgba(130,184,154,0.12)'
                : '#2e3440',
              border: `1px solid ${
                isUser
                  ? 'rgba(130,184,154,0.2)'
                  : 'rgba(255,255,255,0.06)'
              }`,
            }}
          >
            <p
              className="text-sm whitespace-pre-wrap"
              style={{ color: '#e2e0e6', lineHeight: 1.5 }}
            >
              {message.text}
            </p>
          </div>
        )}

        {/* Timestamp */}
        <div className={`px-1 ${isUser ? 'text-right' : 'text-left'}`}>
          <span className="text-[10px]" style={{ color: '#7e8a96' }}>
            {formatTime(message.timestamp)}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ───

export default function MessagesPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // Scroll on new messages
  useEffect(() => {
    scrollToBottom();
  }, [messages, isSending, scrollToBottom]);

  // Load profile and message history
  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setIsLoading(false);
      return;
    }

    const load = async () => {
      setIsLoading(true);
      try {
        const [userProfile, historyRes] = await Promise.all([
          getUserProfile(user.uid),
          fetch(`${BACKEND_URL}/api/messages/${user.uid}`),
        ]);

        if (!userProfile || !userProfile.onboardingComplete) {
          router.push('/onboarding');
          return;
        }

        setProfile(userProfile);

        if (historyRes.ok) {
          const history: ChatMessage[] = await historyRes.json();
          setMessages(history);
        }
      } catch (err) {
        console.error('Error loading messages:', err);
      } finally {
        setIsLoading(false);
      }
    };

    load();
  }, [user, authLoading, router]);

  // ─── Send text message ───

  const handleSendMessage = async () => {
    if (!user || (!inputText.trim() && !selectedImage) || isSending) return;

    const textToSend = inputText.trim();
    setInputText('');
    setIsSending(true);

    // Optimistic user message
    const tempId = `temp-${Date.now()}`;
    const tempUserMsg: ChatMessage = {
      id: tempId,
      role: 'user',
      text: textToSend,
      imageUrl: imagePreview || undefined,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, tempUserMsg]);

    const imageToSend = selectedImage;
    setSelectedImage(null);
    setImagePreview(null);

    try {
      let response;

      if (imageToSend) {
        const formData = new FormData();
        formData.append('file', imageToSend);
        if (textToSend) formData.append('text', textToSend);

        response = await fetch(`${BACKEND_URL}/api/messages/${user.uid}/photo`, {
          method: 'POST',
          body: formData,
        });
      } else {
        response = await fetch(`${BACKEND_URL}/api/messages/${user.uid}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: textToSend }),
        });
      }

      if (!response.ok) throw new Error(`API error: ${response.status}`);

      const data = await response.json();

      setMessages((prev) => {
        const withoutTemp = prev.filter((m) => m.id !== tempId);
        return [
          ...withoutTemp,
          {
            id: data.userMessage.id,
            role: 'user' as const,
            text: data.userMessage.text,
            imageUrl: data.userMessage.imageUrl,
            imageDescription: data.userMessage.imageDescription,
            habitId: data.userMessage.habitId,
            timestamp: data.userMessage.timestamp,
          },
          {
            id: data.assistantMessage.id,
            role: 'assistant' as const,
            text: data.assistantMessage.text,
            habitId: data.assistantMessage.habitId,
            timestamp: data.assistantMessage.timestamp,
          },
        ];
      });
    } catch (err) {
      console.error('Error sending message:', err);
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      setInputText(textToSend);
    } finally {
      setIsSending(false);
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  // ─── Image handling ───

  const showError = useCallback((msg: string) => {
    setError(msg);
    setTimeout(() => setError(null), 3000);
  }, []);

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
    if (!allowedTypes.includes(file.type)) {
      showError('Only images (JPEG, PNG, WebP, HEIC) are allowed.');
      e.target.value = '';
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      showError('Image must be under 10 MB.');
      e.target.value = '';
      return;
    }

    setError(null);
    setSelectedImage(file);
    const reader = new FileReader();
    reader.onload = (ev) => setImagePreview(ev.target?.result as string);
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const removeSelectedImage = () => {
    setSelectedImage(null);
    setImagePreview(null);
  };

  // ─── Loading / Auth guard ───

  if (authLoading || isLoading) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ backgroundColor: '#1e2128' }}
      >
        <span className="text-sm" style={{ color: '#7e8a96' }}>
          Loading...
        </span>
      </div>
    );
  }

  if (!user) {
    return (
      <div
        className="min-h-screen flex flex-col items-center justify-center gap-3"
        style={{ backgroundColor: '#1e2128' }}
      >
        <span className="text-sm" style={{ color: '#7e8a96' }}>
          Sign in to view messages.
        </span>
        <Link
          href="/"
          className="text-sm px-4 py-2 rounded-lg"
          style={{ color: '#82b89a' }}
        >
          Go to home
        </Link>
      </div>
    );
  }

  if (!profile) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ backgroundColor: '#1e2128' }}
      >
        <span className="text-sm" style={{ color: '#7e8a96' }}>
          Loading...
        </span>
      </div>
    );
  }

  const agentName = profile.agentName || 'Partner';

  return (
    <div
      className="min-h-screen flex flex-col max-w-lg mx-auto"
      style={{
        backgroundColor: '#1e2128',
        fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
      }}
    >
      <style>{`
        @keyframes typingPulse {
          0%, 100% { opacity: 0.3; transform: scale(0.8); }
          50% { opacity: 1; transform: scale(1); }
        }
      `}</style>

      {/* Header */}
      <header
        className="flex items-center gap-3 px-4 py-3"
        style={{
          borderBottom: '1px solid rgba(255,255,255,0.04)',
          backgroundColor: '#1e2128',
        }}
      >
        <Link
          href="/"
          className="p-1 transition-opacity hover:opacity-70"
          style={{ color: '#b0b8c4' }}
        >
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="flex-1 min-w-0">
          <h1
            className="text-base font-medium truncate"
            style={{ color: '#e2e0e6' }}
          >
            {agentName}
          </h1>
          <p className="text-xs" style={{ color: '#7e8a96' }}>
            {isSending ? 'typing...' : 'accountability partner'}
          </p>
        </div>
      </header>

      {/* Messages area */}
      <main
        className="flex-1 overflow-y-auto px-4 py-4 space-y-3"
        style={{ paddingBottom: selectedImage ? 160 : 80 }}
      >
        {/* Empty state */}
        {messages.length === 0 && !isSending && (
          <div className="flex flex-col items-center justify-center h-full text-center py-20">
            <p className="text-sm mb-1" style={{ color: '#7e8a96' }}>
              No messages yet -- send one to get started.
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {/* Typing indicator */}
        {isSending && <TypingIndicator />}

        <div ref={messagesEndRef} />
      </main>

      {/* Image preview bar */}
      {imagePreview && (
        <div
          className="px-4 py-2 flex items-center gap-3"
          style={{
            borderTop: '1px solid rgba(255,255,255,0.04)',
            backgroundColor: '#1e2128',
          }}
        >
          <div className="relative">
            <img
              src={imagePreview}
              alt="Selected"
              className="w-16 h-16 rounded-xl object-cover"
            />
            <button
              onClick={removeSelectedImage}
              className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full flex items-center justify-center"
              style={{ backgroundColor: '#ef4444', color: '#fff' }}
            >
              <X className="w-3 h-3" />
            </button>
          </div>
          <span
            className="text-xs flex-1 truncate"
            style={{ color: '#7e8a96' }}
          >
            {selectedImage?.name}
          </span>
        </div>
      )}

      {/* Error toast */}
      {error && (
        <div
          className="mx-4 mb-1 px-3 py-2 rounded-lg text-xs text-center"
          style={{
            backgroundColor: 'rgba(239,68,68,0.15)',
            color: '#f87171',
            border: '1px solid rgba(239,68,68,0.2)',
          }}
        >
          {error}
        </div>
      )}

      {/* Input bar */}
      <div
        className="px-4 py-3"
        style={{
          borderTop: '1px solid rgba(255,255,255,0.04)',
          backgroundColor: '#1e2128',
        }}
      >
        <div className="flex items-center gap-2">
          {/* Photo button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="p-2 rounded-full flex-shrink-0 transition-opacity hover:opacity-70"
            style={{ color: selectedImage ? '#82b89a' : '#7e8a96' }}
            disabled={isSending}
            title="Share a photo"
          >
            {selectedImage ? (
              <ImageIcon className="w-5 h-5" />
            ) : (
              <Camera className="w-5 h-5" />
            )}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleImageSelect}
          />

          {/* Text input */}
          <input
            ref={inputRef}
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={selectedImage ? 'Add a caption...' : 'Message...'}
            className="flex-1 px-4 py-2.5 rounded-full text-sm focus:outline-none"
            style={{
              backgroundColor: '#2e3440',
              border: '1px solid rgba(255,255,255,0.06)',
              color: '#e2e0e6',
            }}
            disabled={isSending}
          />

          {/* Send button */}
          <button
            onClick={handleSendMessage}
            disabled={isSending || (!inputText.trim() && !selectedImage)}
            className="p-2 rounded-full flex-shrink-0 transition-opacity disabled:opacity-30"
            style={{
              backgroundColor:
                !inputText.trim() && !selectedImage
                  ? 'transparent'
                  : '#82b89a',
              color:
                !inputText.trim() && !selectedImage
                  ? '#7e8a96'
                  : '#1e2128',
            }}
            title="Send"
          >
            <Send className="w-5 h-5" />
          </button>
        </div>
      </div>
    </div>
  );
}
