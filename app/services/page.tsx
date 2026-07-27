"use client";

import { useState, useEffect } from "react";
import { getAuth, onAuthStateChanged } from "firebase/auth";
// import { db } from "../firebase"; // Adjust this path to your actual firebase config file

export default function ServicesPage() {
  const [businessName, setBusinessName] = useState("Loading...");
  const [services, setServices] = useState([
    { id: 1, name: "B&W Printing", price: 10, category: "Document" },
    { id: 2, name: "Color Printing", price: 50, category: "Document" },
    { id: 3, name: "Scanning", price: 20, category: "Document" },
    { id: 4, name: "Lamination", price: 100, category: "Service" },
    { id: 5, name: "Passport Photos", price: 150, category: "Photography" },
    { id: 6, name: "Snack / Soda", price: 70, category: "Refreshment" },
  ]);

  useEffect(() => {
    const auth = getAuth();
    // Listen for the logged-in user to grab the name they used during sign-up
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        // Uses the display name from sign up. If blank, falls back to a default.
        setBusinessName(user.displayName || "Biz Manager Services");
      } else {
        setBusinessName("Guest User");
      }
    });

    return () => unsubscribe();
  }, []);

  return (
    <div className="min-h-screen bg-neutral-50 p-8 font-sans">
      
      {/* Header Section */}
      <header className="mb-10">
        <h1 className="text-4xl font-light text-neutral-800 tracking-tight">
          {businessName}
        </h1>
        <p className="text-neutral-500 mt-2 text-sm uppercase tracking-widest font-medium">
          Service & Inventory Management
        </p>
      </header>

      {/* Services Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {services.map((service) => (
          <div 
            key={service.id} 
            className="bg-white p-6 rounded-2xl border border-neutral-100 shadow-sm hover:shadow-md transition-shadow duration-200 flex flex-col justify-between"
          >
            <div>
              <span className="text-xs font-semibold text-emerald-600 bg-emerald-50 px-3 py-1 rounded-full uppercase tracking-wide">
                {service.category}
              </span>
              <h3 className="text-xl font-medium text-neutral-800 mt-4">
                {service.name}
              </h3>
            </div>
            
            <div className="flex items-center justify-between mt-6 pt-4 border-t border-neutral-50">
              <span className="text-2xl font-light text-neutral-900">
                KES {service.price}
              </span>
              <button className="text-sm bg-neutral-900 text-white px-5 py-2 rounded-xl hover:bg-neutral-800 transition-colors">
                Add to Cart
              </button>
            </div>
          </div>
        ))}

        {/* Add New Service Button Card */}
        <button className="bg-transparent border-2 border-dashed border-neutral-200 p-6 rounded-2xl flex flex-col items-center justify-center text-neutral-400 hover:text-neutral-600 hover:border-neutral-300 hover:bg-neutral-100/50 transition-all min-h-[160px]">
          <svg className="w-8 h-8 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
          <span className="font-medium">Add New Service</span>
        </button>
      </div>
    </div>
  );
}