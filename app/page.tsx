'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { auth, db } from '@/lib/firebase';
import { onAuthStateChanged, User, signOut } from 'firebase/auth';
import { collection, onSnapshot, doc, getDoc, addDoc, setDoc, query, orderBy, limit } from 'firebase/firestore';

// ============================================================
// CONFIG
// ============================================================
const DEFAULT_RATE_KES_PER_MINUTE = 2;
const DEFAULT_FREE_ALLOWANCE_MINUTES = 5;
const LOW_TIME_WARNING_SECONDS = 60;
// A PC counts as offline once its last heartbeat is older than this —
// a few missed check-ins, not just one slow tick, to avoid false alarms.
const OFFLINE_THRESHOLD_MS = 15000;
// A self-service request from an idle screen auto-clears if nobody at
// the counter approves it within this window — the customer likely
// walked off.
const REQUEST_TIMEOUT_MS = 3 * 60 * 1000;

// ============================================================
// TYPES
// ============================================================
type SessionType = 'postpaid' | 'prepaid' | null;
type PcStatus = 'Available' | 'Active' | 'Paused';
type PowerAction = 'shutdown' | 'restart' | 'logoff';

interface Service {
  id: string;
  name: string;
  price: number;
  category?: string;
}

// Firestore's client SDK returns a Timestamp object (with .toMillis()),
// but freshly-added PCs won't have one yet — this covers both.
type FirestoreTimestampLike = { toMillis?: () => number; seconds?: number } | null | undefined;

interface Pc {
  id: number;
  name: string;
  status: PcStatus;
  sessionType: SessionType;
  sessionStart: number | null;
  prepaidAmount: number;
  pausedAt: number | null;
  totalPausedTime: number;
  lastHeartbeat?: FirestoreTimestampLike;
  pendingCommand?: PowerAction | null;
  pendingCommandIssuedAt?: number | null;
  screenshotB64?: string | null;
  sessionRequest?: SessionType;
  sessionRequestAt?: FirestoreTimestampLike;
}

interface BusinessProfile {
  businessName?: string;
  address?: string;
  phone?: string;
  rateKesPerMinute?: number;
  freeAllowanceMinutes?: number;
}

interface CartItem {
  id: string;
  name: string;
  price: number;
  qty: number;
}

interface Sale {
  id: string;
  items: CartItem[];
  totalAmount: number;
  timestamp: string;
}

// ============================================================
// HELPERS
// ============================================================
const formatTime = (totalSeconds: number) => {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${sec}`;
};

const extractPcName = (itemName: string) => itemName.replace(/ \(Pre-paid\)$/, '').replace(/ Session$/, '');

const timestampToMillis = (ts: FirestoreTimestampLike): number | null => {
  if (!ts) return null;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (typeof ts.seconds === 'number') return ts.seconds * 1000;
  return null;
};

const isPcOnline = (pc: Pc, now: number) => {
  const lastMs = timestampToMillis(pc.lastHeartbeat);
  return lastMs !== null && now - lastMs < OFFLINE_THRESHOLD_MS;
};

const computeTiming = (pc: Pc, now: number, rate: number, allowanceSec: number) => {
  let activeMs = 0;
  if (pc.sessionStart) {
    activeMs = now - pc.sessionStart - (pc.totalPausedTime || 0);
    if (pc.status === 'Paused' && pc.pausedAt) activeMs -= now - pc.pausedAt;
  }
  const elapsedSeconds = Math.max(0, Math.floor(activeMs / 1000));
  const isPrepaid = pc.sessionType === 'prepaid';

  let timeString = '00:00:00';
  let currentCost = 0;
  let remainingSeconds = Infinity;

  if (pc.status !== 'Available') {
    if (isPrepaid) {
      const purchasedSeconds = (pc.prepaidAmount / (rate || 1)) * 60;
      remainingSeconds = Math.max(0, purchasedSeconds + allowanceSec - elapsedSeconds);
      timeString = formatTime(remainingSeconds);
      currentCost = pc.prepaidAmount;
    } else {
      timeString = formatTime(elapsedSeconds);
      currentCost = Math.max(0, Math.floor((elapsedSeconds - allowanceSec) / 60)) * rate;
    }
  }

  return { elapsedSeconds, currentCost, timeString, remainingSeconds, isPrepaid };
};

const playBeep = (freq = 880, durationMs = 160) => {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine'; // Changed from square to sine for a softer, more natural tone
    osc.frequency.value = freq;
    gain.gain.value = 0.05;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    setTimeout(() => {
      osc.stop();
      ctx.close();
    }, durationMs);
  } catch {
    // Audio not available
  }
};

// Natural Theme Status Styles
const statusStyles: Record<PcStatus, { border: string; bg: string; text: string; badge: string }> = {
  Active: { border: 'border-emerald-200', bg: 'bg-emerald-50', text: 'text-emerald-900', badge: 'bg-emerald-100 text-emerald-700' },
  Paused: { border: 'border-amber-200', bg: 'bg-amber-50', text: 'text-amber-900', badge: 'bg-amber-100 text-amber-700' },
  Available: { border: 'border-stone-200', bg: 'bg-white', text: 'text-stone-500', badge: 'bg-stone-100 text-stone-500' },
};

export default function BizManagerPOS() {
  const router = useRouter();

  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [services, setServices] = useState<Service[]>([]);
  const [businessProfile, setBusinessProfile] = useState<BusinessProfile | null>(null);
  const [isSavingTransaction, setIsSavingTransaction] = useState(false);
  const [toast, setToast] = useState<{ msg: string; tone: 'error' | 'success' } | null>(null);

  const [cart, setCart] = useState<CartItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [showReceipt, setShowReceipt] = useState(false);

  const [pcs, setPcs] = useState<Pc[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [tick, setTick] = useState(Date.now());

  const [selectedPcForStart, setSelectedPcForStart] = useState<Pc | null>(null);
  const [prepaidAmount, setPrepaidAmount] = useState('');
  const [pcPendingEnd, setPcPendingEnd] = useState<{ pc: Pc; cost: number } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [rateDraft, setRateDraft] = useState('');
  const [allowanceDraft, setAllowanceDraft] = useState('');
  const [pcPendingTopUp, setPcPendingTopUp] = useState<Pc | null>(null);
  const [topUpAmount, setTopUpAmount] = useState('');
  const [powerModalPc, setPowerModalPc] = useState<Pc | null>(null);
  const [powerAction, setPowerAction] = useState<PowerAction | null>(null);
  const [previewPcId, setPreviewPcId] = useState<number | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const autoEndedRef = useRef<Set<number>>(new Set());
  const beepedPcsRef = useRef<Set<number>>(new Set());
  const offlinePcsRef = useRef<Set<number>>(new Set());
  const requestClearedRef = useRef<Set<number>>(new Set());

  const RATE = businessProfile?.rateKesPerMinute ?? DEFAULT_RATE_KES_PER_MINUTE;
  const ALLOWANCE_SEC = (businessProfile?.freeAllowanceMinutes ?? DEFAULT_FREE_ALLOWANCE_MINUTES) * 60;

  const notify = (msg: string, tone: 'error' | 'success' = 'error') => {
    setToast({ msg, tone });
    setTimeout(() => setToast(null), 4000);
  };

  useEffect(() => {
    const unsubscribeAuth = onAuthStateChanged(auth, (currentUser) => {
      if (currentUser) {
        setUser(currentUser);
      } else {
        setUser(null);
        router.push('/login');
      }
    });
    return () => unsubscribeAuth();
  }, [router]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    const loadProfile = async () => {
      try {
        const userDocRef = doc(db, 'users', user.uid);
        const userDocSnap = await getDoc(userDocRef);
        if (!cancelled && userDocSnap.exists()) setBusinessProfile(userDocSnap.data() as BusinessProfile);
      } catch (err) {
        console.error('Failed to load business profile', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    loadProfile();

    const unsubscribeServices = onSnapshot(
      collection(db, 'users', user.uid, 'services'),
      (snapshot) => setServices(snapshot.docs.map((d) => ({ id: d.id, ...d.data() }) as Service)),
      () => notify("Lost the connection to your services list — reconnecting…")
    );

    const unsubscribePcs = onSnapshot(
      collection(db, 'users', user.uid, 'pcs'),
      (snapshot) => {
        const fetchedPcs = snapshot.docs.map((d) => d.data() as Pc);
        fetchedPcs.sort((a, b) => a.id - b.id);
        setPcs(fetchedPcs);
      },
      () => notify('Lost the live feed from your PCs — reconnecting…')
    );

    const unsubscribeSales = onSnapshot(
      query(collection(db, 'users', user.uid, 'sales'), orderBy('timestamp', 'desc'), limit(200)),
      (snapshot) => setSales(snapshot.docs.map((d) => ({ id: d.id, ...d.data() }) as Sale))
    );

    return () => {
      cancelled = true;
      unsubscribeServices();
      unsubscribePcs();
      unsubscribeSales();
    };
  }, [user]);

  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      setTick(now);

      pcs.forEach((pc) => {
        // Offline check runs for every PC, regardless of session state —
        // a PC can say "Active" in Firestore while its lock script has
        // actually crashed, so this is a separate signal from status.
        const online = isPcOnline(pc, now);
        if (!online) {
          if (!offlinePcsRef.current.has(pc.id)) {
            offlinePcsRef.current.add(pc.id);
            playBeep(320, 260);
            if (pc.status === 'Active' && user) {
              // Nothing is enforcing the timer or lock screen on that
              // machine right now — freeze billing instead of letting
              // it silently keep running.
              pauseSession(pc);
              notify(`${pc.name} went offline mid-session — paused automatically. Resume once it reconnects.`, 'error');
            } else {
              notify(`${pc.name} has gone offline — its lock screen isn't checking in.`, 'error');
            }
          }
        } else {
          offlinePcsRef.current.delete(pc.id);
        }

        // A customer's self-service request auto-clears if it sits
        // unapproved too long — they probably walked off.
        if (pc.sessionRequest && user) {
          const requestMs = timestampToMillis(pc.sessionRequestAt);
          if (requestMs !== null && now - requestMs > REQUEST_TIMEOUT_MS) {
            if (!requestClearedRef.current.has(pc.id)) {
              requestClearedRef.current.add(pc.id);
              setDoc(doc(db, 'users', user.uid, 'pcs', pc.id.toString()), { sessionRequest: null, sessionRequestAt: null }, { merge: true })
                .catch(() => {})
                .finally(() => requestClearedRef.current.delete(pc.id));
            }
          }
        }

        if (pc.status === 'Available' || pc.sessionType !== 'prepaid') return;
        const { remainingSeconds } = computeTiming(pc, now, RATE, ALLOWANCE_SEC);

        if (remainingSeconds <= 0) {
          if (!autoEndedRef.current.has(pc.id)) {
            autoEndedRef.current.add(pc.id);
            endSession(pc, 0).finally(() => autoEndedRef.current.delete(pc.id));
          }
          beepedPcsRef.current.delete(pc.id);
        } else if (pc.status === 'Active' && remainingSeconds <= LOW_TIME_WARNING_SECONDS) {
          if (!beepedPcsRef.current.has(pc.id)) {
            beepedPcsRef.current.add(pc.id);
            playBeep(600, 200); // Softer warning beep
          }
        } else if (remainingSeconds > LOW_TIME_WARNING_SECONDS) {
          beepedPcsRef.current.delete(pc.id);
        }
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [pcs, user, RATE, ALLOWANCE_SEC]);

  const handleLogout = async () => {
    await signOut(auth);
    router.push('/login');
  };

  const filteredServices = services.filter(
    (service) =>
      service.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (service.category && service.category.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const addToCart = (service: { id: string; name: string; price: number }) => {
    setCart((prevCart) => {
      const existingItem = prevCart.find((item) => item.id === service.id);
      if (existingItem) return prevCart.map((item) => (item.id === service.id ? { ...item, qty: item.qty + 1 } : item));
      return [...prevCart, { ...service, qty: 1 }];
    });
    setSearchQuery('');
  };

  const updateQuantity = (id: string, delta: number) => {
    setCart((prevCart) =>
      prevCart.map((item) => {
        if (item.id === id) {
          const newQty = item.qty + delta;
          return newQty > 0 ? { ...item, qty: newQty } : item;
        }
        return item;
      })
    );
  };

  const removeFromCart = (id: string) => setCart((prevCart) => prevCart.filter((item) => item.id !== id));

  const startSession = async (pc: Pc, type: 'postpaid' | 'prepaid', amount: number = 0) => {
    if (!user) return;
    if (!isPcOnline(pc, Date.now())) {
      notify(`${pc.name} is offline — can't start a session until it reconnects.`);
      return;
    }
    try {
      const pcRef = doc(db, 'users', user.uid, 'pcs', pc.id.toString());
      if (type === 'prepaid') addToCart({ id: `pc-${pc.id}-${Date.now()}`, name: `${pc.name} (Pre-paid)`, price: amount });

      await setDoc(
        pcRef,
        {
          status: 'Active',
          sessionType: type,
          sessionStart: Date.now(),
          prepaidAmount: amount,
          pausedAt: null,
          totalPausedTime: 0,
          sessionRequest: null,
          sessionRequestAt: null,
        },
        { merge: true }
      );
      notify(`${pc.name} is live.`, 'success');
      setSelectedPcForStart(null);
      setPrepaidAmount('');
    } catch (err) {
      console.error('Failed to start session', err);
      notify(`Couldn't fire up ${pc.name} — check the connection and try again.`);
    }
  };

  const dismissRequest = async (pc: Pc) => {
    if (!user) return;
    try {
      await setDoc(doc(db, 'users', user.uid, 'pcs', pc.id.toString()), { sessionRequest: null, sessionRequestAt: null }, { merge: true });
    } catch (err) {
      console.error('Failed to dismiss request', err);
      notify(`Couldn't dismiss the request on ${pc.name}.`);
    }
  };

  const pauseSession = async (pc: Pc) => {
    if (!user) return;
    try {
      await setDoc(doc(db, 'users', user.uid, 'pcs', pc.id.toString()), { status: 'Paused', pausedAt: Date.now() }, { merge: true });
    } catch (err) {
      console.error('Failed to pause session', err);
      notify(`Couldn't put ${pc.name} on hold.`);
    }
  };

  const resumeSession = async (pc: Pc) => {
    if (!user || !pc.pausedAt) return;
    try {
      const pauseDuration = Date.now() - pc.pausedAt;
      await setDoc(
        doc(db, 'users', user.uid, 'pcs', pc.id.toString()),
        { status: 'Active', pausedAt: null, totalPausedTime: (pc.totalPausedTime || 0) + pauseDuration },
        { merge: true }
      );
    } catch (err) {
      console.error('Failed to resume session', err);
      notify(`Couldn't bring ${pc.name} back.`);
    }
  };

  const endSession = async (pc: Pc, costToBill: number) => {
    if (!user) return;
    try {
      if (pc.sessionType === 'postpaid' && costToBill > 0) {
        addToCart({ id: `pc-${pc.id}-${Date.now()}`, name: `${pc.name} Session`, price: costToBill });
      }
      await setDoc(
        doc(db, 'users', user.uid, 'pcs', pc.id.toString()),
        { status: 'Available', sessionStart: null, sessionType: null, prepaidAmount: 0, pausedAt: null, totalPausedTime: 0 },
        { merge: true }
      );
    } catch (err) {
      console.error('Failed to end session', err);
      notify(`Couldn't wrap up ${pc.name} — its session is still running, try again.`);
    }
  };

  const confirmEndSession = async () => {
    if (!pcPendingEnd) return;
    await endSession(pcPendingEnd.pc, pcPendingEnd.cost);
    setPcPendingEnd(null);
  };

  const topUpSession = async (pc: Pc, amount: number) => {
    if (!user || !amount || amount <= 0) return;
    try {
      addToCart({ id: `pc-${pc.id}-topup-${Date.now()}`, name: `${pc.name} Top-up`, price: amount });
      await setDoc(doc(db, 'users', user.uid, 'pcs', pc.id.toString()), { prepaidAmount: (pc.prepaidAmount || 0) + amount }, { merge: true });
      notify(`Added KES ${amount} to ${pc.name}.`, 'success');
      setPcPendingTopUp(null);
      setTopUpAmount('');
    } catch (err) {
      console.error('Failed to top up session', err);
      notify(`Couldn't add time to ${pc.name}.`);
    }
  };

  const sendPowerCommand = async (pc: Pc, action: PowerAction) => {
    if (!user) return;
    try {
      await setDoc(doc(db, 'users', user.uid, 'pcs', pc.id.toString()), { pendingCommand: action, pendingCommandIssuedAt: Date.now() }, { merge: true });
      notify(`Sent ${action} to ${pc.name} — it'll run next time the PC checks in.`, 'success');
      setPowerModalPc(null);
      setPowerAction(null);
    } catch (err) {
      console.error('Failed to send power command', err);
      notify(`Couldn't reach ${pc.name} to send the command.`);
    }
  };

  const handleAddPc = async () => {
    if (!user) return;
    try {
      const nextId = pcs.length > 0 ? Math.max(...pcs.map((p) => p.id)) + 1 : 1;
      await setDoc(doc(db, 'users', user.uid, 'pcs', nextId.toString()), {
        id: nextId,
        name: `PC ${nextId}`,
        status: 'Available',
        sessionStart: null,
        sessionType: null,
        prepaidAmount: 0,
        pausedAt: null,
        totalPausedTime: 0,
      });
      notify(`PC ${nextId} wired up and ready.`, 'success');
    } catch (err) {
      console.error('Failed to add PC', err);
      notify("Couldn't add a new PC.");
    }
  };

  const saveRates = async () => {
    if (!user) return;
    const rate = Number(rateDraft);
    const allowance = Number(allowanceDraft);
    if (!rate || rate <= 0 || allowance < 0) {
      notify('Enter a valid rate and allowance.');
      return;
    }
    try {
      await setDoc(doc(db, 'users', user.uid), { rateKesPerMinute: rate, freeAllowanceMinutes: allowance }, { merge: true });
      notify('Billing rates updated.', 'success');
      setShowSettings(false);
    } catch (err) {
      console.error('Failed to save rates', err);
      notify("Couldn't save the new rates.");
    }
  };

  const cartTotal = cart.reduce((total, item) => total + item.price * item.qty, 0);

  const handleCompleteTransaction = async () => {
    if (!user || cart.length === 0) return;
    setIsSavingTransaction(true);
    try {
      await addDoc(collection(db, 'users', user.uid, 'sales'), { items: cart, totalAmount: cartTotal, timestamp: new Date().toISOString() });
      setCart([]);
      setShowReceipt(false);
    } catch (error) {
      console.error('Error saving transaction: ', error);
      notify('Failed to save the sale. Your cart is still here — give it another go.');
    } finally {
      setIsSavingTransaction(false);
    }
  };

  const todayStats = useMemo(() => {
    const todayKey = new Date().toDateString();
    const todaysSales = sales.filter((s) => new Date(s.timestamp).toDateString() === todayKey);
    const revenue = todaysSales.reduce((sum, s) => sum + s.totalAmount, 0);

    const pcTally: Record<string, number> = {};
    let sessionCount = 0;
    todaysSales.forEach((s) => {
      s.items.forEach((item) => {
        if (item.name.endsWith('(Pre-paid)') || item.name.endsWith('Session')) {
          sessionCount += item.qty;
          const pcName = extractPcName(item.name);
          pcTally[pcName] = (pcTally[pcName] || 0) + item.qty;
        }
      });
    });
    const busiest = Object.entries(pcTally).sort((a, b) => b[1] - a[1])[0];

    return { revenue, sessionCount, busiest: busiest ? busiest[0] : '—' };
  }, [sales]);

  const activeCount = pcs.filter((p) => p.status === 'Active').length;
  const pausedCount = pcs.filter((p) => p.status === 'Paused').length;
  const availableCount = pcs.filter((p) => p.status === 'Available').length;
  const offlineCount = pcs.filter((p) => !isPcOnline(p, tick)).length;
  const requestCount = pcs.filter((p) => !!p.sessionRequest).length;
  const previewPc = pcs.find((p) => p.id === previewPcId) || null;
  const liveSelectedPc = selectedPcForStart ? pcs.find((p) => p.id === selectedPcForStart.id) || selectedPcForStart : null;

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#f9f8f6] text-emerald-800">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-4 border-emerald-200 border-t-emerald-600 rounded-full animate-spin"></div>
          <div className="font-semibold tracking-widest text-sm uppercase text-stone-500">
            LOADING {businessProfile?.businessName || 'WORKSPACE'}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f9f8f6] text-stone-800 flex flex-col font-sans print:bg-white selection:bg-emerald-100">
      
      {/* TOAST */}
      {toast && (
        <div
          className={`fixed top-4 right-4 z-[60] text-sm px-5 py-3 rounded-lg shadow-lg font-medium transition-all print:hidden ${
            toast.tone === 'error' ? 'bg-white border border-rose-200 text-rose-600' : 'bg-emerald-600 text-white shadow-emerald-600/20'
          }`}
        >
          {toast.msg}
        </div>
      )}

      {/* HEADER */}
      <header className="relative bg-white border-b border-stone-200 px-4 sm:px-6 py-3 sm:py-4 flex justify-between items-center gap-3 print:hidden shadow-sm">
        <div className="flex flex-wrap items-center gap-3 sm:gap-6 min-w-0">
          <div className="min-w-0">
            <h1 className="text-lg sm:text-2xl font-extrabold tracking-tight text-emerald-900 truncate">
              {businessProfile?.businessName || 'Biz Manager POS'}
            </h1>
            <p className="hidden sm:block text-[10px] font-bold text-emerald-600/70 uppercase tracking-widest mt-0.5">EST. 2022</p>
          </div>
          <div className="hidden md:block h-8 w-px bg-stone-200"></div>
          <div className="text-[11px] sm:text-xs font-medium text-stone-500 flex flex-wrap gap-2.5 sm:gap-4">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500"></span> {activeCount} live</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500"></span> {pausedCount} paused</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-stone-300"></span> {availableCount} free</span>
            {offlineCount > 0 && (
              <span className="flex items-center gap-1 text-rose-600 font-semibold"><span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse"></span> {offlineCount} offline</span>
            )}
            {requestCount > 0 && (
              <span className="flex items-center gap-1 text-sky-600 font-semibold">
                <span className="w-2 h-2 rounded-full bg-sky-500 animate-pulse"></span> {requestCount} request{requestCount > 1 ? 's' : ''} waiting
              </span>
            )}
          </div>
        </div>

        {/* Full nav — larger screens only */}
        <div className="hidden sm:flex gap-5 items-center text-sm font-medium shrink-0">
          <button onClick={() => router.push('/dashboard')} className="text-stone-500 hover:text-emerald-700 transition-colors">
            Dashboard
          </button>
          <button onClick={() => router.push('/services')} className="text-stone-500 hover:text-emerald-700 transition-colors">
            Services
          </button>
          <button
            onClick={() => {
              setRateDraft(String(RATE));
              setAllowanceDraft(String(ALLOWANCE_SEC / 60));
              setShowSettings(true);
            }}
            className="text-stone-500 hover:text-emerald-700 transition-colors"
          >
            Billing Rates
          </button>
          <button onClick={handleLogout} className="text-rose-500 hover:text-rose-700 transition-colors px-4 py-2 bg-rose-50 rounded-lg hover:bg-rose-100">
            Logout
          </button>
        </div>

        {/* Compact overflow menu — mobile only */}
        <div className="sm:hidden shrink-0">
          <button
            onClick={() => setMobileMenuOpen((v) => !v)}
            className="w-9 h-9 flex items-center justify-center rounded-lg border border-stone-200 text-stone-500 hover:bg-stone-50"
            aria-label="Menu"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16"></path></svg>
          </button>

          {mobileMenuOpen && (
            <div className="absolute right-4 top-full mt-1 w-48 bg-white border border-stone-200 rounded-xl shadow-lg py-1.5 z-50">
              <button
                onClick={() => {
                  setMobileMenuOpen(false);
                  router.push('/dashboard');
                }}
                className="w-full text-left px-4 py-2.5 text-sm font-medium text-stone-600 hover:bg-stone-50"
              >
                Dashboard
              </button>
              <button
                onClick={() => {
                  setMobileMenuOpen(false);
                  router.push('/services');
                }}
                className="w-full text-left px-4 py-2.5 text-sm font-medium text-stone-600 hover:bg-stone-50"
              >
                Services
              </button>
              <button
                onClick={() => {
                  setMobileMenuOpen(false);
                  setRateDraft(String(RATE));
                  setAllowanceDraft(String(ALLOWANCE_SEC / 60));
                  setShowSettings(true);
                }}
                className="w-full text-left px-4 py-2.5 text-sm font-medium text-stone-600 hover:bg-stone-50"
              >
                Billing Rates
              </button>
              <div className="my-1 border-t border-stone-100"></div>
              <button
                onClick={() => {
                  setMobileMenuOpen(false);
                  handleLogout();
                }}
                className="w-full text-left px-4 py-2.5 text-sm font-medium text-rose-600 hover:bg-rose-50"
              >
                Logout
              </button>
            </div>
          )}
        </div>
      </header>

      {/* DAILY STATS STRIP */}
      <div className="bg-white border-b border-stone-200 px-4 sm:px-6 py-3 flex flex-wrap gap-4 sm:gap-8 text-xs sm:text-sm print:hidden">
        <span className="text-stone-500">
          TODAY&apos;S REVENUE: <span className="font-bold text-emerald-700">KES {todayStats.revenue}</span>
        </span>
        <span className="text-stone-500">
          SESSIONS: <span className="font-semibold text-stone-800">{todayStats.sessionCount}</span>
        </span>
        <span className="text-stone-500">
          BUSIEST RIG: <span className="font-semibold text-stone-800">{todayStats.busiest}</span>
        </span>
      </div>

      <main className="flex-1 flex flex-col lg:flex-row p-3 sm:p-6 gap-4 sm:gap-6 print:hidden max-w-[1600px] mx-auto w-full">
        
        {/* PC Management */}
        <section className="flex-1 flex flex-col">
          <div className="flex flex-wrap justify-between items-end gap-3 mb-4 sm:mb-6">
            <h2 className="text-xl font-bold text-stone-800 tracking-tight">Active Workstations</h2>
            <button
              onClick={handleAddPc}
              className="bg-white text-emerald-700 hover:bg-emerald-50 px-4 py-2 rounded-xl font-semibold text-sm transition-colors border border-emerald-200 shadow-sm"
            >
              + Add New PC
            </button>
          </div>

          {pcs.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-stone-400 border-2 border-dashed border-stone-200 bg-white/50 rounded-2xl text-center px-6">
              No workstations configured. Click "+ Add New PC" to get started.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 sm:gap-5">
              {pcs.map((pc) => {
                const { timeString, currentCost, remainingSeconds, isPrepaid } = computeTiming(pc, tick, RATE, ALLOWANCE_SEC);
                const runningLow = isPrepaid && pc.status === 'Active' && remainingSeconds <= LOW_TIME_WARNING_SECONDS;
                const style = statusStyles[pc.status];
                const online = isPcOnline(pc, tick);

                return (
                  <div
                    key={pc.id}
                    className={`p-5 rounded-2xl border transition-all duration-300 shadow-sm flex flex-col justify-between min-h-[160px] ${style.bg} ${style.border} ${
                      runningLow ? 'border-rose-400 bg-rose-50 shadow-rose-100' : ''
                    } ${!online ? 'opacity-70' : ''}`}
                  >
                    <div className="flex justify-between items-center mb-2 gap-2">
                      <span className="font-bold text-lg text-stone-800 tracking-tight">{pc.name}</span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span
                          className={`text-[10px] uppercase font-bold tracking-wider px-2.5 py-1 rounded-full ${
                            !online ? 'bg-rose-100 text-rose-700' : runningLow ? 'bg-rose-100 text-rose-700' : style.badge
                          }`}
                        >
                          {!online ? 'Offline' : runningLow ? 'Time low' : pc.status}
                        </span>
                        <button
                          onClick={() => {
                            setPowerModalPc(pc);
                            setPowerAction(null);
                          }}
                          title="Power options"
                          className="w-7 h-7 flex items-center justify-center rounded-full text-stone-400 hover:text-stone-700 hover:bg-stone-100 transition"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5.636 5.636a9 9 0 1012.728 0M12 3v9"></path></svg>
                        </button>
                      </div>
                    </div>

                    {!online && pc.sessionType && (
                      <div className="mb-2 text-[10px] font-bold text-rose-600 bg-rose-50 border border-rose-100 rounded-lg px-2.5 py-1.5 flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse shrink-0"></span>
                        Offline mid-session — auto-paused. Go check on this PC, or End it below.
                      </div>
                    )}

                    {pc.pendingCommand && (
                      <div className="mb-2 text-[10px] font-bold text-amber-600 bg-amber-50 border border-amber-100 rounded-lg px-2.5 py-1.5">
                        Sending {pc.pendingCommand}… waiting for PC to check in
                      </div>
                    )}

                    {pc.status === 'Available' && pc.sessionRequest && (
                      <div className="mb-2 text-[10px] font-bold text-sky-700 bg-sky-50 border border-sky-100 rounded-lg px-2.5 py-1.5">
                        Customer requested {pc.sessionRequest === 'prepaid' ? 'Pay Now' : 'Pay Later'} — approve at the counter
                      </div>
                    )}

                    {pc.status === 'Active' && pc.screenshotB64 && (
                      <button
                        onClick={() => setPreviewPcId(pc.id)}
                        className="mb-3 block w-full rounded-lg overflow-hidden border border-stone-200 hover:border-emerald-300 transition"
                        title="View live preview"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={`data:image/jpeg;base64,${pc.screenshotB64}`} alt={`${pc.name} screen preview`} className="w-full h-24 object-cover" />
                      </button>
                    )}

                    <div className="text-center my-4">
                      <div className="text-[10px] font-bold text-stone-400 uppercase tracking-widest mb-1">
                        {pc.status === 'Available' ? 'Ready' : isPrepaid ? 'Remaining' : 'Elapsed'}
                      </div>
                      <div className={`text-4xl font-mono tracking-tight font-light ${runningLow ? 'text-rose-600' : style.text}`}>
                         {pc.status === 'Available' ? '--:--:--' : timeString}
                      </div>
                    </div>

                    <div className="flex justify-between items-end gap-2 mt-2">
                      <div className="flex flex-col">
                        <span className="font-bold text-stone-700 text-base">KES {currentCost}</span>
                        {isPrepaid && pc.status !== 'Available' && <span className="text-[10px] text-emerald-600 font-bold uppercase tracking-wider">Pre-paid</span>}
                      </div>

                      {pc.status === 'Available' ? (
                        !online ? (
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-bold text-stone-400 italic px-1">Waiting for PC to come online…</span>
                            {pc.sessionRequest && (
                              <button
                                onClick={() => dismissRequest(pc)}
                                title="Dismiss request"
                                className="w-8 h-8 flex items-center justify-center rounded-full text-stone-400 hover:text-rose-600 hover:bg-rose-50 transition shrink-0"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                              </button>
                            )}
                          </div>
                        ) : pc.sessionRequest ? (
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => setSelectedPcForStart(pc)}
                              className="text-sm bg-sky-600 text-white px-4 py-2 rounded-xl transition hover:bg-sky-700 font-semibold shadow-sm hover:shadow"
                            >
                              Approve {pc.sessionRequest === 'prepaid' ? 'Pay Now' : 'Pay Later'}
                            </button>
                            <button
                              onClick={() => dismissRequest(pc)}
                              title="Dismiss request"
                              className="w-8 h-8 flex items-center justify-center rounded-full text-stone-400 hover:text-rose-600 hover:bg-rose-50 transition shrink-0"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setSelectedPcForStart(pc)}
                            className="text-sm bg-emerald-600 text-white px-5 py-2 rounded-xl transition hover:bg-emerald-700 font-semibold shadow-sm hover:shadow"
                          >
                            Start Session
                          </button>
                        )
                      ) : (
                        <div className="flex gap-2 flex-wrap justify-end">
                          {isPrepaid && (
                            <button
                              onClick={() => setPcPendingTopUp(pc)}
                              className="text-xs bg-white border border-emerald-200 text-emerald-700 hover:bg-emerald-50 px-3 py-2 rounded-xl font-bold transition shadow-sm"
                              title="Add more time"
                            >
                              +Time
                            </button>
                          )}
                          {pc.status === 'Active' ? (
                            <button onClick={() => pauseSession(pc)} className="text-xs bg-white border border-amber-200 text-amber-700 hover:bg-amber-50 px-4 py-2 rounded-xl font-bold transition shadow-sm">
                              Pause
                            </button>
                          ) : (
                            <button
                              onClick={() => resumeSession(pc)}
                              disabled={!online}
                              title={!online ? "Can't resume — PC is offline" : undefined}
                              className={`text-xs px-4 py-2 rounded-xl font-bold transition shadow-sm border ${
                                online ? 'bg-emerald-100 border-emerald-200 text-emerald-700 hover:bg-emerald-200' : 'bg-stone-100 border-stone-200 text-stone-400 cursor-not-allowed'
                              }`}
                            >
                              Resume
                            </button>
                          )}
                          <button
                            onClick={() => setPcPendingEnd({ pc, cost: currentCost })}
                            className="text-xs bg-white border border-rose-200 text-rose-600 hover:bg-rose-50 px-4 py-2 rounded-xl font-bold transition shadow-sm"
                          >
                            End
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Quick Sale Cart */}
        <aside className="w-full lg:w-[420px] bg-white rounded-3xl shadow-sm border border-stone-200 flex flex-col relative overflow-hidden">
          <div className="p-6 pb-4 border-b border-stone-100 bg-stone-50/50">
             <h2 className="text-lg font-bold text-stone-800 tracking-tight mb-4">Current Bill</h2>
             <div className="relative">
              <input
                type="text"
                placeholder="Search services or categories…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full px-4 py-2.5 bg-white border border-stone-200 rounded-xl text-stone-800 placeholder-stone-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 outline-none transition-all shadow-sm"
              />
              {searchQuery && (
                <ul className="absolute z-10 w-full bg-white border border-stone-200 rounded-xl shadow-xl max-h-60 overflow-y-auto mt-2 p-1">
                  {filteredServices.length > 0 ? (
                    filteredServices.map((service) => (
                      <li
                        key={service.id}
                        onClick={() => addToCart(service)}
                        className="p-3 hover:bg-stone-50 cursor-pointer flex justify-between rounded-lg items-center"
                      >
                        <div>
                          <span className="block font-medium text-stone-800">{service.name}</span>
                          <span className="text-[11px] font-medium text-stone-400 uppercase tracking-wider">{service.category}</span>
                        </div>
                        <span className="font-bold text-emerald-700">KES {service.price}</span>
                      </li>
                    ))
                  ) : (
                    <li className="p-4 text-stone-500 text-sm text-center">No matches found.</li>
                  )}
                </ul>
              )}
            </div>
          </div>

          <div className="flex-1 p-6 overflow-y-auto space-y-3 bg-white">
            {cart.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-stone-400 space-y-2">
                <svg className="w-12 h-12 text-stone-200" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"></path></svg>
                <p className="text-sm">Cart is empty</p>
              </div>
            ) : (
              cart.map((item) => (
                <div key={item.id} className="flex flex-wrap sm:flex-nowrap justify-between items-center gap-2 p-3 rounded-xl border border-stone-100 bg-stone-50 group hover:border-stone-200 transition-colors">
                  <div className="flex-1 min-w-[120px]">
                    <span className="block font-bold text-stone-800 text-sm">{item.name}</span>
                    <span className="text-[11px] font-medium text-stone-500">KES {item.price} each</span>
                  </div>
                  <div className="flex items-center gap-1 bg-white border border-stone-200 rounded-lg p-0.5 shadow-sm shrink-0">
                    <button onClick={() => updateQuantity(item.id, -1)} className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-stone-100 text-stone-600 font-medium transition">-</button>
                    <span className="w-6 text-center font-bold text-sm text-stone-800">{item.qty}</span>
                    <button onClick={() => updateQuantity(item.id, 1)} className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-stone-100 text-stone-600 font-medium transition">+</button>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="font-bold w-16 text-right text-sm text-stone-800">KES {item.price * item.qty}</span>
                    <button onClick={() => removeFromCart(item.id)} className="w-7 h-7 flex items-center justify-center rounded-full text-stone-300 hover:text-rose-500 hover:bg-rose-50 transition-colors">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="p-6 bg-stone-50/50 border-t border-stone-100">
            <div className="flex justify-between items-center mb-4">
              <span className="font-bold text-stone-500 uppercase tracking-widest text-xs">Total Amount</span>
              <span className="font-extrabold text-2xl text-emerald-700">KES {cartTotal}</span>
            </div>
            <button
              onClick={() => setShowReceipt(true)}
              disabled={cart.length === 0}
              className={`w-full py-3.5 rounded-xl font-bold text-lg transition-all shadow-sm ${
                cart.length > 0 ? 'bg-emerald-600 text-white hover:bg-emerald-700 hover:shadow-md' : 'bg-stone-200 text-stone-400 cursor-not-allowed'
              }`}
            >
              Complete Checkout
            </button>
          </div>
        </aside>
      </main>

      {/* START SESSION MODAL */}
      {liveSelectedPc && (
        <div className="fixed inset-0 bg-stone-900/40 backdrop-blur-sm flex items-center justify-center z-50 print:hidden p-4">
          <div className="bg-white p-6 sm:p-8 rounded-3xl shadow-2xl w-[400px] max-w-full border border-stone-100">
            <h2 className="text-xl font-extrabold mb-6 text-stone-800 tracking-tight">Start {liveSelectedPc.name}</h2>

            {!isPcOnline(liveSelectedPc, tick) && (
              <div className="mb-4 text-xs font-bold text-rose-600 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2.5">
                This PC just went offline — starting is disabled until it reconnects.
              </div>
            )}

            <div className="mb-4 p-5 border border-stone-200 rounded-2xl bg-stone-50 hover:border-emerald-200 transition-colors">
              <h3 className="font-bold text-stone-800 mb-1">Pay Later</h3>
              <p className="text-xs text-stone-500 mb-4 font-medium leading-relaxed">
                Open tab. First {ALLOWANCE_SEC / 60} mins free, then KES {RATE}/min.
              </p>
              <button
                onClick={() => startSession(liveSelectedPc, 'postpaid')}
                disabled={!isPcOnline(liveSelectedPc, tick)}
                className="w-full bg-white border border-emerald-200 text-emerald-700 py-2.5 rounded-xl font-bold hover:bg-emerald-50 transition shadow-sm disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white"
              >
                Start Open Session
              </button>
            </div>

            <div className="p-5 border border-stone-200 rounded-2xl bg-stone-50 hover:border-emerald-200 transition-colors">
              <h3 className="font-bold text-stone-800 mb-1">Pay Now</h3>
              <p className="text-xs text-stone-500 mb-4 font-medium leading-relaxed">Lock in time upfront. Auto-locks at zero.</p>
              <div className="flex gap-2">
                <input
                  type="number"
                  placeholder="Amount (KES)"
                  value={prepaidAmount}
                  onChange={(e) => setPrepaidAmount(e.target.value)}
                  className="flex-1 bg-white border border-stone-200 p-2.5 rounded-xl focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 outline-none font-bold text-stone-800 shadow-sm transition-all"
                />
                <button
                  onClick={() => startSession(liveSelectedPc, 'prepaid', Number(prepaidAmount))}
                  disabled={!prepaidAmount || Number(prepaidAmount) <= 0 || !isPcOnline(liveSelectedPc, tick)}
                  className="bg-emerald-600 text-white px-6 rounded-xl font-bold hover:bg-emerald-700 transition disabled:opacity-50 shadow-sm"
                >
                  Start
                </button>
              </div>
            </div>

            <button
              onClick={() => {
                setSelectedPcForStart(null);
                setPrepaidAmount('');
              }}
              className="mt-6 w-full py-3 rounded-xl font-bold text-stone-500 hover:bg-stone-100 transition"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* CONFIRM END SESSION MODAL */}
      {pcPendingEnd && (
        <div className="fixed inset-0 bg-stone-900/40 backdrop-blur-sm flex items-center justify-center z-50 print:hidden p-4">
          <div className="bg-white border border-stone-100 p-6 sm:p-8 rounded-3xl shadow-2xl w-[400px] max-w-full text-center">
            <div className="w-16 h-16 bg-rose-100 rounded-full flex items-center justify-center mx-auto mb-4">
               <svg className="w-8 h-8 text-rose-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
            </div>
            <h2 className="text-xl font-extrabold mb-2 text-stone-800 tracking-tight">End {pcPendingEnd.pc.name} Session?</h2>
            <p className="text-sm text-stone-500 mb-8 font-medium leading-relaxed">
              This will lock the screen and add <span className="font-bold text-emerald-600">KES {pcPendingEnd.cost}</span> to the current checkout cart.
            </p>
            <div className="flex gap-3">
              <button onClick={() => setPcPendingEnd(null)} className="flex-1 bg-stone-100 py-3 rounded-xl font-bold hover:bg-stone-200 text-stone-700 transition">
                Keep Running
              </button>
              <button onClick={confirmEndSession} className="flex-1 bg-rose-600 hover:bg-rose-700 text-white py-3 rounded-xl font-bold shadow-sm transition">
                End Session
              </button>
            </div>
          </div>
        </div>
      )}

      {/* TOP UP MODAL */}
      {pcPendingTopUp && (
        <div className="fixed inset-0 bg-stone-900/40 backdrop-blur-sm flex items-center justify-center z-50 print:hidden p-4">
          <div className="bg-white p-6 sm:p-8 rounded-3xl shadow-2xl w-[380px] max-w-full border border-stone-100">
            <h2 className="text-xl font-extrabold mb-1 text-stone-800 tracking-tight">Add Time — {pcPendingTopUp.name}</h2>
            <p className="text-sm text-stone-500 mb-6 font-medium leading-relaxed">Tops up the running session without ending it or resetting the clock.</p>
            <input
              type="number"
              placeholder="Amount (KES)"
              value={topUpAmount}
              onChange={(e) => setTopUpAmount(e.target.value)}
              className="w-full mb-6 bg-white border border-stone-200 p-3 rounded-xl focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 outline-none font-bold text-stone-800 shadow-sm"
            />
            <div className="flex gap-3">
              <button
                onClick={() => {
                  setPcPendingTopUp(null);
                  setTopUpAmount('');
                }}
                className="flex-1 bg-stone-100 py-3 rounded-xl font-bold hover:bg-stone-200 text-stone-700 transition"
              >
                Cancel
              </button>
              <button
                onClick={() => topUpSession(pcPendingTopUp, Number(topUpAmount))}
                disabled={!topUpAmount || Number(topUpAmount) <= 0}
                className="flex-1 bg-emerald-600 text-white py-3 rounded-xl font-bold hover:bg-emerald-700 disabled:opacity-50 shadow-sm transition"
              >
                Add Time
              </button>
            </div>
          </div>
        </div>
      )}

      {/* POWER CONTROL MODAL */}
      {powerModalPc && (
        <div className="fixed inset-0 bg-stone-900/40 backdrop-blur-sm flex items-center justify-center z-50 print:hidden p-4">
          <div className="bg-white p-6 sm:p-8 rounded-3xl shadow-2xl w-[380px] max-w-full border border-stone-100">
            {!powerAction ? (
              <>
                <h2 className="text-xl font-extrabold mb-1 text-stone-800 tracking-tight">Power — {powerModalPc.name}</h2>
                <p className="text-sm text-stone-500 mb-6 font-medium leading-relaxed">Sends a command that runs the next time this PC checks in.</p>
                <div className="space-y-2">
                  <button onClick={() => setPowerAction('logoff')} className="w-full text-left px-4 py-3 rounded-xl border border-stone-200 hover:bg-stone-50 font-semibold text-stone-700 transition">
                    Log off current user
                  </button>
                  <button onClick={() => setPowerAction('restart')} className="w-full text-left px-4 py-3 rounded-xl border border-amber-200 hover:bg-amber-50 font-semibold text-amber-700 transition">
                    Restart
                  </button>
                  <button onClick={() => setPowerAction('shutdown')} className="w-full text-left px-4 py-3 rounded-xl border border-rose-200 hover:bg-rose-50 font-semibold text-rose-700 transition">
                    Shut down
                  </button>
                </div>
                <button
                  onClick={() => {
                    setPowerModalPc(null);
                    setPowerAction(null);
                  }}
                  className="mt-6 w-full py-3 rounded-xl font-bold text-stone-500 hover:bg-stone-100 transition"
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <h2 className="text-xl font-extrabold mb-2 text-stone-800 tracking-tight capitalize">Confirm {powerAction}</h2>
                <p className="text-sm text-stone-500 mb-8 font-medium leading-relaxed">
                  This will {powerAction === 'shutdown' ? 'shut down' : powerAction === 'restart' ? 'restart' : 'log off'} {powerModalPc.name} as soon as it checks in. Anything unsaved there closes first.
                </p>
                <div className="flex gap-3">
                  <button onClick={() => setPowerAction(null)} className="flex-1 bg-stone-100 py-3 rounded-xl font-bold hover:bg-stone-200 text-stone-700 transition">
                    Back
                  </button>
                  <button onClick={() => sendPowerCommand(powerModalPc, powerAction)} className="flex-1 bg-rose-600 hover:bg-rose-700 text-white py-3 rounded-xl font-bold shadow-sm transition">
                    Confirm
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* SCREEN PREVIEW MODAL */}
      {previewPc && previewPc.screenshotB64 && (
        <div className="fixed inset-0 bg-stone-900/60 backdrop-blur-sm flex items-center justify-center z-50 print:hidden p-4" onClick={() => setPreviewPcId(null)}>
          <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full overflow-hidden border border-stone-200" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center px-5 py-3 border-b border-stone-100">
              <h3 className="font-bold text-stone-800">{previewPc.name} — live preview</h3>
              <button onClick={() => setPreviewPcId(null)} className="text-stone-400 hover:text-stone-700 w-7 h-7 flex items-center justify-center rounded-full hover:bg-stone-100">
                ✕
              </button>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`data:image/jpeg;base64,${previewPc.screenshotB64}`} alt={`${previewPc.name} live screen preview`} className="w-full" />
            <div className="px-5 py-3 text-xs text-stone-400 border-t border-stone-100">Thumbnail refreshes every few seconds — not real-time video.</div>
          </div>
        </div>
      )}

      {/* SETTINGS MODAL */}
      {showSettings && (
        <div className="fixed inset-0 bg-stone-900/40 backdrop-blur-sm flex items-center justify-center z-50 print:hidden p-4">
          <div className="bg-white border border-stone-100 p-6 sm:p-8 rounded-3xl shadow-2xl w-[400px] max-w-full">
            <h2 className="text-xl font-extrabold mb-1 text-stone-800 tracking-tight">Billing Settings</h2>
            <p className="text-sm text-stone-500 mb-6 font-medium">Update the base rates for all workstations.</p>

            <label className="block text-sm font-bold text-stone-700 mb-1.5">Rate (KES per minute)</label>
            <input
              type="number"
              value={rateDraft}
              onChange={(e) => setRateDraft(e.target.value)}
              className="w-full mb-5 bg-white border border-stone-200 p-3 rounded-xl text-stone-800 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 outline-none transition font-medium shadow-sm"
            />

            <label className="block text-sm font-bold text-stone-700 mb-1.5">Free allowance (minutes)</label>
            <input
              type="number"
              value={allowanceDraft}
              onChange={(e) => setAllowanceDraft(e.target.value)}
              className="w-full mb-8 bg-white border border-stone-200 p-3 rounded-xl text-stone-800 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 outline-none transition font-medium shadow-sm"
            />

            <div className="flex gap-3">
              <button onClick={() => setShowSettings(false)} className="flex-1 bg-stone-100 py-3 rounded-xl font-bold hover:bg-stone-200 text-stone-700 transition">
                Cancel
              </button>
              <button onClick={saveRates} className="flex-1 bg-emerald-600 text-white py-3 rounded-xl font-bold hover:bg-emerald-700 shadow-sm transition">
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}

      {/* RECEIPT MODAL */}
      {showReceipt && (
        <div className="fixed inset-0 bg-stone-900/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 print:bg-transparent print:relative print:flex-col print:items-start print:justify-start print:p-0">
          <div className="bg-white text-black p-6 sm:p-8 rounded-3xl shadow-2xl w-[400px] max-w-full print:shadow-none print:w-[80mm] print:p-0 print:m-0 border border-stone-100">
            <div className="text-center mb-6 font-mono">
              <h2 className="text-2xl font-bold uppercase mb-1">{businessProfile?.businessName || 'Biz Manager'}</h2>
              <p className="text-sm text-stone-600">{businessProfile?.address}</p>
              <p className="text-sm text-stone-600">Tel: {businessProfile?.phone}</p>
              <p className="text-xs text-stone-500 mt-2">{new Date().toLocaleString()}</p>
              <div className="border-b-2 border-dashed border-stone-200 my-5"></div>
            </div>
            
            <div className="font-mono text-sm mb-6">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-dashed border-stone-200 text-left">
                    <th className="pb-3 font-semibold text-stone-600">Item</th>
                    <th className="pb-3 font-semibold text-right text-stone-600">Qty</th>
                    <th className="pb-3 font-semibold text-right text-stone-600">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {cart.map((item) => (
                    <tr key={item.id}>
                      <td className="py-2.5 pr-2 text-stone-800">{item.name}</td>
                      <td className="py-2.5 text-right text-stone-800">{item.qty}</td>
                      <td className="py-2.5 text-right font-semibold text-stone-800">KES {item.price * item.qty}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="border-t-2 border-dashed border-stone-200 mt-5 pt-5">
                <div className="flex justify-between font-bold text-lg text-stone-900">
                  <span>TOTAL:</span>
                  <span>KES {cartTotal}</span>
                </div>
              </div>
            </div>
            
            <div className="text-center font-mono text-xs text-stone-500 mb-8">
              <p>Thank you! See you next time.</p>
            </div>
            
            <div className="flex gap-3 print:hidden">
              <button onClick={() => setShowReceipt(false)} disabled={isSavingTransaction} className="flex-1 bg-stone-100 py-3 rounded-xl font-bold hover:bg-stone-200 text-stone-700 transition">
                Back
              </button>
              <button onClick={() => window.print()} disabled={isSavingTransaction} className="flex-1 bg-stone-800 text-white py-3 rounded-xl font-bold hover:bg-stone-900 shadow-sm transition">
                Print
              </button>
              <button onClick={handleCompleteTransaction} disabled={isSavingTransaction} className="flex-1 bg-emerald-600 text-white py-3 rounded-xl font-bold hover:bg-emerald-700 shadow-sm transition">
                {isSavingTransaction ? 'Saving…' : 'Done'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
