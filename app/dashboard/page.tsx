'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { auth, db } from '@/lib/firebase';
import { onAuthStateChanged, User } from 'firebase/auth';
import { collection, onSnapshot, query, orderBy, doc, getDoc } from 'firebase/firestore';

interface SaleRecord {
  id: string;
  items: any[];
  totalAmount: number;
  timestamp: string;
}

export default function Dashboard() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [sales, setSales] = useState<SaleRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [businessProfile, setBusinessProfile] = useState<any>(null);

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
        
        // Fetch Sales Data in real-time, newest first
        const salesRef = collection(db, 'users', currentUser.uid, 'sales');
        const q = query(salesRef, orderBy('timestamp', 'desc'));
        
        const unsubscribeSales = onSnapshot(q, (snapshot) => {
          const fetchedSales = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
          })) as SaleRecord[];
          
          setSales(fetchedSales);
          setLoading(false);
        });

        return () => unsubscribeSales();
      } else {
        router.push('/login');
      }
    });

    return () => unsubscribeAuth();
  }, [router]);

  // Calculate today's revenue
  const today = new Date().toDateString();
  const todaysSales = sales.filter(sale => new Date(sale.timestamp).toDateString() === today);
  const todaysRevenue = todaysSales.reduce((sum, sale) => sum + sale.totalAmount, 0);
  
  // Calculate all-time revenue
  const totalRevenue = sales.reduce((sum, sale) => sum + sale.totalAmount, 0);

  if (loading) return <div className="min-h-screen flex items-center justify-center font-sans">Loading Dashboard...</div>;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col font-sans">
      <header className="bg-blue-900 text-white p-4 flex justify-between items-center shadow-md">
        <div>
          <h1 className="text-2xl font-bold tracking-wider">
            {businessProfile?.businessName || 'Biz Manager Dashboard'}
          </h1>
          <p className="text-xs text-blue-300">EST. 2022</p>
        </div>
        <div className="flex gap-4">
          <button onClick={() => router.push('/')} className="hover:text-blue-200 transition font-semibold">Back to POS</button>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto p-6 flex flex-col gap-6">
        
        {/* Top Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-white p-6 rounded-xl shadow border border-gray-200 flex flex-col items-center justify-center">
            <h3 className="text-gray-500 font-medium mb-2">Today's Revenue</h3>
            <span className="text-3xl font-bold text-green-600">KES {todaysRevenue}</span>
            <span className="text-sm text-gray-400 mt-1">{todaysSales.length} Transactions</span>
          </div>
          
          <div className="bg-white p-6 rounded-xl shadow border border-gray-200 flex flex-col items-center justify-center">
            <h3 className="text-gray-500 font-medium mb-2">Total All-Time Revenue</h3>
            <span className="text-3xl font-bold text-blue-600">KES {totalRevenue}</span>
            <span className="text-sm text-gray-400 mt-1">{sales.length} Transactions</span>
          </div>

          <div className="bg-white p-6 rounded-xl shadow border border-gray-200 flex flex-col items-center justify-center">
            <h3 className="text-gray-500 font-medium mb-2">Expenses (Coming Soon)</h3>
            <span className="text-3xl font-bold text-red-500">KES 0</span>
            <button className="mt-2 text-sm text-blue-600 hover:underline">Manage Expenses</button>
          </div>
        </div>

        {/* Transaction History Table */}
        <div className="bg-white p-6 rounded-xl shadow border border-gray-200 flex-1">
          <h2 className="text-xl font-semibold mb-4 text-gray-800">Recent Transactions</h2>
          
          {sales.length === 0 ? (
            <div className="text-center py-10 text-gray-500 border-2 border-dashed border-gray-200 rounded">
              No sales recorded yet. Make a sale in the POS to see it here!
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b-2 border-gray-200 text-gray-700">
                    <th className="p-3 font-semibold">Date & Time</th>
                    <th className="p-3 font-semibold">Items Sold</th>
                    <th className="p-3 font-semibold text-right">Total Amount (KES)</th>
                  </tr>
                </thead>
                <tbody>
                  {sales.map((sale) => (
                    <tr key={sale.id} className="border-b border-gray-100 hover:bg-gray-50 transition">
                      <td className="p-3 text-gray-600 text-sm">
                        {new Date(sale.timestamp).toLocaleString()}
                      </td>
                      <td className="p-3 text-gray-800 text-sm">
                        {sale.items.map(item => `${item.qty}x ${item.name}`).join(', ')}
                      </td>
                      <td className="p-3 text-right font-bold text-gray-800">
                        {sale.totalAmount}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

      </main>
    </div>
  );
}