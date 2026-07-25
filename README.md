# cyberpos
Biz Manager (by Jaba Planet) is a modern POS and PC management system for cyber cafes. It bridges a Next.js front-desk dashboard with a Python desktop client via Firebase. Features include real-time session control, automated PC lock screens, custom billing, and a minimalist draggable HUD timer for customers

Biz Manager 
Powered by Jaba Planet (EST. 2022)

Biz Manager is a modern, full-stack Point of Sale (POS) and PC management system built specifically for cyber cafes, gaming lounges, and service-oriented workspaces.

Instead of relying on clunky, outdated management software, Biz Manager bridges a sleek, cloud-hosted web dashboard with a lightweight desktop client. It seamlessly controls customer workstations, tracks time, and handles billing in real-time. Designed with a "Natural Minimalist" aesthetic, the system provides a calm, distraction-free interface for both the front desk and the end-users.

 System Features
The Front Desk (Next.js POS Dashboard)
Real-Time PC Control: Start, pause, resume, and end customer sessions instantly across the local network or remotely.

Flexible Billing Models:

Post-paid: Open tabs that count up elapsed time.

Pre-paid: Fixed-time sessions that lock automatically when the countdown hits zero.

Smart Cart Integration: PC session costs are automatically calculated (factoring in customizable free allowances) and pushed to a digital checkout cart alongside physical services, printing, or snacks.

Live Dashboard Analytics: Tracks daily revenue, total sessions, and identifies the busiest workstations on the floor.

Centralized Settings: Update global billing rates (KES/min) and free time allowances on the fly. The desktop clients will automatically sync with the new rates.

🔒 The Workstation (Python Desktop Client)
Automated Screen Locking: A fullscreen, tamper-resistant lock screen that prevents unauthorized access when a PC is marked as "Available" or "Paused".

Draggable HUD Timer: When a session is active, the lock screen disappears and is replaced by a minimalist, draggable floating timer. Customers can monitor their elapsed time or remaining balance without interrupting their workflow or gaming.

Resilient Network Polling: Features exponential backoff and timeout handling to survive spotty internet connections, firewall drops, or clock-sync issues without crashing.

Time-Warning Audio: Plays a soft, natural chime when a pre-paid session has 60 seconds remaining to warn the user.

Staff Override: Built-in hidden hotkey (F12) for staff to bypass the lock screen using a secure PIN.

Tech Stack
Frontend & Dashboard:

Next.js (React)

Tailwind CSS (Custom Natural Minimalist Theme)

Firebase Authentication

Backend & Database:

Google Firebase (Firestore) - Serves as the real-time bridge between the POS and the client PCs.

Target PC Client:

Python 3

Tkinter (GUI)

Firebase Admin SDK

Architecture Overview
The project is split into two halves that communicate entirely via Firestore:

app/page.tsx (The Host): The control center run by the cafe attendant. When a session is started, it updates the specific PC's document in Firestore to status: 'Active'.

lock.py (The Client): Runs as a background service on each customer computer. It continuously polls its specific document in Firestore. When it sees Active, it hides the lock screen. When the time runs out or the attendant clicks 'Pause', it instantly draws the lock screen back over the monitor.

Getting Started
1. Setting up the Web POS
Clone the repository.

Navigate to the web directory and install dependencies:

Bash
npm install
Add your Firebase config credentials to your .env.local file.

Run the development server:

Bash
npm run dev
2. Setting up the PC Clients
Install Python 3 on the target Windows machine.

Install the required Firebase Admin SDK:

Bash
pip install firebase-admin
Drop your Firebase serviceAccountKey.json into the client folder.

Create a config.json file with your specific Firebase UID and the PC's ID.

Run the client script:

Bash
python lock.py
(For production, you can add a shortcut of this script to the Windows shell:startup folder so it launches automatically when the PC turns on).
