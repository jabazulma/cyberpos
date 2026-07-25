'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { auth, db } from '@/lib/firebase';
import { onAuthStateChanged, User, signOut } from 'firebase/auth';
import { collection, onSnapshot, doc, getDoc, addDoc, setDoc } from 'firebase/firestore';

export default function BizManagerPOS() {
  const router = useRouter();
  
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [services, setServices] = useState<any[]>([]);
  const [businessProfile, setBusinessProfile] = useState<any>(null);
  const [isSavingTransaction, setIsSavingTransaction] = useState(false);

  const [cart, setCart] = useState<{ id: string; name: string; price: number; qty: number }[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [showReceipt, setShowReceipt] = useState(false);
  
  const [pcs, setPcs] = useState<any[]>([]);
  const [tick, setTick] = useState(Date.now());

  // 1. AUTHENTICATION & DATABASE SYNC
  useEffect(() => {
    const unsubscribeAuth = onAuthStateChanged(auth, async (currentUser) => {
      if (currentUser) {
        setUser(currentUser);
        
        // Fetch Business Details
        const userDocRef = doc(db, 'users', currentUser.uid);
        const userDocSnap = await getDoc(userDocRef);
        if (userDocSnap.exists()) {
          setBusinessProfile(userDocSnap.data());
        }

        // Fetch Services
        const servicesRef = collection(db, 'users', currentUser.uid, 'services');
        const unsubscribeServices = onSnapshot(servicesRef, (snapshot) => {
          const fetchedServices = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
          setServices(fetchedServices);
        });

        // Fetch PCs and Auto-Initialize if empty
        const pcsRef = collection(db, 'users', currentUser.uid, 'pcs');
        const unsubscribePcs = onSnapshot(pcsRef, (snapshot) => {
          if (snapshot.empty) {
            // Create 3 default PCs in the database the first time you log in
            [1, 2, 3].forEach(id => {
              setDoc(doc(db, 'users', currentUser.uid, 'pcs', id.toString()), {
                id: id,
                name: `PC ${id}`,
                status: 'Available',
                sessionStart: null
              });
            });
          } else {
            const fetchedPcs = snapshot.docs.map(doc => doc.data());
            fetchedPcs.sort((a, b) => a.id - b.id); // Keep them in order
            setPcs(fetchedPcs);
          }
        });

        setLoading(false);
        return () => {
          unsubscribeServices();
          unsubscribePcs();
        };
      } else {
        router.push('/login');
      }
    });

    return () => unsubscribeAuth();
  }, [router]);

  // 2. LIVE CLOCK TICKER
  useEffect(() => {
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const handleLogout = async () => {
    await signOut(auth);
    router.push('/login');
  };

  const filteredServices = services.filter(service => 
    service.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
    (service.category && service.category.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const addToCart = (service: { id: string; name: string; price: number }) => {
    setCart(prevCart => {
      const existingItem = prevCart.find(item => item.id === service.id);
      if (existingItem) {
        return prevCart.map(item => item.id === service.id ? { ...item, qty: item.qty + 1 } : item);
      }
      return [...prevCart, { ...service, qty: 1 }];
    });
    setSearchQuery('');
  };

  const updateQuantity = (id: string, delta: number) => {
    setCart(prevCart => prevCart.map(item => {
      if (item.id === id) {
        const newQty = item.qty + delta;
        return newQty > 0 ? { ...item, qty: newQty } : item;
      }
      return item;
    }));
  };

  const removeFromCart = (id: string) => {
    setCart(prevCart => prevCart.filter(item => item.id !== id));
  };

  // 3. MASTER PC CONTROLLER (This talks to the desktop!)
  const togglePcSession = async (pc: any, currentCost: number) => {
    if (!user) return;
    const pcRef = doc(db, 'users', user.uid, 'pcs', pc.id.toString());

    if (pc.status === 'Active') {
      // END SESSION -> LOCK THE PC
      addToCart({ id: `pc-${pc.id}-${Date.now()}`, name: `${pc.name} Session`, price: currentCost });
      await setDoc(pcRef, { status: 'Available', sessionStart: null }, { merge: true });
    } else {
      // START SESSION -> UNLOCK THE PC
      await setDoc(pcRef, { status: 'Active', sessionStart: Date.now() }, { merge: true });
    }
  };

  const cartTotal = cart.reduce((total, item) => total + (item.price * item.qty), 0);

  const handleCompleteTransaction = async () => {
    if (!user || cart.length === 0) return;
    setIsSavingTransaction(true);
    try {
      const salesRef = collection(db, 'users', user.uid, 'sales');
      await addDoc(salesRef, {
        items: cart,
        totalAmount: cartTotal,
        timestamp: new Date().toISOString(),
      });
      setCart([]);
      setShowReceipt(false);
    } catch (error) {
      console.error("Error saving transaction: ", error);
      alert("Failed to save transaction.");
    } finally {
      setIsSavingTransaction(false);
    }
  };

  if (loading) return <div className="min-h-screen flex items-center justify-center font-sans">Syncing POS...</div>;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col font-sans print:bg-white">
      
      <header className="bg-blue-900 text-white p-4 flex justify-between items-center shadow-md print:hidden">
        <div>
          <h1 className="text-2xl font-bold tracking-wider">
            {businessProfile?.businessName || 'Biz Manager POS'}
          </h1>
          <p className="text-xs text-blue-300">EST. 2022</p>
        </div>
        <div className="flex gap-4">
          <button onClick={() => router.push('/dashboard')} className="hover:text-blue-200 font-semibold">Dashboard</button>
          <button onClick={() => router.push('/services')} className="hover:text-blue-200">Manage Services</button>
          <button onClick={handleLogout} className="text-red-300 hover:text-red-100 font-semibold">Logout</button>
        </div>
      </header>

      <main className="flex-1 flex p-4 gap-6 print:hidden">
        
        {/* PC Management */}
        <section className="flex-1 bg-white rounded-lg shadow p-4 border border-gray-200">
          <h2 className="text-xl font-semibold mb-4 text-gray-800">PC Sessions</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {pcs.map((pc) => {
              const isActive = pc.status === 'Active' && pc.sessionStart;
              const elapsedSeconds = isActive ? Math.floor((tick - pc.sessionStart) / 1000) : 0;
              
              const h = String(Math.floor(elapsedSeconds / 3600)).padStart(2, '0');
              const m = String(Math.floor((elapsedSeconds % 3600) / 60)).padStart(2, '0');
              const s = String(elapsedSeconds % 60).padStart(2, '0');
              
              const timeString = isActive ? `${h}:${m}:${s}` : '00:00:00';
              const cost = Math.floor(elapsedSeconds / 60) * 1; 

              return (
                <div key={pc.id} className={`p-4 rounded-lg border-2 flex flex-col justify-between h-32 ${pc.status === 'Active' ? 'border-green-500 bg-green-50' : 'border-gray-300 bg-gray-50'}`}>
                  <div className="flex justify-between font-bold text-gray-700">
                    <span>{pc.name}</span>
                    <span className={pc.status === 'Active' ? 'text-green-600' : 'text-gray-500'}>{pc.status}</span>
                  </div>
                  <div className="text-center text-2xl font-mono text-gray-800">{timeString}</div>
                  <div className="flex justify-between items-end">
                    <span className="font-semibold text-gray-600">KES {cost}</span>
                    <button 
                      onClick={() => togglePcSession(pc, cost)} 
                      className={`text-sm text-white px-3 py-1 rounded transition ${pc.status === 'Active' ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'}`}
                    >
                      {pc.status === 'Active' ? 'End & Bill' : 'Start'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Quick Sale Cart */}
        <aside className="w-[400px] bg-white rounded-lg shadow p-4 border border-gray-200 flex flex-col relative">
          <h2 className="text-xl font-semibold mb-4 text-gray-800">Current Bill</h2>
          
          <div className="relative mb-4">
            <input 
              type="text" 
              placeholder="Search services or categories..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full p-2 border border-gray-300 rounded focus:border-blue-500 outline-none"
            />
            {searchQuery && (
              <ul className="absolute z-10 w-full bg-white border border-gray-300 rounded shadow-lg max-h-48 overflow-y-auto mt-1">
                {filteredServices.length > 0 ? (
                  filteredServices.map(service => (
                    <li key={service.id} onClick={() => addToCart(service)} className="p-2 hover:bg-blue-50 cursor-pointer flex justify-between border-b last:border-b-0">
                      <div>
                        <span className="block">{service.name}</span>
                        <span className="text-xs text-gray-500">{service.category}</span>
                      </div>
                      <span className="font-semibold mt-1">KES {service.price}</span>
                    </li>
                  ))
                ) : (
                  <li className="p-2 text-gray-500 text-sm">No services found</li>
                )}
              </ul>
            )}
          </div>

          <div className="flex-1 border-t border-b py-4 overflow-y-auto space-y-3">
            {cart.length === 0 ? (
              <p className="text-gray-400 text-center italic mt-10">Bill is empty</p>
            ) : (
              cart.map((item) => (
                <li key={item.id} className="flex justify-between items-center bg-gray-50 p-2 rounded border">
                  <div className="flex-1">
                    <span className="block font-medium text-gray-800 text-sm">{item.name}</span>
                    <span className="text-xs text-gray-500">KES {item.price} each</span>
                  </div>
                  
                  <div className="flex items-center gap-2 mr-4">
                    <button onClick={() => updateQuantity(item.id, -1)} className="bg-gray-200 px-2 rounded hover:bg-gray-300">-</button>
                    <span className="w-6 text-center font-semibold text-sm">{item.qty}</span>
                    <button onClick={() => updateQuantity(item.id, 1)} className="bg-gray-200 px-2 rounded hover:bg-gray-300">+</button>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="font-bold w-16 text-right text-sm">KES {item.price * item.qty}</span>
                    <button onClick={() => removeFromCart(item.id)} className="text-red-500 hover:text-red-700 font-bold px-1">✕</button>
                  </div>
                </li>
              ))
            )}
          </div>

          <div className="pt-4">
            <div className="flex justify-between font-bold text-xl mb-4 text-gray-800">
              <span>Total:</span>
              <span>KES {cartTotal}</span>
            </div>
            <button 
              onClick={() => setShowReceipt(true)}
              disabled={cart.length === 0}
              className={`w-full py-3 rounded-lg font-bold text-lg transition ${
                cart.length > 0 ? 'bg-green-600 text-white hover:bg-green-700' : 'bg-gray-300 text-gray-500 cursor-not-allowed'
              }`}
            >
              Checkout
            </button>
          </div>
        </aside>
      </main>

      {/* RECEIPT MODAL */}
      {showReceipt && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 print:bg-transparent print:relative print:flex-col print:items-start print:justify-start">
          <div className="bg-white p-6 rounded-lg shadow-xl w-96 max-w-full print:shadow-none print:w-[80mm] print:p-0 print:m-0">
            
            <div className="text-center mb-6 font-mono">
              <h2 className="text-2xl font-bold uppercase mb-1">
                {businessProfile?.businessName || 'Biz Manager'}
              </h2>
              <p className="text-sm text-gray-600">{businessProfile?.address}</p>
              <p className="text-sm text-gray-600">Tel: {businessProfile?.phone}</p>
              <p className="text-xs text-gray-500 mt-2">{new Date().toLocaleString()}</p>
              <div className="border-b-2 border-dashed border-gray-300 my-4"></div>
            </div>

            <div className="font-mono text-sm mb-6">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-dashed border-gray-300 text-left">
                    <th className="pb-2 font-semibold">Item</th>
                    <th className="pb-2 font-semibold text-right">Qty</th>
                    <th className="pb-2 font-semibold text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {cart.map((item) => (
                    <tr key={item.id}>
                      <td className="py-2 pr-2">{item.name}</td>
                      <td className="py-2 text-right">{item.qty}</td>
                      <td className="py-2 text-right">KES {item.price * item.qty}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="border-t-2 border-dashed border-gray-300 mt-4 pt-4">
                <div className="flex justify-between font-bold text-lg">
                  <span>TOTAL:</span>
                  <span>KES {cartTotal}</span>
                </div>
              </div>
            </div>

            <div className="text-center font-mono text-sm text-gray-500 mb-6">
              <p>Thank you for visiting!</p>
            </div>

            <div className="flex gap-3 print:hidden">
              <button onClick={() => setShowReceipt(false)} disabled={isSavingTransaction} className="flex-1 border border-gray-300 py-2 rounded font-semibold hover:bg-gray-50">Back</button>
              <button onClick={() => window.print()} disabled={isSavingTransaction} className="flex-1 bg-blue-600 text-white py-2 rounded font-semibold hover:bg-blue-700">Print</button>
              <button onClick={handleCompleteTransaction} disabled={isSavingTransaction} className="flex-1 bg-green-600 text-white py-2 rounded font-semibold hover:bg-green-700">
                {isSavingTransaction ? 'Saving...' : 'Done'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}