# DevOps Learning Platform — Backend

Node.js and Express API for the DevOps Learning Platform.

## Requirements

- Node.js and npm
- MongoDB (local or MongoDB Atlas)
- Google OAuth client ID if Google sign-in is used
- SMTP credentials if email OTP delivery is used

Check versions:

```bash
node --version
npm --version
```

## Setup

1. Clone this repository and enter its directory.
2. Install dependencies:

   ```bash
   npm ci
   ```

3. Create your local environment file:

   ```bash
   cp .env.example .env
   ```

4. Set your own values in `.env`:

   ```dotenv
   PORT=5000
   MONGODB_URI=mongodb+srv://<username>:<password>@<cluster>.mongodb.net/<dbname>?retryWrites=true&w=majority
   JWT_SECRET=replace_with_a_long_random_secret
   JWT_EXPIRES_IN=7d
   GOOGLE_CLIENT_ID=your_google_client_id_here.apps.googleusercontent.com

   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=your_sending_gmail_address@gmail.com
   SMTP_PASS=your_16_character_google_app_password
   EMAIL_FROM="DevOps Learning Platform" <your_sending_gmail_address@gmail.com>
   ```

Notes:
- Replace the MongoDB URI with your real connection string and configure database credentials/network access.
- Use a long, unpredictable JWT secret; do not use the placeholder.
- Set the Google OAuth client ID expected by the backend.
- SMTP is needed for OTP emails. For Gmail, use a Google App Password with 2-Step Verification enabled, not your normal Gmail password. Port `587` is the STARTTLS example. Set `EMAIL_FROM` to a sender accepted by your SMTP provider.
- Google sign-in and OTP delivery will not work until their respective configuration is valid.

Never commit `.env` or share real secrets.

## Run in development

```bash
npm run dev
```

## Run normally

```bash
npm start
```

The package scripts start `src/server.js`. The example port is `5000`.

## Tests

```bash
npm test
```

The test suite may need the configuration/services it exercises; use its output to identify missing settings or external dependencies.

## Connect the frontend and mobile app

- Frontend: set `VITE_API_URL` to the backend URL, normally `http://localhost:5000/api` for local browser development.
- Mobile: configure `API_URL` with Flutter's `--dart-define` option. A physical phone needs your computer's LAN IP, not `localhost`. The standard Android emulator commonly reaches the host computer at `10.0.2.2`.
- Ensure CORS permits the frontend origin.

## Troubleshooting

- **MongoDB errors:** check `MONGODB_URI`, credentials, Atlas network access, and connectivity.
- **OTP emails fail:** check SMTP host/port, App Password, sender address, and spam folder.
- **Port already in use:** change `PORT` and update frontend/mobile API URLs.
- **Authentication fails:** verify JWT settings and Google OAuth configuration.
