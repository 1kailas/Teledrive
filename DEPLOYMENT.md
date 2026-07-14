# Cloudflare Deployment Guide — TeleDrive 2.0

TeleDrive 2.0 is fully Cloudflare-native:
* **Backend**: Hosted on **Cloudflare Workers** (Hono + D1 SQL Database)
* **Frontend**: Hosted on **Cloudflare Pages** (React + Vite static hosting)

Follow these steps to deploy both components to production.

---

## Phase 1: Deploy the Backend (Cloudflare Workers + D1)

### 1. Login to Cloudflare CLI
In your terminal, run:
```bash
npx wrangler login
```
This will open a browser window for you to authenticate your Cloudflare account.

### 2. Create the D1 Database
Create a production database in your Cloudflare account:
```bash
npx wrangler d1 create teledrive-db
```
This command will output configuration details. Look for the `database_id` in the output:
```text
[[d1_databases]]
binding = "DB"
database_name = "teledrive-db"
database_id = "xxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

### 3. Configure `wrangler.toml`
Open `worker/wrangler.toml` and replace the database ID with your new production ID:
```toml
# worker/wrangler.toml
[[d1_databases]]
binding = "DB"
database_name = "teledrive-db"
database_id = "YOUR_NEW_PRODUCTION_DATABASE_ID" # <-- Paste here
migrations_dir = "src/db/migrations"
```

### 4. Run Migrations on the Production D1
Initialize the tables on your live database:
```bash
npx wrangler d1 migrations apply teledrive-db --remote
```

### 5. Set Backend Production Environment Variables
Set the secrets for your worker on the Cloudflare network:
```bash
# Set your Telegram bot tokens (comma-separated list of bots)
npx wrangler secret put TELEGRAM_BOT_TOKEN

# Set your target Telegram storage channel ID (e.g. -1004316562629)
npx wrangler secret put TELEGRAM_CHAT_ID

# Set your random JWT Secret passcode
npx wrangler secret put JWT_SECRET
```
*Note: The CLI will prompt you to type/paste each secret. Press Enter to submit.*

### 6. Deploy the Worker
Publish the backend worker:
```bash
npm run deploy --workspace=worker
```
Once deployed, this will output your Worker's live URL (e.g., `https://teledrive-worker.username.workers.dev`). **Copy this URL.**

---

## Phase 2: Deploy the Frontend (Cloudflare Pages)

### 1. Build the Frontend Locally
Before building, make sure you configure the production API endpoint. You can build manually or link Cloudflare Pages to your Git repository (recommended).

#### Option A: Direct Wrangler Deployment (Fastest)
1. Build the project:
   ```bash
   # Run in frontend folder
   cd frontend
   npm run build
   ```
2. Deploy the `dist` directory to Cloudflare Pages:
   ```bash
   npx wrangler pages deploy dist --project-name=teledrive
   ```
   *Follow the prompts to create the project. It will give you a Pages URL (e.g., `https://teledrive.pages.dev`).*

#### Option B: Git Hook Deployment (Automatic builds on git push)
1. Push your repository to GitHub/GitLab.
2. Log in to the Cloudflare Dashboard → **Workers & Pages** → **Create Application** → **Pages** → **Connect to Git**.
3. Choose your repository and set these build settings:
   - **Framework Preset**: `Vite`
   - **Build Command**: `npm run build`
   - **Build Directory**: `dist`
4. Add this Environment Variable in the Pages build settings:
   - **Key**: `VITE_API_URL`
   - **Value**: `https://teledrive-worker.username.workers.dev` (Your Workers URL from Phase 1)
   - **Key**: `VITE_TELEGRAM_BOT_USERNAME`
   - **Value**: `teledruve1_bot` (Your primary bot username)
5. Save and deploy.

---

## Phase 3: Connect Frontend and Backend (CORS Security)

Because the frontend (`https://teledrive.pages.dev`) and backend (`https://teledrive-worker.username.workers.dev`) run on different domains, we need to allow the frontend to access the backend.

1. Log in to the **Cloudflare Dashboard** → **Workers & Pages**.
2. Click on your **`teledrive-worker`** project → **Settings** → **Variables**.
3. Under **Environment Variables**, add the production URL of your frontend:
   - **Key**: `FRONTEND_URL`
   - **Value**: `https://teledrive.pages.dev` (Your Pages URL)
4. Redeploy the worker or click save to apply.

---

## 🔒 Post-Deployment Checklist

* **Telegram Domain whitelist**:
  Go to `@BotFather` → `/setdomain` → Select `@teledruve1_bot` → Type your production frontend domain: `teledrive.pages.dev` (so the widget button works on your live URL).
