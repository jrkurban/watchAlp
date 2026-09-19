import React, { useState, useEffect, useRef } from 'react';
import { Send } from 'lucide-react';
import { db } from '../lib/firebase';
import { collection, doc, setDoc, query, orderBy, onSnapshot } from 'firebase/firestore';
import { Socket } from 'socket.io-client';
import { getAuth } from 'firebase/auth';

const MAX_MESSAGE_LENGTH = 2000;

interface ChatProps {
  roomId: string;
  socket: Socket | null;
  displayName: string;
  disabled?: boolean;
}

interface Message {
  id: string;
  text: string;
  uid: string;
  name?: string;
  createdAt: number;
}

function mergeMessages(prev: Message[], incoming: Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const message of prev) byId.set(message.id, message);
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
}

export function Chat({ roomId, socket, displayName, disabled }: ChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [currentUid, setCurrentUid] = useState<string>('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const auth = getAuth();
    const unsubscribe = auth.onAuthStateChanged((user) => {
      setCurrentUid(user?.uid ?? '');
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    setMessages([]);
    const q = query(collection(db, 'rooms', roomId, 'messages'), orderBy('createdAt', 'asc'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const history = snapshot.docs.map((docSnap) => ({
        id: docSnap.id,
        ...docSnap.data(),
      })) as Message[];
      setMessages((prev) => mergeMessages(prev, history));
      scrollToBottom();
    }, (err) => {
      console.error('Failed to listen for chat history:', err);
    });

    return () => unsubscribe();
  }, [roomId]);

  useEffect(() => {
    if (!socket) return;

    const handleNewMessage = (message: Message) => {
      if (!message?.id || typeof message.text !== 'string') return;
      setMessages((prev) => mergeMessages(prev, [message]));
      scrollToBottom();
    };

    socket.on('chat-message', handleNewMessage);

    return () => {
      socket.off('chat-message', handleNewMessage);
    };
  }, [socket]);

  const scrollToBottom = () => {
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 100);
  };

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUid || disabled) return;

    const msgText = newMessage.trim().slice(0, MAX_MESSAGE_LENGTH);
    if (!msgText) return;

    setNewMessage('');

    const messageId = crypto.randomUUID();
    const messageObj: Message = {
      id: messageId,
      text: msgText,
      uid: currentUid,
      name: displayName,
      createdAt: Date.now()
    };

    setMessages((prev) => mergeMessages(prev, [messageObj]));
    scrollToBottom();
    socket?.emit('chat-message', { roomId, message: messageObj });

    try {
      const msgRef = doc(db, 'rooms', roomId, 'messages', messageId);
      await setDoc(msgRef, messageObj);
    } catch (err) {
      console.error('Failed to save message to Firestore:', err);
    }
  };

  return (
    <div className="flex flex-col h-[500px] lg:h-[calc(100vh-8rem)] lg:min-h-[500px] bg-white dark:bg-stone-950 border border-stone-200 dark:border-stone-800 rounded-2xl overflow-hidden shadow-sm transition-colors duration-200">
      <div className="bg-stone-50 dark:bg-stone-900 border-b border-stone-200 dark:border-stone-800 p-4 transition-colors">
        <div>
          <h3 className="font-semibold text-stone-800 dark:text-stone-100">Live Chat</h3>
          {displayName ? (
            <p className="text-xs text-stone-500 dark:text-stone-400 mt-0.5 truncate">as {displayName}</p>
          ) : null}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-stone-50/50 dark:bg-stone-950/50">
        {messages.length === 0 ? (
          <div className="h-full flex items-center justify-center text-stone-400 dark:text-stone-600 text-sm">
            No messages yet. Say hi!
          </div>
        ) : (
          messages.map((msg) => {
            const isMe = msg.uid === currentUid;
            return (
              <div key={msg.id} className={`flex ${isMe ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[80%] ${isMe ? 'text-right' : 'text-left'}`}>
                  <p className={`text-[11px] mb-1 px-1 ${isMe ? 'text-indigo-500' : 'text-stone-400 dark:text-stone-500'}`}>
                    {isMe ? 'You' : (msg.name || 'Guest')}
                  </p>
                  <div
                    className={`px-4 py-2 rounded-2xl text-sm ${
                      isMe
                        ? 'bg-indigo-600 text-white rounded-br-sm'
                        : 'bg-white dark:bg-stone-800 text-stone-800 dark:text-stone-100 border border-stone-200 dark:border-stone-700 rounded-bl-sm shadow-sm'
                    }`}
                  >
                    {msg.text}
                  </div>
                </div>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="p-3 bg-white dark:bg-stone-950 border-t border-stone-200 dark:border-stone-800 transition-colors">
        <form onSubmit={sendMessage} className="flex items-center gap-2">
          <input
            type="text"
            value={newMessage}
            onChange={(e) => setNewMessage(e.target.value.slice(0, MAX_MESSAGE_LENGTH))}
            placeholder={disabled ? 'You cannot chat' : currentUid ? 'Type a message...' : 'Connecting…'}
            disabled={!currentUid || disabled}
            maxLength={MAX_MESSAGE_LENGTH}
            className="flex-1 bg-stone-100 dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:text-stone-100 dark:placeholder-stone-500 transition-colors disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={!newMessage.trim() || !currentUid || disabled}
            className="p-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-stone-200 dark:disabled:bg-stone-800 disabled:text-stone-400 text-white rounded-xl transition-colors shrink-0"
          >
            <Send className="w-5 h-5" />
          </button>
        </form>
      </div>
    </div>
  );
}
