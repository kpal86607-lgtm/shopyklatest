// Client-side authentication module compatible with Firebase Auth API
const STORAGE_KEY = 'shopyk_user';

class MockAuthProvider {
  constructor(providerId = 'google.com') {
    this.providerId = providerId;
  }
}

export const googleProvider = new MockAuthProvider('google.com');

class AuthState {
  constructor() {
    this.listeners = new Set();
    this.currentUser = null;
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        this.currentUser = JSON.parse(saved);
      }
    } catch {
      this.currentUser = null;
    }
  }

  notify() {
    for (const listener of this.listeners) {
      try {
        listener(this.currentUser);
      } catch (e) {
        console.error('Auth listener error:', e);
      }
    }
  }

  setUser(user) {
    this.currentUser = user;
    try {
      if (user) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch {}
    this.notify();
  }
}

export const auth = new AuthState();

export function onAuthStateChanged(authInstance, callback) {
  authInstance.listeners.add(callback);
  // Trigger callback asynchronously with current user state
  setTimeout(() => {
    callback(authInstance.currentUser);
  }, 0);
  return () => authInstance.listeners.delete(callback);
}

export async function signInAnonymously(authInstance) {
  const guestUser = {
    uid: 'guest_' + Math.random().toString(36).substring(2, 10),
    isAnonymous: true,
    displayName: 'Guest Shopper',
    email: '',
    photoURL: '',
  };
  authInstance.setUser(guestUser);
  return { user: guestUser };
}

export async function signInWithPopup(authInstance, provider) {
  // Check if we can prompt for custom name or use standard Google profile
  const storedName = localStorage.getItem('shopyk_last_user_name') || 'Shopper';
  const name = prompt('Sign in with Google - Enter your name:', storedName) || 'Shopper';
  if (name) {
    try { localStorage.setItem('shopyk_last_user_name', name); } catch {}
  }
  const email = name.toLowerCase().replace(/[^a-z0-9]/g, '') + '@gmail.com';
  const googleUser = {
    uid: 'google_' + Math.random().toString(36).substring(2, 10),
    isAnonymous: false,
    displayName: name,
    email: email,
    photoURL: '',
  };
  authInstance.setUser(googleUser);
  return { user: googleUser };
}

export async function signOut(authInstance) {
  authInstance.setUser(null);
  return true;
}
