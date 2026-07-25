# Biz Manager POS 🌿

> A modern, full-stack Point of Sale (POS) and PC management system built for cyber cafes. Powered by Jaba Planet (EST. 2022).

Biz Manager bridges a cloud-hosted web dashboard (Next.js) with a lightweight desktop client (Python) to seamlessly control customer workstations, track time, and handle billing in real-time. Designed with a "Natural Minimalist" aesthetic for a calm, distraction-free interface.

---

## 📋 Table of Contents
- [Features](#-features)
- [Tech Stack](#-tech-stack)
- [Getting Started](#-getting-started)
  - [Prerequisites](#prerequisites)
  - [Web POS Setup](#1-web-pos-setup)
  - [Desktop Client Setup](#2-desktop-client-setup)
- [Environment Variables](#-environment-variables)
- [Deployment](#-deployment)

---

## ✨ Features

### 📡 The Front Desk (Host POS)
* **Real-Time PC Control:** Start, pause, resume, and end customer sessions instantly.
* **Flexible Billing:** Supports Post-paid (open tab) and Pre-paid (countdown) sessions.
* **Smart Cart Integration:** Automatically calculates PC session costs alongside physical services.
* **Live Analytics:** Tracks daily revenue, total sessions, and busiest rigs.
* **Centralized Settings:** Update global billing rates (KES/min) on the fly.

### 🔒 The Workstation (Client PC)
* **Automated Screen Locking:** Fullscreen lock prevents unauthorized access when a PC is available or paused.
* **Draggable HUD:** Active sessions display a minimalist, draggable floating timer.
* **Network Resilience:** Exponential backoff and timeout handling for spotty connections.
* **Staff Override:** Built-in hidden hotkey (`F12`) to bypass the lock screen using a secure PIN.

---

## 🛠 Tech Stack

**Frontend (Dashboard)**
* [Next.js](https://nextjs.org/) (React)
* [Tailwind CSS](https://tailwindcss.com/)
* Firebase Authentication

**Backend (Database)**
* Google Firebase (Firestore)

**Client (Target PC)**
* Python 3
* Tkinter (GUI)
* Firebase Admin SDK

---

## 🚀 Getting Started

### Prerequisites
* Node.js installed (for the web dashboard)
* Python 3 installed (for the client PCs)
* A Firebase Project with Firestore and Authentication enabled

### 1. Web POS Setup
Clone the repository and install the dependencies:

```bash
git clone [https://github.com/your-username/cyberpos.git](https://github.com/your-username/cyberpos.git)
cd cyberpos
npm install
