# Monday.com BI Agent

An AI-powered Business Intelligence agent that answers founder-level queries by fetching live data from Monday.com boards.

---

## Tech Stack
- **Frontend**: React + Vite
- **Backend**: Node.js + Express
- **AI**: Google Gemini 1.5 Flash (via @google/generative-ai)
- **Data**: Monday.com GraphQL API (live, no caching)
- **Deploy**: Render.com

---

## Setup Instructions

### Step 1: Accounts You Need
1. [Monday.com](https://monday.com) — free account
2. [Google AI Studio](https://aistudio.google.com) — free Gemini API key
3. [Render.com](https://render.com) — free hosting

---

### Step 2: Create Monday.com Boards

**Board 1 — "Deal Funnel":**
Create a new board with these columns (exact names matter for import):
| Column Name | Type |
|---|---|
| Owner code | Text |
| Client Code | Text |
| Deal Status | Status |
| Close Date | Date |
| Closure Probability | Text |
| Masked Deal value | Numbers |
| Tentative Close Date | Date |
| Deal Stage | Text |
| Product deal | Text |
| Sector/service | Text |
| Created Date | Date |

**Board 2 — "Work Orders":**
| Column Name | Type |
|---|---|
| Customer Name Code | Text |
| Serial # | Text |
| Nature of Work | Text |
| Execution Status | Status |
| Date of PO/LOI | Date |
| Probable Start Date | Date |
| Probable End Date | Date |
| BD/KAM Personnel code | Text |
| Sector | Text |
| Type of Work | Text |
| Amount (Excl GST) | Numbers |
| Billed Value | Numbers |
| Collected Amount | Numbers |
| Amount Receivable | Numbers |
| WO Status | Text |
| Billing Status | Text |

**Get Board IDs:**
1. Open each board in Monday.com
2. Copy the number from the URL: `https://monday.com/boards/XXXXXXXXX`

**Get API Key:**
Go to: Monday.com → Profile picture (top right) → Developers → My Access Tokens → Copy token

---

### Step 3: Get Gemini API Key
Go to: [https://aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) → Create API key → Copy it

---

### Step 4: Configure Environment
Edit `backend/.env` and fill in your keys:
```
GEMINI_API_KEY=your_gemini_key_here
MONDAY_API_KEY=your_monday_token_here
MONDAY_DEALS_BOARD_ID=123456789
MONDAY_WORKORDERS_BOARD_ID=987654321
PORT=3001
```

---

### Step 5: Import Data to Monday.com
Place both Excel files in the `import/` folder, then:
```bash
cd import
npm install
npm run import
```
This uploads all 347 deals and 177 work orders to Monday.com automatically.

---

### Step 6: Run Locally
**Terminal 1 — Backend:**
```bash
cd backend
npm install
npm start
```

**Terminal 2 — Frontend:**
```bash
cd frontend
npm install
npm run dev
```

Open: http://localhost:5173

---

### Step 7: Deploy to Render.com

**Backend:**
1. Push this project to GitHub
2. Go to Render.com → New → Web Service
3. Connect your GitHub repo
4. Set:
   - Root Directory: `backend`
   - Build Command: `npm install`
   - Start Command: `npm start`
5. Add Environment Variables (from your .env file)
6. Deploy → Copy the URL (e.g. `https://bi-agent-backend.onrender.com`)

**Frontend:**
1. Create `frontend/.env`:
   ```
   VITE_API_URL=https://your-backend-url.onrender.com
   ```
2. New → Static Site
3. Root Directory: `frontend`
4. Build Command: `npm install && npm run build`
5. Publish Directory: `dist`
6. Deploy → Share this URL with evaluators

---

## Sample Questions to Ask
- "How's our overall pipeline looking?"
- "Which sector has the highest deal value?"
- "What's our total receivables outstanding?"
- "Who is the top performing owner/salesperson?"
- "How's our energy sector pipeline this quarter?"
- "Compare Mining vs Powerline in terms of deal value"
- "Show me all deals in Negotiations stage"
- "What's our collection efficiency on work orders?"

---

## Architecture
```
User Query
    ↓
React Chat UI (shows messages + tool traces)
    ↓
Express Backend (/api/chat)
    ↓
Gemini 1.5 Flash (decides which tools to call)
    ↓
Tool Functions (5 tools)
    ↓
Monday.com GraphQL API (LIVE - no cache)
    ↓
Results → Gemini synthesizes → Answer to user
```
