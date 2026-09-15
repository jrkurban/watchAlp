import React, { useState, useEffect, useRef } from 'react';
import { Send } from 'lucide-react';
import { db } from '../lib/firebase';
import { collection, doc, setDoc, getDocs, query, orderBy, serverTimestamp } from 'firebase/firestore';
import { Socket } from 'socket.io-client';
import { getAuth } from 'firebase/auth';

interface ChatProps {
  roomId: string;
  socket: Socket;
}

interface Message {
  id: string;
  text: string;
  uid: string;
  createdAt: number;
}

export function Chat({ roomId, socket }: ChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [currentUid, setCurrentUid] = useState<string>('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const auth = getAuth();
    const unsubscribe = auth.onAuthStateChanged((user) => {
      if (user) {
        setCurrentUid(user.uid);
      } else {
        setCurrentUid('');
      }
    });
    return () => unsubscribe();
  }, []);

  // Fetch initial messages history from Firestore
  useEffect(() => {
    const fetchHistory = async () => {
      try {
        const q = query(collection(db, 'rooms', roomId, 'messages'), orderBy('createdAt', 'asc'));
        const snapshot = await getDocs(q);
        const history: Message[] = [];
        snapshot.forEach(doc => {
          history.push({ id: doc.id, ...doc.data() } as Message);
        });
        setMessages(history);
        scrollToBottom();
      } catch (err) {
        console.error('Failed to fetch chat history:', err);
      }
    };
    
    fetchHistory();
  }, [roomId]);

  // Listen for incoming messages via Socket
  useEffect(() => {
    if (!socket) return;

    const handleNewMessage = (message: Message) => {
      setMessages(prev => {
        // Prevent duplicates if socket delivers multiple times
        if (prev.some(m => m.id === message.id)) return prev;
        return [...prev, message];
      });
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
    if (!newMessage.trim() || !currentUid) return;

    const msgText = newMessage.trim();
    setNewMessage('');

    const messageId = Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
    const timestamp = Date.now();
    
    const messageObj: Message = {
      id: messageId,
      text: msgText,
      uid: currentUid,
      createdAt: timestamp
    };

    // 1. Instantly update local state
    setMessages(prev => [...prev, messageObj]);
    scrollToBottom();

    // 2. Broadcast via Socket for instant update for others
    socket.emit('chat-message', { roomId, message: messageObj });

    // 3. Store in Firestore
    try {
      const msgRef = doc(db, 'rooms', roomId, 'messages', messageId);
      await setDoc(msgRef, messageObj);
    } catch (err) {
      console.error('Failed to save message to Firestore:', err);
    }
  };

  return (
    <div className="flex flex-col h-[500px] bg-white dark:bg-stone-950 border border-stone-200 dark:border-stone-800 rounded-2xl overflow-hidden shadow-sm transition-colors duration-200">
      <div className="bg-stone-50 dark:bg-stone-900 border-b border-stone-200 dark:border-stone-800 p-4 transition-colors">
        <h3 className="font-semibold text-stone-800 dark:text-stone-100">Live Chat</h3>
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
                <div 
                  className={`max-w-[80%] px-4 py-2 rounded-2xl text-sm ${
                    isMe 
                      ? 'bg-indigo-600 text-white rounded-br-sm' 
                      : 'bg-white dark:bg-stone-800 text-stone-800 dark:text-stone-100 border border-stone-200 dark:border-stone-700 rounded-bl-sm shadow-sm'
                  }`}
                >
                  {msg.text}
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
            onChange={(e) => setNewMessage(e.target.value)}
            placeholder="Type a message..."
            className="flex-1 bg-stone-100 dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 dark:text-stone-100 dark:placeholder-stone-500 transition-colors"
          />
          <button
            type="submit"
            disabled={!newMessage.trim()}
            className="p-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-stone-200 dark:disabled:bg-stone-800 disabled:text-stone-400 text-white rounded-xl transition-colors shrink-0"
          >
            <Send className="w-5 h-5" />
          </button>
        </form>
      </div>
    </div>
  );
}
