'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { auth, db } from '@/lib/firebase';
import { collection, addDoc, deleteDoc, doc, onSnapshot, query, orderBy } from 'firebase/firestore';
import { onAuthStateChanged, User } from 'firebase/auth';

interface ServiceItem {
  id: string;
  name: string;
  price: number;
  category: string;
}

export default function ServicesManager() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [services, setServices] = useState<ServiceItem[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Form State
  const [serviceName, setServiceName] = useState('');
  const [servicePrice, setServicePrice] = useState('');
  const [serviceCategory, setServiceCategory] = useState('');
  const [isAdding, setIsAdding] = useState(false);

  // Authenticate and fetch services
  useEffect(() => {
    const unsubscribeAuth = onAuthStateChanged(auth, (currentUser) => {
      if (currentUser) {
        setUser(currentUser);
        
        // Setup real-time listener for this specific user's services
        const servicesRef = collection(db, 'users', currentUser.uid, 'services');
        const q = query(servicesRef, orderBy('category', 'asc'), orderBy('name', 'asc'));
        
        const unsubscribeSnapshot = onSnapshot(q, (snapshot) => {
          const fetchedServices = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
          })) as ServiceItem[];
          
          setServices(fetchedServices);
          setLoading(false);
        });

        return () => unsubscribeSnapshot();
      } else {
        router.push('/login');
      }
    });

    return () => unsubscribeAuth();
  }, [router]);

  // Add a new service
  const handleAddService = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !serviceName || !servicePrice || !serviceCategory) return;

    setIsAdding(true);
    try {
      const servicesRef = collection(db, 'users', user.uid, 'services');
      await addDoc(servicesRef, {
        name: serviceName,
        price: Number(servicePrice),
        category: serviceCategory,
        createdAt: new Date().toISOString()
      });
      
      setServiceName('');
      setServicePrice('');
      // We keep the category as is, in case the user wants to add multiple items to the same category back-to-back
    } catch (error) {
      console.error("Error adding service: ", error);
      alert("Failed to add service.");
    } finally {
      setIsAdding(false);
    }
  };

  // Delete a service
  const handleDeleteService = async (serviceId: string) => {
    if (!user) return;
    const confirmDelete = window.confirm("Are you sure you want to delete this service?");
    if (!confirmDelete) return;

    try {
      const serviceDocRef = doc(db, 'users', user.uid, 'services', serviceId);
      await deleteDoc(serviceDocRef);
    } catch (error) {
      console.error("Error deleting service: ", error);
      alert("Failed to delete service.");
    }
  };

  if (loading) return <div className="min-h-screen flex items-center justify-center font-sans">Loading Services...</div>;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col font-sans">
      <header className="bg-blue-900 text-white p-4 flex justify-between items-center shadow-md">
        <h1 className="text-2xl font-bold tracking-wider">Biz Manager</h1>
        <div className="flex gap-4">
          <button onClick={() => router.push('/')} className="hover:text-blue-200 transition">Back to POS</button>
        </div>
      </header>

      <main className="flex-1 max-w-5xl w-full mx-auto p-6 flex flex-col md:flex-row gap-6">
        
        {/* Left Column: Add Service Form */}
        <div className="w-full md:w-1/3 bg-white p-6 rounded-xl shadow border border-gray-200 h-fit">
          <h2 className="text-xl font-semibold mb-4 text-gray-800">Add New Service</h2>
          <form onSubmit={handleAddService} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
              <input
                type="text"
                required
                list="category-suggestions"
                value={serviceCategory}
                onChange={(e) => setServiceCategory(e.target.value)}
                className="w-full p-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 outline-none"
                placeholder="e.g., Government, Printing..."
              />
              {/* Datalist provides autocomplete suggestions based on existing entries */}
              <datalist id="category-suggestions">
                {Array.from(new Set(services.map(s => s.category))).map(cat => (
                  <option key={cat} value={cat} />
                ))}
              </datalist>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Service Name</label>
              <input
                type="text"
                required
                value={serviceName}
                onChange={(e) => setServiceName(e.target.value)}
                className="w-full p-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 outline-none"
                placeholder="e.g., KRA PIN Registration"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Price (KES)</label>
              <input
                type="number"
                required
                min="0"
                value={servicePrice}
                onChange={(e) => setServicePrice(e.target.value)}
                className="w-full p-2 border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 outline-none"
                placeholder="e.g., 300"
              />
            </div>
            <button
              type="submit"
              disabled={isAdding}
              className={`w-full py-2 rounded-lg font-bold text-white transition ${
                isAdding ? 'bg-blue-400' : 'bg-blue-600 hover:bg-blue-700'
              }`}
            >
              {isAdding ? 'Adding...' : 'Save Service'}
            </button>
          </form>
        </div>

        {/* Right Column: List of Services */}
        <div className="w-full md:w-2/3 bg-white p-6 rounded-xl shadow border border-gray-200">
          <h2 className="text-xl font-semibold mb-4 text-gray-800">Your Services</h2>
          
          {services.length === 0 ? (
            <div className="text-center py-10 text-gray-500 border-2 border-dashed border-gray-200 rounded">
              No services added yet. Add your first service to get started.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b-2 border-gray-200 text-gray-700">
                    <th className="p-3 font-semibold">Category</th>
                    <th className="p-3 font-semibold">Service Name</th>
                    <th className="p-3 font-semibold text-right">Price (KES)</th>
                    <th className="p-3 font-semibold text-center">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {services.map((service) => (
                    <tr key={service.id} className="border-b border-gray-100 hover:bg-gray-50 transition">
                      <td className="p-3 text-gray-500 text-sm">
                        <span className="bg-gray-100 px-2 py-1 rounded border border-gray-200">{service.category || 'Uncategorized'}</span>
                      </td>
                      <td className="p-3 text-gray-800 font-medium">{service.name}</td>
                      <td className="p-3 text-right text-gray-600 font-semibold">{service.price}</td>
                      <td className="p-3 text-center">
                        <button 
                          onClick={() => handleDeleteService(service.id)}
                          className="text-red-500 hover:text-red-700 text-sm font-bold bg-red-50 px-3 py-1 rounded transition"
                        >
                          Delete
                        </button>
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