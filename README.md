# LOOP (Leap Lounge)

**No more missed deadlines.**
LOOP is a modern, personalized platform that aggregates internships, scholarships, fellowships, and competitions into a highly curated feed tailored specifically to your profile.

With an intuitive swiping interface and smart match-scoring, LOOP ensures you only see the opportunities that matter most to you—and helps you track them so you never miss a deadline again.

---

## ✨ Features

- **Personalized Opportunity Feed**: A curated list of internships, scholarships, fellowships, and competitions ranked by a "Match Score" based on your unique skills, interests, and professional field.
- **Tinder-Style Swiping Interface**: Quickly triage opportunities by swiping right to show interest or swiping left to pass.
- **AI-Powered Personalization**: Integrated with Google Gemini 2.5 Flash to generate highly relevant, realistic opportunities instantly based on your profile tokens.
- **Automated Resume Parsing**: Upload your resume (PDF) to automatically extract your skills and professional field—no manual data entry required.
- **Deadline Tracking & Watchlist**: Save opportunities to your Watchlist. Get real-time countdown timers, a unified calendar view, and active popup reminders for impending deadlines.
- **Dynamic User Profiles**: Store your professional links (GitHub, LeetCode, Portfolio) and manage your custom skills and interests.

---

## 🛠 Tech Stack

LOOP is built on a modern, high-performance web stack:

### Frontend
- **Framework**: [React 19](https://react.dev/)
- **Routing & SSR**: [TanStack Start](https://tanstack.com/start) & [TanStack Router](https://tanstack.com/router)
- **Data Fetching**: [TanStack Query](https://tanstack.com/query) (React Query)
- **Styling**: [Tailwind CSS v4](https://tailwindcss.com/)
- **Animations**: [Framer Motion](https://www.framer.com/motion/) (powering the fluid swipe cards and entry animations)
- **UI Components**: [Radix UI](https://www.radix-ui.com/) (headless, accessible components) & [Lucide React](https://lucide.dev/) (icons)

### Backend & Database
- **Database**: [MongoDB](https://www.mongodb.com/) (using native Node.js driver)
- **Authentication**: Custom JWT-based authentication (`jsonwebtoken`, `bcrypt`)
- **Server Engine**: Powered by Nitro (via TanStack Start)

### Integrations
- **AI Integration**: [Google GenAI API](https://ai.google.dev/) (`@google/genai`) for personalized feed generation
- **Email Notifications**: [Resend](https://resend.com/) for automated deadline reminders

---

## 🚀 Getting Started

### Prerequisites
- Node.js (v20+ recommended)
- MongoDB instance (local or Atlas)
- Google Gemini API Key

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/your-username/leap-lounge.git
   cd leap-lounge
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Environment Setup:**
   Create a `.env` file in the root directory and add the following variables:
   ```env
   MONGODB_URI=your_mongodb_connection_string
   JWT_SECRET=your_jwt_secret
   GEMINI_API_KEY=your_gemini_api_key
   RESEND_API_KEY=your_resend_api_key
   ```

4. **Run the development server:**
   ```bash
   npm run dev
   ```

5. **Open the app:**
   Navigate to [http://localhost:3000](http://localhost:3000) in your browser.

---

## 📅 Scripts

- `npm run dev`: Starts the development server using Vite.
- `npm run build`: Builds the app for production.
- `npm run lint`: Runs ESLint to check for code issues.
- `npm run format`: Formats the code using Prettier.
- `npm run cron:reminders`: Executes the deadline reminder script (ideal for cron jobs).

---

*Designed and built to help you land your next big leap.*
